import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import {
  STANDARD_LAUNCH_ARGS,
  pageEnvironment,
  standardContextOptions,
  validateStandardEnvironment
} from "./runtime-profile.mjs";

function timestamp() {
  return new Date().toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace("Z", "");
}

function safeName(value) {
  return String(value || "debug")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "debug";
}

function truncateText(text, maxChars = 50000) {
  if (text == null) return "";
  const value = String(text);
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated:${value.length - maxChars}]`;
}

async function collectTextSnapshot(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const textBlock = (value) => String(value || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
    const attr = (element, name) => element.getAttribute(name) || null;
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    };
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity || 1) !== 0 &&
        rect.width > 0 &&
        rect.height > 0;
    };
    const valueShape = (element) => {
      if (!("value" in element)) return undefined;
      const type = String(element.getAttribute("type") || "").toLowerCase();
      if (["password", "hidden"].includes(type)) return { redacted: true };
      const value = String(element.value || "");
      return { empty: value.length === 0, length: value.length };
    };
    const describe = (element) => ({
      tag: element.tagName.toLowerCase(),
      role: attr(element, "role"),
      type: attr(element, "type"),
      id: element.id || null,
      name: attr(element, "name"),
      dataTestId: attr(element, "data-testid"),
      dataTest: attr(element, "data-test"),
      dataCy: attr(element, "data-cy"),
      ariaLabel: attr(element, "aria-label"),
      title: attr(element, "title"),
      placeholder: attr(element, "placeholder"),
      href: element.tagName.toLowerCase() === "a" ? attr(element, "href") : null,
      text: normalize(element.innerText || element.textContent).slice(0, 160) || null,
      valueShape: valueShape(element),
      rect: rectOf(element)
    });

    const interactiveSelector = [
      "button",
      "input",
      "select",
      "textarea",
      "a[href]",
      "[role]",
      "[tabindex]",
      "[contenteditable='true']",
      "[data-testid]",
      "[data-test]",
      "[data-cy]"
    ].join(",");

    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
      .filter(isVisible)
      .slice(0, 80)
      .map((element) => ({
        level: element.tagName.toLowerCase(),
        text: normalize(element.innerText || element.textContent).slice(0, 200),
        rect: rectOf(element)
      }));

    const interactiveElements = Array.from(document.querySelectorAll(interactiveSelector))
      .filter(isVisible)
      .slice(0, 300)
      .map(describe);

    const forms = Array.from(document.querySelectorAll("form"))
      .filter(isVisible)
      .slice(0, 30)
      .map((form) => ({
        id: form.id || null,
        name: attr(form, "name"),
        action: attr(form, "action"),
        method: attr(form, "method"),
        text: normalize(form.innerText || form.textContent).slice(0, 300),
        fields: Array.from(form.querySelectorAll("input,select,textarea,button"))
          .slice(0, 80)
          .map(describe)
      }));

    const tables = Array.from(document.querySelectorAll("table"))
      .filter(isVisible)
      .slice(0, 20)
      .map((table) => ({
        caption: normalize(table.caption?.innerText || ""),
        headers: Array.from(table.querySelectorAll("th"))
          .slice(0, 40)
          .map((cell) => normalize(cell.innerText || cell.textContent).slice(0, 120)),
        rowCount: table.querySelectorAll("tbody tr, tr").length,
        rect: rectOf(table)
      }));

    const bodyText = textBlock(document.body?.innerText || document.body?.textContent || "");

    return {
      title: document.title,
      url: location.href,
      visibleText: bodyText,
      headings,
      interactiveElements,
      forms,
      tables
    };
  });
}

export async function saveDebugSnapshot(page, runDir, label = "debug", metadata = {}) {
  const screenshotsDir = join(runDir, "screenshots");
  const snapshotsDir = join(runDir, "debug-snapshots");
  mkdirSync(screenshotsDir, { recursive: true });
  mkdirSync(snapshotsDir, { recursive: true });

  const stem = `${safeName(label)}-${timestamp()}`;
  const screenshotPath = join(screenshotsDir, `${stem}.png`);
  const htmlPath = join(snapshotsDir, `${stem}.html`);
  const jsonPath = join(snapshotsDir, `${stem}.json`);
  const visibleTextPath = join(snapshotsDir, `${stem}.visible-text.txt`);
  const interactivePath = join(snapshotsDir, `${stem}.interactive-elements.json`);
  const domSummaryPath = join(snapshotsDir, `${stem}.dom-summary.json`);

  const environment = await pageEnvironment(page).catch((error) => ({ error: error.message }));
  const html = await page.content().catch((error) => `<!-- unreadable:${error.message} -->`);
  const textSnapshot = await collectTextSnapshot(page).catch((error) => ({ error: error.message }));
  let savedScreenshotPath = screenshotPath;
  let screenshotError = null;
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch((error) => {
    savedScreenshotPath = null;
    screenshotError = error.message;
  });
  writeFileSync(htmlPath, html);
  writeFileSync(visibleTextPath, `${truncateText(textSnapshot.visibleText)}\n`);
  writeFileSync(interactivePath, `${JSON.stringify(textSnapshot.interactiveElements || [], null, 2)}\n`);
  writeFileSync(
    domSummaryPath,
    `${JSON.stringify({
      title: textSnapshot.title,
      url: textSnapshot.url,
      headings: textSnapshot.headings || [],
      forms: textSnapshot.forms || [],
      tables: textSnapshot.tables || [],
      error: textSnapshot.error || null
    }, null, 2)}\n`
  );
  writeFileSync(
    jsonPath,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      url: page.url(),
      label,
      environment,
      environmentIssues: environment.error ? [] : validateStandardEnvironment(environment),
      screenshotPath: savedScreenshotPath,
      screenshotError,
      htmlPath,
      visibleTextPath,
      interactivePath,
      domSummaryPath,
      ...metadata
    }, null, 2)}\n`
  );

  return { screenshotPath: savedScreenshotPath, htmlPath, visibleTextPath, interactivePath, domSummaryPath, jsonPath };
}

function flagValue(flags, name, fallback) {
  const prefix = `${name}=`;
  const inline = flags.find((flag) => flag.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = flags.indexOf(name);
  if (index !== -1 && flags[index + 1]) return flags[index + 1];
  return fallback;
}

async function main() {
  const [, , url, runDirArg = "runs/debug-snapshot", ...flags] = process.argv;
  if (!url) {
    console.error("Usage: node debug-snapshot.mjs <url> [run-dir] [--headless] [--storage-state=path] [--label=name]");
    process.exit(2);
  }

  const runDir = resolve(runDirArg);
  const storageState = flagValue(flags, "--storage-state", null);
  const label = flagValue(flags, "--label", "manual");
  const headless = flags.includes("--headless");
  const consoleEvents = [];
  const pageErrors = [];

  const browser = await chromium.launch({ headless, args: [...STANDARD_LAUNCH_ARGS] });
  const context = await browser.newContext(standardContextOptions(
    storageState && existsSync(storageState) ? { storageState } : {}
  ));
  const page = await context.newPage();
  page.on("console", (message) => {
    consoleEvents.push({ type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => {
    pageErrors.push({ message: error.message });
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const snapshot = await saveDebugSnapshot(page, runDir, label, { consoleEvents, pageErrors });
    console.log(JSON.stringify({ ok: true, ...snapshot }, null, 2));
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
