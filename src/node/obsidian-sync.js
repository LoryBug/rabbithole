import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { exportHoleToVault } from "./obsidian-export.js";
import { collectSubtreeIds } from "../core/model.js";
import { onHoleSaved } from "./fs-store.js";

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

export function markVaultWrite(filePath, action = "write") {
  const resolved = path.resolve(filePath);
  if (action === "delete") {
    recentWrites.set(resolved, null);
    return;
  }
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

function indexManagedFiles(dir, out = new Map()) {
  for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) indexManagedFiles(file, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      try {
        const { frontmatter } = parseFrontmatterAndBody(fsSync.readFileSync(file, "utf8"));
        if (frontmatter.rabbithole_id && frontmatter.hole_id) {
          out.set(path.resolve(file), { holeId: frontmatter.hole_id, nodeId: frontmatter.rabbithole_id });
        }
      } catch {}
    }
  }
  return out;
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
  let managedFiles = indexManagedFiles(watchDir);
  let missingTimer = null;
  let reconciling = false;
  let stopped = false;

  const removeDeletedNode = async (entry, filePath) => {
    const hole = await store.loadHole(entry.holeId);
    if (!hole) return;
    if (hole.root_id === entry.nodeId) {
      await exportHoleToVault(store, entry.holeId, { vaultPath: vaultRoot, folder: folderPath, onWrite: markVaultWrite });
      managedFiles = indexManagedFiles(watchDir);
      return;
    }
    const nodes = Array.isArray(hole.nodes) ? hole.nodes : Object.values(hole.nodes || {});
    const doomed = new Set(collectSubtreeIds(nodes, entry.nodeId));
    if (doomed.size === 1 && !nodes.some((node) => node.id === entry.nodeId)) return;
    hole.nodes = nodes.filter((node) => !doomed.has(node.id));
    await store.saveHole(hole);
    for (const [managedFile, info] of managedFiles) {
      if (info.holeId === entry.holeId && doomed.has(info.nodeId)) managedFiles.delete(managedFile);
    }
    managedFiles.delete(filePath);
  };

  const reconcileMissingFiles = async () => {
    if (stopped || reconciling) return;
    reconciling = true;
    missingTimer = null;
    try {
      for (const [file, entry] of [...managedFiles]) {
        if (stopped) return;
        if (fsSync.existsSync(file)) continue;
        if (recentWrites.has(file) && recentWrites.get(file) === null) {
          recentWrites.delete(file);
          managedFiles.delete(file);
          continue;
        }
        await removeDeletedNode(entry, file);
      }
    } finally {
      reconciling = false;
    }
  };

  const scheduleMissingReconciliation = () => {
    if (missingTimer) clearTimeout(missingTimer);
    missingTimer = setTimeout(() => reconcileMissingFiles().catch(() => {}), 500);
  };

  const onChange = (filePath) => {
    const full = filePath ? path.resolve(watchDir, filePath) : watchDir;
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(watchDir))) return;
    if (!resolved.endsWith(".md")) {
      scheduleMissingReconciliation();
      return;
    }

    if (!fsSync.existsSync(resolved)) {
      scheduleMissingReconciliation();
      return;
    }

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
        reimportFile(resolved, store).then(() => {
          managedFiles = indexManagedFiles(watchDir);
        }).catch(() => {});
      }, 400)
    );
  };

  const watcher = fsSync.watch(watchDir, { recursive: true }, (_event, filename) => {
    if (filename) onChange(filename);
  });

  const exportTimer = { value: null };
  let exportInFlight = Promise.resolve();
  const stopStoreWatch = holeId
    ? onHoleSaved((hole) => {
      if (String(hole.hole_id) !== String(holeId)) return;
      if (exportTimer.value) clearTimeout(exportTimer.value);
      exportTimer.value = setTimeout(() => {
        exportTimer.value = null;
        exportInFlight = exportInFlight
          .then(() => exportHoleToVault(store, holeId, { vaultPath: vaultRoot, folder: folderPath, onWrite: markVaultWrite }))
          .then(() => { managedFiles = indexManagedFiles(watchDir); })
          .catch(() => {});
      }, 400);
    })
    : () => {};
  const missingPoll = setInterval(() => reconcileMissingFiles().catch(() => {}), 500);
  missingPoll.unref?.();

  activeWatcher = {
    watcher,
    watchDir,
    stop() {
      stopped = true;
      watcher.close();
      stopStoreWatch();
      if (exportTimer.value) clearTimeout(exportTimer.value);
      if (missingTimer) clearTimeout(missingTimer);
      clearInterval(missingPoll);
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
