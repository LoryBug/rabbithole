import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WEB_DIST = path.join(ROOT, "web/dist");
const MOCK_KEY = `sk-or-v1-${"x".repeat(64)}`;
const BAD_KEY = `sk-or-v1-${"y".repeat(64)}`;
const PROVIDER_URL = "https://openrouter.ai/api/v1/chat/completions";
const KEY_URL = "https://openrouter.ai/api/v1/key";

try {
  await fs.access(path.join(WEB_DIST, "index.html"));
} catch {
  const build = spawnSync(process.execPath, ["build.mjs"], { cwd: ROOT, encoding: "utf8" });
  if (build.status !== 0) {
    process.stderr.write(build.stderr || build.stdout || "build failed\n");
    process.exit(build.status || 1);
  }
}

const server = await serveStatic(WEB_DIST);
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

try {
  await verifyLandingAndComposer();
  await verifyAskKeyUxAndRail();
  await verifyCanvasBranching();
  console.log("stage10 web verification passed");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

async function verifyLandingAndComposer() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#composer-modal:not([hidden])");
  assert.equal(await page.locator(".web-home").count(), 0, "form-based home page must be gone");

  await page.fill("#composer-input", "What is entropy?");
  await assertActiveIntent(page, "ask");
  await page.fill("#composer-input", "https://example.com/paper");
  await assertActiveIntent(page, "url");
  const longMarkdown = `# Inferred title\n\n${"A structured paragraph about a concept. ".repeat(20)}`;
  await page.fill("#composer-input", longMarkdown);
  await assertActiveIntent(page, "document");
  assert.equal(await page.locator("#improve-chip").isVisible(), true, "Improve structure chip should appear for documents");
  await page.click(".intent-chip[data-intent='ask']");
  await assertActiveIntent(page, "ask");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#composer-modal[hidden]", { state: "attached" });
  const noHoles = await page.evaluate(() => window.__rhWebApp.store.listHoles());
  assert.equal(noHoles.length, 0, "dismissing the composer must not create an Untitled hole");

  const first = await createDocument(page, "# First hole\n\nEuler identity $e^{i\\pi}+1=0$.");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rhWebApp?.currentHoleId() === id, first);

  const second = await createDocument(page, "# Second hole\n\nA second saved document.");
  assert.notEqual(first, second, "creating a second document should open a distinct hole");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rhWebApp?.currentHoleId() === id, second);

  await page.goto(`${baseUrl}/?hash-wins=1#hole=${encodeURIComponent(first)}`, { waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rhWebApp?.currentHoleId() === id, first);

  await page.evaluate((deletedId) => localStorage.setItem("rh-last-hole", deletedId), second);
  await page.goto(`${baseUrl}/?last=second`, { waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rhWebApp?.currentHoleId() === id, second);
  await ensureRailOpen(page);
  assert.equal(await page.locator(`.rail-row[data-hole="${second}"] .rail-delete`).count(), 1);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 5000 }).catch(() => null),
    page.evaluate((id) => window.__rhWebApp.deleteHoleForTest(id), second),
  ]);
  await page.waitForFunction((id) => window.__rhWebApp?.currentHoleId() === id, first);
  await page.evaluate((deletedId) => localStorage.setItem("rh-last-hole", deletedId), second);
  await page.goto(`${baseUrl}/?last=deleted`, { waitUntil: "networkidle" });
  await page.waitForFunction((id) => window.__rhWebApp?.currentHoleId() === id, first);

  await context.close();
}

