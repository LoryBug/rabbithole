import { CANVAS_SHELL } from "../core/html/shell.js";
import { createBrain, defaultBrainSettings, presetFor, settingsForPreset, BRAIN_PRESETS } from "./brain/index.js";
import { IdbStore } from "./store/idb-store.js";
import { DirectRabbitholeHost, createHoleFromMarkdown, titleFromMarkdown } from "./transport/direct-host.js";
import { startRabbithole } from "../ui/entry.js";
import { activateFocusTrap } from "../ui/focus-trap.js";
import { renderMarkdownToHtml } from "../ui/renderer.js";
import { setSnapshotHooks, buildSnapshotHydration, buildSnapshotHtml, buildSnapshotJson } from "../ui/snapshot.js";
import { openUrlToStoredHole } from "./ingest/url.js";
import { downloadRabbitholeExport, importRabbitholeFile, importSessionJsonFile, rabbitholeFilename } from "./portable.js";
import { testedModelHint } from "./brain/tested-models.js";

const SETTINGS_KEY = "rh-web-settings";
const KEY_KEY = "rh-web-api-key";
const LAST_HOLE_KEY = "rh-last-hole";
const RAIL_KEY = "rh-rail-open";
const AGENT_COMMAND = "claude mcp add rabbithole -- npx -y github:shlokkhemani/rabbithole";
const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";
const OPENROUTER_KEY_CHECK_URL = "https://openrouter.ai/api/v1/key";
const DEFAULT_FETCH_PROXY_URL =
  typeof __RABBITHOLE_DEFAULT_PROXY_URL__ === "string" ? __RABBITHOLE_DEFAULT_PROXY_URL__ : "";

const INTENTS = Object.freeze({
  ask: { id: "ask", label: "Ask", primary: "Ask" },
  document: { id: "document", label: "Open as document", primary: "Open document" },
  url: { id: "url", label: "Open URL", primary: "Open URL" },
});

const EXAMPLE_QUESTIONS = [
  "How do rockets land themselves?",
  "Explain the attention mechanism",
  "What actually happens in a black hole?",
];

const store = new IdbStore();
let memoryKey = "";
let currentHost = null;
let currentHoleId = null;
let uiStarted = false;
let railOpen = false;
let blankZoom = 1;
let composerTrap = null;
let settingsTrap = null;
let composerIntentOverride = "";
let composerAbortController = null;
let composerStreamingHoleId = "";
let pendingComposerAction = null;
let pendingBranchRetry = null;
let lastHoleCount = 0;

applyInitialWebTheme();

boot().catch((err) => {
  document.body.innerHTML = `<main class="web-fatal"><h1>Rabbithole</h1><p>${escapeHtml(err?.message || String(err))}</p></main>`;
});

async function boot() {
  document.body.classList.add("web-app");
  renderShell();
  initAppChrome();
  initComposer();
  initSettingsModal();
  initGlobalDrops();

  const initial = await chooseInitialHole();
  await renderRail();
  if (initial) {
    await startHole(initial, { replace: true });
  } else {
    showBlankCanvas({ openComposer: true });
  }
  exposeTestApi();
}

function renderShell() {
  document.documentElement.classList.remove("web-home-active");
  document.documentElement.classList.add("web-canvas-active");
  document.body.classList.add("mode-canvas", "web-shell");
  document.body.innerHTML = `<div id="canvas-root">${CANVAS_SHELL}</div>
    <aside id="web-rail" class="web-rail" aria-label="Rabbitholes" tabindex="-1"></aside>
    <div id="composer-modal" class="composer-modal" role="dialog" aria-modal="true" aria-labelledby="composer-title" hidden>
      <div class="composer-card" id="composer-card">
        <div class="composer-question" id="composer-question" hidden></div>
        <textarea id="composer-input" rows="1" placeholder="What do you want to understand?" autocomplete="off" spellcheck="true"></textarea>
        <div class="composer-subline">Paste a doc or URL — or drop a PDF anywhere</div>
        <div class="intent-row" role="group" aria-label="Intent">
          ${Object.values(INTENTS).map((intent) => `<button class="intent-chip" type="button" data-intent="${intent.id}" aria-pressed="false">${escapeHtml(intent.label)}</button>`).join("")}
          <label class="intent-chip improve-chip" id="improve-chip" hidden>
            <input id="composer-improve" type="checkbox">
            <span>Improve structure</span>
          </label>
        </div>
        <div id="composer-examples" class="composer-examples" hidden></div>
        <div id="composer-key-panel" class="inline-key-slot" hidden></div>
        <div id="composer-stream" class="composer-stream" hidden>
          <div id="composer-stream-doc" class="composer-stream-doc md" aria-live="polite"></div>
        </div>
        <div id="ingest-status" class="ingest-status" aria-live="polite" aria-atomic="true"></div>
        <div class="composer-actions">
          <label class="file-pick" for="file-md">
            <input id="file-md" type="file" accept=".md,.markdown,.pdf,.rabbithole,.json,text/markdown,text/plain,application/pdf,application/json">
            <span>Choose file</span>
          </label>
          <button id="composer-primary" class="web-primary" type="button">Ask</button>
        </div>
      </div>
    </div>
    <div id="blank-start-hint" class="blank-start-hint" hidden>Press N to start a new Rabbithole</div>
    <div id="web-settings-modal" class="web-settings-modal" role="dialog" aria-modal="true" aria-label="Provider settings" hidden>
      <div class="web-settings-dialog">
        <button id="web-settings-close" class="web-close" type="button">Close</button>
        <div id="settings-inline-key" class="settings-inline-key" hidden></div>
        <section id="settings-panel" class="settings-panel expanded"></section>
      </div>
    </div>
    <div id="web-toast" class="web-toast" aria-live="polite"></div>`;
  railOpen = loadRailOpen();
  applyRailState();
}

async function chooseInitialHole() {
  const hashHole = holeIdFromHash();
  if (hashHole) {
    const hole = await store.loadHole(hashHole);
    if (hole) return hole;
  }
  const storedId = safeLocalStorageGet(LAST_HOLE_KEY);
  if (storedId && storedId !== hashHole) {
    const stored = await store.loadHole(storedId);
    if (stored) return stored;
  }
  const holes = await store.listHoles();
  lastHoleCount = holes.length;
  if (!holes.length) return null;
  return store.loadHole(holes[0].hole_id);
}

