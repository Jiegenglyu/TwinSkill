import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { attachNetworkRecorder } from "./record-network.mjs";
import {
  STANDARD_LAUNCH_ARGS,
  assertStandardEnvironment,
  standardContextOptions,
  writeEnvironmentSnapshot
} from "./runtime-profile.mjs";

const [, , startUrl, runDirArg = "runs/human-recording", ...flags] = process.argv;

if (!startUrl) {
  console.error("Usage: node human-record.mjs <url> [run-dir] [--headless]");
  process.exit(2);
}

const requestedRunDir = resolve(runDirArg);
const headless = flags.includes("--headless");
const append = flags.includes("--append");
const artifactNames = [
  "storage-state.json",
  "session.json",
  "network.jsonl",
  "user-actions.jsonl",
  "candidates.json",
  "operation.recipe.draft.json",
  "operation.recipe.json",
  "inputs.json",
  "validation.json",
  "replay-acceptance.json",
  "api-materials.json",
  "results.jsonl",
  "run-manifest.json",
  "skill-seed.json",
  "skill-brief.md"
];

function hasRunArtifacts(directory) {
  return artifactNames.some((name) => existsSync(join(directory, name)));
}

function timestampSuffix() {
  return new Date().toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace("Z", "");
}

function chooseRunDir(baseDir) {
  if (append || !hasRunArtifacts(baseDir)) return baseDir;
  const stem = `${baseDir}-${timestampSuffix()}`;
  let candidate = stem;
  let suffix = 2;
  while (existsSync(candidate)) {
    candidate = `${stem}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

const runDir = chooseRunDir(requestedRunDir);
mkdirSync(runDir, { recursive: true });
mkdirSync(join(runDir, "downloads"), { recursive: true });

const actionStream = createWriteStream(join(runDir, "user-actions.jsonl"), { flags: "a" });
const recorders = [];
const attachedPages = new WeakSet();
const pageNames = new WeakMap();
const pages = [];
let pageSequence = 0;
const startedAt = new Date();
const runId = `${startedAt.toISOString()
  .replace(/\.\d{3}Z$/, "Z")
  .replace(/[-:]/g, "")
  .replace("T", "-")
  .replace("Z", "")}-${runDir.split(/[\\/]/).pop()}`;

function writeRunManifest(status, extra = {}) {
  writeFileSync(
    join(runDir, "run-manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      runId,
      status,
      stage: status,
      startUrl,
      requestedRunDir,
      runDir,
      createdAt: startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      isolation: {
        isolatedRunDirectory: runDir !== requestedRunDir,
        appendMode: append
      },
      artifacts: {
        session: "session.json",
        network: "network.jsonl",
        userActions: "user-actions.jsonl",
        environment: "environment.json",
        storageState: "storage-state.json",
        downloads: "downloads/"
      },
      skillProduction: {
        eligibleAfter: "api-replay-user-accepted",
        seedFile: "skill-seed.json",
        briefFile: "skill-brief.md"
      },
      ...extra
    }, null, 2)}\n`
  );
}

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
      const attr = (name) => element.getAttribute(name);
      const selectorHints = [];

      for (const name of ["data-testid", "data-test", "data-cy", "id", "name"]) {
        const value = attr(name);
        if (value) selectorHints.push({ kind: name, value });
      }
      if (attr("role")) {
        const accessibleName = attr("aria-label") || text.slice(0, 80);
        selectorHints.push({ kind: "role", role: attr("role"), name: accessibleName || null });
      }
      if (attr("aria-label")) selectorHints.push({ kind: "aria-label", value: attr("aria-label") });
      if (attr("placeholder")) selectorHints.push({ kind: "placeholder", value: attr("placeholder") });
      if (text) selectorHints.push({ kind: "text", value: text.slice(0, 80) });

      return {
        tag: element.tagName?.toLowerCase(),
        role: attr("role") || null,
        id: element.id || null,
        name: attr("name") || null,
        type: attr("type") || null,
        ariaLabel: attr("aria-label") || null,
        title: attr("title") || null,
        placeholder: attr("placeholder") || null,
        text: text ? text.slice(0, 80) : null,
        selectorHints
      };
    };

    const send = (payload) => {
      window.__apiReplayRecordAction?.({
        ...payload,
        url: location.href,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        }
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

const browser = await chromium.launch({ headless, args: [...STANDARD_LAUNCH_ARGS] });
const context = await browser.newContext(standardContextOptions());
writeRunManifest("recording");

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
const initialEnvironment = await assertStandardEnvironment(page);
writeEnvironmentSnapshot(runDir, initialEnvironment, {
  checkedAt: new Date().toISOString(),
  mode: "human-driven-recording"
});
writeAction({ type: "ui.environment", environment: initialEnvironment });
await page.goto(startUrl, { waitUntil: "domcontentloaded" });
const pageEnvironment = await assertStandardEnvironment(page);
writeAction({ type: "ui.environment", environment: pageEnvironment });

console.log(`Recording: ${startUrl}`);
console.log(`Run directory: ${runDir}`);
if (runDir !== requestedRunDir) {
  console.log(`Requested run directory already had artifacts. Created isolated run directory instead of appending: ${runDir}`);
}
if (append) {
  console.log("Append mode enabled. Existing run artifacts may be mixed with this recording.");
}
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
    runId,
    requestedRunDir,
    runDir,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    stopReason,
    standardEnvironment: {
      enforced: true,
      environmentFile: "environment.json"
    },
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
writeRunManifest("recorded", {
  endedAt: new Date().toISOString(),
  stopReason,
  pages
});

console.log(`Saved recording artifacts to ${runDir}`);
console.log(`Stop reason: ${stopReason}`);
