import { buildSourcesOverview } from "../core/sources.js";
import {
  esc,
  flashHint,
  goToNode,
  motionSourceFromEvent,
  nodes,
  truncate,
} from "./core.js";
import { activateFocusTrap } from "./focus-trap.js";

var panel = null;
var body = null;
var open = false;
var releaseTrap = null;

export function initSourcesPanel(){
  panel = document.getElementById("sources-panel");
  body = document.getElementById("sources-body");
  document.getElementById("r-sources").addEventListener("click", function(e){ toggleSourcesPanel(motionSourceFromEvent(e)); });
  document.getElementById("t-sources").addEventListener("click", function(e){ toggleSourcesPanel(motionSourceFromEvent(e)); });
  document.getElementById("sources-close").addEventListener("click", closeSourcesPanel);
  panel.addEventListener("click", onPanelClick);
}

export function closeSourcesPanel(){
  open = false;
  if (panel) {
    panel.classList.remove("visible");
    panel.setAttribute("aria-hidden", "true");
  }
  if (releaseTrap){ releaseTrap(); releaseTrap = null; }
}

function toggleSourcesPanel(source){
  if (open){ closeSourcesPanel(); return; }
  renderSourcesPanel(source);
  open = true;
  panel.classList.add("visible");
  panel.setAttribute("aria-hidden", "false");
  if (releaseTrap) releaseTrap();
  releaseTrap = activateFocusTrap(panel, { initialFocus: panel.querySelector("button"), onEscape: closeSourcesPanel });
}

function renderSourcesPanel(source){
  var overview = buildSourcesOverview(nodes);
  var html = "";
  html += renderSources(overview.sources);
  html += renderDerived(overview.derived_nodes);
  html += renderUnsourced(overview.nodes_without_sources);
  body.innerHTML = html || '<div class="sources-empty">No nodes yet.</div>';
  body.dataset.source = source || "pointer";
}

function renderSources(sources){
  if (!sources.length) return '<div class="sources-section"><h4>Sources</h4><div class="sources-empty">No explicit sources found yet. Add PMID, DOI, arXiv, URLs, markdown links, or node base_url values.</div></div>';
  var html = '<div class="sources-section"><h4>Sources (' + sources.length + ')</h4>';
  for (var i = 0; i < sources.length; i++){
    var source = sources[i];
    var direct = source.node_ids || [];
    var derived = source.derived_node_ids || [];
    html += '<div class="source-card">';
    html += '<div class="source-main"><span class="source-type">' + esc(source.type) + '</span>';
    html += source.url ? '<a class="source-label source-link" href="' + esc(source.url) + '" target="_blank" rel="noreferrer">' + esc(source.label) + '</a>' : '<span class="source-label">' + esc(source.label) + '</span>';
    html += '</div>';
    html += '<div class="source-meta">Used directly by ' + direct.length + ' node' + (direct.length === 1 ? '' : 's') + (derived.length ? ', inherited by ' + derived.length + ' derived node' + (derived.length === 1 ? '' : 's') : '') + '.</div>';
    html += nodeButtons(direct, 'Direct') + nodeButtons(derived, 'Derived');
    html += '</div>';
  }
  return html + '</div>';
}

function renderDerived(derived){
  if (!derived.length) return "";
  var html = '<div class="sources-section"><h4>Derived Nodes</h4>';
  for (var i = 0; i < derived.length; i++){
    var node = derived[i];
    html += '<div class="source-node-card">';
    html += '<button class="source-node" data-node="' + esc(node.id) + '">' + esc(truncate(node.title || "Untitled", 54)) + '</button>';
    html += '<div class="source-meta">Derived from ' + node.source_node_ids.length + ' selected node' + (node.source_node_ids.length === 1 ? '' : 's') + ' and ' + node.source_keys.length + ' source' + (node.source_keys.length === 1 ? '' : 's') + '.</div>';
    html += nodeButtons(node.source_node_ids, 'Source nodes');
    html += '</div>';
  }
  return html + '</div>';
}

function renderUnsourced(nodesWithoutSources){
  if (!nodesWithoutSources.length) return "";
  var html = '<div class="sources-section"><h4>No Explicit Sources (' + nodesWithoutSources.length + ')</h4>';
  html += '<div class="source-node-list">';
  for (var i = 0; i < nodesWithoutSources.length; i++){
    var node = nodesWithoutSources[i];
    html += '<button class="source-node" data-node="' + esc(node.id) + '">' + esc(truncate(node.title || "Untitled", 42)) + '</button>';
  }
  return html + '</div></div>';
}

function nodeButtons(ids, label){
  if (!ids || !ids.length) return "";
  var html = '<div class="source-meta">' + esc(label) + '</div><div class="source-node-list">';
  for (var i = 0; i < ids.length; i++){
    var node = nodes[ids[i]];
    if (!node) continue;
    html += '<button class="source-node" data-node="' + esc(node.id) + '">' + esc(truncate(node.title || "Untitled", 42)) + '</button>';
  }
  return html + '</div>';
}

function onPanelClick(e){
  var btn = e.target.closest && e.target.closest("button[data-node]");
  if (!btn) return;
  var node = nodes[btn.dataset.node];
  if (!node){ flashHint("That node is no longer available."); return; }
  closeSourcesPanel();
  goToNode(node, body.dataset.source || "pointer");
}