function initAppChrome() {
  const rail = document.getElementById("web-rail");
  document.getElementById("t-rail")?.addEventListener("click", () => toggleRail());
  document.getElementById("t-new")?.addEventListener("click", () => openComposer({ source: "button" }));
  document.getElementById("t-settings")?.addEventListener("click", () => openSettingsModal());
  rail?.addEventListener("click", async (event) => {
    const row = event.target?.closest?.(".rail-row");
    if (!row) return;
    const id = row.dataset.hole;
    if (event.target.closest(".rail-delete")) {
      event.preventDefault();
      event.stopPropagation();
      await deleteHoleFromRail(id);
      return;
    }
    if (event.target.closest(".rail-export")) {
      event.preventDefault();
      event.stopPropagation();
      await exportHoleFromRail(id);
      return;
    }
    if (event.target.closest(".rail-open")) {
      event.preventDefault();
      if (!id || id === currentHoleId) return;
      await currentHost?.flushSave();
      const hole = await store.loadHole(id);
      if (hole) await startHole(hole);
    }
  });
  document.getElementById("t-theme")?.addEventListener("click", () => {
    if (currentHoleId) return;
    toggleBlankTheme();
  });
  document.getElementById("t-zin")?.addEventListener("click", () => {
    if (!currentHoleId) setBlankZoom(blankZoom * 1.15);
  });
  document.getElementById("t-zout")?.addEventListener("click", () => {
    if (!currentHoleId) setBlankZoom(blankZoom * 0.87);
  });
  document.getElementById("zoom-label")?.addEventListener("click", () => {
    if (!currentHoleId) setBlankZoom(1);
  });
  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return;
    if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      openComposer({ source: "keyboard" });
    } else if (event.key === "s" || event.key === "S") {
      event.preventDefault();
      toggleRail();
    }
  });
}

function initComposer() {
  const modal = document.getElementById("composer-modal");
  const input = document.getElementById("composer-input");
  const primary = document.getElementById("composer-primary");
  const fileInput = document.getElementById("file-md");

  input.addEventListener("input", () => {
    autoGrowTextarea(input, 240);
    updateComposerIntent();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      runComposer();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeComposer();
    }
  });
  primary.addEventListener("click", runComposer);
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (file) await createFromFile(file);
    fileInput.value = "";
  });
  modal.querySelectorAll(".intent-chip[data-intent]").forEach((button) => {
    button.addEventListener("click", () => {
      composerIntentOverride = button.dataset.intent;
      updateComposerIntent();
    });
  });
  for (const type of ["dragenter", "dragover"]) {
    modal.addEventListener(type, (event) => {
      event.preventDefault();
      modal.classList.add("dragging");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    modal.addEventListener(type, (event) => {
      event.preventDefault();
      modal.classList.remove("dragging");
    });
  }
  modal.addEventListener("drop", async (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) await createFromFile(file);
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeComposer();
  });
}