async function verifyAskKeyUxAndRail() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await routeProvider(page, {
    keyStatus: (key) => key === MOCK_KEY ? 200 : 401,
    streams: [[
      "# Attention mechanism\n\n",
      "Attention compares tokens, scores their relevance, and mixes information according to those scores.",
    ]],
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.fill("#composer-input", "Explain the attention mechanism");
  await page.click("#composer-primary");
  await page.waitForSelector("#composer-key-panel:not([hidden])");
  assert.equal(await page.inputValue("#composer-input"), "Explain the attention mechanism");

  await page.fill("#composer-key", "sk-ant-fake-key");
  await page.waitForSelector("text=That looks like an Anthropic key");
  await page.fill("#composer-key", BAD_KEY);
  await page.waitForSelector(".key-status.invalid");
  await page.fill("#composer-key", MOCK_KEY);
  await page.waitForSelector(".node .doc-content[data-node-id]");
  await waitForCanvasText(page, "Attention compares tokens");
  await page.waitForTimeout(1200); // view-state debounce + IndexedDB save debounce
  const hole = await page.evaluate(async () => window.__rhWebApp.readRawHole());
  assert.equal(hole.title, "Attention mechanism");
  assert.equal(!!hole.view_state?.view, false, "composer-created hole must not persist a camera before user interaction");
  assert.equal(await page.locator(".rail-thumb svg").count(), 1, "rail should render constellation thumbnails");
  const rootDot = await page.locator(".rail-thumb circle.root-dot").evaluate((circle) => ({
    cx: Number(circle.getAttribute("cx")),
    cy: Number(circle.getAttribute("cy")),
  }));
  assert.deepEqual(rootDot, { cx: 22, cy: 16 }, "single-node rail constellation must center its root dot");
  assert.equal(await page.evaluate(() => localStorage.getItem("rh-web-api-key")), null, "session-only key must not be stored");
  const snapshotHtml = await page.evaluate(() => window.__rhWebApp.exportSnapshotForTest());
  assert(!snapshotHtml.includes(MOCK_KEY), "snapshot export must not contain provider key");
  const rawJson = JSON.stringify(hole);
  assert(!rawJson.includes(MOCK_KEY), "IndexedDB hole record must not contain provider key");

  await context.close();

  const rememberContext = await browser.newContext();
  const rememberPage = await rememberContext.newPage();
  await routeProvider(rememberPage, {
    keyStatus: () => 200,
    streams: [["# Remembered key\n\nThis root verifies remembered storage."]],
  });
  await rememberPage.goto(baseUrl, { waitUntil: "networkidle" });
  await rememberPage.fill("#composer-input", "Check remembered storage");
  await rememberPage.click("#composer-primary");
  await rememberPage.waitForSelector("#composer-key-panel:not([hidden])");
  await rememberPage.check("#composer-remember");
  await rememberPage.fill("#composer-key", MOCK_KEY);
  await waitForCanvasText(rememberPage, "This root verifies remembered storage");
  assert.equal(await rememberPage.evaluate(() => localStorage.getItem("rh-web-api-key")), MOCK_KEY);
  await rememberContext.close();
}

async function verifyCanvasBranching() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  let providerCalls = 0;
  page.on("request", (request) => requests.push(request.url()));
  await routeProvider(page, {
    keyStatus: () => 200,
    onProviderCall: () => { providerCalls += 1; },
    streams: [
      [
        "TITLE: Euler branch\n",
        "Euler identity connects rotation, growth, and zero in one compact statement.\n\n",
        "```show\n<style>.flow{display:grid;gap:8px}.box{border:1px solid var(--border);padding:8px;border-radius:6px}</style><div class='flow'><div class='box'>rotation</div><div class='box'>cancellation</div></div>\n```\n",
      ],
      [
        "TITLE: Deeper link\n",
        "Second branch explains the geometric view: multiplication by $e^{i\\theta}$ rotates a point on the complex plane.",
      ],
    ],
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.keyboard.press("Escape");
  await page.waitForSelector("#composer-modal[hidden]", { state: "attached" });
  await page.click("#t-settings");
  await page.fill("#api-key", MOCK_KEY);
  await page.click("#save-settings");
  await page.waitForSelector("text=Settings saved.");
  await page.click("#web-settings-close");

  const markdown = [
    "# Web Smoke",
    "",
    "Euler identity $e^{i\\pi}+1=0$ ties exponentials to geometry.",
    "",
    "```js",
    "console.log('math branch');",
    "```",
    "",
    "```show",
    "<style>.flow{display:grid;gap:8px}.box{border:1px solid var(--border);padding:8px;border-radius:6px}</style>",
    "<div class='flow'><div class='box'>Select</div><div class='box' style='background:var(--hl)'>Ask</div></div>",
    "```",
  ].join("\n");

  await createDocument(page, markdown);
  await page.waitForSelector(".node .katex");
  await page.waitForSelector(".node .hljs");
  await page.waitForSelector(".node .viz-show");
  const synthModes = await page.$$eval("#synth-mode option", (options) => options.map((option) => option.value));
  assert.deepEqual(synthModes, ["synthesis", "question_map"]);

  await selectText(page, "Euler identity");
  await page.waitForSelector("#ask.visible");
  await page.fill("#ask-text", "Why does this matter?");
  await page.click("#ask-go");
  await waitForCanvasText(page, "Euler identity connects rotation");
  assert.equal(providerCalls, 1);

  await page.click("#t-reader");
  await page.fill("#composer-text", "Go one layer deeper.");
  await page.click("#composer-send");
  await page.locator("#reader-main", { hasText: "Second branch explains the geometric view" }).waitFor();
  assert.equal(providerCalls, 2);

  await page.waitForTimeout(900);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__rhWebApp && !!document.querySelector(".node .doc-content[data-node-id]"));
  const reloadedRaw = await page.evaluate(() => window.__rhWebApp.readRawHole().then((hole) => JSON.stringify(hole)));
  assert(reloadedRaw.includes("Euler identity connects rotation"));
  assert(reloadedRaw.includes("Second branch explains the geometric view"));
  assert(!reloadedRaw.includes(MOCK_KEY), "IndexedDB hole record must not contain provider key");
  assert(!page.url().includes(MOCK_KEY), "URL must not contain provider key");

  const external = requests.filter((url) => !url.startsWith(baseUrl));
  assert(external.length > 0, "provider and key validation should have been called");
  assert(external.every((url) => url === PROVIDER_URL || url === KEY_URL), `unexpected external request(s): ${external.join(", ")}`);

  const snapshotJson = await page.evaluate(() => window.__rhWebApp.exportSnapshotJsonForTest());
  assert.equal(snapshotJson.format, "rabbithole-session-json");
  assert.equal(snapshotJson.format_version, 1);
  assert.equal(snapshotJson.session.title, "Web Smoke");
  assert(JSON.stringify(snapshotJson).includes("Second branch explains the geometric view"));
  assert(!JSON.stringify(snapshotJson).includes(MOCK_KEY), "session JSON export must not contain provider key");

  const rawHoleJson = await page.evaluate(() => window.__rhWebApp.readRawHole().then((hole) => JSON.stringify(hole)));
  assert(rawHoleJson.includes("Second branch explains the geometric view"));
  assert(!rawHoleJson.includes(MOCK_KEY), "IndexedDB hole record must not contain provider key");
  await context.close();
}

async function routeProvider(page, { keyStatus, streams, onProviderCall = null }) {
  await page.route(KEY_URL, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders(), body: "" });
      return;
    }
    const auth = route.request().headers().authorization || "";
    const key = auth.replace(/^Bearer\s+/i, "");
    const status = keyStatus ? keyStatus(key) : 200;
    await route.fulfill({
      status,
      headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" },
      body: status === 200 ? JSON.stringify({ data: { label: "test key" } }) : JSON.stringify({ error: { message: "invalid key" } }),
    });
  });
  await page.route(PROVIDER_URL, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders(), body: "" });
      return;
    }
    onProviderCall?.();
    const chunks = streams.shift() || ["# Fallback\n\nFallback streamed document."];
    await route.fulfill({
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
      },
      body: sse(chunks),
    });
  });
}

