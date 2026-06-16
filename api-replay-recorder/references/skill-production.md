# Skill Production From a Recording Run

Use this file only after a run is verified and `run-manifest.json` has status `skill-ready`.

## Inputs

Use these files as source material:

- `run-manifest.json`: run id, status, source URL, actual run directory, and readiness.
- `skill-brief.md`: concise human-readable summary for the generated Skill author.
- `skill-seed.json`: structured operation contract and safety guidance.
- `operation.recipe.json`: verified API operation or executable contract.
- `api-materials.json`: final material manifest and supporting evidence list.
- `results.jsonl`: replay proof points and output metadata.
- `validation.json` when present: known examples and acceptance checks.

## Output Goal

Generate a separate formal Skill with its own:

- `SKILL.md` describing when to use the generated Skill.
- `scripts/` runner when deterministic execution is required.
- `references/` for sanitized API or workflow details.
- Validation command or fixture that proves the Skill still executes the verified operation.

The generated Skill should encode the business operation, not the original human clicks.

## Exclusions

Do not copy these into the generated Skill unless the user explicitly requests a private local-only Skill and accepts the risk:

- `storage-state.json`
- raw cookies, bearer tokens, CSRF tokens, or SSO artifacts
- raw `network.jsonl` with business data
- user-specific downloaded files
- screenshots or raw HTML that expose tenant data
- values from `inputs.json` that are user-specific or sensitive

Prefer schemas, variable names, redacted examples, and deterministic runners over raw captured data.

## Generation Rules

1. Confirm the source run is `skill-ready`.
2. Use `skill-seed.json` to identify the operation name, purpose, inputs, API steps, outputs, rate limits, and failure handling.
3. Convert `operation.recipe.json` into a reusable script or keep it as a recipe consumed by a script.
4. Replace sample input values with declared user inputs or safe fixtures.
5. Keep auth refresh instructions explicit and local; do not bake a user's login state into the Skill.
6. Add validation that checks statuses, response keys, row counts, file metadata, or other non-secret proof points.
7. Run the generated Skill on a fixture or approved live example before considering it complete.
