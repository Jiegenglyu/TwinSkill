import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join, relative, resolve } from "node:path";

const [, , runDirArg, ...flags] = process.argv;

if (!runDirArg) {
  console.error("Usage: node finalize-api-materials.mjs <run-dir> --user-confirmed [--confirmed-by=user] [--note='...'] [--overwrite-final]");
  process.exit(2);
}

function hasFlag(name) {
  return flags.includes(name);
}

function flagValue(name, fallback = null) {
  const prefix = `${name}=`;
  const inline = flags.find((flag) => flag.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = flags.indexOf(name);
  if (index !== -1 && flags[index + 1] && !flags[index + 1].startsWith("--")) {
    return flags[index + 1];
  }
  return fallback;
}

function fail(message) {
  console.error(`Cannot finalize API materials: ${message}`);
  process.exit(1);
}

function requireFile(path, label) {
  if (!existsSync(path)) fail(`missing ${label}: ${path}`);
  if (!statSync(path).isFile()) fail(`${label} is not a file: ${path}`);
}

function requireNonEmptyFile(path, label) {
  requireFile(path, label);
  if (statSync(path).size === 0) fail(`${label} is empty: ${path}`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function listFiles(directory, root = directory) {
  if (!existsSync(directory)) return [];
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(path, root));
    } else if (entry.isFile()) {
      out.push(relative(root, path));
    }
  }
  return out.sort();
}

if (!hasFlag("--user-confirmed")) {
  fail("explicit user confirmation is required. Re-run with --user-confirmed only after the user confirms the API replay result is correct.");
}

const runDir = resolve(runDirArg);
if (!existsSync(runDir) || !statSync(runDir).isDirectory()) {
  fail(`run directory does not exist: ${runDir}`);
}

const draftRecipePath = join(runDir, "operation.recipe.draft.json");
const finalRecipePath = join(runDir, "operation.recipe.json");
const inputsPath = join(runDir, "inputs.json");
const resultsPath = join(runDir, "results.jsonl");
const acceptancePath = join(runDir, "replay-acceptance.json");
const manifestPath = join(runDir, "api-materials.json");
const runManifestPath = join(runDir, "run-manifest.json");
const skillSeedPath = join(runDir, "skill-seed.json");
const skillBriefPath = join(runDir, "skill-brief.md");

requireFile(inputsPath, "inputs.json");
requireNonEmptyFile(resultsPath, "results.jsonl");

const hasDraftRecipe = existsSync(draftRecipePath);
const hasFinalRecipe = existsSync(finalRecipePath);
if (!hasDraftRecipe && !hasFinalRecipe) {
  fail("missing operation.recipe.draft.json or operation.recipe.json");
}

let promotedFrom = null;
if (hasDraftRecipe) {
  readJson(draftRecipePath, "operation.recipe.draft.json");
  if (hasFinalRecipe) {
    const draftText = readFileSync(draftRecipePath, "utf8");
    const finalText = readFileSync(finalRecipePath, "utf8");
    if (draftText !== finalText && !hasFlag("--overwrite-final")) {
      fail("operation.recipe.json already exists and differs from operation.recipe.draft.json. Use --overwrite-final only if this promotion is intentional.");
    }
  }
  copyFileSync(draftRecipePath, finalRecipePath);
  promotedFrom = "operation.recipe.draft.json";
} else {
  readJson(finalRecipePath, "operation.recipe.json");
  promotedFrom = "operation.recipe.json";
}

const recipe = readJson(finalRecipePath, "operation.recipe.json");
const inputs = readJson(inputsPath, "inputs.json");
const runManifest = existsSync(runManifestPath) ? readJson(runManifestPath, "run-manifest.json") : null;
const inputSampleShape = Object.fromEntries(
  Object.entries(inputs || {}).map(([key, value]) => [key, {
    type: Array.isArray(value) ? "array" : typeof value,
    empty: value == null || value === "" || (Array.isArray(value) && value.length === 0)
  }])
);

const confirmedBy = flagValue("--confirmed-by", "user");
const note = flagValue("--note", null);
const acceptedAt = new Date().toISOString();
const optionalFiles = [
  "run-manifest.json",
  "environment.json",
  "storage-state.json",
  "session.json",
  "network.jsonl",
  "user-actions.jsonl",
  "candidates.json",
  "validation.json",
  "ui-replay-report.json"
].filter((name) => existsSync(join(runDir, name)));

const downloads = listFiles(join(runDir, "downloads"), runDir);
const acceptance = {
  status: "verified",
  replayMode: "api",
  acceptedByUser: true,
  confirmedBy,
  acceptedAt,
  note,
  promotedFrom,
  proof: {
    recipe: "operation.recipe.json",
    inputs: "inputs.json",
    replayResults: "results.jsonl",
    downloads
  }
};