async function createDocument(page, markdown) {
  const previous = await page.evaluate(() => window.__rhWebApp?.currentHoleId?.() || "");
  if (await page.locator("#composer-modal[hidden]").count()) {
    await page.click("#t-new");
  }
  await page.waitForSelector("#composer-modal:not([hidden])");
  await page.fill("#composer-input", markdown);
  await assertActiveIntent(page, "document");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle", timeout: 2500 }).catch(() => null),
    page.keyboard.press("Enter"),
  ]);
  await page.waitForFunction((oldId) => {
    const id = window.__rhWebApp?.currentHoleId?.();
    return id && id !== oldId;
  }, previous);
  await page.waitForSelector(".node .doc-content[data-node-id]");
  return page.evaluate(() => window.__rhWebApp.currentHoleId());
}

async function assertActiveIntent(page, intent) {
  await page.waitForFunction((value) => {
    const active = document.querySelector(".intent-chip.active");
    return active?.dataset.intent === value;
  }, intent);
}

async function ensureRailOpen(page) {
  if (await page.getAttribute("#t-rail", "aria-expanded") !== "true") {
    await page.click("#t-rail");
  }
  await page.waitForSelector("#web-rail.open");
}

async function waitForCanvasText(page, text) {
  await page.locator(".node", { hasText: text }).first().waitFor();
}

function sse(chunks) {
  return chunks.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + "data: [DONE]\n\n";
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, accept, http-referer, x-title",
  };
}

async function selectText(page, needle) {
  await page.evaluate((text) => {
    const root = document.querySelector(".node .doc-content[data-node-id]");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.nodeValue.indexOf(text);
      if (idx === -1) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 120, clientY: 160 }));
      return;
    }
    throw new Error(`Text not found: ${text}`);
  }, needle);
}

async function serveStatic(rootDir) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(rootDir, rel);
    if (!file.startsWith(rootDir)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const bytes = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" });
      res.end(bytes);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}
