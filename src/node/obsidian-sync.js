import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportHoleToVault } from "./obsidian-export.js";

const CONTENT_START = "<!-- rabbithole:content:start -->";
const CONTENT_END = "<!-- rabbithole:content:end -->";

/**
 * Two-way sync: watch the Obsidian vault subfolder and re-import edited notes
 * back into their Rabbithole nodes. Structure stays authoritative in Rabbithole
 * (parent/child come from frontmatter ids, not wikilinks); only the note body
 * is pulled in. Our own exports trigger file events, so we suppress them via
 * markVaultWrite within a short window.
 */

const recentWrites = new Map();
const debounceTimers = new Map();
let activeWatcher = null;

export function markVaultWrite(filePath) {
  const resolved = path.resolve(filePath);
  try {
    recentWrites.set(resolved, fsSync.readFileSync(resolved, "utf8"));
  } catch {
    recentWrites.set(resolved, null);
  }
}

function parseFrontmatterAndBody(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { frontmatter: {}, body: text };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: text };
  const fmBlock = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const frontmatter = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (m) {
      const raw = m[2].trim();
      frontmatter[m[1]] = raw.replace(/^["']|["']$/g, "");
    }
  }
  return { frontmatter, body };
}

function extractManagedContent(body) {
  const start = body.indexOf(CONTENT_START);
  const end = body.indexOf(CONTENT_END);
  if (start === -1 || end === -1 || end < start) return body.trim() + "\n";
  return body.slice(start + CONTENT_START.length, end).trim() + "\n";
}

async function reimportFile(filePath, store) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }
  const { frontmatter, body } = parseFrontmatterAndBody(text);
  const nodeId = frontmatter.rabbithole_id;
  const holeId = frontmatter.hole_id;
  if (!nodeId || !holeId) return;

  const hole = await store.loadHole(holeId);
  if (!hole) return;
  const nodes = Array.isArray(hole.nodes) ? hole.nodes : Object.values(hole.nodes || {});
  const node = nodes.find((n) => String(n.id) === String(nodeId));
  if (!node) return;
  const markdown = extractManagedContent(body);
  if (node.markdown === markdown) return;

  node.markdown = markdown;
  await store.saveHole(hole);
}

function rabbitsDir() {
  return process.env.RABBITHOLE_DIR || path.join(os.homedir(), ".rabbithole");
}

export function startVaultWatch({ vaultPath, folder = "Rabbithole", store, holeId = "" }) {
  if (activeWatcher) stopVaultWatch();
  const vaultRoot = path.resolve(vaultPath);
  const folderPath = String(folder || "Rabbithole");
  if (path.isAbsolute(folderPath) || folderPath.split(/[\\/]+/).includes("..")) {
    throw new Error("folder must be a safe relative path inside the Obsidian vault");
  }
  if (!fsSync.statSync(vaultRoot, { throwIfNoEntry: false })?.isDirectory() ||
      !fsSync.statSync(path.join(vaultRoot, ".obsidian"), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Not an Obsidian vault: ${vaultRoot}`);
  }
  const watchDir = path.join(vaultRoot, folderPath);
  if (!fsSync.existsSync(watchDir)) throw new Error(`Obsidian sync folder does not exist: ${watchDir}`);

  const onChange = (filePath) => {
    const full = filePath ? path.resolve(watchDir, filePath) : watchDir;
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(watchDir))) return;
    if (!resolved.endsWith(".md")) return;

    if (recentWrites.has(resolved)) {
      const writtenContent = recentWrites.get(resolved);
      let currentContent = null;
      try { currentContent = fsSync.readFileSync(resolved, "utf8"); } catch {}
      recentWrites.delete(resolved);
      if (writtenContent === currentContent) return;
    }
    if (debounceTimers.has(resolved)) clearTimeout(debounceTimers.get(resolved));
    debounceTimers.set(
      resolved,
      setTimeout(() => {
        debounceTimers.delete(resolved);
        reimportFile(resolved, store).catch(() => {});
      }, 400)
    );
  };

  const watcher = fsSync.watch(watchDir, { recursive: true }, (_event, filename) => {
    if (filename) onChange(filename);
  });

  const storeDir = rabbitsDir();
  const holeFile = holeId ? `${holeId}.json` : "";
  const exportTimer = { value: null };
  const storeWatcher = holeFile && fsSync.existsSync(storeDir)
    ? fsSync.watch(storeDir, (_event, filename) => {
      if (String(filename || "") !== holeFile) return;
      if (exportTimer.value) clearTimeout(exportTimer.value);
      exportTimer.value = setTimeout(() => {
        exportTimer.value = null;
        exportHoleToVault(store, holeId, { vaultPath: vaultRoot, folder: folderPath, onWrite: markVaultWrite }).catch(() => {});
      }, 400);
    })
    : null;

  activeWatcher = {
    watcher,
    storeWatcher,
    watchDir,
    stop() {
      watcher.close();
      storeWatcher?.close();
      if (exportTimer.value) clearTimeout(exportTimer.value);
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
    },
  };
  return { watching: watchDir };
}

export function stopVaultWatch() {
  if (activeWatcher) {
    activeWatcher.stop();
    activeWatcher = null;
  }
}
