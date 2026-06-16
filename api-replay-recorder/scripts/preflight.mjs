import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { saveDebugSnapshot } from "./debug-snapshot.mjs";
import {
  STANDARD_LAUNCH_ARGS,
  assertStandardEnvironment,
  standardContextOptions,
  writeEnvironmentSnapshot
} from "./runtime-profile.mjs";

const [, , startUrl, runDirArg = "runs/preflight", ...flags] = process.argv;

if (!startUrl) {
  console.error("Usage: node preflight.mjs <url> [run-dir] [--headless] [--storage-state=path] [--expect-text=text] [--expect-selector=css]");
  process.exit(2);
}

function flagValue(name, fallback) {
  const prefix = `${name}=`;
  const inline = flags.find((flag) => flag.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = flags.indexOf(name);
  if (index !== -1 && flags[index + 1]) return flags[index + 1];
  return fallback;
}

const runDir = resolve(runDirArg);
const headless = flags.includes("--headless");
const storageState = flagValue("--storage-state", null);
const expectText = flagValue("--expect-text", null);
const expectSelector = flagValue("--expect-selector", null);
mkdirSync(runDir, { recursive: true });

const report = {
  ts: new Date().toISOString(),
  startUrl,
  runDir,
  checks: []
};

function recordCheck(name, ok, details = {}) {
  report.checks.push({ name, ok, ...details });
}

const browser = await chromium.launch({ headless, args: [...STANDARD_LAUNCH_ARGS] });
const context = await browser.newContext(standardContextOptions(
  storageState && existsSync(storageState) ? { storageState } : {}
));
const page = await context.newPage();

try {
  const initialEnvironment = await assertStandardEnvironment(page);
  writeEnvironmentSnapshot(runDir, initialEnvironment, {
    checkedAt: new Date().toISOString(),
    mode: "preflight"
  });
  recordCheck("standard_environment_before_navigation", true, { environment: initialEnvironment });

  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  recordCheck("navigation", true, { url: page.url() });

  const pageEnvironment = await assertStandardEnvironment(page);
  recordCheck("standard_environment_after_navigation", true, { environment: pageEnvironment });

  if (expectText) {
    await page.getByText(expectText, { exact: false }).first().waitFor({ state: "visible", timeout: 10000 });
    recordCheck("expected_text_visible", true, { text: expectText });
  }

  if (expectSelector) {
    await page.locator(expectSelector).first().waitFor({ state: "visible", timeout: 10000 });
    recordCheck("expected_selector_visible", true, { selector: expectSelector });
  }

  report.ok = true;
  writeFileSync(join(runDir, "preflight.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.ok = false;
  report.error = error.message;
  if (error.issues) report.environmentIssues = error.issues;
  const snapshot = await saveDebugSnapshot(page, runDir, "preflight-failure", { report });
  report.debugSnapshot = snapshot;
  writeFileSync(join(runDir, "preflight.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.error(JSON.stringify(report, null, 2));
  await browser.close();
  process.exit(1);
}

await browser.close();
