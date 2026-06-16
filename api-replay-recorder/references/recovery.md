# Recovery and Debugging

Use this file when preflight, recording, UI replay, or API replay fails.

## Required Failure Artifacts

On failure, preserve:

- Current URL.
- Visible text snapshot: `*.visible-text.txt`.
- Interactive element inventory: `*.interactive-elements.json`.
- DOM summary: headings, forms, tables, and page title in `*.dom-summary.json`.
- HTML snapshot for deeper selector inspection.
- Full-page screenshot when available. Treat it as optional human-facing evidence, not a required model input.
- Console and page error summary when available.
- `environment.json` or environment details.
- Relevant `network.jsonl` window around the failed action.
- Replay output or API status/body keys with secrets redacted.

Use:

```bash
node api-replay-recorder/scripts/debug-snapshot.mjs \
  "https://internal.example.com/report" \
  runs/export-report \
  --storage-state=runs/export-report/storage-state.json \
  --label=after-failure
```

## Text-Only Recovery

Assume the next agent may be text-only and unable to inspect screenshots. Use the text artifacts first:

1. Read the debug JSON to get URL, environment issues, and artifact paths.
2. Read `*.dom-summary.json` to identify the page state, headings, forms, tables, and available controls.
3. Read `*.interactive-elements.json` to rebuild selector candidates and named targets.
4. Read `*.visible-text.txt` to confirm business state, empty states, login redirects, errors, and result labels.
5. Use the HTML snapshot only when the structured summaries do not expose enough selector detail.

Do not ask a text-only agent to infer behavior from a screenshot. If screenshots are the only evidence, rerun `scripts/debug-snapshot.mjs` to generate text artifacts.

## Common Failures

- **SSO expired**: preflight redirects to login, expected menu is missing, or API replay gets `401`/`403`. Ask the user to re-authenticate in the recorder, then rerun preflight.
- **Slow page or async export**: replace visual waiting with polling of job/status endpoints and explicit max attempts.
- **No query results**: record empty-state DOM and response keys; treat this as a valid business outcome when the API proves zero rows.
- **Pagination changed**: identify cursor, offset, page, size, or total fields before batch replay.
- **Popup or modal blocked**: record at browser-context level and assert the popup page or modal DOM before acting.
- **DOM changed**: rebuild selector catalog from recorded selector hints and new DOM; do not fall back to permanent coordinates.
- **Download failed**: inspect download event, content-disposition, status code, file size, and final URL.
- **Replay returns fewer rows than UI**: compare hidden filters, tenant headers, locale, date defaults, and permission-scoping headers.

## Stop Conditions

Stop instead of improvising when:

- The action cannot be expressed with stable selectors, API steps, and assertions.
- The model would need a raw DOM dump to guess the next click repeatedly.
- More than three retries produce different failure modes.
- Secrets would need to be pasted into chat or committed to the skill.
