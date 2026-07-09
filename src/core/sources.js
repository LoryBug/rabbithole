const URL_RE = /https?:\/\/[^\s)<>'"]+/gi;
const PMID_RE = /(?:\bPMID\s*:?\s*|pubmed\.ncbi\.nlm\.nih\.gov\/)(\d{5,9})/gi;
const DOI_RE = /(?:\bDOI\s*:?\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,9}\/[^\s\])<>'"`]+)/gi;
const ARXIV_RE = /(?:\barXiv\s*:?\s*|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+\/\d{7}(?:v\d+)?)/gi;

export function buildSourcesOverview(inputNodes) {
  const nodeList = normalizeNodeList(inputNodes);
  const byId = new Map(nodeList.map((node) => [node.id, node]));
  const sources = new Map();
  const directByNode = new Map();

  for (const node of nodeList) {
    const keys = new Set();
    const add = (source) => {
      if (!source) return;
      keys.add(source.key);
      upsertSource(sources, source, node.id, "direct");
    };
    for (const source of extractSourcesFromNode(node)) add(source);
    directByNode.set(node.id, keys);
  }

  const derivedNodes = [];
  for (const node of nodeList) {
    const sourceIds = Array.isArray(node.origin?.synthesis_sources) ? node.origin.synthesis_sources : [];
    if (!sourceIds.length) continue;
    const derivedKeys = new Set();
    for (const sourceId of sourceIds) {
      for (const key of directByNode.get(String(sourceId)) || []) derivedKeys.add(key);
    }
    for (const key of derivedKeys) {
      const source = sources.get(key);
      if (source) addUnique(source.derived_node_ids, node.id);
    }
    derivedNodes.push({
      id: node.id,
      title: node.title,
      source_node_ids: sourceIds.filter((id) => byId.has(String(id))).map(String),
      source_keys: [...derivedKeys].sort(),
    });
  }

  const nodesWithoutSources = nodeList
    .filter((node) => !(directByNode.get(node.id) || new Set()).size)
    .map((node) => ({ id: node.id, title: node.title }));

  return {
    sources: [...sources.values()].sort(compareSources),
    nodes_without_sources: nodesWithoutSources,
    derived_nodes: derivedNodes,
  };
}

export function extractSourcesFromNode(rawNode) {
  const node = normalizeNode(rawNode);
  const text = [node.base_url || "", node.markdown || ""].join("\n");
  const found = new Map();
  const add = (source) => { if (source) found.set(source.key, source); };

  scan(PMID_RE, text, (match) => add(pmidSource(match[1])));
  scan(DOI_RE, text, (match) => add(doiSource(cleanDoi(match[1]))));
  scan(ARXIV_RE, text, (match) => add(arxivSource(match[1])));
  scan(URL_RE, text, (match) => add(urlSource(match[0])));

  return [...found.values()].sort(compareSources);
}

function normalizeNodeList(inputNodes) {
  const raw = Array.isArray(inputNodes) ? inputNodes : Object.values(inputNodes || {});
  return raw.map(normalizeNode).filter((node) => node.id);
}

function normalizeNode(node) {
  return {
    id: String(node?.id || ""),
    title: String(node?.title || "Untitled"),
    markdown: String(node?.markdown ?? node?.md ?? ""),
    base_url: node?.base_url || null,
    origin: node?.origin || null,
  };
}

function scan(re, text, cb) {
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(text))) cb(match);
}

function upsertSource(map, source, nodeId, kind) {
  const current = map.get(source.key) || {
    ...source,
    node_ids: [],
    derived_node_ids: [],
  };
  addUnique(kind === "derived" ? current.derived_node_ids : current.node_ids, nodeId);
  map.set(source.key, current);
}

function addUnique(list, value) {
  const v = String(value || "");
  if (v && !list.includes(v)) list.push(v);
}

function pmidSource(value) {
  const pmid = String(value || "").replace(/\D/g, "");
  if (!pmid) return null;
  return { key: `pmid:${pmid}`, type: "pmid", label: `PMID: ${pmid}`, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` };
}

function doiSource(value) {
  const doi = cleanDoi(value);
  if (!doi) return null;
  return { key: `doi:${doi.toLowerCase()}`, type: "doi", label: `DOI: ${doi}`, url: `https://doi.org/${doi}` };
}

function arxivSource(value) {
  const id = stripTrailing(String(value || ""));
  if (!id) return null;
  return { key: `arxiv:${id.toLowerCase()}`, type: "arxiv", label: `arXiv: ${id}`, url: `https://arxiv.org/abs/${id}` };
}

function urlSource(value) {
  const url = stripTrailing(String(value || ""));
  if (!url) return null;
  const pmid = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,9})/i.exec(url);
  if (pmid) return pmidSource(pmid[1]);
  const doi = /(?:dx\.)?doi\.org\/(10\.\d{4,9}\/.+)/i.exec(url);
  if (doi) return doiSource(doi[1]);
  const arxiv = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+\/\d{7}(?:v\d+)?)/i.exec(url);
  if (arxiv) return arxivSource(arxiv[1]);
  return { key: `url:${url}`, type: "url", label: url.replace(/^https?:\/\//, ""), url };
}

function cleanDoi(value) {
  return stripTrailing(String(value || "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ""));
}

function stripTrailing(value) {
  return String(value || "").trim().replace(/[.,;:!?]+$/g, "").replace(/\)+$/g, "");
}

function compareSources(a, b) {
  return `${a.type}:${a.label}`.localeCompare(`${b.type}:${b.label}`);
}
