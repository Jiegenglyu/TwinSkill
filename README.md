# EasySkill

EasySkill is a human UI operation recorder for LLM agents. It records one browser workflow per isolated run, stores UI and network evidence locally, verifies deterministic API replay when possible, and turns the verified run into skill-ready materials.

The repository currently contains one skill:

- `api-replay-recorder`: records human or agent-driven web UI actions, page transitions, downloads, selectors, environment fingerprints, and API traffic.

## Positioning

This is a recorder and Skill-production precursor. It copies one human UI operation into a managed run directory and prepares verified materials for a later complete Skill, for example:

- scrape data from an internal website
- export or download reports
- transform the captured data
- run analysis
- generate a final report

The key idea is to record the human UI workflow once, then stop asking an LLM to repeatedly click around the browser. Each recording is managed separately through `run-manifest.json`. After API replay succeeds and the user explicitly confirms the result, the run is marked `skill-ready` and produces `api-materials.json`, `skill-seed.json`, and `skill-brief.md` for a later Skill-generation workflow.

## Workflow

1. Optionally run preflight against the target website to verify the standard browser environment, login state, and expected page controls.
2. Start a headed recorder on the target website.
3. Let the user complete one representative operation in the browser.
4. Save local artifacts under a separate `runs/<task-name>/` directory.
5. Summarize the UI timeline and network traffic into operation candidates.
6. Compile the recording into semantic actions or `operation.recipe.draft.json`.
7. Run API replay and show the non-secret result summary to the user.
8. After explicit user confirmation, promote the draft recipe, write final API materials, and mark the run as `skill-ready`.
9. Use `skill-seed.json` and `skill-brief.md` as input to a later formal Skill.

Typical artifacts:

```text
runs/<task-name>/
  run-manifest.json
  storage-state.json
  session.json
  network.jsonl
  user-actions.jsonl
  environment.json
  preflight.json
  candidates.json
  operation.recipe.draft.json
  operation.recipe.json
  inputs.json
  validation.json
  replay-acceptance.json
  api-materials.json
  skill-seed.json
  skill-brief.md
  results.jsonl
  ui-replay-report.json
  downloads/
  screenshots/
  debug-snapshots/
```

Run artifacts are intentionally ignored by git because they can contain cookies, tokens, intranet URLs, request bodies, downloaded files, or business data.

## Installation

This repository can be used by Codex, OpenCode, Claude Code, Cursor-style agents, or any local AI agent that can read a folder of instructions and run shell commands.

The skill itself is the folder:

```text
api-replay-recorder/
```

The important entrypoint for an AI agent is:

```text
api-replay-recorder/SKILL.md
```

### For Any AI Agent

Tell the agent to clone the repo, install dependencies from the repo root, and either load `api-replay-recorder/SKILL.md` directly or copy/symlink the `api-replay-recorder` folder into its own skill/instruction directory.

Agent-facing install prompt:

```text
Install the EasySkill api-replay-recorder skill.

1. Clone https://github.com/Jiegenglyu/EasySkill.git.
2. Run npm install from the repository root.
3. Use api-replay-recorder/SKILL.md as the skill entrypoint.
4. If your environment has a skills directory, install the whole api-replay-recorder folder there by copy or symlink.
5. Keep runs/, storage-state.json, network.jsonl, user-actions.jsonl, downloads/, cookies, tokens, CSRF values, and intranet data local. Do not commit or paste them into chat.
```

Manual install:

```bash
git clone https://github.com/Jiegenglyu/EasySkill.git ~/.easyskill
npm --prefix ~/.easyskill install
```

If your agent supports a skill directory, install the skill folder into that directory:

```bash
mkdir -p ~/.agent-skills
ln -sfn ~/.easyskill/api-replay-recorder ~/.agent-skills/api-replay-recorder
```

Replace `~/.agent-skills` with the path your agent uses. If your agent does not follow symlinks, copy the folder instead:

```bash
mkdir -p ~/.agent-skills
cp -R ~/.easyskill/api-replay-recorder ~/.agent-skills/api-replay-recorder
```

For agents without a native skill directory, keep the repository cloned and ask the agent to read `~/.easyskill/api-replay-recorder/SKILL.md` before using the scripts.

### For Codex

For Codex, run:

```bash
git clone https://github.com/Jiegenglyu/EasySkill.git "${CODEX_HOME:-$HOME/.codex}/easyskill"
npm --prefix "${CODEX_HOME:-$HOME/.codex}/easyskill" install

mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -sfn \
  "${CODEX_HOME:-$HOME/.codex}/easyskill/api-replay-recorder" \
  "${CODEX_HOME:-$HOME/.codex}/skills/api-replay-recorder"
```

Restart Codex after installation. The skill should be available as:

