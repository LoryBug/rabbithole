import assert from "node:assert/strict";
import { buildSourcesOverview, extractSourcesFromNode } from "../src/core/sources.js";

const root = {
  id: "root",
  title: "Root Review",
  base_url: "https://pubmed.ncbi.nlm.nih.gov/38104516/",
  markdown: [
    "# Root",
    "DOI: 10.1016/j.compbiomed.2023.107777",
    "See [paper](https://doi.org/10.1016/j.compbiomed.2023.107777).",
  ].join("\n"),
};

const branch = {
  id: "branch",
  title: "Branch",
  markdown: "Related method [project](https://example.org/method). arXiv: 2401.01234",
};

const synthesis = {
  id: "synth",
  title: "Question map",
  markdown: "Derived answer without explicit sources.",
  origin: { synthesis: true, synthesis_sources: ["root", "branch"] },
};

const loose = {
  id: "loose",
  title: "Loose idea",
  markdown: "This node has no references.",
};

const direct = extractSourcesFromNode(root);
assert.deepEqual(direct.map((source) => source.key).sort(), [
  "doi:10.1016/j.compbiomed.2023.107777",
  "pmid:38104516",
]);

const overview = buildSourcesOverview([root, branch, synthesis, loose]);
const keys = overview.sources.map((source) => source.key).sort();
assert.deepEqual(keys, [
  "arxiv:2401.01234",
  "doi:10.1016/j.compbiomed.2023.107777",
  "pmid:38104516",
  "url:https://example.org/method",
]);

const pmid = overview.sources.find((source) => source.key === "pmid:38104516");
assert.deepEqual(pmid.node_ids, ["root"]);
assert.deepEqual(pmid.derived_node_ids, ["synth"]);

const derived = overview.derived_nodes.find((node) => node.id === "synth");
assert.deepEqual(derived.source_node_ids, ["root", "branch"]);
assert(derived.source_keys.includes("doi:10.1016/j.compbiomed.2023.107777"));
assert(derived.source_keys.includes("url:https://example.org/method"));

const noSources = overview.nodes_without_sources.map((node) => node.id).sort();
assert.deepEqual(noSources, ["loose", "synth"]);

console.log("stage13 sources verification passed");
