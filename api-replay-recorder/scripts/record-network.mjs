import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_RESOURCE_TYPES = new Set(["fetch", "xhr", "document"]);
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-csrf-token",
  "x-xsrf-token"
]);

function redactHeaders(headers, includeSensitive) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const normalized = key.toLowerCase();
    out[key] = !includeSensitive && SENSITIVE_HEADERS.has(normalized) ? "[redacted]" : value;
  }
  return out;
}

function truncate(text, maxChars) {
  if (text == null) return null;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...[truncated:${text.length - maxChars}]`;
}

function jsonKeySummary(text) {
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return ["[]"];
    if (value && typeof value === "object") return Object.keys(value).slice(0, 40);
  } catch {
    return [];
  }
  return [];
}

export function attachNetworkRecorder(page, options = {}) {
  const {
    outFile = "runs/current/network.jsonl",
    resourceTypes = DEFAULT_RESOURCE_TYPES,
    captureDownloads = true,
    downloadDir = null,
    metadata = {},
    includeSensitiveHeaders = false,
    maxBodyChars = 200000
  } = options;

  mkdirSync(dirname(outFile), { recursive: true });
  const stream = createWriteStream(outFile, { flags: "a" });
  const capturedResourceTypes = resourceTypes instanceof Set ? resourceTypes : new Set(resourceTypes);
  const requestIds = new WeakMap();
  let sequence = 0;

  function shouldCapture(request) {
    return capturedResourceTypes.has(request.resourceType());
  }

  function write(record) {
    stream.write(`${JSON.stringify({ ts: Date.now(), ...metadata, ...record })}\n`);
  }

  page.on("request", (request) => {
    if (!shouldCapture(request)) return;
    const id = `req-${Date.now()}-${++sequence}`;
    requestIds.set(request, id);
    const postData = truncate(request.postData(), maxBodyChars);
    write({
      type: "request",
      id,
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      headers: redactHeaders(request.headers(), includeSensitiveHeaders),
      postData,
      postDataKeys: jsonKeySummary(postData)
    });
  });

  page.on("response", async (response) => {
    const request = response.request();
    if (!shouldCapture(request)) return;
    const id = requestIds.get(request) || `untracked-${Date.now()}-${++sequence}`;
    const headers = response.headers();
    const contentType = headers["content-type"] || headers["Content-Type"] || "";
    let bodyText = null;
    let bodyKeys = [];

    if (/json|graphql|text\/plain|text\/csv|xml/i.test(contentType)) {
      try {
        bodyText = truncate(await response.text(), maxBodyChars);
        bodyKeys = jsonKeySummary(bodyText);
      } catch (error) {
        bodyText = `[unreadable:${error.message}]`;
      }
    }

    write({
      type: "response",
      id,
      method: request.method(),
      url: response.url(),
      status: response.status(),
      contentType,
      headers: redactHeaders(headers, includeSensitiveHeaders),
      bodyText,
      bodyKeys
    });
  });

  page.on("requestfailed", (request) => {
    if (!shouldCapture(request)) return;
    write({
      type: "requestfailed",
      id: requestIds.get(request) || `failed-${Date.now()}-${++sequence}`,
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      failure: request.failure()
    });
  });

  if (captureDownloads) {
    page.on("download", async (download) => {
      let savedPath = null;
      if (downloadDir) {
        mkdirSync(downloadDir, { recursive: true });
        savedPath = join(downloadDir, download.suggestedFilename());
        await download.saveAs(savedPath);
      }
      write({
        type: "download",
        url: download.url(),
        suggestedFilename: download.suggestedFilename(),
        savedPath
      });
    });
  }

  return {
    mark(name, data = {}) {
      write({ type: "marker", name, data });
    },
    close() {
      stream.end();
    }
  };
}
