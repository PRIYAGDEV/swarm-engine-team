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
import { dispatchTask, parseDispatchLine, resolveTargetWorkers } from "../src/dispatch.js";
import { loadPanesMap, getPanesFilePath } from "../src/state.js";
import { getSwarmStatus, formatStatusBar, evaluateWorkerState } from "../src/status.js";
import { checkModelCompatibility } from "../src/config.js";

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

test("presets directory contains supported CLIs including agy with accurate local verification markers", () => {
  const names = listPresetNames();
  assert.deepEqual(names, ["agy", "aider", "claude", "codex", "gemini", "kilocode", "opencode"]);

  const expectedVerified = {
    agy: true,
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

test("Stage 3: dispatch parser resolves @worker, @all, @workers 1,2,5 syntax and rejects unknown targets", () => {
  // Syntax parser tests
  const line1 = parseDispatchLine("@worker-3 optimize query");
  assert.deepEqual(line1, { target: "@worker-3", task: "optimize query" });

  const line2 = parseDispatchLine("@all git pull origin main");
  assert.deepEqual(line2, { target: "@all", task: "git pull origin main" });

  const line3 = parseDispatchLine("@workers 1, 2, 5 run integration tests");
  assert.deepEqual(line3, { target: "@workers 1,2,5", task: "run integration tests" });

  assert.equal(parseDispatchLine("no-at-sign here"), null);
  assert.equal(parseDispatchLine(""), null);

  // Target resolution tests against an active worker panesMap
  const panesMap = {
    orchestrator: 1,
    "worker-1": 2,
    "worker-2": 3,
    "worker-3": 4
  };

  assert.deepEqual(resolveTargetWorkers("@worker-3", panesMap), ["worker-3"]);
  assert.deepEqual(resolveTargetWorkers("worker-3", panesMap), ["worker-3"]);
  assert.deepEqual(resolveTargetWorkers("3", panesMap), ["worker-3"]);
  assert.deepEqual(resolveTargetWorkers("@all", panesMap), ["worker-1", "worker-2", "worker-3"]);
  assert.deepEqual(resolveTargetWorkers("@workers 1,3", panesMap), ["worker-1", "worker-3"]);
  assert.deepEqual(resolveTargetWorkers("1,2", panesMap), ["worker-1", "worker-2"]);

  // Reject unknown worker targets loudly
  assert.throws(
    () => resolveTargetWorkers("@worker-9", panesMap),
    /Unknown target: "@worker-9"/
  );
  assert.throws(
    () => resolveTargetWorkers("@workers 1,9", panesMap),
    /Unknown target: "worker-9"/
  );
  assert.throws(
    () => resolveTargetWorkers("unknown-bot", panesMap),
    /Unknown target: "unknown-bot"/
  );
});

test("Stage 3: automated task dispatch delivers to worker-3 only, then broadcasts to @all, and cleans panes.json", async (t) => {
  const weztermPath = findWezTerm();
  if (!weztermPath) {
    t.skip("WezTerm is not installed on this system; skipping dispatch test.");
    return;
  }

  const tempConfigPath = path.join(REPO_ROOT, ".swarm.test.dispatch.config.json");
  const inbox1 = path.join(REPO_ROOT, ".test-inbox-worker-1.log");
  const inbox2 = path.join(REPO_ROOT, ".test-inbox-worker-2.log");
  const inbox3 = path.join(REPO_ROOT, ".test-inbox-worker-3.log");

  for (const f of [inbox1, inbox2, inbox3]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  const testConfig = {
    default_cli: "custom",
    orchestrator: {
      cli: "custom",
      command: process.execPath,
      base_args: [STUB_CLI_PATH, "--pane-id", "orchestrator", "--hold", "20000"],
      model_flag: "--model",
      model: "orch-model"
    },
    workers: [
      {
        cli: "custom",
        command: process.execPath,
        base_args: [STUB_CLI_PATH, "--pane-id", "worker-1", "--inbox", inbox1, "--hold", "20000"],
        model_flag: "--model",
        model: "worker-1-model"
      },
      {
        cli: "custom",
        command: process.execPath,
        base_args: [STUB_CLI_PATH, "--pane-id", "worker-2", "--inbox", inbox2, "--hold", "20000"],
        model_flag: "--model",
        model: "worker-2-model"
      },
      {
        cli: "custom",
        command: process.execPath,
        base_args: [STUB_CLI_PATH, "--pane-id", "worker-3", "--inbox", inbox3, "--hold", "20000"],
        model_flag: "--model",
        model: "worker-3-model"
      }
    ]
  };

  fs.writeFileSync(tempConfigPath, JSON.stringify(testConfig, null, 2), "utf8");

  try {
    // 1. Start layout
    const startResult = await startSwarmLayout({ configPath: tempConfigPath });
    assert.equal(startResult.ok, true);

    // 2. Verify .swarm/panes.json was created and contains valid mappings
    const panesMapPath = getPanesFilePath(REPO_ROOT);
    assert.ok(fs.existsSync(panesMapPath), "Expected .swarm/panes.json to exist after layout launch");
    const panesMap = loadPanesMap(REPO_ROOT);
    assert.ok(panesMap["orchestrator"] !== undefined);
    assert.ok(panesMap["worker-1"] !== undefined);
    assert.ok(panesMap["worker-2"] !== undefined);
    assert.ok(panesMap["worker-3"] !== undefined);

    // Allow terminal panes to initialize and start stdin listeners
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 3. Dispatch task to worker-3 ONLY
    const taskWorker3 = "run-database-migration-step-4";
    const resW3 = await dispatchTask({
      target: "@worker-3",
      task: taskWorker3,
      baseDir: REPO_ROOT,
      weztermPath
    });
    assert.equal(resW3.ok, true);
    assert.equal(resW3.delivered.length, 1);
    assert.equal(resW3.delivered[0].worker, "worker-3");

    // Allow WezTerm IPC to deliver keystrokes to target pane
    await new Promise((resolve) => setTimeout(resolve, 800));

    const content1Before = fs.existsSync(inbox1) ? fs.readFileSync(inbox1, "utf8") : "";
    const content2Before = fs.existsSync(inbox2) ? fs.readFileSync(inbox2, "utf8") : "";
    const content3Before = fs.existsSync(inbox3) ? fs.readFileSync(inbox3, "utf8") : "";

    // PROVE: ONLY worker-3 received the task
    assert.equal(content1Before, "", "Worker 1 should NOT have received worker-3's task");
    assert.equal(content2Before, "", "Worker 2 should NOT have received worker-3's task");
    assert.ok(
      content3Before.includes(taskWorker3),
      `Worker 3 should have received "${taskWorker3}", got: "${content3Before}"`
    );

    // 4. Dispatch task to @all
    const taskAll = "broadcast-check-git-status";
    const resAll = await dispatchTask({
      target: "@all",
      task: taskAll,
      baseDir: REPO_ROOT,
      weztermPath
    });
    assert.equal(resAll.ok, true);
    assert.equal(resAll.delivered.length, 3);

    // Allow delivery
    await new Promise((resolve) => setTimeout(resolve, 800));

    const content1After = fs.existsSync(inbox1) ? fs.readFileSync(inbox1, "utf8") : "";
    const content2After = fs.existsSync(inbox2) ? fs.readFileSync(inbox2, "utf8") : "";
    const content3After = fs.existsSync(inbox3) ? fs.readFileSync(inbox3, "utf8") : "";

    // PROVE: Every worker received the broadcast task
    assert.ok(
      content1After.includes(taskAll),
      `Worker 1 should have received "${taskAll}", got: "${content1After}"`
    );
    assert.ok(
      content2After.includes(taskAll),
      `Worker 2 should have received "${taskAll}", got: "${content2After}"`
    );
    assert.ok(
      content3After.includes(taskAll),
      `Worker 3 should have received "${taskAll}", got: "${content3After}"`
    );
    // Worker 3 must also retain its previous task
    assert.ok(content3After.includes(taskWorker3));

    // 5. Test unknown target rejection
    await assert.rejects(
      async () => {
        await dispatchTask({
          target: "@worker-9",
          task: "this must fail",
          baseDir: REPO_ROOT,
          weztermPath
        });
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('Unknown target: "@worker-9"'));
        assert.ok(err.message.includes("Active workers: worker-1, worker-2, worker-3"));
        return true;
      }
    );

    // 6. Stop layout cleanly and verify .swarm/panes.json is deleted
    const stopResult = await stopSwarmLayout({ log: () => {} });
    assert.equal(stopResult.ok, true);
    assert.equal(fs.existsSync(panesMapPath), false, "Expected .swarm/panes.json to be deleted on stop");
  } finally {
    for (const f of [tempConfigPath, inbox1, inbox2, inbox3]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
});

test("Stage 4: flags --workers N (1-6) and --cli <name> with model compatibility warnings", () => {
  const baseConfig = {
    default_cli: "kilocode",
    orchestrator: { cli: "claude", model: "sonnet" },
    workers: [
      { cli: "kilocode", model: "river/deepseek-ai/DeepSeek-V4.1-Flash" },
      { cli: "kilocode", model: "river/Qwen/Qwen3.8-27B-FP8" },
      { cli: "kilocode", model: "river/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4" }
    ]
  };

  // 1. Test --workers N shrinks and expands worker count correctly
  const panesW1 = normalizePaneConfigs(baseConfig, REPO_ROOT, { workerCount: 1 });
  assert.equal(panesW1.filter((p) => p.role === "worker").length, 1);

  const panesW5 = normalizePaneConfigs(baseConfig, REPO_ROOT, { workerCount: 5 });
  assert.equal(panesW5.filter((p) => p.role === "worker").length, 5);

  const panesW6 = normalizePaneConfigs(baseConfig, REPO_ROOT, { workerCount: 6 });
  assert.equal(panesW6.filter((p) => p.role === "worker").length, 6);

  // Invalid worker count must reject
  assert.throws(
    () => normalizePaneConfigs(baseConfig, REPO_ROOT, { workerCount: 0 }),
    /Invalid worker count: "0"/
  );
  assert.throws(
    () => normalizePaneConfigs(baseConfig, REPO_ROOT, { workerCount: 7 }),
    /Invalid worker count: "7"/
  );

  // 2. Test --cli <name> forces CLI on all panes while preserving config models
  const warnings = [];
  const panesClaude = normalizePaneConfigs(baseConfig, REPO_ROOT, {
    forcedCli: "claude",
    onWarning: (msg) => warnings.push(msg)
  });

  for (const pane of panesClaude) {
    assert.equal(pane.cli, "claude", `Expected pane ${pane.id} to use forced cli "claude"`);
  }

  // Orchestrator model is "sonnet" (compatible with Claude, no warning)
  // Workers have "river/..." models which do NOT fit Claude -> must trigger warnings
  assert.ok(warnings.length >= 3);
  assert.ok(warnings[0].includes("may not be compatible with forced CLI \"claude\""));

  // Verify models were preserved from config and NOT silently defaulted
  assert.equal(panesClaude.find((p) => p.id === "orchestrator").model, "sonnet");
  assert.equal(
    panesClaude.find((p) => p.id === "worker-1").model,
    "river/deepseek-ai/DeepSeek-V4.1-Flash"
  );
});

test("Stage 4: state detection evaluates idle / working / done / error states accurately", () => {
  const now = 10000000;
  const stabilitySec = 3;

  // 1. Initial state (alive, no task sent yet) -> "idle"
  const sIdle = evaluateWorkerState({
    isAlive: true,
    currentText: "Ready for input\n",
    previousRecord: { lastTaskSentAt: null },
    stabilitySec,
    now
  });
  assert.equal(sIdle.state, "idle");

  // 2. Task just sent -> "working"
  const sWorking = evaluateWorkerState({
    isAlive: true,
    currentText: "Processing query...\n",
    previousRecord: {
      lastTaskSentAt: now - 1000, // 1s ago (< 3s stabilitySec)
      lastOutputHash: "hash-initial",
      lastOutputChangedAt: now - 1000
    },
    stabilitySec,
    now
  });
  assert.equal(sWorking.state, "working");

  // 3. Output actively changed -> "working"
  const sWorkingChanged = evaluateWorkerState({
    isAlive: true,
    currentText: "Processing query... 50% complete\n",
    previousRecord: {
      lastTaskSentAt: now - 5000,
      lastOutputHash: "hash-previous-diff",
      lastOutputChangedAt: now - 5000
    },
    stabilitySec,
    now
  });
  assert.equal(sWorkingChanged.state, "working");

  // 4. Output stabilized for >= 3s after task delivery -> "done"
  const sDone = evaluateWorkerState({
    isAlive: true,
    currentText: "Processing query... complete.\n",
    previousRecord: {
      lastTaskSentAt: now - 6000,
      lastOutputHash: "hash-complete",
      lastOutputChangedAt: now - 4000 // 4s ago (> 3s stabilitySec)
    },
    stabilitySec,
    now
  });
  // When currentText hashes to "hash-complete" (same hash), output has settled
  const hashComplete = sDone.record.lastOutputHash;
  const sDoneSettled = evaluateWorkerState({
    isAlive: true,
    currentText: "Processing query... complete.\n",
    previousRecord: {
      lastTaskSentAt: now - 6000,
      lastOutputHash: hashComplete,
      lastOutputChangedAt: now - 4000
    },
    stabilitySec,
    now
  });
  assert.equal(sDoneSettled.state, "done");

  // 5. Dead process -> "error"
  const sDead = evaluateWorkerState({
    isAlive: false,
    currentText: null,
    previousRecord: { lastTaskSentAt: now - 1000 },
    stabilitySec,
    now
  });
  assert.equal(sDead.state, "error");

  // Status bar format check
  const statusBarText = formatStatusBar({
    running: true,
    sessionName: "swarm-engine-team",
    workerCount: 3,
    workers: [
      { id: "worker-1", state: "idle" },
      { id: "worker-2", state: "working" },
      { id: "worker-3", state: "done" }
    ]
  });
  assert.equal(
    statusBarText,
    "swarm-engine-team · 3 workers · worker-1: idle · worker-2: working · worker-3: done"
  );
});

test("Stage 4: swarm status reports live worker states during session and not running when idle", async (t) => {
  const weztermPath = findWezTerm();
  if (!weztermPath) {
    t.skip("WezTerm is not installed on this system; skipping status test.");
    return;
  }

  // Before starting, status must report not running
  const statusBefore = await getSwarmStatus({ baseDir: REPO_ROOT });
  assert.equal(statusBefore.running, false);
  assert.equal(statusBefore.message, "not running");

  const tempConfigPath = path.join(REPO_ROOT, ".swarm.test.status.config.json");
  const testConfig = {
    default_cli: "custom",
    orchestrator: {
      cli: "custom",
      command: process.execPath,
      base_args: [STUB_CLI_PATH, "--pane-id", "orchestrator", "--hold", "15000"],
      model_flag: "--model",
      model: "orch-status-model"
    },
    workers: [
      {
        cli: "custom",
        command: process.execPath,
        base_args: [STUB_CLI_PATH, "--pane-id", "worker-1", "--hold", "15000"],
        model_flag: "--model",
        model: "worker-1-model"
      },
      {
        cli: "custom",
        command: process.execPath,
        base_args: [STUB_CLI_PATH, "--pane-id", "worker-2", "--hold", "15000"],
        model_flag: "--model",
        model: "worker-2-model"
      }
    ]
  };

  fs.writeFileSync(tempConfigPath, JSON.stringify(testConfig, null, 2), "utf8");

  try {
    const startResult = await startSwarmLayout({ configPath: tempConfigPath });
    assert.equal(startResult.ok, true);

    await new Promise((r) => setTimeout(r, 800));

    // Live status check: both workers should be idle
    const statusLive = await getSwarmStatus({ baseDir: REPO_ROOT, weztermPath });
    assert.equal(statusLive.running, true);
    assert.equal(statusLive.sessionName, "swarm-engine-team");
    assert.equal(statusLive.workerCount, 2);
    assert.equal(statusLive.workers[0].state, "idle");
    assert.equal(statusLive.workers[1].state, "idle");

    // Clean up
    const stopResult = await stopSwarmLayout({ log: () => {} });
    assert.equal(stopResult.ok, true);

    // Status after shutdown must report not running
    const statusAfter = await getSwarmStatus({ baseDir: REPO_ROOT });
    assert.equal(statusAfter.running, false);
    assert.equal(statusAfter.message, "not running");
  } finally {
    if (fs.existsSync(tempConfigPath)) {
      fs.unlinkSync(tempConfigPath);
    }
  }
});
