import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [, , recipeFile, inputsFile, runDirArg] = process.argv;

if (!recipeFile || !inputsFile) {
  console.error("Usage: node run-operation.mjs <operation.recipe.draft.json|operation.recipe.json> <inputs.json> [run-dir]");
  process.exit(2);
}

const recipePath = resolve(recipeFile);
const recipeDir = dirname(recipePath);
const runDir = resolve(runDirArg || recipeDir);
const recipe = JSON.parse(readFileSync(recipePath, "utf8"));
const input = JSON.parse(readFileSync(resolve(inputsFile), "utf8"));
const state = {};

mkdirSync(runDir, { recursive: true });

function resolveFromRecipe(path) {
  return resolve(recipeDir, path);
}

function getPath(value, path) {
  if (!path || path === "$") return value;
  const parts = path.replace(/^\$\./, "").split(".");
  let current = value;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function renderString(text) {
  return text.replace(/\$\{([^}]+)\}/g, (_, expression) => {
    const [scope, ...rest] = expression.split(".");
    const keyPath = rest.join(".");
    if (scope === "input") return getPath(input, `$.${keyPath}`) ?? "";
    if (scope === "state") return getPath(state, `$.${keyPath}`) ?? "";
    if (scope === "env") return globalThis.process?.env?.[keyPath] ?? "";
    throw new Error(`Unsupported template expression: ${expression}`);
  });
}

function render(value) {
  if (typeof value === "string") return renderString(value);
  if (Array.isArray(value)) return value.map(render);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, render(entry)]));
  }
  return value;
}

function cookieHeaderFor(url) {
  const storageStatePath = recipe.auth?.storageState || recipe.auth?.storage_state;
  if (!storageStatePath) return "";
  const storageState = JSON.parse(readFileSync(resolveFromRecipe(storageStatePath), "utf8"));
  const target = new URL(url);
  return (storageState.cookies || [])
    .filter((cookie) => {
      const domain = cookie.domain?.replace(/^\./, "");
      return domain && target.hostname.endsWith(domain);
    })
    .filter((cookie) => !cookie.path || target.pathname.startsWith(cookie.path))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function filenameFromDisposition(header) {
  const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(header || "");
  return match ? decodeURIComponent(match[1] || match[2]) : null;
}

async function requestOnce(step) {
  const request = render(step.request);
  const method = request.method || "GET";
  const headers = { ...(request.headers || {}) };
  const cookie = cookieHeaderFor(request.url);
  if (cookie && !headers.cookie) headers.cookie = cookie;

  let body;
  if (request.body != null) {
    body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    if (!headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
  }

  const response = await fetch(request.url, { method, headers, body, redirect: "manual" });
  const contentType = response.headers.get("content-type") || "";
  const bytes = Buffer.from(await response.arrayBuffer());
  let parsedBody = null;
  let textBody = "";

  if (/json/i.test(contentType)) {
    textBody = bytes.toString("utf8");
    parsedBody = textBody ? JSON.parse(textBody) : null;
  } else if (/text|xml|html/i.test(contentType)) {
    textBody = bytes.toString("utf8");
  }

  return { response, contentType, bytes, parsedBody, textBody };
}

function assertExpected(step, result) {
  const expectedStatus = step.expect?.status;
  if (expectedStatus && result.response.status !== expectedStatus) {
    throw new Error(`${step.id} expected HTTP ${expectedStatus}, got ${result.response.status}`);
  }
}

function captureState(step, result) {
  for (const [name, path] of Object.entries(step.capture || {})) {
    if (path.startsWith("$.headers.")) {
      const headerName = path.slice("$.headers.".length).toLowerCase();
      const headers = Object.fromEntries(result.response.headers.entries());
      state[name] = headers[headerName];
    } else {
      state[name] = getPath(result.parsedBody, path);
    }
  }
}

function repeatDone(step, result) {
  const condition = step.repeat?.until;
  if (!condition) return true;
  const actual = getPath(result.parsedBody, condition.path);
  if ("equals" in condition) return actual === condition.equals;
  if ("exists" in condition) return condition.exists ? actual != null : actual == null;
  return false;
}

function writeStepOutput(step, result) {
  if (step.output?.type !== "file") return null;
  let relativePath = renderString(step.output.path || "");
  if (!relativePath) {
    relativePath = filenameFromDisposition(result.response.headers.get("content-disposition")) || `${step.id}.bin`;
  }
  const absolutePath = join(runDir, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, result.bytes);
  return relativePath;
}

async function runStep(step) {
  const maxAttempts = step.repeat?.maxAttempts || 1;
  const delayMs = step.repeat?.delayMs || 0;
  let result;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = await requestOnce(step);
    assertExpected(step, result);
    captureState(step, result);
    if (repeatDone(step, result)) break;
    if (attempt === maxAttempts) {
      throw new Error(`${step.id} repeat condition not satisfied after ${maxAttempts} attempts`);
    }
    await sleep(delayMs);
  }

  const file = writeStepOutput(step, result);
  const record = {
    ts: new Date().toISOString(),
    step: step.id,
    status: result.response.status,
    contentType: result.contentType,
    capturedState: { ...state },
    file
  };
  appendFileSync(join(runDir, recipe.outputs?.resultLog || "results.jsonl"), `${JSON.stringify(record)}\n`);
  return record;
}

const records = [];
for (const step of recipe.steps || []) {
  records.push(await runStep(step));
  if (recipe.rateLimit?.delayMs) await sleep(recipe.rateLimit.delayMs);
}

console.log(JSON.stringify({ ok: true, runDir, state, records }, null, 2));
