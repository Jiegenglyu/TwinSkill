# Selector and Semantic Action Rules

Use this file when converting `user-actions.jsonl` into a deterministic state machine or API recipe. Raw recorded actions are draft material, not executable automation.

## Priority Order

Use the highest stable option available:

1. Direct API or request-context execution.
2. Backend endpoint chain from `operation.recipe.draft.json`.
3. Stable DOM attributes: `data-testid`, `data-test`, `data-cy`, `name`, durable `id`.
4. Accessible selectors: role/name, label, placeholder, visible text.
5. Narrow CSS selector tied to a stable component boundary.
6. XPath.
7. Coordinate click.
8. Screenshot/OCR click.

Coordinate and image-based clicks are only acceptable for `scripts/replay-ui.mjs` visual inspection or as a last-resort discovery step. They must not become the final repeatable operation. Prefer text-only artifacts such as `*.interactive-elements.json`, `*.dom-summary.json`, and HTML snapshots over screenshot reasoning because the next agent may not be multimodal.

## Semantic Compilation

Compile human actions into business actions:

```text
recorded: click x=421,y=214; input shape length=7; click x=912,y=214; wait 3s
semantic: open asset query; fill asset id; submit query; wait for result table; open first result; read latest network record
```

For each semantic action, define:

- `state`: the current page or workflow state.
- `target`: a named target from a selector catalog.
- `action`: one enum value such as `click`, `fill`, `select`, `wait_for_selector`, or `extract_text`.
- `assertion`: the visible URL, DOM, response, download, or output that proves the action succeeded.
- `fallback`: what to do when the assertion fails.

## Prohibited Patterns

Do not compile a durable workflow from:

- Pure coordinate clicks.
- A user-controlled Chrome profile or current open browser tab.
- Maximized-window assumptions.
- Fixed sleeps such as `sleep(5)` without a business-state wait.
- Wheel scrolling to a visual position.
- OCR for ordinary text buttons.
- Element order such as "third button" or "fifth input" without a scoped stable parent.

## Selector Catalog

Keep stable target names close to the replay harness:

```json
{
  "asset_id_input": {
    "selector": "input[name=\"assetId\"]",
    "assert": "visible"
  },
  "query_button": {
    "role": "button",
    "name": "查询"
  }
}
```

Reject any model action that references an unknown target. If the target cannot be made stable, stop and ask for another recording, an API route, or a narrower state machine.
