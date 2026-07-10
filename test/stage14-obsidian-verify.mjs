import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultFsStore } from "../src/node/fs-store.js";
import { exportHoleToVault, extractCitations, linkCitationsInMarkdown, literatureNoteName, nodeNoteName, slugify } from "../src/node/obsidian-export.js";
import { startVaultWatch, stopVaultWatch } from "../src/node/obsidian-sync.js";
import { toPersistedHole } from "../src/core/schema.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-obsidian-"));
const previousStoreDir = process.env.RABBITHOLE_DIR;
process.env.RABBITHOLE_DIR = path.join(tmp, "rabbithole-store");

try {
  // ---- unit: citation extraction + wikilink rewrite ----
  const md = "See PMID: 38104516 and DOI:10.1016/j.compbiomed.2023.107777 and arXiv:2401.01234.";
  const cites = extractCitations(md);
  assert.equal(cites.length, 3);
  assert.ok(cites.some((c) => c.kind === "pmid" && c.id === "38104516"));
  assert.ok(cites.some((c) => c.kind === "doi" && c.id === "10.1016/j.compbiomed.2023.107777"));
  assert.ok(cites.some((c) => c.kind === "arxiv" && c.id === "2401.01234"));
  const linked = linkCitationsInMarkdown(md);
  assert.ok(linked.includes(`[[${literatureNoteName("pmid", "38104516")}]]`));
  assert.ok(linked.includes(`[[${literatureNoteName("doi", "10.1016/j.compbiomed.2023.107777")}]]`));
  assert.equal(slugify("CBIR polmonare: valutazione!"), "cbir-polmonare-valutazione");

  // ---- integration: export a hole into a temp vault ----
  const holeId = "obs-test-hole-0001";
  const rootId = "node-root";
  const childId = "node-child";
  const hole = toPersistedHole({
    hole_id: holeId,
    title: "Obsidian Sync Test",
    root_id: rootId,
    nodes: [
      {
        id: rootId,
        parent_id: "",
        title: "Root node",
        markdown: "# Root node\n\nIntro with PMID: 38104516 reference.",
        origin: null,
      },
      {
        id: childId,
        parent_id: rootId,
        title: "Child node",
        markdown: "# Child node\n\nLinks to DOI:10.1016/j.compbiomed.2023.107777.",
        origin: { branch_type: "followup", question: "Why?" },
      },
    ],
  });
  await defaultFsStore.saveHole(hole);

  const vaultPath = path.join(tmp, "vault");
  await fs.mkdir(vaultPath, { recursive: true });
  await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true }); // make it look like a vault

  const result = await exportHoleToVault(defaultFsStore, holeId, { vaultPath, folder: "Rabbithole" });
  // 2 nodes + 2 literature notes = 4 files
  assert.equal(result.notes, 4);
  assert.equal(result.files.length, 4);

  const rootFile = path.join(vaultPath, "Rabbithole", "obsidian-sync-test", `${nodeNoteName(hole.nodes[0])}.md`);
  const childFile = path.join(vaultPath, "Rabbithole", "obsidian-sync-test", `${nodeNoteName(hole.nodes[1])}.md`);
  const litPmid = path.join(vaultPath, "Rabbithole", "obsidian-sync-test", "Literature", "PMID 38104516.md");
  const litDoi = path.join(vaultPath, "Rabbithole", "obsidian-sync-test", "Literature", "DOI 10.1016-j.compbiomed.2023.107777.md");
  for (const f of [rootFile, childFile, litPmid, litDoi]) {
    await fs.access(f);
  }

  const rootText = await fs.readFile(rootFile, "utf8");
  assert.match(rootText, /rabbithole_id: "node-root"/);
  assert.match(rootText, /hole_id: "obs-test-hole-0001"/);
  assert.match(rootText, /tags: \[rabbithole\]/);
  assert.ok(rootText.includes("<!-- rabbithole:content:start -->"));
  assert.ok(rootText.includes("<!-- rabbithole:content:end -->"));
  assert.ok(rootText.includes(`[[${nodeNoteName(hole.nodes[1])}|Child node]]`));
  assert.ok(rootText.includes(`[[${literatureNoteName("pmid", "38104516")}]]`));

  const childText = await fs.readFile(childFile, "utf8");
  assert.match(childText, /parent_id: "node-root"/);
  assert.ok(childText.includes(`Parent: [[${nodeNoteName(hole.nodes[0])}|Root node]]`));
  assert.ok(childText.includes(`[[${literatureNoteName("doi", "10.1016/j.compbiomed.2023.107777")}]]`));

  const litText = await fs.readFile(litPmid, "utf8");
  assert.match(litText, /type: literature/);
  assert.ok(litText.includes("https://pubmed.ncbi.nlm.nih.gov/38104516/"));

  // ---- two-way: editing a note re-imports into the node ----
  startVaultWatch({ vaultPath, folder: "Rabbithole", store: defaultFsStore });
  await fs.writeFile(rootFile, rootText.replace("Intro with", "EDITED intro with"), "utf8");

  // wait for debounced reimport
  await new Promise((r) => setTimeout(r, 900));
  const reloaded = await defaultFsStore.loadHole(holeId);
  const reloadedRoot = (Array.isArray(reloaded.nodes) ? reloaded.nodes : Object.values(reloaded.nodes)).find((n) => n.id === rootId);
  assert.ok(reloadedRoot.markdown.includes("EDITED intro with"), "edit should flow back into the node");
  assert.ok(!reloadedRoot.markdown.includes("Parent:"), "generated navigation must not re-import into node markdown");
  assert.ok(!reloadedRoot.markdown.includes("rabbithole:content"), "sync markers must not re-import into node markdown");
  stopVaultWatch();

  console.log("stage14 obsidian integration verification passed");
} finally {
  if (previousStoreDir == null) delete process.env.RABBITHOLE_DIR;
  else process.env.RABBITHOLE_DIR = previousStoreDir;
  stopVaultWatch();
  await fs.rm(tmp, { recursive: true, force: true });
}