const manifest = {
  status: "verified",
  generatedAt: acceptedAt,
  replayMode: "api",
  userAcceptedReplay: true,
  runId: runManifest?.runId || null,
  recipeName: recipe.name || null,
  purpose: recipe.purpose || null,
  finalMaterials: {
    recipe: "operation.recipe.json",
    inputs: "inputs.json",
    replayAcceptance: "replay-acceptance.json",
    replayResults: "results.jsonl",
    downloads,
    skillSeed: "skill-seed.json",
    skillBrief: "skill-brief.md"
  },
  supportingEvidence: optionalFiles,
  skillProduction: {
    status: "skill-ready",
    seed: "skill-seed.json",
    brief: "skill-brief.md",
    instruction: "Use these files as input to a separate skill-creation workflow. Keep local secrets out of the generated skill."
  },
  safety: {
    keepLocal: [
      "storage-state.json",
      "network.jsonl",
      "user-actions.jsonl",
      "downloads/"
    ],
    doNotPasteSecrets: true
  }
};

const skillSeed = {
  schemaVersion: 1,
  status: "skill-ready",
  generatedAt: acceptedAt,
  sourceRun: {
    runId: runManifest?.runId || null,
    runDir,
    startUrl: runManifest?.startUrl || null,
    purpose: recipe.purpose || null
  },
  operation: {
    name: recipe.name || null,
    purpose: recipe.purpose || null,
    inputs: recipe.inputs || {},
    sampleInputShape: inputSampleShape,
    steps: (recipe.steps || []).map((step) => ({
      id: step.id,
      method: step.request?.method || "GET",
      url: step.request?.url || null,
      expects: step.expect || {},
      captures: Object.keys(step.capture || {}),
      output: step.output || null,
      repeat: step.repeat || null
    })),
    rateLimit: recipe.rateLimit || null,
    failureHandling: recipe.failureHandling || null
  },
  reusableArtifacts: {
    recipe: "operation.recipe.json",
    inputs: "inputs.json",
    results: "results.jsonl",
    apiMaterials: "api-materials.json",
    replayAcceptance: "replay-acceptance.json",
    candidates: existsSync(join(runDir, "candidates.json")) ? "candidates.json" : null,
    validation: existsSync(join(runDir, "validation.json")) ? "validation.json" : null,
    environment: existsSync(join(runDir, "environment.json")) ? "environment.json" : null
  },
  skillCreationGuidance: {
    suggestedSkillName: recipe.name || "recorded-operation",
    includeInGeneratedSkill: [
      "operation intent and input schema",
      "sanitized operation recipe or equivalent deterministic runner",
      "validation checks based on replay results",
      "failure handling and auth refresh instructions"
    ],
    keepOutOfGeneratedSkill: [
      "storage-state.json",
      "raw cookies, bearer tokens, CSRF tokens",
      "raw network logs with business data",
      "user-specific downloaded files unless explicitly requested"
    ]
  },
  safety: manifest.safety
};

const skillBrief = `# Skill Production Brief

Status: skill-ready
Generated at: ${acceptedAt}
Source run: ${runManifest?.runId || "unknown"}
Operation: ${recipe.name || "unnamed-operation"}

## Purpose

${recipe.purpose || "No purpose provided in operation.recipe.json."}

## Inputs

\`\`\`json
${JSON.stringify(recipe.inputs || {}, null, 2)}
\`\`\`

## Reusable Files

- \`operation.recipe.json\`: verified API operation.
- \`inputs.json\`: sample replay inputs.
- \`results.jsonl\`: proof that replay ran.
- \`api-materials.json\`: verified material manifest.
- \`skill-seed.json\`: structured seed for generating a formal Skill.

## Skill Creation Notes

Use this run as source material for a separate Skill. Keep secrets and user-specific state local; do not copy \`storage-state.json\`, raw cookies, bearer tokens, CSRF tokens, or raw business data into the generated Skill.
`;

const updatedRunManifest = {
  ...(runManifest || {
    schemaVersion: 1,
    runId: null,
    runDir
  }),
  status: "skill-ready",
  stage: "skill-ready",
  updatedAt: acceptedAt,
  verifiedAt: acceptedAt,
  apiReplayAccepted: true,
  skillProduction: {
    status: "skill-ready",
    seedFile: "skill-seed.json",
    briefFile: "skill-brief.md",
    apiMaterials: "api-materials.json"
  }
};

mkdirSync(runDir, { recursive: true });
writeFileSync(acceptancePath, `${JSON.stringify(acceptance, null, 2)}\n`);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(skillSeedPath, `${JSON.stringify(skillSeed, null, 2)}\n`);
writeFileSync(skillBriefPath, `${skillBrief}\n`);
writeFileSync(runManifestPath, `${JSON.stringify(updatedRunManifest, null, 2)}\n`);

console.log(JSON.stringify({
  ok: true,
  runDir,
  recipe: finalRecipePath,
  acceptance: acceptancePath,
  manifest: manifestPath,
  skillSeed: skillSeedPath,
  skillBrief: skillBriefPath
}, null, 2));