```text
$api-replay-recorder
```

Quick verification:

```bash
test -f ~/.easyskill/api-replay-recorder/SKILL.md
node --check ~/.easyskill/api-replay-recorder/scripts/runtime-profile.mjs
node --check ~/.easyskill/api-replay-recorder/scripts/preflight.mjs
node --check ~/.easyskill/api-replay-recorder/scripts/human-record.mjs
node --check ~/.easyskill/api-replay-recorder/scripts/replay-ui.mjs
node --check ~/.easyskill/api-replay-recorder/scripts/finalize-api-materials.mjs
```

To update later:

```bash
git -C ~/.easyskill pull
npm --prefix ~/.easyskill install
```

The symlink install keeps the repository layout intact, so the skill can find its bundled scripts while the Node dependency is installed once at the repository root.

## Usage

Install dependencies:

```bash
npm install
```

The commands below assume the current working directory is the cloned `EasySkill` repository root.

Preflight a target page before a fragile workflow:

```bash
npm run preflight -- \
  "https://internal.example.com/report" \
  runs/export-report \
  --expect-text="Report"
```

Record a human operation:

```bash
npm run record -- "https://internal.example.com/report" runs/export-report
```

Use the opened browser to complete the target operation once. Press Enter in the terminal when the operation is finished.

The recorder will not silently append to an existing run that already has artifacts. It creates a timestamped sibling directory and prints the actual run directory. Use that printed directory in later commands. Pass `--append` only when intentionally continuing the same run.

Summarize the captured materials:

```bash
npm run summarize -- \
  runs/export-report/network.jsonl \
  runs/export-report/candidates.json \
  runs/export-report/user-actions.jsonl
```

Replay the visible UI path once from `user-actions.jsonl`:

```bash
npm run replay-ui -- runs/export-report
```

This is best-effort: it first tries recorded selector hints and falls back to recorded coordinates. It is useful for showing "what I did" once, but it is not a deterministic API replay and it does not authorize final API or Skill materials.

Replay an extracted API operation from a draft recipe:

```bash
npm run replay -- \
  runs/export-report/operation.recipe.draft.json \
  runs/export-report/inputs.json \
  runs/export-report
```

After the user explicitly confirms that the API replay result is correct, finalize the API materials:

```bash
npm run finalize-api -- \
  runs/export-report \
  --user-confirmed \
  --confirmed-by=user
```

Finalization writes:

- `operation.recipe.json`: verified operation recipe
- `replay-acceptance.json`: explicit acceptance record
- `api-materials.json`: verified material manifest
- `skill-seed.json`: structured input for generating a formal Skill
- `skill-brief.md`: human-readable Skill production brief
- `run-manifest.json`: updated to `skill-ready`

Capture text-first debug evidence when a workflow fails:

```bash
npm run debug-snapshot -- \
  "https://internal.example.com/report" \
  runs/export-report \
  --storage-state=runs/export-report/storage-state.json \
  --label=after-failure
```

The debug snapshot writes visible text, interactive element inventory, DOM summary, HTML, environment details, and an optional screenshot. It is designed to be useful even when the next model cannot inspect images.

## Design Principles

- Record the human UI workflow once; avoid repeated fragile browser automation.
- Manage every recording as a separate run; never mix unrelated operations in one run directory.
- Standardize Playwright Chromium at `1920 x 1080`, device scale factor `1`, `zh-CN`, and `Asia/Shanghai`.
- Preserve raw materials locally; expose only compact summaries to the agent.
- Keep secrets out of chat, git, prompts, and final answers.
- Prefer deterministic scripts, schemas, and state machines over open-ended browser control.
- Treat API replay as the correctness gate; UI replay is visual inspection only.
- Require explicit user confirmation before promoting draft API materials.
- Treat `skill-seed.json` and `skill-brief.md` as the handoff into a later formal Skill.

## Repository Layout

```text
api-replay-recorder/
  SKILL.md
  agents/openai.yaml
  references/environment.md
  references/selectors.md
  references/api-strategy.md
  references/api-recipe.md
  references/recovery.md
  references/skill-production.md
  scripts/runtime-profile.mjs
  scripts/preflight.mjs
  scripts/debug-snapshot.mjs
  scripts/human-record.mjs
  scripts/record-network.mjs
  scripts/summarize-network.mjs
  scripts/replay-ui.mjs
  scripts/run-operation.mjs
  scripts/finalize-api-materials.mjs
```

## Status

Prototype. The recorder, standard runtime, preflight, text-first debug snapshots, UI replay, API replay finalization, and Skill seed generation are implemented. Automatic recipe synthesis, full UI-vs-API equivalence checking, and broad enterprise recovery remain active research and engineering work.