function initGlobalDrops() {
  const viewport = document.getElementById("viewport");
  for (const type of ["dragenter", "dragover"]) {
    viewport.addEventListener(type, (event) => {
      if (currentHoleId || !event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      document.body.classList.add("blank-dragging");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    viewport.addEventListener(type, (event) => {
      if (currentHoleId) return;
      event.preventDefault();
      document.body.classList.remove("blank-dragging");
    });
  }
  viewport.addEventListener("drop", async (event) => {
    if (currentHoleId) return;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    openComposer({ source: "drop" });
    await createFromFile(file);
  });
}

function openComposer({ source = "button", value = "" } = {}) {
  const modal = document.getElementById("composer-modal");
  const input = document.getElementById("composer-input");
  const examples = document.getElementById("composer-examples");
  const hint = document.getElementById("blank-start-hint");

  pendingComposerAction = null;
  composerIntentOverride = "";
  setIngestStatus("");
  clearComposerKeyPanel();
  resetComposerStreaming();
  document.getElementById("composer-question").hidden = true;
  document.getElementById("composer-stream").hidden = true;
  document.getElementById("composer-input").hidden = false;
  document.querySelector(".composer-subline").hidden = false;
  document.querySelector(".intent-row").hidden = false;
  document.querySelector(".composer-actions").hidden = false;
  input.value = value;
  autoGrowTextarea(input, 240);
  renderComposerExamples();
  examples.hidden = lastHoleCount !== 0 || source !== "empty";
  modal.hidden = false;
  hint.hidden = true;
  updateComposerIntent();
  if (composerTrap) composerTrap();
  composerTrap = activateFocusTrap(modal, {
    initialFocus: input,
    onEscape: closeComposer,
  });
  input.focus({ preventScroll: true });
}

function closeComposer() {
  if (composerAbortController) {
    composerAbortController.abort();
    cleanupStreamingHole();
  }
  const modal = document.getElementById("composer-modal");
  modal.hidden = true;
  modal.classList.remove("dragging", "streaming");
  pendingComposerAction = null;
  clearComposerKeyPanel();
  if (composerTrap) {
    composerTrap();
    composerTrap = null;
  }
  if (!currentHoleId && lastHoleCount === 0) {
    document.getElementById("blank-start-hint").hidden = false;
  }
}

function renderComposerExamples() {
  const examples = document.getElementById("composer-examples");
  examples.innerHTML = EXAMPLE_QUESTIONS.map((question) =>
    `<button type="button" class="example-chip">${escapeHtml(question)}</button>`
  ).join("");
  examples.querySelectorAll(".example-chip").forEach((button) => {
    button.addEventListener("click", () => {
      document.getElementById("composer-input").value = button.textContent.trim();
      composerIntentOverride = "ask";
      autoGrowTextarea(document.getElementById("composer-input"), 240);
      updateComposerIntent();
      document.getElementById("composer-input").focus();
    });
  });
}

function updateComposerIntent() {
  const input = document.getElementById("composer-input");
  const inferred = inferIntent(input.value);
  const active = composerIntentOverride || inferred;
  document.querySelectorAll(".intent-chip[data-intent]").forEach((button) => {
    const isActive = button.dataset.intent === active;
    button.classList.toggle("active", isActive);
    button.classList.toggle("inferred", button.dataset.intent === inferred);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  document.getElementById("improve-chip").hidden = active !== "document";
  document.getElementById("composer-primary").textContent = INTENTS[active]?.primary || "Ask";
}

function inferIntent(value) {
  const text = String(value || "").trim();
  if (isSingleHttpUrl(text)) return "url";
  if (looksLikeDocument(text)) return "document";
  return "ask";
}

async function runComposer() {
  const input = document.getElementById("composer-input");
  const value = input.value.trim();
  const intent = document.querySelector(".intent-chip.active")?.dataset.intent || inferIntent(value);
  if (intent === "url") return createFromUrl(value);
  if (intent === "document") return createFromComposerDocument(value);
  return createFromAsk(value);
}

async function createFromComposerDocument(markdown) {
  if (!markdown) {
    setIngestStatus("Paste a document first.", "error");
    return;
  }
  const action = () => createFromComposerDocument(markdown);
  if (shouldImproveStructure() && !(await ensureKeyForComposerAction(action))) return;
  try {
    const authored = await maybeAuthorMarkdown({
      title: "",
      markdown,
      sourceName: "pasted text",
      kind: "paste",
    });
    const hole = createHoleFromMarkdown({ title: "", markdown: authored });
    await store.saveHole(hole);
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(`Document import failed. ${err?.message || String(err)}`, "error");
  }
}

async function createFromAsk(question) {
  if (!question) {
    setIngestStatus("Ask a question first.", "error");
    return;
  }
  const action = () => createFromAsk(question);
  if (!(await ensureKeyForComposerAction(action))) return;

  const settings = loadSettings();
  const key = getApiKey(settings);
  const brain = createBrain(settings, key);
  const controller = new AbortController();
  composerAbortController = controller;
  composerStreamingHoleId = "";

  const modal = document.getElementById("composer-modal");
  const questionEl = document.getElementById("composer-question");
  const stream = document.getElementById("composer-stream");
  const streamDoc = document.getElementById("composer-stream-doc");
  modal.classList.add("streaming");
  questionEl.hidden = false;
  questionEl.textContent = question;
  stream.hidden = false;
  streamDoc.innerHTML = "";
  document.getElementById("composer-input").hidden = true;
  document.querySelector(".composer-subline").hidden = true;
  document.querySelector(".intent-row").hidden = true;
  document.querySelector(".composer-actions").hidden = true;
  setIngestStatus("Writing the root document...", "busy");

  let markdown = "";
  let hole = null;
  try {
    for await (const chunk of brain.authorExplainer({ question }, controller.signal)) {
      if (controller.signal.aborted) return;
      markdown += chunk;
      renderComposerStream(markdown);
      if (!hole && markdown.trim()) {
        hole = createHoleFromMarkdown({ title: "", markdown });
        composerStreamingHoleId = hole.hole_id;
        await store.saveHole(hole);
      }
    }
    if (!markdown.trim()) throw new Error("The provider returned an empty document.");
    if (!hole) {
      hole = createHoleFromMarkdown({ title: "", markdown });
      composerStreamingHoleId = hole.hole_id;
    }
    updateHoleRootMarkdown(hole, markdown);
    await store.saveHole(hole);
    setIngestStatus("");
    composerStreamingHoleId = "";
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    if (controller.signal.aborted) return;
    await cleanupStreamingHole();
    const message = err?.message || String(err);
    if (isAuthLikeError(err)) {
      showComposerKeyPanel({
        message,
        afterValidated: action,
      });
    } else {
      setIngestStatus(`Ask failed. ${message}`, "error");
    }
  } finally {
    if (composerAbortController === controller) composerAbortController = null;
  }
}

function renderComposerStream(markdown) {
  const streamDoc = document.getElementById("composer-stream-doc");
  streamDoc.innerHTML = `${renderMarkdownToHtml(markdown)}<span class="stream-caret" aria-hidden="true"></span>`;
  const stream = document.getElementById("composer-stream");
  stream.scrollTop = stream.scrollHeight;
}

function updateHoleRootMarkdown(hole, markdown) {
  const title = titleFromMarkdown(markdown) || hole.title || "Untitled";
  hole.title = title;
  const root = hole.nodes?.find((node) => node.id === hole.root_id) || hole.nodes?.[0];
  if (root) {
    root.title = title;
    root.markdown = markdown;
    root.status = "answered";
    root.read = true;
  }
}

async function cleanupStreamingHole() {
  const id = composerStreamingHoleId;
  composerStreamingHoleId = "";
  if (!id) return;
  try { await store.deleteHole(id); } catch {}
  await renderRail();
}

function resetComposerStreaming() {
  if (composerAbortController) {
    composerAbortController.abort();
    composerAbortController = null;
  }
  composerStreamingHoleId = "";
  document.getElementById("composer-modal")?.classList.remove("streaming");
}

async function createFromUrl(rawUrl) {
  if (!rawUrl) {
    setIngestStatus("Enter a URL first.", "error");
    return;
  }
  try {
    const settings = loadSettings();
    setIngestStatus("Fetching URL...", "busy");
    const { hole } = await openUrlToStoredHole({
      rawUrl,
      store,
      title: "",
      proxyBaseUrl: settings.fetch_proxy_url || "",
      onProgress: (progress) => {
        if (progress.phase === "fetch") setIngestStatus(`Fetching URL via ${progress.via}...`, "busy");
        else if (progress.phase === "page") setIngestStatus(`Importing PDF page ${progress.index}/${progress.total}...`, "busy");
      },
    });
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(err?.message || String(err), "error");
  }
}

async function createFromFile(file) {
  if (isRabbitholeFile(file)) return createFromRabbitholeFile(file);
  if (isSessionJsonFile(file)) return createFromSessionJsonFile(file);
  if (isPdfFile(file)) return createFromPdfFile(file);
  if (!isMarkdownFile(file)) {
    setIngestStatus("Choose a markdown, PDF, .rabbithole, or session JSON file.", "error");
    return;
  }
  const action = () => createFromFile(file);
  if (shouldImproveStructure() && !(await ensureKeyForComposerAction(action))) return;
  try {
    setIngestStatus("Reading markdown file...", "busy");
    const markdown = await file.text();
    const authored = await maybeAuthorMarkdown({
      title: file.name.replace(/\.[^.]+$/, ""),
      markdown,
      sourceName: file.name,
      kind: "file",
    });
    const hole = createHoleFromMarkdown({ title: "", markdown: authored });
    await store.saveHole(hole);
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(`Markdown import failed. ${err?.message || String(err)}`, "error");
  }
}

async function createFromSessionJsonFile(file) {
  try {
    setIngestStatus("Importing Rabbithole session JSON...", "busy");
    const imported = await importSessionJsonFile(store, file);
    setIngestStatus("");
    const hole = await store.loadHole(imported.hole_id);
    if (!hole) throw new Error("Imported session JSON could not be loaded.");
    await startHole(hole);
  } catch (err) {
    setIngestStatus(err?.message || String(err), "error");
  }
}

async function createFromRabbitholeFile(file) {
  try {
    setIngestStatus("Importing Rabbithole file...", "busy");
    const imported = await importRabbitholeFile(store, file);
    setIngestStatus("");
    const hole = await store.loadHole(imported.hole_id);
    if (!hole) throw new Error("Imported file could not be loaded.");
    await startHole(hole);
  } catch (err) {
    setIngestStatus(err?.message || String(err), "error");
  }
}

async function createFromPdfFile(file) {
  try {
    const { ingestPdfToStoredHole } = await import("./ingest/pdf.js");
    setIngestStatus("Loading PDF importer...", "busy");
    const { hole } = await ingestPdfToStoredHole({
      source: file,
      store,
      title: "",
      onProgress: ({ page, index, total }) => {
        if (page) setIngestStatus(`Importing PDF page ${index}/${total}...`, "busy");
      },
    });
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(`PDF import failed. ${err?.message || String(err)} Paste the text manually or drop a different PDF.`, "error");
  }
}

async function maybeAuthorMarkdown({ title = "", markdown = "", sourceName = "", kind = "source", baseUrl = "" } = {}) {
  if (!shouldImproveStructure()) return markdown;
  const settings = loadSettings();
  const key = getApiKey(settings);
  setIngestStatus("Improving structure with the author model...", "busy");
  const brain = createBrain(settings, key);
  const controller = new AbortController();
  let out = "";
  for await (const chunk of brain.authorDocument({
    title,
    markdown,
    source_name: sourceName,
    kind,
    base_url: baseUrl,
  }, controller.signal)) {
    out += chunk;
    if (out.length) setIngestStatus(`Improving structure... ${out.length.toLocaleString()} characters`, "busy");
  }
  return out.trim() || markdown;
}

function shouldImproveStructure() {
  return document.getElementById("composer-improve")?.checked === true &&
    !document.getElementById("improve-chip")?.hidden;
}

async function ensureKeyForComposerAction(action) {
  const settings = loadSettings();
  const preset = presetFor(settings.preset);
  if (!preset.requires_key || getApiKey(settings)) return true;
  pendingComposerAction = action;
  showComposerKeyPanel({
    message: shouldImproveStructure()
      ? "Improve structure uses your model key."
      : "Ask uses your model key.",
    afterValidated: action,
  });
  return false;
}

function showComposerKeyPanel({ message = "", afterValidated = null } = {}) {
  const slot = document.getElementById("composer-key-panel");
  slot.hidden = false;
  renderInlineKeyPanel(slot, {
    idPrefix: "composer",
    message,
    afterValidated: async () => {
      slot.hidden = true;
      pendingComposerAction = null;
      await afterValidated?.();
    },
  });
}

function clearComposerKeyPanel() {
  const slot = document.getElementById("composer-key-panel");
  if (slot) {
    slot.hidden = true;
    slot.innerHTML = "";
  }
}

async function startHole(hole, { replace = false } = {}) {
  if (uiStarted) {
    await currentHost?.flushSave();
    location.hash = `hole=${encodeURIComponent(hole.hole_id)}`;
    location.reload();
    return;
  }
  uiStarted = true;
  currentHoleId = hole.hole_id;
  currentHost = null;
  document.body.classList.remove("web-blank-canvas");
  document.getElementById("blank-start-hint").hidden = true;
  closeComposerSilently();
  safeLocalStorageSet(LAST_HOLE_KEY, hole.hole_id);
  if (replace) history.replaceState(null, "", `#hole=${encodeURIComponent(hole.hole_id)}`);
  else history.pushState(null, "", `#hole=${encodeURIComponent(hole.hole_id)}`);

  setSnapshotHooks({
    fetchAssetData: async (name) => blobToDataUrl(await store.getAsset(currentHoleId, name)),
    getFrozenClientSource: () => window.__RABBITHOLE_FROZEN_CLIENT__ || "",
    getDompurifySource: () => window.__RABBITHOLE_DOMPURIFY_SOURCE__ || "",
  });

  const settings = loadSettings();
  const key = getApiKey(settings);
  const brain = key || !presetFor(settings.preset).requires_key ? createBrain(settings, key) : null;
  currentHost = new DirectRabbitholeHost({
    store,
    hole,
    brain,
    onToast: showToast,
    onDone: async () => {
      await currentHost?.flushSave();
      history.replaceState(null, "", location.pathname);
      location.reload();
    },
    onRestore: () => location.reload(),
    onAuthRequired: handleBranchAuthRequired,
  });

  const hydration = currentHost.hydration();
  hydration.asset_data = await buildLiveAssetData(hole.hole_id);
  startRabbithole(hydration, {
    transport: currentHost.adapter(),
    exportPortable: exportCurrentRabbithole,
  });
  document.getElementById("r-canvas")?.click();
  await renderRail();
  exposeTestApi();
}

function closeComposerSilently() {
  const modal = document.getElementById("composer-modal");
  if (modal) modal.hidden = true;
  if (composerTrap) {
    composerTrap();
    composerTrap = null;
  }
}

function showBlankCanvas({ openComposer: shouldOpenComposer = false } = {}) {
  uiStarted = false;
  currentHost = null;
  currentHoleId = null;
  document.body.classList.add("mode-canvas", "web-blank-canvas");
  document.getElementById("world").innerHTML = `<svg id="edges"></svg>`;
  setBlankZoom(1);
  history.replaceState(null, "", location.pathname);
  if (shouldOpenComposer) openComposer({ source: "empty" });
}

async function exportCurrentRabbithole() {
  await currentHost?.flushSave();
  if (!currentHoleId) throw new Error("No open Rabbithole to export.");
  const payload = await downloadRabbitholeExport(store, currentHoleId);
  return { filename: rabbitholeFilename(payload.hole?.title), payload };
}

async function renderRail() {
  const rail = document.getElementById("web-rail");
  if (!rail) return;
  const summaries = await store.listHoles();
  lastHoleCount = summaries.length;
  const holes = [];
  for (const summary of summaries) {
    const hole = await store.loadHole(summary.hole_id);
    if (hole) holes.push({ summary, hole });
  }
  rail.innerHTML = `<div class="rail-inner">
    <header class="rail-head">
      <div class="rail-wordmark"><span class="rail-mark">${bunnyMarkSvg()}</span><span>Rabbithole</span></div>
      <span class="rail-count">${holes.length}</span>
    </header>
    <div class="rail-list" id="rail-list">
      ${holes.length ? holes.map(({ summary, hole }) => railRowHtml(summary, hole)).join("") : `<div class="rail-empty">No Rabbitholes yet.</div>`}
    </div>
    <footer class="rail-footer">
      <details>
        <summary>Use with a coding agent</summary>
        <div class="agent-command-row">
          <code>${escapeHtml(AGENT_COMMAND)}</code>
          <button class="rail-mini" type="button" data-copy-agent>Copy</button>
        </div>
      </details>
      <a href="https://github.com/shlokkhemani/rabbithole" target="_blank" rel="noreferrer">GitHub</a>
    </footer>
  </div>`;
  rail.querySelectorAll("[data-copy-agent]").forEach((button) => {
    button.addEventListener("click", () => copyText(AGENT_COMMAND, "Command copied."));
  });
  rail.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setRailOpen(false);
  });
  applyRailState();
}

function railRowHtml(summary, hole) {
  const title = summary.title || hole.title || "Untitled";
  return `<article class="rail-row${summary.hole_id === currentHoleId ? " current" : ""}" data-hole="${escapeAttr(summary.hole_id)}">
    <button class="rail-open" type="button">
      <span class="rail-thumb" aria-hidden="true">${constellationSvg(hole)}</span>
      <span class="rail-row-copy">
        <span class="rail-title">${escapeHtml(title)}</span>
        <span class="rail-meta">${summary.node_count} ${summary.node_count === 1 ? "node" : "nodes"} · ${escapeHtml(formatRelativeDate(summary.updated_at, { compact: true }))}</span>
      </span>
    </button>
    <span class="rail-actions">
      <button class="rail-icon rail-export" type="button" aria-label="Export ${escapeAttr(title)}"><svg width="15" height="15" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M8 2.75v7"/><path d="M5.25 7.1 8 9.85l2.75-2.75"/><path d="M3.25 12.75h9.5"/></svg></button>
      <button class="rail-icon rail-delete" type="button" aria-label="Delete ${escapeAttr(title)}"><svg width="15" height="15" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M3.25 4.25h9.5"/><path d="M6.25 2.75h3.5"/><path d="M5.25 4.25v8.25h5.5V4.25"/><path d="M7 6.5v3.75"/><path d="M9 6.5v3.75"/></svg></button>
    </span>
  </article>`;
}

async function deleteHoleFromRail(holeId) {
  if (!holeId) return;
  const deletingCurrent = holeId === currentHoleId;
  if (deletingCurrent) {
    await currentHost?.flushSave();
    currentHost?.dispose?.();
    currentHost = null;
  }
  const hole = await store.loadHole(holeId);
  if (!hole) return;
  const assets = [];
  for (const name of await store.listAssets(holeId)) {
    assets.push({ name, blob: await store.getAsset(holeId, name) });
  }
  await store.deleteHole(holeId);
  if (safeLocalStorageGet(LAST_HOLE_KEY) === holeId) localStorage.removeItem(LAST_HOLE_KEY);
  await renderRail();
  showToast({
    message: `Deleted "${hole.title || "Untitled"}"`,
    actionLabel: "Undo",
    timeoutMs: 10000,
    onAction: async () => {
      await store.saveHole(hole);
      for (const asset of assets) {
        if (asset.blob) await store.putAsset(holeId, asset.name, asset.blob);
      }
      await renderRail();
    },
  });
  if (deletingCurrent) {
    const next = (await store.listHoles())[0];
    if (next) {
      const nextHole = await store.loadHole(next.hole_id);
      if (nextHole) await startHole(nextHole, { replace: true });
    } else {
      location.hash = "";
      location.reload();
    }
  }
}

async function exportHoleFromRail(holeId) {
  try {
    if (holeId === currentHoleId) await currentHost?.flushSave();
    const payload = await downloadRabbitholeExport(store, holeId);
    showToast({ message: `Exported ${rabbitholeFilename(payload.hole?.title)}.` });
  } catch (err) {
    showToast({ message: err?.message || String(err) });
  }
}

function toggleRail() {
  setRailOpen(!railOpen);
}

function setRailOpen(value) {
  railOpen = !!value;
  safeLocalStorageSet(RAIL_KEY, railOpen ? "1" : "0");
  applyRailState();
  if (railOpen) document.getElementById("web-rail")?.focus({ preventScroll: true });
}

function applyRailState() {
  document.body.classList.toggle("rail-open", railOpen);
  const rail = document.getElementById("web-rail");
  const toggle = document.getElementById("t-rail");
  if (rail) rail.classList.toggle("open", railOpen);
  if (toggle) toggle.setAttribute("aria-expanded", railOpen ? "true" : "false");
}

function loadRailOpen() {
  const raw = safeLocalStorageGet(RAIL_KEY);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return window.innerWidth >= 1100;
}

function initSettingsModal() {
  initSettingsPanel();
  const modal = document.getElementById("web-settings-modal");
  const close = document.getElementById("web-settings-close");
  close.addEventListener("click", closeSettingsModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeSettingsModal();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSettingsModal();
  });
}

function openSettingsModal({ focusKey = false } = {}) {
  const modal = document.getElementById("web-settings-modal");
  initSettingsPanel();
  modal.hidden = false;
  document.getElementById("t-settings")?.setAttribute("aria-expanded", "true");
  if (settingsTrap) settingsTrap();
  settingsTrap = activateFocusTrap(modal, {
    initialFocus: focusKey ? modal.querySelector("#api-key") : modal.querySelector("select, input, button, summary"),
    onEscape: closeSettingsModal,
  });
}

function closeSettingsModal() {
  const modal = document.getElementById("web-settings-modal");
  modal.hidden = true;
  document.getElementById("t-settings")?.setAttribute("aria-expanded", "false");
  const inline = document.getElementById("settings-inline-key");
  inline.hidden = true;
  inline.innerHTML = "";
  pendingBranchRetry = null;
  if (settingsTrap) {
    settingsTrap();
    settingsTrap = null;
  }
}

function initSettingsPanel() {
  const panel = document.getElementById("settings-panel");
  if (!panel) return;
  const settings = loadSettings();
  const preset = presetFor(settings.preset);
  const presetOptions = Object.values(BRAIN_PRESETS).map((item) => {
    const label = item.recommended ? `${item.label} (recommended)` : item.label;
    return `<option value="${item.id}" ${preset.id === item.id ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  panel.dataset.preset = preset.id;
  panel.innerHTML = `<div class="settings-inner">
    <div class="settings-hero">
      <div>
        <h2>OpenRouter</h2>
        <p>Use one key for Rabbithole's Ask and Improve structure actions.</p>
      </div>
      <a class="key-walkthrough" href="${OPENROUTER_KEYS_URL}" target="_blank" rel="noreferrer">Get a key in 30 seconds →</a>
    </div>
    <div class="settings-basic settings-openrouter">
      <div class="field key-field">
        <label for="api-key">API key</label>
        <div class="secret-input">
          <input id="api-key" type="password" autocomplete="off" placeholder="${escapeAttr(apiKeyPlaceholder(settings.preset))}" value="${escapeAttr(getApiKey(settings))}">
          <button id="api-key-toggle" class="web-secondary" type="button" aria-label="Show API key" aria-pressed="false">Show</button>
        </div>
        <div id="api-key-status" class="key-status" aria-live="polite"></div>
      </div>
      <label class="switch-field remember-field" for="session-only">
        <input id="session-only" type="checkbox" role="switch" ${settings.session_only === false ? "checked" : ""}>
        <span class="switch-track" aria-hidden="true"></span>
        <span class="switch-copy"><strong>Remember on this device</strong><small>Off keeps the key only in this tab.</small></span>
      </label>
    </div>
    <details class="settings-other">
      <summary>Other providers</summary>
      <div class="settings-other-grid">
        <label class="field provider-field" for="provider-preset">
          <span>Provider</span>
          <select id="provider-preset">${presetOptions}</select>
        </label>
        <label class="field custom-only" for="provider-base">
          <span>Base URL</span>
          <input id="provider-base" value="${escapeAttr(settings.base_url || "")}" placeholder="http://localhost:11434/v1">
        </label>
      </div>
    </details>
    <details class="settings-advanced">
      <summary>Advanced</summary>
      <div class="settings-advanced-grid">
        <label class="field" for="answer-model">
          <span>Answer model</span>
          <input id="answer-model" value="${escapeAttr(settings.answer_model || "")}">
          <small class="model-hint" data-model-hint="answer">${escapeHtml(testedModelHint(settings.answer_model || preset.answer_model))}</small>
        </label>
        <label class="field" for="author-model">
          <span>Author model</span>
          <input id="author-model" value="${escapeAttr(settings.author_model || "")}">
          <small class="model-hint" data-model-hint="author">${escapeHtml(testedModelHint(settings.author_model || preset.author_model))}</small>
        </label>
        <label class="field wide-field" for="fetch-proxy-url">
          <span>Fetch proxy URL</span>
          <input id="fetch-proxy-url" value="${escapeAttr(settings.fetch_proxy_url || "")}" placeholder="https://your-worker.example/?url=">
        </label>
        <p class="custom-csp-note wide-field">Custom remote origins require editing this static app's CSP. Localhost custom endpoints are allowed by default.</p>
      </div>
    </details>
    <div class="settings-actions">
      <div></div>
      <button id="save-settings" class="web-primary" type="button">Save settings</button>
    </div>
  </div>`;

  const keyInput = panel.querySelector("#api-key");
  const status = panel.querySelector("#api-key-status");
  let validateTimer = 0;
  panel.querySelector("#provider-preset").addEventListener("change", (event) => {
    const next = settingsForPreset(event.target.value, readSettingsForm());
    panel.dataset.preset = next.preset;
    panel.querySelector("#provider-base").value = next.base_url;
    panel.querySelector("#answer-model").value = next.answer_model;
    panel.querySelector("#author-model").value = next.author_model;
    keyInput.placeholder = apiKeyPlaceholder(next.preset);
    setKeyStatus(status, providerKeyHint(keyInput.value, next.preset), "hint");
    updateModelHints(panel);
  });
  keyInput.addEventListener("input", () => {
    window.clearTimeout(validateTimer);
    const hint = providerKeyHint(keyInput.value, panel.querySelector("#provider-preset").value);
    setKeyStatus(status, hint, hint ? "hint" : "");
    validateTimer = window.setTimeout(() => validateKeyFromSettings(false), 350);
  });
  keyInput.addEventListener("blur", () => validateKeyFromSettings(false));
  keyInput.addEventListener("paste", () => window.setTimeout(() => validateKeyFromSettings(false), 0));
  panel.querySelector("#answer-model").addEventListener("input", () => updateModelHints(panel));
  panel.querySelector("#author-model").addEventListener("input", () => updateModelHints(panel));
  panel.querySelector("#api-key-toggle").addEventListener("click", () => toggleSecretInput(panel));
  panel.querySelector("#save-settings").addEventListener("click", async () => {
    if (keyInput.value.trim() && !(await validateKeyFromSettings(true))) return;
    const next = readSettingsForm();
    saveSettings(next);
    refreshCurrentBrain(next);
    showToast({ message: "Settings saved." });
  });
  updateModelHints(panel);
}

async function validateKeyFromSettings(required) {
  const panel = document.getElementById("settings-panel");
  const settings = readSettingsForm();
  const input = panel.querySelector("#api-key");
  const status = panel.querySelector("#api-key-status");
  return validateKeyForPreset({
    key: input.value,
    presetId: settings.preset,
    statusEl: status,
    required,
    onShake: () => input.classList.add("shake-once"),
  });
}

function readSettingsForm(root = document) {
  const remember = root.getElementById?.("session-only")?.checked === true ||
    root.querySelector?.("#session-only")?.checked === true;
  return {
    preset: root.getElementById?.("provider-preset")?.value || root.querySelector?.("#provider-preset")?.value || "openrouter",
    base_url: root.getElementById?.("provider-base")?.value.trim() || root.querySelector?.("#provider-base")?.value.trim() || "",
    author_model: root.getElementById?.("author-model")?.value.trim() || root.querySelector?.("#author-model")?.value.trim() || "",
    answer_model: root.getElementById?.("answer-model")?.value.trim() || root.querySelector?.("#answer-model")?.value.trim() || "",
    fetch_proxy_url: root.getElementById?.("fetch-proxy-url")?.value.trim() || root.querySelector?.("#fetch-proxy-url")?.value.trim() || "",
    session_only: !remember,
    api_key: root.getElementById?.("api-key")?.value || root.querySelector?.("#api-key")?.value || "",
  };
}

function loadSettings() {
  const defaults = defaultWebSettings();
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")) };
  } catch {
    return defaults;
  }
}

function defaultWebSettings() {
  return { ...defaultBrainSettings(), fetch_proxy_url: DEFAULT_FETCH_PROXY_URL || "" };
}

function saveSettings(settings) {
  const { api_key, ...persistable } = settings;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistable));
  if (settings.session_only === false) {
    localStorage.setItem(KEY_KEY, api_key || "");
    memoryKey = "";
  } else {
    localStorage.removeItem(KEY_KEY);
    memoryKey = api_key || "";
  }
}

function getApiKey(settings) {
  if (settings.session_only === false) {
    try { return localStorage.getItem(KEY_KEY) || ""; } catch { return ""; }
  }
  return memoryKey;
}

function refreshCurrentBrain(settings = loadSettings()) {
  if (!currentHost) return;
  const key = getApiKey(settings);
  currentHost.brain = key || !presetFor(settings.preset).requires_key ? createBrain(settings, key) : null;
}

function handleBranchAuthRequired({ node, error, retry }) {
  pendingBranchRetry = retry;
  openSettingsModal({ focusKey: true });
  const slot = document.getElementById("settings-inline-key");
  slot.hidden = false;
  renderInlineKeyPanel(slot, {
    idPrefix: "branch",
    message: error?.message || "Update your key to retry this ask.",
    afterValidated: async () => {
      slot.hidden = true;
      pendingBranchRetry = null;
      refreshCurrentBrain();
      retry?.();
      showToast({ message: `Retrying "${node?.title || "ask"}".` });
    },
  });
}

function renderInlineKeyPanel(container, { idPrefix, message = "", afterValidated = null } = {}) {
  const settings = loadSettings();
  const remember = settings.session_only === false;
  container.innerHTML = `<section class="inline-key-panel">
    <div class="inline-key-head">
      <div>
        <h3>Add your OpenRouter key</h3>
        <p>${escapeHtml(message || "Rabbithole uses your key directly from this browser.")}</p>
      </div>
      <a href="${OPENROUTER_KEYS_URL}" target="_blank" rel="noreferrer">Get a key in 30 seconds →</a>
    </div>
    <label class="field key-field" for="${idPrefix}-key">
      <span>API key</span>
      <input id="${idPrefix}-key" type="password" autocomplete="off" placeholder="sk-or-v1-..." value="">
    </label>
    <label class="switch-field remember-field" for="${idPrefix}-remember">
      <input id="${idPrefix}-remember" type="checkbox" role="switch" ${remember ? "checked" : ""}>
      <span class="switch-track" aria-hidden="true"></span>
      <span class="switch-copy"><strong>Remember on this device</strong><small>Off keeps the key only in this tab.</small></span>
    </label>
    <div id="${idPrefix}-key-status" class="key-status" aria-live="polite"></div>
    <div class="inline-key-actions">
      <button class="web-primary" type="button" id="${idPrefix}-connect">Connect</button>
    </div>
  </section>`;
  const input = container.querySelector(`#${idPrefix}-key`);
  const status = container.querySelector(`#${idPrefix}-key-status`);
  let timer = 0;
  let continued = false;
  const continueOnce = async () => {
    if (continued) return;
    continued = true;
    const current = loadSettings();
    saveSettings({
      ...current,
      preset: current.preset || "openrouter",
      api_key: input.value,
      session_only: !container.querySelector(`#${idPrefix}-remember`).checked,
    });
    initSettingsPanel();
    refreshCurrentBrain();
    await afterValidated?.();
  };
  const validate = async (required = false) => {
    const presetId = loadSettings().preset || "openrouter";
    const switched = await maybeSwitchProviderFromKey(input.value, container, continueOnce);
    if (switched) return true;
    const ok = await validateKeyForPreset({
      key: input.value,
      presetId,
      statusEl: status,
      required,
      onShake: () => input.classList.add("shake-once"),
    });
    if (ok && input.value.trim()) await continueOnce();
    return ok;
  };
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    const hint = providerKeyHint(input.value, loadSettings().preset || "openrouter");
    setKeyStatus(status, hint, hint ? "hint" : "");
    timer = window.setTimeout(() => validate(false), 350);
  });
  input.addEventListener("paste", () => window.setTimeout(() => validate(false), 0));
  input.addEventListener("blur", () => validate(false));
  container.querySelector(`#${idPrefix}-connect`).addEventListener("click", () => validate(true));
  input.focus({ preventScroll: true });
}

async function maybeSwitchProviderFromKey(key, container, continueOnce) {
  const value = String(key || "").trim();
  const status = container.querySelector(".key-status");
  let target = "";
  if (value.startsWith("sk-ant-")) target = "anthropic";
  else if (value.startsWith("sk-") && !value.startsWith("sk-or-")) target = "openai";
  if (!target) return false;
  const label = presetFor(target).label;
  status.innerHTML = `That looks like an ${escapeHtml(label)} key. <button type="button" class="key-switch">Switch provider</button>`;
  status.className = "key-status hint visible";
  status.querySelector("button").addEventListener("click", async () => {
    const current = loadSettings();
    const next = settingsForPreset(target, current);
    saveSettings({
      ...next,
      api_key: value,
      session_only: !container.querySelector("input[role='switch']").checked,
    });
    initSettingsPanel();
    refreshCurrentBrain();
    await continueOnce?.();
  }, { once: true });
  return true;
}

async function validateKeyForPreset({ key, presetId, statusEl, required = false, onShake = null } = {}) {
  const value = String(key || "").trim();
  const preset = presetFor(presetId);
  if (!preset.requires_key) {
    setKeyStatus(statusEl, "No key required for this provider.", "valid");
    return true;
  }
  const hint = providerKeyHint(value, preset.id);
  if (!value) {
    if (required) {
      setKeyStatus(statusEl, "Enter a key first.", "invalid");
      shake(onShake);
      return false;
    }
    setKeyStatus(statusEl, "", "");
    return false;
  }
  if (hint) {
    setKeyStatus(statusEl, hint, "hint");
    if (required && /truncated|looks like/i.test(hint)) shake(onShake);
    if (preset.id !== "openrouter") return true;
    if (!isPlausibleOpenRouterKey(value)) return false;
  }
  if (preset.id !== "openrouter") {
    setKeyStatus(statusEl, "Key saved for this provider.", "valid");
    return true;
  }
  if (!isPlausibleOpenRouterKey(value)) {
    setKeyStatus(statusEl, "That OpenRouter key looks too short.", "invalid");
    if (required) shake(onShake);
    return false;
  }
  setKeyStatus(statusEl, "Validating...", "busy");
  try {
    const result = await validateOpenRouterKey(value);
    setKeyStatus(statusEl, openRouterValidMessage(result), "valid");
    return true;
  } catch (err) {
    setKeyStatus(statusEl, err?.message || "OpenRouter rejected that key.", "invalid");
    shake(onShake);
    return false;
  }
}

async function validateOpenRouterKey(key) {
  const response = await fetch(OPENROUTER_KEY_CHECK_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("That key was rejected by OpenRouter.");
    throw new Error(`OpenRouter returned HTTP ${response.status}.`);
  }
  let json = {};
  try { json = await response.json(); } catch {}
  return json;
}

function providerKeyHint(key, presetId) {
  const value = String(key || "").trim();
  if (!value) return "";
  if (value.startsWith("sk-ant-") && presetId !== "anthropic") return "That looks like an Anthropic key — switch provider?";
  if (value.startsWith("sk-") && !value.startsWith("sk-or-") && !value.startsWith("sk-ant-") && presetId !== "openai") {
    return "That looks like an OpenAI key — switch provider?";
  }
  if (presetId === "openrouter" && value.startsWith("sk-or-v1-") && value.length < 30) {
    return "That OpenRouter key looks truncated.";
  }
  return "";
}

function isPlausibleOpenRouterKey(value) {
  return /^sk-or-v1-[A-Za-z0-9_-]{24,}$/.test(String(value || "").trim());
}

function openRouterValidMessage(result) {
  const data = result?.data || result || {};
  const label = data.label || data.name || data.key_name || "";
  const limit = data.limit || data.usage_limit || data.limit_remaining || "";
  const detail = [label, limit ? `limit ${limit}` : ""].filter(Boolean).join(" · ");
  return detail ? `Connected · ${detail}` : "Connected";
}

function setKeyStatus(el, message, tone = "") {
  if (!el) return;
  el.textContent = message || "";
  el.className = `key-status${message ? " visible" : ""}${tone ? ` ${tone}` : ""}`;
}

function shake(onShake) {
  onShake?.();
  window.setTimeout(() => document.querySelectorAll(".shake-once").forEach((el) => el.classList.remove("shake-once")), 260);
}

function toggleSecretInput(root) {
  const input = root.querySelector("#api-key");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  const button = root.querySelector("#api-key-toggle");
  button.textContent = showing ? "Show" : "Hide";
  button.setAttribute("aria-label", showing ? "Show API key" : "Hide API key");
  button.setAttribute("aria-pressed", showing ? "false" : "true");
}

function updateModelHints(panel = document.getElementById("settings-panel")) {
  if (!panel) return;
  const answer = panel.querySelector("#answer-model")?.value || "";
  const author = panel.querySelector("#author-model")?.value || "";
  const answerHint = panel.querySelector("[data-model-hint='answer']");
  const authorHint = panel.querySelector("[data-model-hint='author']");
  if (answerHint) answerHint.textContent = testedModelHint(answer);
  if (authorHint) authorHint.textContent = testedModelHint(author);
}

async function buildLiveAssetData(holeId) {
  const out = {};
  for (const name of await store.listAssets(holeId)) {
    const blob = await store.getAsset(holeId, name);
    if (blob) out[name] = URL.createObjectURL(blob);
  }
  return out;
}

function showToast({ message, actionLabel = "", timeoutMs = 4000, onAction = null } = {}) {
  const el = document.getElementById("web-toast");
  if (!el) return;
  el.innerHTML = `<span>${escapeHtml(message || "")}</span>${actionLabel ? `<button type="button">${escapeHtml(actionLabel)}</button>` : ""}`;
  el.classList.add("visible");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.classList.remove("visible");
  };
  const timer = setTimeout(finish, timeoutMs);
  const button = el.querySelector("button");
  if (button) {
    button.addEventListener("click", async () => {
      clearTimeout(timer);
      await onAction?.();
      finish();
    }, { once: true });
  }
}

function setIngestStatus(message, tone = "") {
  const el = document.getElementById("ingest-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = `ingest-status${message ? " visible" : ""}${tone ? ` ${tone}` : ""}`;
  el.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
}

function constellationSvg(hole) {
  const nodes = Array.isArray(hole?.nodes) ? hole.nodes : [];
  if (!nodes.length) return `<svg viewBox="0 0 44 32" role="img" aria-label=""></svg>`;
  const points = nodes.map((node) => {
    const size = node.size || {};
    const pos = node.position || {};
    return {
      id: node.id,
      parent: node.parent_id,
      root: node.id === hole.root_id,
      x: Number(pos.x || 0) + Number(size.w || 0) / 2,
      y: Number(pos.y || 0) + Number(size.h || 0) / 2,
    };
  });
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const width = maxX - minX;
  const height = maxY - minY;
  const fit = (p) => ({
    x: width ? 4 + ((p.x - minX) / width) * 36 : 22,
    y: height ? 4 + ((p.y - minY) / height) * 24 : 16,
  });
  const byId = new Map(points.map((p) => [p.id, p]));
  const lines = points.filter((p) => p.parent && byId.has(p.parent)).map((p) => {
    const a = fit(byId.get(p.parent));
    const b = fit(p);
    return `<line x1="${round(a.x)}" y1="${round(a.y)}" x2="${round(b.x)}" y2="${round(b.y)}"></line>`;
  }).join("");
  const dots = points.map((p) => {
    const f = fit(p);
    return `<circle class="${p.root ? "root-dot" : ""}" cx="${round(f.x)}" cy="${round(f.y)}" r="${p.root ? "2.3" : "1.55"}"></circle>`;
  }).join("");
  return `<svg viewBox="0 0 44 32" role="img" aria-label="">${lines}${dots}</svg>`;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function setBlankZoom(value) {
  blankZoom = Math.min(2.5, Math.max(0.15, Number(value) || 1));
  const world = document.getElementById("world");
  if (world && !currentHoleId) world.style.transform = `translate(0px,0px) scale(${blankZoom})`;
  const label = document.getElementById("zoom-label");
  if (label && !currentHoleId) label.textContent = `${Math.round(blankZoom * 100)}%`;
}

function toggleBlankTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("rh-theme", next); } catch {}
}

function isPdfFile(file) {
  return /(\.pdf$|application\/pdf)/i.test(`${file?.name || ""} ${file?.type || ""}`);
}

function isRabbitholeFile(file) {
  return /\.rabbithole$/i.test(file?.name || "");
}

function isSessionJsonFile(file) {
  return /(\.json$|application\/json)/i.test(`${file?.name || ""} ${file?.type || ""}`);
}

function isMarkdownFile(file) {
  return /(\.md$|\.markdown$|markdown|text\/plain|application\/json)/i.test(`${file?.name || ""} ${file?.type || ""}`);
}

function isSingleHttpUrl(value) {
  const text = String(value || "").trim();
  if (!text || /\s/.test(text)) return false;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function looksLikeDocument(value) {
  const text = String(value || "").trim();
  if (text.length > 400) return true;
  if (/^#{1,6}\s+\S/m.test(text)) return true;
  if (/```/.test(text)) return true;
  const paragraphs = text.split(/\n\s*\n/).filter((part) => part.trim().length > 24);
  return paragraphs.length >= 2;
}

function holeIdFromHash() {
  const match = /^#hole=(.+)$/.exec(location.hash || "");
  return match ? decodeURIComponent(match[1]) : "";
}

function formatRelativeDate(value, { compact = false } = {}) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return compact ? "unknown" : "Updated at an unknown time";
  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(deltaSeconds);
  const ranges = [
    [60, "second", 1],
    [60 * 60, "minute", 60],
    [60 * 60 * 24, "hour", 60 * 60],
    [60 * 60 * 24 * 30, "day", 60 * 60 * 24],
    [60 * 60 * 24 * 365, "month", 60 * 60 * 24 * 30],
    [Infinity, "year", 60 * 60 * 24 * 365],
  ];
  try {
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    const [, unit, divisor] = ranges.find(([limit]) => abs < limit);
    const formatted = formatter.format(Math.round(deltaSeconds / divisor), unit);
    return compact ? formatted : `Updated ${formatted}`;
  } catch {
    return date.toLocaleString(undefined, { month: "short", day: "numeric" });
  }
}

function blobToDataUrl(blob) {
  if (!blob) return Promise.resolve("data:,");
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "data:,"));
    reader.onerror = () => resolve("data:,");
    reader.readAsDataURL(blob);
  });
}

function apiKeyPlaceholder(presetId) {
  switch (presetFor(presetId).id) {
    case "openrouter": return "sk-or-v1-...";
    case "anthropic": return "sk-ant-...";
    case "openai": return "sk-...";
    default: return "optional";
  }
}

function isAuthLikeError(err) {
  return err?.status === 401 ||
    err?.status === 403 ||
    err?.code === "missing_key" ||
    /api key|401|403|unauthorized|forbidden/i.test(err?.message || String(err));
}

function autoGrowTextarea(textarea, maxHeight) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(maxHeight, textarea.scrollHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

function isEditableTarget(target) {
  return !!target?.closest?.("input, textarea, select, [contenteditable='true']");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function applyInitialWebTheme() {
  try {
    let savedTheme = localStorage.getItem("rh-theme");
    if (savedTheme !== "dark" && savedTheme !== "light") savedTheme = "";
    if (!savedTheme && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) savedTheme = "dark";
    if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
  } catch {}
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    fallbackCopyText(text);
  }
  showToast({ message });
}

function fallbackCopyText(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-999px";
  document.body.append(area);
  area.select();
  try { document.execCommand("copy"); } catch {}
  area.remove();
}

function safeLocalStorageGet(key) {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}

function safeLocalStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function bunnyMarkSvg() {
  return `<svg width="24" height="24" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
    <ellipse cx="30" cy="17" rx="4.6" ry="12.5" transform="rotate(20 30 17)"></ellipse>
    <ellipse cx="21.5" cy="15.5" rx="4.6" ry="13" transform="rotate(3 21.5 15.5)"></ellipse>
    <circle cx="21" cy="33" r="9.5"></circle>
    <ellipse cx="36" cy="45" rx="17" ry="13.5"></ellipse>
    <circle cx="52.5" cy="49" r="5"></circle>
  </svg>`;
}

function exposeTestApi() {
  window.__rhWebApp = {
    store,
    importRabbitholeForTest: (text) => importRabbitholeFile(store, text),
    importSessionJsonForTest: (text) => importSessionJsonFile(store, text),
    exportRabbitholeForTest: async (id = currentHoleId) => {
      await currentHost?.flushSave();
      return downloadRabbitholeExport(store, id);
    },
    exportSnapshotForTest: async () => buildSnapshotHtml(await buildSnapshotHydration()),
    exportSnapshotJsonForTest: async () => buildSnapshotJson(await buildSnapshotHydration()),
    currentHoleId: () => currentHoleId,
    readRawHole: (id = currentHoleId) => id ? store.readRawHoleForTest(id) : null,
    renderRailForTest: renderRail,
    deleteHoleForTest: deleteHoleFromRail,
    exportHoleFromRailForTest: exportHoleFromRail,
  };
}
