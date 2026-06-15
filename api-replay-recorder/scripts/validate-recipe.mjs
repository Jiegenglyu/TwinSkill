import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SUPPORTED_TEMPLATE_SCOPES = new Set(["input", "state", "env"]);
const SUPPORTED_REPEAT_UNTIL_KEYS = new Set(["path", "equals", "exists"]);

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function walk(value, visit, path = "$") {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, visit, `${path}[${index}]`));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      walk(entry, visit, `${path}.${key}`);
    }
  }
}

function templateExpressions(value) {
  const out = [];
  walk(value, (entry, path) => {
    if (typeof entry !== "string") return;
    for (const match of entry.matchAll(/\$\{([^}]+)\}/g)) {
      out.push({ expression: match[1], path });
    }
  });
  return out;
}

function validatePath(path, location, errors) {
  if (typeof path !== "string" || !path) {
    errors.push(`${location} must be a non-empty JSON path string`);
    return;
  }
  if (path !== "$" && !path.startsWith("$.")) {
    errors.push(`${location} must start with "$" or "$."`);
  }
  if (/[\[\]\?\*]/.test(path)) {
    errors.push(`${location} uses array/filter JSONPath syntax that run-operation.mjs does not support: ${path}`);
  }
}

function validateTemplates(value, location, context, errors, warnings) {
  for (const { expression, path } of templateExpressions(value)) {
    if (expression.trim() !== expression) {
      errors.push(`${location}${path} has whitespace inside template expression: \${${expression}}`);
      continue;
    }
    const [scope, ...rest] = expression.split(".");
    const keyPath = rest.join(".");
    const topKey = rest[0];
    if (!SUPPORTED_TEMPLATE_SCOPES.has(scope)) {
      errors.push(`${location}${path} uses unsupported template expression \${${expression}}. Supported scopes: input, state, env.`);
      continue;
    }
    if (!keyPath) {
      errors.push(`${location}${path} must reference a key path, not just \${${scope}}`);
      continue;
    }
    if (scope === "input") {
      if (!context.definedInputs.has(topKey)) {
        errors.push(`${location}${path} references undeclared input "${topKey}" in \${${expression}}`);
      }
      if (context.hasInputValues && !context.providedInputs.has(topKey) && context.inputDefaults.get(topKey) == null) {
        warnings.push(`${location}${path} references input "${topKey}", but inputs.json does not provide it and no default is declared`);
      }
    }
    if (scope === "state" && !context.availableState.has(topKey)) {
      warnings.push(`${location}${path} references state "${topKey}" before any earlier capture declares it`);
    }
  }
}

