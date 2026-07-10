import fs from "node:fs/promises";
import path from "node:path";

/**
 * Export a Rabbithole hole into an existing Obsidian vault as a folder of
 * markdown notes. Each node becomes one note with frontmatter carrying the
 * stable rabbithole_id / hole_id so a later 2-way import can map the file back
 * to its node. Citations (PMID / DOI / arXiv) become Literature notes linked
 * with Obsidian wikilinks, so the vault graph reproduces the canvas tree and
 * its sources.
 *
 * Rabbithole owns the graph (parent/child); Obsidian owns the prose. Wikilinks
 * are navigation only — the 2-way importer ignores them for structure and uses
 * the frontmatter ids.
 */

const LIT_FOLDER = "Literature";
export const CONTENT_START = "<!-- rabbithole:content:start -->";
export const CONTENT_END = "<!-- rabbithole:content:end -->";

export function slugify(text, max = 48) {
  const slug = String(text || "")
    .toLowerCase()
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return slug || "untitled";
}

const CITATION_RE = new RegExp(
  [
    /(?:PMID:?\s*)(\d{6,8})/.source,
    /(?:DOI:?\s*)(10\.\d{4,9}\/[^\s)]+)/.source,
    /(?:arXiv:?\s*)(\d{4}\.\d{4,5}(?:v\d+)?)/.source,
  ].join("|"),
  "g"
);

export function extractCitations(markdown) {
  const found = new Map();
  let match;
  const re = new RegExp(CITATION_RE.source, "g");
  while ((match = re.exec(String(markdown || ""))) !== null) {
    if (match[1]) add(found, "pmid", match[1], `https://pubmed.ncbi.nlm.nih.gov/${match[1]}/`);
    else if (match[2]) {
      const doi = match[2].replace(/[).]+$/, "");
      add(found, "doi", doi, `https://doi.org/${doi}`);
    } else if (match[3]) add(found, "arxiv", match[3], `https://arxiv.org/abs/${match[3]}`);
  }
  return [...found.values()];
}

function add(map, kind, id, url) {
  const key = `${kind}:${id}`;
  if (!map.has(key)) map.set(key, { kind, id, url, label: literatureLabel(kind, id) });
}

export function literatureLabel(kind, id) {
  if (kind === "pmid") return `PMID ${id}`;
  if (kind === "doi") return `DOI ${id.replace(/\//g, "-")}`;
  if (kind === "arxiv") return `arXiv ${id}`;
  return id;
}

export function literatureNoteName(kind, id) {
  return `${LIT_FOLDER}/${literatureLabel(kind, id)}`;
}

export function nodeNoteName(node) {
  return `${slugify(node.title || node.id)}--${slugify(node.id, 12)}`;
}

export function nodeFolderName(node) {
  return `${slugify(node.title || node.id, 24)}--${slugify(node.id, 8)}`;
}

function buildNodeNotePaths(nodes, rootId) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const paths = new Map();

  function resolve(node) {
    if (paths.has(node.id)) return paths.get(node.id);
    if (!node.parent_id || node.id === rootId || !byId.has(node.parent_id)) {
      paths.set(node.id, "index");
      return "index";
    }
    const parent = byId.get(node.parent_id);
    const parentPath = resolve(parent);
    const parentDir = parentPath === "index" ? "" : path.posix.dirname(parentPath);
    const notePath = path.posix.join(parentDir, nodeFolderName(node), "index");
    paths.set(node.id, notePath);
    return notePath;
  }

  for (const node of nodes) resolve(node);
  return paths;
}

function nodeWikilink(node, notePaths, linkPrefix) {
  return `[[${path.posix.join(linkPrefix, notePaths.get(node.id))}|${node.title || "Untitled"}]]`;
}

// Replace bare citation tokens with Obsidian wikilinks to Literature notes.
export function linkCitationsInMarkdown(markdown) {
  return String(markdown || "").replace(CITATION_RE, (full, pmid, doi, arxiv) => {
    if (pmid) return `[[${literatureNoteName("pmid", pmid)}]]`;
    if (doi) {
      const clean = doi.replace(/[).]+$/, "");
      return `[[${literatureNoteName("doi", clean)}]]`;
    }
    if (arxiv) return `[[${literatureNoteName("arxiv", arxiv)}]]`;
    return full;
  });
}

function yamlValue(value) {
  if (value === "" || value == null) return '""';
  return JSON.stringify(String(value));
}

export function buildFrontmatter(node, hole, { type, parentTitle }) {
  const lines = [
    "---",
    `rabbithole_id: ${yamlValue(node.id)}`,
    `hole_id: ${yamlValue(hole.hole_id || hole.id)}`,
    `parent_id: ${yamlValue(node.parent_id || "")}`,
    `title: ${yamlValue(node.title || "Untitled")}`,
    `type: ${yamlValue(type)}`,
    "tags: [rabbithole]",
  ];
  if (parentTitle) lines.push(`parent: ${yamlValue(parentTitle)}`);
  if (node.origin?.question) lines.push(`synopsis: ${yamlValue(node.origin.question)}`);
  lines.push("---");
  return lines.join("\n");
}

function nodeType(node) {
  if (node.origin?.branch_type) return node.origin.branch_type;
  if (node.origin?.synthesis) return node.origin.synthesis_mode === "question_map" ? "question_map" : "synthesis";
  if (node.origin?.lens) return `lens:${node.origin.lens}`;
  return "document";
}

