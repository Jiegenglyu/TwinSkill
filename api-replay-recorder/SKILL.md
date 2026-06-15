---
name: api-replay-recorder
description: Fake and preserve human browser operations by recording UI actions, page transitions, downloads, and network requests, then turning the trace into reusable pre-skill materials for a low-capability agent. Use when an agent must copy a human UI workflow on logged-in web apps, replay what the user did visually, generate local artifacts for later skills such as data scraping, analysis, and reporting, or compile the discovered workflow into deterministic API replay with feasibility checks, auth/token modeling, business anchors, and replay acceptance criteria.
---

# Fake Human UI Recorder

## Overview

Use this skill as a pre-skill for copying human web operations. It records a real or agent-driven browser session, preserves the UI timeline and related API/download traffic, and produces compact local materials that a later full skill can use for tasks such as data scraping, data analysis, report generation, approval flows, exports, and batch operations.

The main goal is not to finish the business task directly. The goal is to fake the human UI operation once, preserve enough evidence to replay or compile it, and keep a low-capability agent on a narrow state-machine path. Playwright discovers the operation and refreshes auth, scripts create compact artifacts, and replay uses two distinct meanings:

- **UI replay**: best-effort visual replay from `user-actions.jsonl` with recorded URLs, viewport sizes, and click coordinates. Use this only when the user asks to "show what I did" or wants to inspect the captured path. It is not an acceptance gate.
- **API replay**: deterministic HTTP execution from `operation.recipe.draft.json`. Use this as the only correctness replay for repeatable operations, batch work, exports, scraping, or later skills.

Treat "recording complete" as evidence capture only. It does not mean the operation is replayable, accepted, or ready to become a final skill. After recording, classify the operation, preflight the recipe against runner capabilities, define business anchors and acceptance criteria, then replay.

Do not invent ad hoc Playwright replay scripts. Use `scripts/replay-ui.mjs` for visual inspection only, or write and run `operation.recipe.draft.json` with `scripts/run-operation.mjs` for API replay. If the operation cannot fit the generic runner, stop and document the runtime gap or create a narrow, named state-machine harness with explicit inputs, anchors, assertions, and file validation. Produce final API materials only after the user explicitly confirms that the API replay result is correct.

## Agent Assumption

- Assume no stronger model is available for planning, review, endpoint selection, or recovery.
- Make every important decision either deterministic or bounded by small enumerations.
- Require scripts to create compact artifacts before the agent reasons over them.
- Prefer "choose one candidate from a ranked list" over "inspect all network traffic".
- Prefer "fill these declared variables and run an operation recipe" over "write a custom replay program".
- Stop and ask for a tighter state machine when the current UI path cannot be expressed with fixed selectors and assertions.
- Stop the local patch loop after preflight failures or two replay failures. Reclassify the flow before changing more JSON.
- Treat "Interrupted" or a failed shell command as unknown until the command output proves the cause. Do not claim a permission failure when earlier commands with the same prefix already ran.

## Core Rules

- Do not ask the model to freely browse, inspect, decide, and batch-query in one loop.
- Prefer human-driven recording when the user can perform the operation. Let the user click; let the agent wait, record, summarize, and replay.
- Use the UI for 1-3 representative examples only. Run repeated work through the captured API operation.
- Persist raw artifacts to files. Put only compact summaries and selected candidates in model context.
- Treat cookies, bearer tokens, CSRF tokens, and intranet data as local secrets. Do not paste them into chat, logs, or final answers.
- Use selectors, URL assertions, timeouts, and state transitions owned by code. The model may choose among known actions but must not invent arbitrary browser operations.
- Do not design a strong-model/weak-model handoff. This skill is for one low-capability agent operating with deterministic guardrails.
- The required final output is a user-confirmed executable API material set plus a short invocation command, not just an endpoint guess.
- Do not generate a final business skill from the recording. Produce durable pre-skill materials that another workflow can compose into a complete skill later.
- Treat unconfirmed API chains as draft material. Do not present `operation.recipe.json` as final until API replay has run and the user has explicitly accepted the result.
- Never use weak replay anchors such as "latest task", `totalRows`, `totalCount`, timestamps, or file name alone when the system exposes a `jobId`, `taskId`, `exportId`, `requestId`, `fileId`, or `docId`.

## Material Requirements

Every recording must preserve enough local material to replay or compose the operation later:

