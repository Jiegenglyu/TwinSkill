# Standard Runtime Environment

Use this file before starting a recording, UI replay, or agent-driven Playwright discovery. The recorder is only expected to be stable in the standard runtime below.

## Required Runtime

- Browser: Playwright-managed Chromium, not the user's default Chrome profile.
- Browser context: fixed, non-maximized context created with `standardContextOptions()`.
- Viewport: `1920 x 1080`.
- Device scale factor: `1`.
- Locale: `zh-CN`.
- Timezone: `Asia/Shanghai`.
- Browser zoom: `100%`.
- Downloads: accepted into the run directory.
- User behavior: do not move the browser window, zoom the page, switch tabs for unrelated work, or operate another browser profile during recording.

The scripts enforce this through `scripts/runtime-profile.mjs`. Do not replace it with `browser.newPage()` or a default context.

## Preflight

Run preflight before fragile enterprise workflows or when reusing a saved login state:

```bash
node api-replay-recorder/scripts/preflight.mjs \
  "https://internal.example.com/report" \
  runs/export-report \
  --storage-state=runs/export-report/storage-state.json \
  --expect-text="资产管理"
```

Use `--expect-selector=<css>` for a stable known entry point. A failing preflight writes `preflight.json`, `environment.json`, text snapshots, an interactive element inventory, a DOM summary, HTML, a debug JSON snapshot, and an optional screenshot.

## SSO and Login State

For SSO, prefer:

1. First manual login inside the recorder.
2. Save `storage-state.json`.
3. Reuse it for replay or preflight.
4. Ask the user to re-authenticate when preflight detects redirect-to-login, `401`, `403`, or a missing expected menu.

Never treat `storage-state.json` as permanent. Enterprise systems may expire sessions after fixed server-side intervals even when cookies remain.