function noteBody(node, nodesById, notePaths, citations, linkPrefix) {
  const parent = node.parent_id ? nodesById.get(node.parent_id) : null;
  const children = [...nodesById.values()].filter((n) => n.parent_id === node.id);
  const out = [];
  if (parent) out.push(`Parent: ${nodeWikilink(parent, notePaths, linkPrefix)}`);
  out.push("");
  out.push(CONTENT_START);
  out.push(String(node.markdown || "").trim());
  out.push(CONTENT_END);
  if (children.length) {
    out.push("");
    out.push("Children:");
    for (const child of children) out.push(`- ${nodeWikilink(child, notePaths, linkPrefix)}`);
  }
  if (citations.length) {
    out.push("");
    out.push("Sources:");
    for (const c of citations) out.push(`- [[${path.posix.join(linkPrefix, literatureNoteName(c.kind, c.id))}|${c.label}]] — ${c.url}`);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function literatureNoteContent(citation) {
  const lines = [
    "---",
    `type: literature`,
    `citation_kind: ${yamlValue(citation.kind)}`,
    `citation_id: ${yamlValue(citation.id)}`,
    "tags: [rabbithole, literature]",
    "---",
    `# ${citation.label}`,
    "",
    `External: [${citation.url}](${citation.url})`,
    "",
    "> Linked automatically from a Rabbithole note. Replace this stub with your own annotations.",
  ];
  return lines.join("\n").trim() + "\n";
}

async function removeLegacyFlatNote(holeFolder, node, noteFile) {
  const legacyFile = path.join(holeFolder, `${nodeNoteName(node)}.md`);
  if (path.resolve(legacyFile) === path.resolve(noteFile)) return;
  try {
    const text = await fs.readFile(legacyFile, "utf8");
    if (text.includes(`rabbithole_id: "${node.id}"`)) await fs.rm(legacyFile);
  } catch {}
}

async function collectMarkdownFiles(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectMarkdownFiles(file, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(file);
  }
  return out;
}

async function removeStaleNodeNotes(holeFolder, nodeIds) {
  let removed = 0;
  for (const file of await collectMarkdownFiles(holeFolder)) {
    const text = await fs.readFile(file, "utf8");
    const match = /^rabbithole_id:\s*"([^"]+)"/m.exec(text);
    if (!match || nodeIds.has(match[1])) continue;
    await fs.rm(file);
    removed += 1;
  }
  await removeEmptyDirectories(holeFolder, true);
  return removed;
}

async function removeEmptyDirectories(dir, keep = false) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await removeEmptyDirectories(path.join(dir, entry.name));
  }
  if (!keep) {
    try { await fs.rmdir(dir); } catch {}
  }
}

export async function exportHoleToVault(store, holeId, { vaultPath, folder = "Rabbithole", onWrite = null } = {}) {
  if (!vaultPath) throw new Error("vaultPath is required (path to an existing Obsidian vault)");
  const vaultRoot = path.resolve(vaultPath);
  const folderPath = String(folder || "Rabbithole");
  if (path.isAbsolute(folderPath) || folderPath.split(/[\\/]+/).includes("..")) {
    throw new Error("folder must be a safe relative path inside the Obsidian vault");
  }
  let vaultStat;
  try {
    vaultStat = await fs.stat(vaultRoot);
  } catch {
    throw new Error(`Obsidian vault does not exist: ${vaultRoot}`);
  }
  if (!vaultStat.isDirectory()) throw new Error(`Obsidian vault is not a folder: ${vaultRoot}`);
  try {
    const obsidianStat = await fs.stat(path.join(vaultRoot, ".obsidian"));
    if (!obsidianStat.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Not an Obsidian vault (missing .obsidian folder): ${vaultRoot}`);
  }
  const hole = await store.loadHole(holeId);
  if (!hole) throw new Error(`Hole not found: ${holeId}`);
  const nodes = Array.isArray(hole.nodes) ? hole.nodes : Object.values(hole.nodes || {});
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const notePaths = buildNodeNotePaths(nodes, hole.root_id);

  const holeSlug = slugify(hole.title || "rabbithole");
  const holeFolder = path.join(vaultRoot, folderPath, holeSlug);
  const linkPrefix = path.posix.join(folderPath.replace(/\\/g, "/"), holeSlug);
  const litFolder = path.join(holeFolder, LIT_FOLDER);
  await fs.mkdir(holeFolder, { recursive: true });
  await fs.mkdir(litFolder, { recursive: true });

  const written = [];
  const literature = new Map();

  for (const node of nodes) {
    const citations = extractCitations(node.markdown || "");
    for (const c of citations) literature.set(`${c.kind}:${c.id}`, c);
    const parent = node.parent_id ? nodesById.get(node.parent_id) : null;
    const front = buildFrontmatter(node, hole, { type: nodeType(node), parentTitle: parent?.title });
    const body = noteBody(node, nodesById, notePaths, citations, linkPrefix);
    const file = path.join(holeFolder, `${notePaths.get(node.id)}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await removeLegacyFlatNote(holeFolder, node, file);
    await fs.writeFile(file, `${front}\n\n${body}`, "utf8");
    onWrite?.(file);
    written.push(path.relative(vaultRoot, file));
  }

  for (const c of literature.values()) {
    const file = path.join(litFolder, `${literatureLabel(c.kind, c.id)}.md`);
    await fs.writeFile(file, literatureNoteContent(c), "utf8");
    onWrite?.(file);
    written.push(path.relative(vaultRoot, file));
  }
  const removed = await removeStaleNodeNotes(holeFolder, new Set(nodes.map((node) => String(node.id))));

  return {
    hole_id: hole.hole_id || hole.id,
    title: hole.title || "Rabbithole",
    vault_path: vaultRoot,
    folder: folderPath,
    notes: written.length,
    removed,
    files: written,
  };
}