- Interfaces: method, URL, redacted headers, payload shape, response status, response keys, file/download metadata, and request order.
- Auth: `storage-state.json`, redacted auth header names, cookie domains, CSRF-like header names, login redirects, and refresh triggers such as `401` or `403`.
- Navigation: page attachment, main-frame URL changes, popups/new pages, downloads, and `pageName` on UI actions and network events.
- Operation logic: user action timeline, API chain after each action, captured state values such as `jobId` or `downloadUrl`, and final output paths.

Keep these materials local. Summaries may mention header names and domains, but never raw token, cookie, or business data values.

## Artifact Layout

Create a run directory for every task:

```text
runs/<task-name>/
  storage-state.json        # login state, local only
  session.json              # recording scope, stop reason, pages observed
  network.jsonl             # raw API/download capture with pageName
  user-actions.jsonl        # human click/input/change/navigation timeline
  candidates.json           # compact ranked operation candidates
  replay-feasibility.json   # operation type, runner fit, anchors, auth gaps, acceptance checks
  operation.recipe.draft.json # unconfirmed API operation contract
  operation.recipe.json     # user-confirmed final API operation contract
  inputs.json               # user-specified variables for replay
  validation.json           # replay checks on 2-3 examples
  replay-acceptance.json    # explicit user acceptance of API replay
  api-materials.json        # final API material manifest
  results.jsonl             # structured batch output
  ui-replay-report.json     # best-effort visual replay report
  downloads/                # exported files
  screenshots/              # failure screenshots only
```

## Operation Discovery Workflow

1. Establish login state with Playwright and save `storage-state.json`. Do not print auth headers or cookies.
2. Translate the user's request into one concrete UI action, such as `export current report as Excel` or `search keyword and download results`.
3. If the user can operate the site manually, use Human-Driven Recording. Otherwise execute one representative UI action through the fixed state machine below.

## Human-Driven Recording

Use this as the default mode when the user can click the site faster than the agent can safely navigate it.

1. Start a headed browser recorder:

```bash
node api-replay-recorder/scripts/human-record.mjs \
  "https://internal.example.com/report" \
  runs/export-report
```

The recorder refuses to silently mix a new run with existing artifacts. If `runs/export-report` already contains recording files, it creates a timestamped sibling directory and prints the actual run directory. Use that printed directory for summarize, UI replay, and API replay commands. Pass `--append` only when intentionally continuing the same run.

2. Tell the user to complete the exact operation once, for example choose filters and click Export.
3. Wait while the script records `network.jsonl`, `user-actions.jsonl`, downloads, and `storage-state.json`.
4. End recording only when the user explicitly ends the operation by pressing Enter in the terminal, or by sending SIGINT/SIGTERM to cancel and finalize local artifacts.

5. Summarize the session:

```bash
node api-replay-recorder/scripts/summarize-network.mjs \
  runs/export-report/network.jsonl \
  runs/export-report/candidates.json \
  runs/export-report/user-actions.jsonl
```

6. Use `uiTimeline` and `actionWindows` in `candidates.json` to map the user's click to the API request chain.
7. Run the Replay Feasibility Gate below. Write `replay-feasibility.json` before writing a recipe.
8. Write `operation.recipe.draft.json`, preflight it with `scripts/validate-recipe.mjs`, then execute it with `scripts/run-operation.mjs`.
9. Show the API replay result to the user without exposing secrets. If and only if the user explicitly confirms the replay is correct, finalize the materials with `scripts/finalize-api-materials.mjs`.

## Replay Feasibility Gate

Run this gate after summarizing network evidence and before the first API replay. The goal is to decide whether the captured evidence can become a deterministic operation, not to patch errors one at a time.

Write `replay-feasibility.json` with:

```json
{
  "operationType": "async-export",
  "primaryPath": "api",
  "fallbackPath": "ui-state-machine-for-auth-or-proof",
  "runnerFit": "supported",
  "businessAnchors": ["taskId", "fileId"],
  "authModel": ["storage-state cookies", "csrf preflight"],
  "runtimeGaps": [],
  "acceptanceChecks": ["created taskId is polled", "HTTP 200", "not text/html", "file minBytes"]
}
```

Classify into one of these operation types:

- `simple-query`: one request returns the needed JSON. Usually supported by `run-operation.mjs`.
- `sync-download`: one request returns the final file. Supported only when auth and file validation are explicit.
- `async-export`: one request creates a job/task, polling waits for that same anchor, and a final request downloads the file.
- `cross-domain-download`: download uses another host or token exchange. Supported only if the token exchange is modeled as recipe steps.
- `form-submit` or `approval-flow`: submit action with durable server state. Require an idempotency or verification endpoint before replaying on real data.
- `ui-state-machine`: no stable API chain is available. Keep it as a fixed UI state machine with selectors and assertions; do not promote API materials.

Before replay, answer these questions from evidence:

- Which request is the main operation request, and which requests are bootstrap, polling, or download helpers?
- Which user inputs are business filters, and where do they appear in request payloads?
- Which runtime values must be captured and reused, such as CSRF tokens, `jobId`, `taskId`, `fileId`, `docId`, cursors, or download URLs?
- Which credentials are redacted and must be refreshed or extracted at runtime instead of copied from logs?
- What proves the replay is business-equivalent to the UI action?

Run preflight:

```bash
node api-replay-recorder/scripts/validate-recipe.mjs \
  runs/export-report/operation.recipe.draft.json \
  runs/export-report/inputs.json
```

If preflight reports unsupported templates, unsupported repeat conditions, array/filter JSONPath, missing anchors, cross-domain token gaps, or missing file validation, do not run `run-operation.mjs`. Fix the recipe or declare that the flow needs a specialized state-machine harness.

## Business Anchors and Acceptance

For async work, anchor replay on the id created by this run:

```text
create export -> capture taskId
poll list/status -> find the same taskId
wait for that row/status to succeed
capture fileId/docId/downloadUrl from that row
download -> validate file
```

Do not treat "a new row appeared", "latest row", a changed `totalRows`, or a timestamped file name as enough proof. Those are hints, not anchors.

For downloads, "a file was written" is not success. Require at least:

- Expected HTTP status, usually `200`.
- Content type not matching login/error pages such as `text/html`.
- Minimum byte size appropriate for the file.
- File type opens or parses when feasible, such as ZIP/XLSX/PDF.
- Optional business checks, such as expected headers, filter values, row count range, or selected asset/category.

## UI Replay Workflow

Use UI replay only to visibly repeat a captured browser path once. It is not a correctness proof and may click different content if the website changes, recommendations reorder, or coordinates no longer map to the same element. User acceptance of UI replay does not authorize final API materials; acceptance must be based on API replay output.

Run:

```bash
node api-replay-recorder/scripts/replay-ui.mjs \
  runs/export-report
```

Useful flags:

- `--headless`: run without a visible browser.
- `--dry-run`: print the planned navigation and actions without opening the browser.
- `--keep-open`: leave the browser open after replay for inspection.
- `--step-delay-ms=1000`: set the delay between actions.

After running, inspect `ui-replay-report.json`. If it reports skipped `ui.input` or `ui.change` actions, explain that raw input values were intentionally not stored and an API recipe or a tighter state machine is required.

## Recording Scope Boundary

Define one recording run as one user-intended operation, not one page and not one click.

In scope for one run:

- The start URL and every page, popup, redirect, tab, document request, API call, and download created inside the same browser context.
- Multi-page flows such as list page -> detail page -> export page -> download.
- Login or SSO redirects that happen inside the recording context, while keeping credentials and tokens local.
- Async operation chains such as create job -> status polling -> download.

Out of scope for one run:

- A second unrelated user goal after the first operation is complete. Start a new run for that.
- Pages opened in a different browser/profile outside the recorder context.
- Native OS dialogs and external desktop apps. Record only the resulting browser action, API request, or download.
- Raw secrets or business data copied into summaries.

If the user performs extra unrelated clicks before ending the run, keep the raw artifacts but build the recipe only from the shortest UI/API chain that satisfies the stated operation.

## Recording End Rules

Use explicit user stop only:

- Start recording before navigation and before the user performs any operation.
- Do not tell the user to click until the recorder has attached to the browser context and printed the run directory.
- Keep recording continuously while the user operates the site and while exports, async jobs, redirects, popups, polling, and downloads continue.
- End only when the user explicitly indicates this recording is finished, normally by pressing Enter in the recorder terminal.
- If this recorder is wrapped by a chat workflow, end only when the user says the current operation/recording is finished, such as "结束录制" or "本次操作完成".
- Treat SIGINT/SIGTERM as explicit user cancellation; finalize artifacts before closing.

