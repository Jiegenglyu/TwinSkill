import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const [, , runDirArg, ...flags] = process.argv;

if (!runDirArg) {
  console.error("Usage: node replay-ui.mjs <run-dir> [--headless] [--keep-open] [--dry-run] [--step-delay-ms=1000]");
  process.exit(2);
}

const runDir = resolve(runDirArg);
const actionsFile = join(runDir, "user-actions.jsonl");
const sessionFile = join(runDir, "session.json");
const storageStateFile = join(runDir, "storage-state.json");
const screenshotsDir = join(runDir, "screenshots");
const headless = flags.includes("--headless");
const keepOpen = flags.includes("--keep-open");
const dryRun = flags.includes("--dry-run");

function flagValue(name, fallback) {
  const prefix = `${name}=`;
  const inline = flags.find((flag) => flag.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = flags.indexOf(name);
  if (index !== -1 && flags[index + 1]) return flags[index + 1];
  return fallback;
}

const stepDelayMs = Number(flagValue("--step-delay-ms", "1000"));

function parseLines(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { type: "parse_error", index, error: error.message, raw: line.slice(0, 200) };
      }
    });
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

function usableUrl(url) {
  if (!url || url === "about:blank") return false;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "file:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function sameUrl(left, right) {
  if (!usableUrl(left) || !usableUrl(right)) return false;
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = "";
    b.hash = "";
    return a.toString() === b.toString();
  } catch {
    return left === right;
  }
}

function describeTarget(target = {}) {
  return [
    target.tag,
    target.role ? `role=${target.role}` : null,
    target.id ? `id=${target.id}` : null,
    target.name ? `name=${target.name}` : null,
    target.ariaLabel ? `aria=${target.ariaLabel}` : null,
    target.text ? `text=${target.text}` : null
  ].filter(Boolean).join(" ");
}

function firstStartUrl(session, actions) {
  if (usableUrl(session?.startUrl)) return session.startUrl;
  const navigation = actions.find((action) => action.type === "ui.navigation" && usableUrl(action.url));
  if (navigation) return navigation.url;
  const actionWithUrl = actions.find((action) => usableUrl(action.url));
  return actionWithUrl?.url || null;
}

async function safeGoto(page, url, records, reason) {
  if (!usableUrl(url)) return;
  records.push({ action: "goto", reason, url });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
}

async function settle(page) {
  await Promise.race([
    page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {}),
    sleep(5000)
  ]);
  if (stepDelayMs > 0) await sleep(stepDelayMs);
}

if (!existsSync(actionsFile)) {
  console.error(`Missing user actions file: ${actionsFile}`);
  process.exit(2);
}

const session = readJsonIfExists(sessionFile);
const actions = parseLines(actionsFile).filter((action) => action.type?.startsWith("ui."));
const replayableActions = actions.filter((action) => ["ui.click", "ui.input", "ui.change", "ui.submit"].includes(action.type));
const startUrl = firstStartUrl(session, actions);

if (!startUrl) {
  console.error("Could not find a replayable start URL in session.json or user-actions.jsonl.");
  process.exit(2);
}

const report = {
  ts: new Date().toISOString(),
  runDir,
  startUrl,
  dryRun,
  mode: "best-effort-ui-replay",
  warning: "UI replay reuses recorded page URLs, viewport sizes, and click coordinates. Use API replay from operation.recipe.draft.json for correctness, then finalize operation.recipe.json only after user confirmation.",
  records: []
};

if (dryRun) {
  report.records.push({ action: "planned-start", url: startUrl });
  for (const action of replayableActions) {
    report.records.push({
      action: "planned-action",
      type: action.type,
      url: action.url || null,
      x: action.x ?? null,
      y: action.y ?? null,
      target: describeTarget(action.target)
    });
  }
  writeFileSync(join(runDir, "ui-replay-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

mkdirSync(screenshotsDir, { recursive: true });

const browser = await chromium.launch({ headless });
const contextOptions = existsSync(storageStateFile) ? { storageState: storageStateFile } : {};
const context = await browser.newContext(contextOptions);
const page = await context.newPage();

try {
  await safeGoto(page, startUrl, report.records, "start");
  await settle(page);

  for (const action of replayableActions) {
    const record = {
      type: action.type,
      sourceUrl: action.url || null,
      target: describeTarget(action.target),
      x: action.x ?? null,
      y: action.y ?? null,
      status: "pending"
    };
    report.records.push(record);

    if (action.viewport?.width && action.viewport?.height) {
      await page.setViewportSize({
        width: action.viewport.width,
        height: action.viewport.height
      });
      record.viewport = action.viewport;
    }

    if (usableUrl(action.url) && !sameUrl(page.url(), action.url)) {
      await safeGoto(page, action.url, report.records, "action-source-url");
      await settle(page);
    }

    if (action.type === "ui.click") {
      if (typeof action.x !== "number" || typeof action.y !== "number") {
        record.status = "skipped";
        record.reason = "click action has no coordinates";
        continue;
      }
      await page.mouse.click(action.x, action.y);
      record.status = "clicked";
      await settle(page);
      record.afterUrl = page.url();
      continue;
    }

    record.status = "skipped";
    record.reason = "recording stores input/change shape but not raw values";
  }
} catch (error) {
  const screenshotPath = join(screenshotsDir, `ui-replay-failure-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  report.error = error.message;
  report.failureScreenshot = screenshotPath;
  writeFileSync(join(runDir, "ui-replay-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

writeFileSync(join(runDir, "ui-replay-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

if (keepOpen) {
  console.log("Browser left open because --keep-open was provided. Press Ctrl+C to exit.");
  await new Promise(() => {});
}

await browser.close();
