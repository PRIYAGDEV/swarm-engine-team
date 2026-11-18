#!/usr/bin/env node
/**
 * Stub AI CLI used in Stage 1 tests.
 * Reads the model passed via --model <id> (or STUB_MODEL env var),
 * checks for any leaked parent model environment variables, and prints
 * a deterministic JSON + human-readable line to stdout.
 */

const LEAK_CHECK_VARS = [
  "ANTHROPIC_MODEL",
  "CLAUDE_MODEL",
  "KILO_MODEL",
  "KILOCODE_MODEL",
  "OPENCODE_MODEL",
  "OPENAI_MODEL",
  "CODEX_MODEL",
  "GEMINI_MODEL",
  "AIDER_MODEL",
  "LLM_MODEL",
  "MODEL"
];

function parseStubArgs(argv) {
  let paneId = "unknown";
  let modelFromFlag = null;
  let holdMs = 0;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pane-id" && argv[i + 1]) {
      paneId = argv[i + 1];
      i += 1;
    } else if (arg === "--model" && argv[i + 1]) {
      modelFromFlag = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--model=")) {
      modelFromFlag = arg.slice("--model=".length);
    } else if (arg === "--hold") {
      holdMs = argv[i + 1] && !argv[i + 1].startsWith("-") ? parseInt(argv[i + 1], 10) : 30000;
      if (argv[i + 1] && !argv[i + 1].startsWith("-")) {
        i += 1;
      }
    }
  }

  return { paneId, modelFromFlag, holdMs };
}

const { paneId, modelFromFlag, holdMs } = parseStubArgs(process.argv.slice(2));
const model = modelFromFlag ?? process.env.STUB_MODEL ?? null;

const leakedVars = LEAK_CHECK_VARS.filter((name) => process.env[name] !== undefined);

const payload = {
  paneId,
  model,
  leakedVars
};

// Print both a clear human-readable line and structured JSON payload.
console.log(`pane=${paneId} model=${model ?? "NONE"} leaked=${leakedVars.length}`);
console.log(JSON.stringify(payload));

if (holdMs > 0) {
  setTimeout(() => {}, holdMs);
}