Do not use Playwright `networkidle`, quiet-period heuristics, auto-stop timers, success toasts, downloads, or hard timeouts as recording end conditions. Long-running exports may appear idle for a long time before producing a file. Success signals are useful for later analysis, but they must not stop the recorder.

Write `session.json` with the start URL, stop reason, start/end timestamps, and observed pages. Use it later to decide whether the materials cover the whole operation.

## Multi-Page Handling

Record at the browser context level, not just the first page:

- Attach recorders to every new page from `context.on("page")`.
- Assign each page a stable `pageName` such as `page-1`, `page-2`, and include it in `user-actions.jsonl`.
- Record main-frame navigation as `ui.navigation`.
- Keep all page requests in one `network.jsonl` and all UI actions in one `user-actions.jsonl`.
- Preserve popup/download pages. Export buttons often open a new page or hidden document request before the file download starts.
- Use timestamps plus `pageName` to map user actions to API chains. If two pages are active at once, prefer events from the same `pageName`, then nearby events within the next 10 seconds.
- Do not split a cross-page flow into multiple recipes unless the user clearly performed two independent operations.

## Agent-Driven Discovery

Use this only when the user cannot manually operate the site.

1. Attach a network recorder before the action. Prefer `scripts/record-network.mjs`.
2. Execute one representative UI action through a fixed state machine:

```js
import { attachNetworkRecorder } from "./api-replay-recorder/scripts/record-network.mjs";

const recorder = attachNetworkRecorder(page, {
  outFile: "runs/export-report/network.jsonl"
});

recorder.mark("before_action", { operation: "export_report", format: "xlsx" });
await Promise.all([
  page.waitForResponse((response) =>
    ["fetch", "xhr", "document"].includes(response.request().resourceType())
  ),
  page.getByRole("button", { name: "Export" }).click()
]);
recorder.mark("after_action", { operation: "export_report" });
```

```yaml
states:
  - ensure_logged_in
  - open_target_page
  - assert_required_controls
  - set_user_inputs
  - mark_before_action
  - trigger_user_action
  - wait_for_api_or_download
  - mark_after_action
  - assert_operation_result
  - save_artifacts
```

3. Repeat for at most 2 more representative examples when variables, filters, export format, pagination, or async jobs are uncertain.
4. Summarize `network.jsonl` with `scripts/summarize-network.mjs`; inspect `candidates.json`, not the raw log.
5. Select the operation chain using the heuristics below. An operation may have multiple requests.
6. Run the Replay Feasibility Gate and write `replay-feasibility.json`.
7. Write `operation.recipe.draft.json` using `references/api-recipe.md`.
8. Preflight with `scripts/validate-recipe.mjs`, then validate replay on 1-3 known examples before running the user-requested operation.
9. Execute the operation with `scripts/run-operation.mjs` or a narrowly equivalent state-machine harness when the gate says the generic runner is not enough.
10. Ask the user to confirm whether the API replay result is correct. Finalize the API materials only after explicit confirmation.

## Low-Capability Agent Action Contract

When an LLM must control part of the UI, force it to emit only JSON matching this shape:

```json
{
  "action": "fill",
  "target": "search_input",
  "value": "example query"
}
```

Allowed actions:

- `click`
- `fill`
- `select`
- `wait_for_url`
- `wait_for_selector`
- `mark`
- `extract_text`
- `stop`

The executor must map `target` names to fixed selectors. Reject any action outside the enum, any unknown target, and any value that does not match the current state. Keep a small step budget per state and fail closed with a screenshot and network log. The agent should never receive a raw DOM dump or full HAR unless a human explicitly asks for debugging.

## Endpoint Selection Heuristics

Prefer requests that:

- Occur after `mark_before_action` and before `mark_after_action`.
- Are `fetch`, `xhr`, `document`, or a Playwright download event, not image, script, beacon, analytics, or telemetry.
- Have JSON request/response bodies, file response headers, or download metadata.
- Contain action words in the URL or payload such as `search`, `query`, `export`, `download`, `report`, `file`, `task`, `job`, `approve`, or `submit`.
- Return result-like keys such as `items`, `records`, `rows`, `list`, `data`, `total`, `page`, `jobId`, `taskId`, `downloadUrl`, `fileId`, or `status`.
- Reappear with predictable payload changes across different sample inputs.

Treat these as common operation shapes:

