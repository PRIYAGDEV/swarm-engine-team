/**
 * Stage 1 test suite for Swarm Engine Team.
 * Covers:
 *   - 3-pane stub CLI test with 3 different fake model names (Requirement 6)
 *   - Parent shell model env stripping & per-pane isolation (Requirement 4)
 *   - Preset schema & verification status checks (Requirement 3)
 *   - `swarm doctor` collision failure and `swarm --dry-run` (Requirement 5)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { normalizePaneConfigs, loadSwarmConfig } from "../src/config.js";
import { buildLaunchCommand, buildAllLaunchCommands } from "../src/launch-builder.js";
import { listPresetNames, loadPreset } from "../src/presets.js";
import { GLOBAL_MODEL_ENV_VARS } from "../src/env.js";
import { runDoctor, validatePaneLaunches } from "../src/doctor.js";
import { runDryRun } from "../src/dry-run.js";
import { startSwarmLayout, stopSwarmLayout, formatPaneTitle } from "../src/layout.js";
import { findWezTerm, listWezTermPanes } from "../src/wezterm.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const STUB_CLI_PATH = path.join(__dirname, "stub-cli.js");

/**
 * Spawn a built pane launch descriptor and collect exit code + stdout/stderr.
 * @param {object} launch
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runPaneProcess(launch) {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: { ...launch.env },
      shell: false
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

test("3 panes with 3 different fake models each print only their own model via stub CLI", async (t) => {
  // Pollute parent shell environment to prove panes do NOT inherit parent model env vars.
  const previousEnv = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    KILO_MODEL: process.env.KILO_MODEL,
    MODEL: process.env.MODEL
  };

  process.env.ANTHROPIC_MODEL = "parent-leaked-anthropic-model";
  process.env.OPENAI_MODEL = "parent-leaked-openai-model";
  process.env.KILO_MODEL = "parent-leaked-kilo-model";
  process.env.MODEL = "parent-leaked-generic-model";

  try {
    const rawConfig = {
      default_cli: "custom",
      orchestrator: {
        cli: "custom",
        command: process.execPath,
        base_args: [STUB_CLI_PATH, "--pane-id", "orchestrator"],
        model_flag: "--model",
        model: "fake-model-orchestrator-v1"
      },
      workers: [
        {
          cli: "custom",
          command: process.execPath,
          base_args: [STUB_CLI_PATH, "--pane-id", "worker-1"],
          model_flag: "--model",
          model: "fake-model-worker-alpha-v2"
        },
        {
          cli: "custom",
          command: process.execPath,
          base_args: [STUB_CLI_PATH, "--pane-id", "worker-2"],
          model_flag: "--model",
          model: "fake-model-worker-beta-v3"
        }
      ]
    };

    const panes = normalizePaneConfigs(rawConfig, REPO_ROOT);
    assert.equal(panes.length, 3);

    const launches = buildAllLaunchCommands(panes);
    assert.equal(launches.length, 3);

    // Run all 3 panes concurrently to verify zero shared state or cross-pane leakage.
    const results = await Promise.all(launches.map((launch) => runPaneProcess(launch)));

    const expectedModels = [
      "fake-model-orchestrator-v1",
      "fake-model-worker-alpha-v2",
      "fake-model-worker-beta-v3"
    ];
    const expectedIds = ["orchestrator", "worker-1", "worker-2"];

    for (let i = 0; i < 3; i += 1) {
      const res = results[i];
      assert.equal(res.code, 0, `Pane ${expectedIds[i]} exited with ${res.code}: ${res.stderr}`);

      const lines = res.stdout.split(/\r?\n/);
      t.diagnostic(`[${expectedIds[i]}] ${lines[0]}`);
      const parsed = JSON.parse(lines[lines.length - 1]);

      assert.equal(parsed.paneId, expectedIds[i]);
      assert.equal(parsed.model, expectedModels[i]);
      assert.deepEqual(parsed.leakedVars, []);

      // Verify this pane did NOT receive either of the other panes' models.
      for (let j = 0; j < 3; j += 1) {
        if (i !== j) {
          assert.equal(
            res.stdout.includes(expectedModels[j]),
            false,
            `Pane ${expectedIds[i]} unexpectedly contained model ${expectedModels[j]}`
          );
        }
      }
    }
  } finally {
    // Restore parent process.env cleanly.
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("buildLaunchCommand isolates per-pane state and strips all parent model env vars", () => {
  const saved = {};
  for (const key of GLOBAL_MODEL_ENV_VARS) {
    saved[key] = process.env[key];
    process.env[key] = `leaked-${key}`;
  }

  try {
    const mutablePaneA = {
      id: "pane-a",
      cli: "claude",
      model: "fake-claude-model-A",
      args: ["--verbose"]
    };
    const mutablePaneB = {
      id: "pane-b",
      cli: "kilocode",
      model: "fake-kilo-model-B"
    };

    const launchA = buildLaunchCommand(mutablePaneA);
    // Mutate caller's object after calling buildLaunchCommand to ensure defensive isolation.
    mutablePaneA.model = "mutated-after-build";
    mutablePaneA.args.push("--mutated");

    const launchB = buildLaunchCommand(mutablePaneB);

    assert.equal(launchA.model, "fake-claude-model-A");
    assert.deepEqual(launchA.args, ["--model", "fake-claude-model-A", "--verbose"]);
    assert.equal(launchB.model, "fake-kilo-model-B");
    assert.deepEqual(launchB.args, ["--model", "fake-kilo-model-B"]);
    assert.notEqual(launchA.env, launchB.env);

    for (const key of GLOBAL_MODEL_ENV_VARS) {
      assert.equal(launchA.env[key], undefined, `Expected ${key} stripped from launchA.env`);
      assert.equal(launchB.env[key], undefined, `Expected ${key} stripped from launchB.env`);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("presets directory contains all 6 CLIs with accurate local verification markers", () => {
  const names = listPresetNames();
  assert.deepEqual(names, ["aider", "claude", "codex", "gemini", "kilocode", "opencode"]);

  const expectedVerified = {
    kilocode: true,
    claude: true,
    opencode: true,
    codex: false,
    gemini: false,
    aider: false
  };

  for (const name of names) {
    const preset = loadPreset(name);
    assert.equal(typeof preset.command, "string");
    assert.equal(typeof preset.model_passing?.method, "string");
    assert.ok(preset.non_interactive);
    assert.equal(preset.verified, expectedVerified[name], `Unexpected verified flag for ${name}`);
  }
});

test("swarm doctor passes on valid config and fails loudly when panes meant to differ collide", () => {
  const logs = [];
  const validResult = runDoctor({
    configPath: path.join(REPO_ROOT, "swarm.config.json"),
    stdout: (msg) => logs.push(msg),
    stderr: (msg) => logs.push(msg)
  });

  assert.equal(validResult.exitCode, 0);
  assert.ok(logs.join("\n").includes("Doctor status: OK"));

  // Simulate two panes configured with different models that erroneously collide on the same command.
  const paneConfigs = normalizePaneConfigs(
    {
      default_cli: "claude",
      orchestrator: { cli: "claude", model: "model-alpha" },
      workers: [{ cli: "claude", model: "model-beta" }]
    },
    REPO_ROOT
  );

  // Force a simulated broken launch list where worker-1 copied orchestrator's launch command.
  const validLaunch = buildLaunchCommand(paneConfigs[0]);
  const collidedLaunches = [
    validLaunch,
    { ...validLaunch, id: "worker-1", role: "worker" }
  ];

  const validation = validatePaneLaunches(paneConfigs, collidedLaunches);
  assert.equal(validation.ok, false);
  assert.ok(
    validation.errors.some((err) => err.includes("COMMAND COLLISION")),
    `Expected COMMAND COLLISION error, got: ${validation.errors.join("; ")}`
  );
});

test("swarm --dry-run prints launch commands without spawning processes", () => {
  const configPath = path.join(REPO_ROOT, "swarm.config.json");
  const loaded = loadSwarmConfig(configPath);

  const out = [];
  const dryResult = runDryRun({
    configPath,
    stdout: (msg) => out.push(msg)
  });

  assert.equal(dryResult.exitCode, 0);
  const text = out.join("\n");
  assert.ok(text.includes("Dry Run (no processes or panes opened)"));
  for (const pane of loaded.panes) {
    if (pane.model) {
      assert.ok(
        text.includes(pane.model),
        `Expected dry-run output to include model "${pane.model}"`
      );
    }
  }
  assert.equal(dryResult.launches.length, loaded.panes.length);
});

test("Stage 2: WezTerm layout opens with stub CLI, shows distinct models per pane, and stops cleanly", async (t) => {
  const weztermPath = findWezTerm();
  if (!weztermPath) {
    t.skip("WezTerm is not installed on this system; skipping GUI layout test.");
    return;
  }

  const tempConfigPath = path.join(REPO_ROOT, ".swarm.test.config.json");
  const testConfig = {
    default_cli: "custom",
    orchestrator: {
      cli: "custom",
      command: process.execPath,
      base_args: [STUB_CLI_PATH, "--pane-id", "orchestrator", "--hold", "15000"],
      model_flag: "--model",
      model: "orch-fake-gpt-model-1"
    },
    workers: [
      {
        cli: "custom",
        command: process.execPath,
        base_args: [STUB_CLI_PATH, "--pane-id", "worker-1", "--hold", "15000"],
        model_flag: "--model",
        model: "worker1-fake-claude-model-2"
      },
      {
        cli: "custom",
        command: process.execPath,
        base_args: [STUB_CLI_PATH, "--pane-id", "worker-2", "--hold", "15000"],
        model_flag: "--model",
        model: "worker2-fake-gemini-model-3"
      },
      {
        cli: "custom",
        command: process.execPath,
        base_args: [STUB_CLI_PATH, "--pane-id", "worker-3", "--hold", "15000"],
        model_flag: "--model",
        model: "worker3-fake-qwen-model-4"
      }
    ]
  };

  fs.writeFileSync(tempConfigPath, JSON.stringify(testConfig, null, 2), "utf8");

  try {
    const logs = [];
    const startResult = await startSwarmLayout({
      configPath: tempConfigPath,
      log: (msg) => logs.push(msg)
    });

    assert.equal(startResult.ok, true);
    assert.equal(startResult.panes.length, 4);

    // Verify pane titles follow "<name> · <cli> · <model>" derived from launch command
    const expectedTitles = [
      "orchestrator · custom · orch-fake-gpt-model-1",
      "worker-1 · custom · worker1-fake-claude-model-2",
      "worker-2 · custom · worker2-fake-gemini-model-3",
      "worker-3 · custom · worker3-fake-qwen-model-4"
    ];

    const actualTitles = startResult.panes.map((p) => p.title);
    assert.deepEqual(actualTitles, expectedTitles);

    // Verify all 4 models are completely distinct
    const models = startResult.panes.map((p) => p.model);
    const uniqueModels = new Set(models);
    assert.equal(uniqueModels.size, 4);

    // Verify active panes in WezTerm
    const activePanes = await listWezTermPanes(weztermPath);
    assert.ok(activePanes.length >= 4);

    // Cleanly stop the swarm session and close all panes
    const stopResult = await stopSwarmLayout({ log: (msg) => logs.push(msg) });
    assert.equal(stopResult.ok, true);
    assert.equal(stopResult.closedCount, 4);
  } finally {
    if (fs.existsSync(tempConfigPath)) {
      fs.unlinkSync(tempConfigPath);
    }
  }
});
