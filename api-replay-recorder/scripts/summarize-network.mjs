import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [, , inputFile, outputFile = "candidates.json", userActionsFile] = process.argv;

if (!inputFile) {
  console.error("Usage: node summarize-network.mjs <network.jsonl> [candidates.json]");
  process.exit(2);
}

function parseLines(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { type: "parse_error", index, error: error.message, line: line.slice(0, 200) };
      }
    });
}

function urlPath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text || ""));
}

function keys(record, field) {
  return Array.isArray(record?.[field]) ? record[field] : [];
}

function scoreCandidate(request, response, markerBefore) {
  const url = request.url || "";
  const payload = request.postData || "";
  const responseBody = response?.bodyText || "";
  const allText = `${url}\n${payload}\n${responseBody}`;
  const reasons = [];
  let score = 0;

  if (request.resourceType === "fetch" || request.resourceType === "xhr") {
    score += 3;
    reasons.push("fetch/xhr");
  }
  if (/json/i.test(response?.contentType || "")) {
    score += 3;
    reasons.push("json response");
  }
  if (request.method === "POST") {
    score += 2;
    reasons.push("POST");
  }
  if (request.method === "GET") {
    score += 1;
    reasons.push("GET");
  }
  if (markerBefore) {
    score += 2;
    reasons.push(`after marker:${markerBefore.name}`);
  }
  if (hasAny(allText, [/query/i, /keyword/i, /search/i, /filter/i, /page/i, /pageSize/i, /cursor/i, /offset/i])) {
    score += 4;
    reasons.push("query-like fields");
  }
  if (hasAny(allText, [/export/i, /download/i, /report/i, /file/i, /task/i, /job/i, /approve/i, /submit/i])) {
    score += 5;
    reasons.push("operation-like fields");
  }
  if (hasAny(allText, [/items/i, /records/i, /rows/i, /list/i, /total/i, /result/i, /data/i, /jobId/i, /taskId/i, /downloadUrl/i, /fileId/i, /status/i])) {
    score += 4;
    reasons.push("result-like response");
  }
  if (hasAny(response?.contentType || "", [/csv/i, /excel/i, /spreadsheet/i, /pdf/i, /octet-stream/i])) {
    score += 5;
    reasons.push("file response");
  }
  if (hasAny(JSON.stringify(response?.headers || {}), [/content-disposition/i, /filename=/i])) {
    score += 5;
    reasons.push("download headers");
  }
  if (hasAny(url, [/analytics/i, /telemetry/i, /track/i, /beacon/i, /metrics/i, /feature/i, /menu/i, /static/i])) {
    score -= 6;
    reasons.push("likely non-query endpoint");
  }
  if ((response?.status || 0) >= 400) {
    score -= 3;
    reasons.push(`status ${response.status}`);
  }

  return { score, reasons };
}

const records = parseLines(inputFile);
const userActions = userActionsFile && existsSync(userActionsFile) ? parseLines(userActionsFile) : [];
const markers = records.filter((record) => record.type === "marker");
const responses = new Map(records.filter((record) => record.type === "response").map((record) => [record.id, record]));
const requests = records.filter((record) => record.type === "request");

function lastMarkerBefore(ts) {
  let selected = null;
  for (const marker of markers) {
    if (marker.ts <= ts) selected = marker;
    if (marker.ts > ts) break;
  }
  return selected;
}

const requestCandidates = requests
  .map((request) => {
    const response = responses.get(request.id);
    const markerBefore = lastMarkerBefore(request.ts);
    const scoring = scoreCandidate(request, response, markerBefore);
    return {
      ts: request.ts,
      pageName: request.pageName || null,
      score: scoring.score,
      reasons: scoring.reasons,
      markerBefore: markerBefore?.name || null,
      method: request.method,
      url: request.url,
      path: urlPath(request.url),
      status: response?.status || null,
      contentType: response?.contentType || null,
      requestPayloadKeys: keys(request, "postDataKeys"),
      responseBodyKeys: keys(response, "bodyKeys")
    };
  })
  .sort((a, b) => b.score - a.score);

const downloadCandidates = records
  .filter((record) => record.type === "download")
  .map((download) => ({
    ts: download.ts,
    pageName: download.pageName || null,
    score: 12,
    reasons: ["playwright download event"],
    markerBefore: lastMarkerBefore(download.ts)?.name || null,
    method: "GET",
    url: download.url,
    path: urlPath(download.url),
    status: null,
    contentType: null,
    suggestedFilename: download.suggestedFilename,
    savedPath: download.savedPath,
    requestPayloadKeys: [],
    responseBodyKeys: []
  }));

const candidates = [...requestCandidates, ...downloadCandidates]
  .sort((a, b) => b.score - a.score)
  .slice(0, 30);

const chronologicalCandidates = [...requestCandidates, ...downloadCandidates].sort((a, b) => a.ts - b.ts);
const beforeMarkers = markers.filter((marker) => /^before_|_start$|start_/i.test(marker.name || ""));

const actionWindows = beforeMarkers.map((start) => {
  const end = markers.find((marker) => marker.ts > start.ts && /^after_|_done$|end_/i.test(marker.name || ""));
  const events = chronologicalCandidates
    .filter((candidate) => candidate.ts >= start.ts && (!end || candidate.ts <= end.ts))
    .map(({ ts, pageName, score, reasons, method, url, path, status, contentType, suggestedFilename, requestPayloadKeys, responseBodyKeys }) => ({
      ts,
      pageName,
      score,
      reasons,
      method,
      url,
      path,
      status,
      contentType,
      suggestedFilename,
      requestPayloadKeys,
      responseBodyKeys
    }));
  return {
    startMarker: start.name,
    endMarker: end?.name || null,
    events
  };
});

const uiTimeline = userActions
  .filter((action) => /^ui\./.test(action.type || ""))
  .map((action, index, actions) => {
    const nextAction = actions[index + 1];
    const hardStopTs = action.ts + 10000;
    const stopTs = nextAction ? Math.min(nextAction.ts, hardStopTs) : hardStopTs;
    const events = chronologicalCandidates
      .filter((candidate) => candidate.ts >= action.ts && candidate.ts <= stopTs)
      .filter((candidate) => !action.pageName || !candidate.pageName || candidate.pageName === action.pageName)
      .map(({ ts, pageName, score, reasons, method, url, path, status, contentType, suggestedFilename, requestPayloadKeys, responseBodyKeys }) => ({
        deltaMs: ts - action.ts,
        pageName,
        score,
        reasons,
        method,
        url,
        path,
        status,
        contentType,
        suggestedFilename,
        requestPayloadKeys,
        responseBodyKeys
      }));
    return {
      action: {
        ts: action.ts,
        type: action.type,
        url: action.url,
        target: action.target,
        valueShape: action.valueShape
      },
      events
    };
  })
  .filter((entry) => entry.events.length > 0);

writeFileSync(
  outputFile,
  `${JSON.stringify({ inputFile, userActionsFile: userActionsFile || null, generatedAt: new Date().toISOString(), candidates, actionWindows, uiTimeline }, null, 2)}\n`
);
console.log(`Wrote ${candidates.length} candidates to ${outputFile}`);