- Single request: click action maps to one API request and response.
- Export file: click action returns `text/csv`, Excel, PDF, octet-stream, or `content-disposition`.
- Async export: first request creates a `jobId`; later requests poll status; final request downloads a file.
- Query then export: one request loads data or filters; a later request exports the same filter payload.

Reject candidates that:

- Are static assets, tracking calls, permission heartbeats, feature flags, or menu metadata.
- Do not change when the query changes.
- Return HTML for full-page navigation unless no API endpoint exists.
- Require browser-only state that cannot be refreshed or reproduced reliably.

## Replay Workflow

Use direct HTTP replay after feasibility analysis and recipe preflight. Do not use this workflow until `replay-feasibility.json` and `operation.recipe.draft.json` exist and represent the selected API chain. This is the only replay mode that can promote API materials to final status.

1. Load auth from `storage-state.json` or a browser-refreshed session.
2. Run `scripts/validate-recipe.mjs`. Treat errors as a hard stop.
3. Build requests from `operation.recipe.draft.json`, replacing only declared input variables.
4. Run a small validation set and compare status code, returned fields, business anchors, file metadata, or known UI observations.
5. Run the user-requested operation. For batches, checkpoint after every item.
6. Show a compact replay result to the user: statuses, response keys, captured anchors, row counts, file names, file sizes, or other non-secret proof points.
7. Wait for explicit user confirmation that the API replay result is correct.
8. Finalize the materials by promoting `operation.recipe.draft.json` to `operation.recipe.json`, writing `replay-acceptance.json`, and writing `api-materials.json`.
9. Use rate limits and retries with backoff. On repeated `401`, `403`, CSRF errors, or redirect-to-login responses, refresh auth with Playwright and resume from the checkpoint.
10. Save structured responses to `results.jsonl` and exported files to `downloads/`.

Example invocation:

```bash
node api-replay-recorder/scripts/validate-recipe.mjs \
  runs/export-report/operation.recipe.draft.json \
  runs/export-report/inputs.json

node api-replay-recorder/scripts/run-operation.mjs \
  runs/export-report/operation.recipe.draft.json \
  runs/export-report/inputs.json \
  runs/export-report
```

After the user confirms the API replay is correct:

```bash
node api-replay-recorder/scripts/finalize-api-materials.mjs \
  runs/export-report \
  --user-confirmed \
  --confirmed-by=user
```

## Failure Recovery

- If no stable endpoint appears, capture another run with one changed query value and compare candidates.
- If CSRF or nonce fields differ per request, capture the page bootstrap request that creates the token and add it to the recipe preflight.
- If the endpoint paginates, identify page, cursor, offset, or limit fields before batch execution.
- If export is async, capture the create-job request, poll request, and download request as separate recipe steps, and require the poll/download chain to use this run's `jobId`, `taskId`, or equivalent anchor.
- If the download host differs from the app host, model the token exchange or download authorization as explicit steps before saving the file.
- If the browser download has no visible API body, use the download URL and response headers as the candidate operation.
- If replay returns fewer rows than the UI, check hidden filters, tenant headers, locale, date range defaults, and permission-scoping headers.
- If replay writes a tiny file or a text/HTML file, treat it as an auth/download failure, not a successful export.
- If the agent loops or clicks unrelated controls, stop the run and tighten the state machine before retrying.

## Resources

- `scripts/human-record.mjs`: open a headed browser, let the user click manually, and record UI actions, API requests, downloads, and auth state.
- `scripts/record-network.mjs`: import this helper into Playwright scripts to write structured API/download events and action markers to `network.jsonl`.
- `scripts/summarize-network.mjs`: run this on `network.jsonl` and optional `user-actions.jsonl` to produce compact ranked operation candidates and UI-to-API timelines.
- `scripts/replay-ui.mjs`: best-effort visual replay from `user-actions.jsonl`; use for "show me what I did" requests, not deterministic automation.
- `scripts/validate-recipe.mjs`: preflight a recipe before replay; it catches unsupported template expressions, unsupported repeat conditions, unsupported JSONPath, missing inputs, weak anchors, cross-host warnings, and missing file validation.
- `scripts/run-operation.mjs`: execute `operation.recipe.draft.json` or `operation.recipe.json` with user inputs and local auth state.
- `scripts/finalize-api-materials.mjs`: promote a successful API replay to final materials only after explicit user confirmation.
- `references/api-recipe.md`: read this before writing `operation.recipe.draft.json`, finalizing `operation.recipe.json`, or creating a replay harness.
