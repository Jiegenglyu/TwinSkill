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
node --check ~/.easyskill/api-replay-recorder/scripts/human-record.mjs
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