function requestHost(step) {
  try {
    const url = step?.request?.url;
    if (typeof url !== "string" || url.includes("${")) return null;
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function validateRecipe(recipe, options = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];

  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    return { ok: false, errors: ["recipe must be a JSON object"], warnings, notes };
  }

  if (!recipe.name) warnings.push("recipe.name is missing");
  if (!recipe.purpose) warnings.push("recipe.purpose is missing");
  if (!recipe.operationType) {
    warnings.push("recipe.operationType is missing; classify the flow as simple-query, sync-download, async-export, cross-domain-download, form-submit, or ui-state-machine");
  }

  if (!recipe.auth?.storageState && !recipe.auth?.storage_state) {
    warnings.push("auth.storageState is missing; cookie replay will not load browser auth state");
  }
  if (recipe.auth?.refreshWithPlaywright !== true && recipe.auth?.refresh_with_playwright !== true) {
    warnings.push("auth.refreshWithPlaywright is not true; repeated 401/403/redirect-to-login failures require an explicit auth refresh path");
  }

  const inputDefaults = new Map(
    Object.entries(recipe.inputs || {}).map(([name, spec]) => [name, spec && typeof spec === "object" ? spec.default : undefined])
  );
  const context = {
    definedInputs: new Set(Object.keys(recipe.inputs || {})),
    providedInputs: new Set(Object.keys(options.input || {})),
    hasInputValues: Boolean(options.input),
    inputDefaults,
    availableState: new Set()
  };

  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    errors.push("recipe.steps must be a non-empty array");
    return { ok: false, errors, warnings, notes };
  }

  const hosts = new Set();
  const capturedByStep = [];
  const stateReferencesByStep = [];

  recipe.steps.forEach((step, index) => {
    const label = `steps[${index}]${step?.id ? ` (${step.id})` : ""}`;
    if (!step || typeof step !== "object") {
      errors.push(`${label} must be an object`);
      return;
    }
    if (!step.id) warnings.push(`${label} is missing id`);
    if (!step.request || typeof step.request !== "object") {
      errors.push(`${label} is missing request`);
    } else {
      if (!step.request.url) errors.push(`${label}.request.url is missing`);
      validateTemplates(step.request, `${label}.request`, context, errors, warnings);
      const host = requestHost(step);
      if (host) hosts.add(host);
      stateReferencesByStep.push(
        templateExpressions(step.request)
          .map(({ expression }) => expression)
          .filter((expression) => expression.startsWith("state."))
          .map((expression) => expression.split(".")[1])
      );
    }

    if (step.repeat) {
      const until = step.repeat.until;
      if (!Number.isInteger(step.repeat.maxAttempts) || step.repeat.maxAttempts < 1) {
        errors.push(`${label}.repeat.maxAttempts must be a positive integer`);
      }
      if (step.repeat.delayMs != null && (!Number.isInteger(step.repeat.delayMs) || step.repeat.delayMs < 0)) {
        errors.push(`${label}.repeat.delayMs must be a non-negative integer`);
      }
      if (!until || typeof until !== "object") {
        errors.push(`${label}.repeat.until is required for polling`);
      } else {
        for (const key of Object.keys(until)) {
          if (!SUPPORTED_REPEAT_UNTIL_KEYS.has(key)) {
            errors.push(`${label}.repeat.until uses unsupported condition key "${key}". Supported keys: path, equals, exists.`);
          }
        }
        validatePath(until.path, `${label}.repeat.until.path`, errors);
        if ("equals" in until && "exists" in until) {
          errors.push(`${label}.repeat.until must use either equals or exists, not both`);
        }
        if (!("equals" in until) && !("exists" in until)) {
          errors.push(`${label}.repeat.until must use equals or exists`);
        }
        if (/total(Row|Rows|Count)|latest|newest/i.test(String(until.path || ""))) {
          warnings.push(`${label}.repeat.until appears to poll aggregate/latest fields. Prefer polling the row matching this run's jobId/taskId/exportId.`);
        }
      }
    }

    const capturedNames = [];
    for (const [name, path] of Object.entries(step.capture || {})) {
      capturedNames.push(name);
      validatePath(path, `${label}.capture.${name}`, errors);
      if (/csrf|xsrf|token|nonce/i.test(name)) {
        notes.push(`${label} captures runtime token "${name}"; keep the value local and apply it through state templates only.`);
      }
    }
    capturedByStep.push(capturedNames);
    for (const name of capturedNames) context.availableState.add(name);

    if (step.output?.type === "file") {
      validateTemplates(step.output.path || "", `${label}.output.path`, context, errors, warnings);
      const minBytes = step.expect?.minBytes ?? step.output.minBytes;
      if (!Number.isInteger(minBytes) || minBytes < 1) {
        warnings.push(`${label} writes a file but does not declare expect.minBytes or output.minBytes`);
      }
      const rejectContentTypes = asArray(step.expect?.rejectContentTypes || step.output.rejectContentTypes);
      if (rejectContentTypes.length === 0) {
        warnings.push(`${label} writes a file but does not reject text/html or other login/error content-types`);
      }
    }
  });

  if (hosts.size > 1) {
    warnings.push(`recipe calls multiple hosts (${[...hosts].join(", ")}); model cross-domain cookies or token exchange explicitly before replay`);
  }

  const capturedAnchors = capturedByStep.flat().filter((name) => /jobId|taskId|exportId|requestId|fileId|docId/i.test(name));
  if (/(async-export|cross-domain-download)/i.test(recipe.operationType || "") && capturedAnchors.length === 0) {
    warnings.push(`${recipe.operationType} recipes should capture a business anchor such as jobId, taskId, exportId, requestId, fileId, or docId`);
  }
  for (const anchor of capturedAnchors) {
    const anchorUsedLater = stateReferencesByStep.some((refs) => refs.includes(anchor));
    if (!anchorUsedLater && !/fileId|docId/i.test(anchor)) {
      warnings.push(`captured anchor "${anchor}" is not used by a later request; avoid polling latest rows or aggregate counts instead of this run's anchor`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, notes };
}

function main() {
  const [, , recipeFile, inputsFile] = globalThis.process.argv;
  if (!recipeFile || recipeFile === "--help" || recipeFile === "-h") {
    console.error("Usage: node validate-recipe.mjs <operation.recipe.draft.json|operation.recipe.json> [inputs.json]");
    globalThis.process.exit(recipeFile ? 0 : 2);
  }

  const recipe = JSON.parse(readFileSync(resolve(recipeFile), "utf8"));
  const input = inputsFile ? JSON.parse(readFileSync(resolve(inputsFile), "utf8")) : undefined;
  const result = validateRecipe(recipe, { input });
  console.log(JSON.stringify(result, null, 2));
  globalThis.process.exit(result.ok ? 0 : 1);
}

if (globalThis.process?.argv?.[1] && import.meta.url === pathToFileURL(resolve(globalThis.process.argv[1])).href) {
  main();
}
