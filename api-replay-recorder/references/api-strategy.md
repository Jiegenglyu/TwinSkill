# API Strategy

Use this file after summarizing `network.jsonl` and before writing `operation.recipe.draft.json`.

## API First

Prefer API replay when any of these are true:

- The operation is a search, export, approval, submit, report generation, download, pagination, or batch action.
- The same workflow must run for more than 1-3 examples.
- The UI uses async jobs, polling, or generated download URLs.
- The page layout changes across users, tenants, zoom levels, or screen sizes.

Use the UI only to discover auth, request order, dynamic tokens, and representative payloads. The durable output should be `operation.recipe.draft.json` executed by `scripts/run-operation.mjs`.

## Candidate Confirmation

Select endpoint chains that:

- Occur after a relevant user action or `mark_before_action`.
- Change predictably when the sample input changes.
- Return result-like fields, file headers, job ids, task ids, cursors, totals, rows, records, or download URLs.
- Can be replayed with declared inputs plus values captured from earlier recipe steps.

Reject endpoints that only load menus, permissions, telemetry, feature flags, static assets, or heartbeat status.

## Replace UI Waits With Business Waits

Use:

- Response status and response body assertions.
- DOM assertions such as result table visible or empty-state visible.
- Polling repeat conditions with explicit max attempts.
- Download metadata: filename, content type, byte size.

Do not use `networkidle`, quiet-period heuristics, success toasts, or fixed sleeps as proof that the operation is complete.
