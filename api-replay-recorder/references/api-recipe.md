# Operation Recipe Format

Use this file when writing `operation.recipe.draft.json` after selecting captured API requests for a user operation. A recipe represents an executable operation, not just a single endpoint. Promote it to `operation.recipe.json` only after API replay succeeds and the user explicitly confirms that the replay result is correct.

Before writing the recipe, create `replay-feasibility.json` from `SKILL.md` and decide whether the generic runner can execute the flow. Recording evidence is not enough: the recipe must model the mechanism needed for replay, including auth refresh, runtime tokens, business anchors, polling, download authorization, and acceptance checks.

## Required Shape

```json
{
  "name": "export-report",
  "purpose": "Export the current report as an Excel file.",
  "operationType": "async-export",
  "primaryPath": "api",
  "fallbackPath": "ui-state-machine-for-auth-or-proof",
  "auth": {
    "storageState": "storage-state.json",
    "refreshWithPlaywright": true
  },
  "inputs": {
    "startDate": { "type": "string", "source": "user" },
    "endDate": { "type": "string", "source": "user" },
    "format": { "type": "string", "default": "xlsx" }
  },
  "steps": [
    {
      "id": "start_export",
      "request": {
        "method": "POST",
        "url": "https://internal.example.com/api/reports/export",
        "headers": {
          "content-type": "application/json"
        },
        "body": {
          "startDate": "${input.startDate}",
          "endDate": "${input.endDate}",
          "format": "${input.format}"
        }
      },
      "expect": { "status": 200 },
      "capture": {
        "jobId": "$.data.jobId"
      }
    },
    {
      "id": "poll_export",
      "repeat": {
        "maxAttempts": 30,
        "delayMs": 1000,
        "until": { "path": "$.data.status", "equals": "DONE" }
      },
      "request": {
        "method": "GET",
        "url": "https://internal.example.com/api/reports/export/${state.jobId}/status"
      },
      "expect": { "status": 200 },
      "capture": {
        "downloadUrl": "$.data.downloadUrl"
      }
    },
    {
      "id": "download_file",
      "request": {
        "method": "GET",
        "url": "${state.downloadUrl}"
      },
      "expect": {
        "status": 200,
        "rejectContentTypes": ["text/html"],
        "minBytes": 10000
      },
      "output": {
        "type": "file",
        "path": "downloads/report-${input.startDate}-${input.endDate}.xlsx",
        "minBytes": 10000,
        "rejectContentTypes": ["text/html"]
      }
    }
  ],
  "failureHandling": {
    "refreshAuthOn": [401, 403, "redirect_to_login"],
    "retry": { "maxAttempts": 3, "backoffMs": 1000 }
  },
  "rateLimit": {
    "concurrency": 1,
    "delayMs": 300
  },
  "outputs": {
    "resultLog": "results.jsonl"
  },
  "acceptance": {
    "requiresUserConfirmation": true,
    "businessAnchors": ["jobId"],
    "proofPoints": [
      "poll_export waits for the jobId captured by start_export",
      "download_file returns HTTP 200",
      "download_file content-type is not text/html",
      "downloaded file is at least 10000 bytes"
    ]
  }
}
```

## Rules

- Keep secrets out of the recipe. Load cookies and tokens from local auth state or runtime extraction.
- Declare every user-controlled value under `inputs`.
- Represent multi-request operations as ordered `steps`.
- Set `operationType` to `simple-query`, `sync-download`, `async-export`, `cross-domain-download`, `form-submit`, `approval-flow`, or `ui-state-machine`.
- Use `capture` to save values needed by later steps, such as `jobId`, `taskId`, `exportId`, `requestId`, `fileId`, `docId`, `downloadUrl`, CSRF tokens, or cursor values.
- For async export, the polling and download steps must use the id captured from this run. Do not use latest row, total count, or timestamp alone as the anchor.
- Use `repeat` for polling and pagination. Keep explicit max attempts. `run-operation.mjs` only supports `until.path` with either `equals` or `exists`.
- Use only simple dot JSON paths such as `$.data.jobId` or `$.headers.content-disposition`. The generic runner does not support array filters, bracket syntax, `minimum`, `contains`, or arbitrary expressions.
- Use only template expressions supported by the generic runner: `${input.name}`, `${state.name}`, and `${env.NAME}`. Precompute timestamps, JSON strings, or derived payloads into `inputs.json`.
- Use `output.type: "file"` for exports and downloads, and include file validation through `expect.minBytes`, `expect.rejectContentTypes`, or equivalent output fields.
- Include enough validation examples in the run directory to prove the recipe executes the same operation the UI performed.
- Prefer replay with the browser's storage state or request context over manually copying cookies into code.
- Model runtime tokens explicitly. If CSRF, nonce, or download tokens were redacted during recording, add a preflight/bootstrap step that captures the fresh value and apply it through `${state.tokenName}`.
- For cross-domain downloads, include the token exchange or authorization request. A raw browser-only download URL is not a stable recipe unless the required auth can be reproduced.
- If the recipe needs array filtering, row matching, token exchange not representable as steps, or file parsing beyond basic checks, declare a runtime gap in `replay-feasibility.json` and create a narrow state-machine harness instead of forcing the generic runner.
- Treat `operation.recipe.draft.json` as an unverified hypothesis. Do not publish final API materials until `scripts/finalize-api-materials.mjs` records explicit user acceptance.

## Preflight

Run the validator before replay:

```bash
node api-replay-recorder/scripts/validate-recipe.mjs \
  runs/export-report/operation.recipe.draft.json \
  runs/export-report/inputs.json
```

Treat validator errors as hard stops. Warnings are usually acceptable only when `replay-feasibility.json` explains the missing piece and the replay acceptance checks still prove business equivalence.
