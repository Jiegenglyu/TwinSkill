# EasySkill

EasySkill is a fake human UI operation recorder for LLM agents. It captures a human browser workflow once, stores the UI and network evidence locally, and turns that evidence into reusable pre-skill materials.

The repository currently contains one skill:

- `api-replay-recorder`: records human or agent-driven web UI actions, page transitions, downloads, and API traffic.

## Positioning

This is not intended to be the final business skill. It is a pre-skill that copies a human UI operation and prepares materials for a later complete skill, for example:

- scrape data from an internal website
- export or download reports
- transform the captured data
- run analysis
- generate a final report

The key idea is to fake the human UI workflow once, then stop asking an LLM to repeatedly click around the browser. The recording produces artifacts that can be inspected, validated, replayed, or compiled into a deterministic operation.

## Workflow

1. Start a headed recorder on the target website.
2. Let the user complete one representative operation in the browser.
3. Save local artifacts under `runs/<task-name>/`.
4. Summarize the UI timeline and network traffic into operation candidates.
5. Optionally create `operation.recipe.json` for deterministic API replay.
6. Use the materials as input to a later full skill.

Typical artifacts:

```text
runs/<task-name>/
  storage-state.json
  session.json
  network.jsonl
  user-actions.jsonl
  candidates.json
  operation.recipe.json
  inputs.json
  validation.json
  results.jsonl
  downloads/
  screenshots/
```

Run artifacts are intentionally ignored by git because they can contain cookies, tokens, intranet URLs, request bodies, downloaded files, or business data.

## Usage

Install dependencies:

```bash
npm install
```

Record a human operation:

```bash
npm run record -- "https://internal.example.com/report" runs/export-report
```

Use the opened browser to complete the target operation once. Press Enter in the terminal when the operation is finished.

Summarize the captured materials:

```bash
npm run summarize -- \
  runs/export-report/network.jsonl \
  runs/export-report/candidates.json \
  runs/export-report/user-actions.jsonl
```

Replay an extracted operation:

```bash
npm run replay -- \
  runs/export-report/operation.recipe.json \
  runs/export-report/inputs.json \
  runs/export-report
```

## Design Principles

- Record the human UI workflow once; avoid repeated fragile browser automation.
- Preserve raw materials locally; expose only compact summaries to the agent.
- Keep secrets out of chat, git, prompts, and final answers.
- Prefer deterministic scripts, schemas, and state machines over open-ended browser control.
- Treat generated artifacts as pre-skill evidence for a later complete workflow.

## Repository Layout

```text
api-replay-recorder/
  SKILL.md
  agents/openai.yaml
  references/api-recipe.md
  scripts/human-record.mjs
  scripts/record-network.mjs
  scripts/summarize-network.mjs
  scripts/run-operation.mjs
```

## Status

Prototype. The recorder and replay path are implemented, but automatic recipe synthesis, full UI-vs-API equivalence checking, and robust failure recovery are still active research and engineering work.
