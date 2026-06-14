# Operation Recipe Format

Use this file when writing `operation.recipe.draft.json` after selecting captured API requests for a user operation. A recipe represents an executable operation, not just a single endpoint. Promote it to `operation.recipe.json` only after API replay succeeds and the user explicitly confirms that the replay result is correct.

## Required Shape

```json
{
  "name": "export-report",
  "purpose": "Export the current report as an Excel file.",
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
      "expect": { "status": 200 },
      "output": {
        "type": "file",
        "path": "downloads/report-${input.startDate}-${input.endDate}.xlsx"
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
  }
}
```

## Rules

- Keep secrets out of the recipe. Load cookies and tokens from local auth state or runtime extraction.
- Declare every user-controlled value under `inputs`.
- Represent multi-request operations as ordered `steps`.
- Use `capture` to save values needed by later steps, such as `jobId`, `fileId`, `downloadUrl`, CSRF tokens, or cursor values.
- Use `repeat` for polling and pagination. Keep explicit max attempts.
- Use `output.type: "file"` for exports and downloads.
- Include enough validation examples in the run directory to prove the recipe executes the same operation the UI performed.
- Prefer replay with the browser's storage state or request context over manually copying cookies into code.
- Treat `operation.recipe.draft.json` as an unverified hypothesis. Do not publish final API materials until `scripts/finalize-api-materials.mjs` records explicit user acceptance.
