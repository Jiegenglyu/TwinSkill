import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { attachNetworkRecorder } from "./record-network.mjs";

const [, , startUrl, runDirArg = "runs/human-recording", ...flags] = process.argv;

if (!startUrl) {
  console.error("Usage: node human-record.mjs <url> [run-dir] [--headless]");
  process.exit(2);
}

const runDir = resolve(runDirArg);
const headless = flags.includes("--headless");
mkdirSync(runDir, { recursive: true });
mkdirSync(join(runDir, "downloads"), { recursive: true });

const actionStream = createWriteStream(join(runDir, "user-actions.jsonl"), { flags: "a" });
const recorders = [];
const attachedPages = new WeakSet();
const pageNames = new WeakMap();
const pages = [];
let pageSequence = 0;
const startedAt = new Date();

function writeAction(record) {
  actionStream.write(`${JSON.stringify({ ts: Date.now(), ...record })}\n`);
}

function installActionRecorder(context) {
  return context.addInitScript(() => {
    const redactValue = (element) => {
      const type = (element.getAttribute?.("type") || "").toLowerCase();
      if (["password", "hidden"].includes(type)) return { redacted: true };
      const value = element.value;
      if (typeof value !== "string") return {};
      return {
        length: value.length,
        empty: value.length === 0
      };
    };

    const describe = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return {};
      const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      return {
        tag: element.tagName?.toLowerCase(),
        role: element.getAttribute("role") || null,
        id: element.id || null,
        name: element.getAttribute("name") || null,
        type: element.getAttribute("type") || null,
        ariaLabel: element.getAttribute("aria-label") || null,
        title: element.getAttribute("title") || null,
        text: text ? text.slice(0, 80) : null
      };
    };

    const send = (payload) => {
      window.__apiReplayRecordAction?.({
        ...payload,
        url: location.href
      }).catch(() => {});
    };

    document.addEventListener("click", (event) => {
      send({
        type: "ui.click",
        target: describe(event.target),
        x: event.clientX,
        y: event.clientY
      });
    }, true);

    document.addEventListener("input", (event) => {
      send({
        type: "ui.input",
        target: describe(event.target),
        valueShape: redactValue(event.target)
      });
    }, true);

    document.addEventListener("change", (event) => {
      send({
        type: "ui.change",
        target: describe(event.target),
        valueShape: redactValue(event.target)
      });
    }, true);

    document.addEventListener("submit", (event) => {
      send({
        type: "ui.submit",
        target: describe(event.target)
      });
    }, true);
  });
}

function attachPageRecorders(page, pageName) {
  if (attachedPages.has(page)) return null;
  attachedPages.add(page);
  pageNames.set(page, pageName);
  const pageInfo = {
    pageName,
    openedAt: new Date().toISOString(),
    initialUrl: page.url(),
    navigations: [],
    downloads: [],
    closedAt: null
  };
  pages.push(pageInfo);
  const recorder = attachNetworkRecorder(page, {
    outFile: join(runDir, "network.jsonl"),
    downloadDir: join(runDir, "downloads"),
    metadata: { pageName }
  });
  recorder.mark("page_attached", { pageName });
  recorders.push(recorder);
  writeAction({ type: "ui.page_attached", pageName, url: page.url() });

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      pageInfo.navigations.push({ ts: new Date().toISOString(), url: frame.url() });
      writeAction({ type: "ui.navigation", pageName, url: frame.url() });
    }
  });

  page.on("download", (download) => {
    pageInfo.downloads.push({
      ts: new Date().toISOString(),
      url: download.url(),
      suggestedFilename: download.suggestedFilename()
    });
    writeAction({
      type: "ui.download",
      pageName,
      url: download.url(),
      suggestedFilename: download.suggestedFilename()
    });
  });

  page.on("close", () => {
    pageInfo.closedAt = new Date().toISOString();
    writeAction({ type: "ui.page_closed", pageName });
  });

  return recorder;
}

const browser = await chromium.launch({ headless });
const context = await browser.newContext({
  acceptDownloads: true
});

await context.exposeBinding("__apiReplayRecordAction", async (source, payload) => {
  writeAction({
    pageName: pageNames.get(source.page) || "unknown-page",
    ...payload
  });
});
await installActionRecorder(context);

context.on("page", (page) => {
  attachPageRecorders(page, `page-${++pageSequence}`);
});

const page = await context.newPage();
const mainRecorder = attachPageRecorders(page, pageNames.get(page) || `page-${++pageSequence}`) || recorders[0];
mainRecorder.mark("before_action", { mode: "human-driven-recording", startUrl });
await page.goto(startUrl, { waitUntil: "domcontentloaded" });

console.log(`Recording: ${startUrl}`);
console.log(`Run directory: ${runDir}`);
console.log("Use the opened browser to complete the operation once. Press Enter here when finished.");

const stopReason = await new Promise((resolveDone) => {
  let finished = false;
  const finish = (reason) => {
    if (finished) return;
    finished = true;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    resolveDone(reason);
  };
  const onSigint = () => finish("manual-sigint");
  const onSigterm = () => finish("manual-sigterm");

  process.stdin.resume();
  process.stdin.once("data", () => finish("manual-enter"));
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
});

for (const recorder of recorders) {
  recorder.mark("after_action", { mode: "human-driven-recording", stopReason });
}
await context.storageState({ path: join(runDir, "storage-state.json") });

writeFileSync(
  join(runDir, "session.json"),
  `${JSON.stringify({
    startUrl,
    runDir,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    stopReason,
    endingPolicy: {
      explicitUserStopOnly: true,
      manualEnter: true,
      sigint: true,
      sigterm: true
    },
    pages
  }, null, 2)}\n`
);

for (const recorder of recorders) recorder.close();
actionStream.end();
await browser.close();

console.log(`Saved recording artifacts to ${runDir}`);
console.log(`Stop reason: ${stopReason}`);
