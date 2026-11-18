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
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { normalizePaneConfigs, loadSwarmConfig, checkModelCompatibility, resolveSwarmConfigPath } from "../src/config.js";
import { buildLaunchCommand, buildAllLaunchCommands } from "../src/launch-builder.js";
import { listPresetNames, loadPreset } from "../src/presets.js";
import { GLOBAL_MODEL_ENV_VARS, buildCleanPaneEnv } from "../src/env.js";
import { runDoctor, validatePaneLaunches } from "../src/doctor.js";
import { runDryRun } from "../src/dry-run.js";
import { startSwarmLayout, stopSwarmLayout, formatPaneTitle, verifyCleanShutdown } from "../src/layout.js";
import { findWezTerm, listWezTermPanes } from "../src/wezterm.js";
import { dispatchTask, parseDispatchLine, resolveTargetWorkers } from "../src/dispatch.js";
import { loadPanesMap, getPanesFilePath } from "../src/state.js";
import { getSwarmStatus, formatStatusBar, evaluateWorkerState } from "../src/status.js";
import { detectPaneModel, formatModelsReport, detectActiveEnvironmentModel, extractModelFromArgs } from "../src/model-detect.js";
import { renderFullDashboard, renderBox, renderTreeConnectors, stripAnsi } from "../src/tui-layout.js";
import { resolveInitialTask, saveLastTask, loadLastTask, clearLastTask, getLastTaskFilePath, getGitTaskContext } from "../src/task-pickup.js";
import { TuiSession } from "../src/tui-session.js";
import { sendIpcMessage } from "../src/ipc.js";

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
  if (process.env.CI || !weztermPath) {
    t.skip("WezTerm is not available or running in CI; skipping GUI layout test.");
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
      workspace: "swarm-test-s2",
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
    const stopResult = await stopSwarmLayout({ workspace: "swarm-test-s2", log: (msg) => logs.push(msg) });
    assert.equal(stopResult.ok, true);
    assert.equal(stopResult.closedCount, 4);
    await new Promise((r) => setTimeout(r, 600));
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
  if (process.env.CI || !weztermPath) {
    t.skip("WezTerm is not available or running in CI; skipping dispatch test.");
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
    const startResult = await startSwarmLayout({ configPath: tempConfigPath, workspace: "swarm-test-s3" });
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

    // 4b. Dispatch task to a list of workers (@workers 1,2)
    const taskList = "list-worker-1-and-2-only";
    const resList = await dispatchTask({
      target: "@workers 1,2",
      task: taskList,
      baseDir: REPO_ROOT,
      weztermPath
    });
    assert.equal(resList.ok, true);
    assert.equal(resList.delivered.length, 2);
    assert.deepEqual(resList.delivered.map((d) => d.worker).sort(), ["worker-1", "worker-2"]);

    // Allow delivery
    await new Promise((resolve) => setTimeout(resolve, 800));

    const content1List = fs.existsSync(inbox1) ? fs.readFileSync(inbox1, "utf8") : "";
    const content2List = fs.existsSync(inbox2) ? fs.readFileSync(inbox2, "utf8") : "";
    const content3List = fs.existsSync(inbox3) ? fs.readFileSync(inbox3, "utf8") : "";

    // PROVE: Worker 1 and Worker 2 received the list task, Worker 3 did NOT
    assert.ok(
      content1List.includes(taskList),
      `Worker 1 should have received "${taskList}", got: "${content1List}"`
    );
    assert.ok(
      content2List.includes(taskList),
      `Worker 2 should have received "${taskList}", got: "${content2List}"`
    );
    assert.equal(
      content3List.includes(taskList),
      false,
      "Worker 3 should NOT receive list task directed only to 1,2"
    );

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
    const stopResult = await stopSwarmLayout({ workspace: "swarm-test-s3", log: () => {} });
    assert.equal(stopResult.ok, true);
    assert.equal(fs.existsSync(panesMapPath), false, "Expected .swarm/panes.json to be deleted on stop");
    await new Promise((r) => setTimeout(r, 600));
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
  if (process.env.CI || !weztermPath) {
    t.skip("WezTerm is not available or running in CI; skipping status test.");
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
    const startResult = await startSwarmLayout({ configPath: tempConfigPath, workspace: "swarm-test-s4" });
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
    const stopResult = await stopSwarmLayout({ workspace: "swarm-test-s4", log: () => {} });
    assert.equal(stopResult.ok, true);
    await new Promise((r) => setTimeout(r, 600));

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

test("River AI models belong exclusively to Kilo Code; Claude Code uses Amazon Bedrock models & preserves AWS credentials", () => {
  const riverModels = [
    "river/deepseek-ai/DeepSeek-V4.1-Flash",
    "river/Qwen/Qwen3.8-27B-FP8",
    "river/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4"
  ];

  // 1. River AI models are valid for Kilo Code
  for (const model of riverModels) {
    const resKilo = checkModelCompatibility("kilocode", model);
    assert.equal(resKilo.compatible, true, `Expected ${model} to be compatible with kilocode`);
  }

  // 2. River AI models are rejected with explicit warnings on Claude Code and other CLIs
  for (const model of riverModels) {
    const resClaude = checkModelCompatibility("claude", model);
    assert.equal(resClaude.compatible, false);
    assert.ok(
      resClaude.warning.includes("River AI models"),
      `Expected warning to mention River AI models, got: ${resClaude.warning}`
    );
    assert.ok(
      resClaude.warning.includes("belong exclusively to Kilo Code"),
      `Expected warning to mention Kilo Code exclusive ownership, got: ${resClaude.warning}`
    );
    assert.ok(
      resClaude.warning.includes("Amazon Bedrock"),
      `Expected warning to mention Amazon Bedrock models, got: ${resClaude.warning}`
    );

    const resGemini = checkModelCompatibility("gemini", model);
    assert.equal(resGemini.compatible, false);
    assert.ok(resGemini.warning.includes("belong exclusively to Kilo Code"));
  }

  // 3. Amazon Bedrock provided models and standard aliases are compatible with Claude Code
  const bedrockClaudeModels = [
    "anthropic.claude-3-5-sonnet-20241022-v2:0",
    "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "eu.anthropic.claude-3-7-sonnet-20250219-v1:0",
    "apac.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "bedrock/anthropic.claude-3-sonnet",
    "sonnet",
    "opus",
    "haiku",
    "claude-3-5-sonnet-20241022"
  ];

  for (const model of bedrockClaudeModels) {
    const res = checkModelCompatibility("claude", model);
    assert.equal(res.compatible, true, `Expected ${model} to be compatible with claude`);
  }

  // 4. Incompatible arbitrary models with Claude Code produce clear warnings
  const resInvalidClaude = checkModelCompatibility("claude", "gpt-4o-mini");
  assert.equal(resInvalidClaude.compatible, false);
  assert.ok(resInvalidClaude.warning.includes("Amazon Bedrock provided models"));

  // 5. Verify clean environment preserves Amazon Bedrock credentials while stripping model overrides
  const mockParentEnv = {
    ANTHROPIC_MODEL: "override-model-to-strip",
    CLAUDE_MODEL: "claude-model-to-strip",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: "us-west-2",
    AWS_DEFAULT_REGION: "us-west-2",
    AWS_PROFILE: "swarm-bedrock-profile",
    AWS_ACCESS_KEY_ID: "ASIAEXAMPLEKEY123",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    AWS_SESSION_TOKEN: "mock-session-token-xyz"
  };

  const { env: cleanEnv, strippedEnvVars } = buildCleanPaneEnv(
    { id: "orchestrator", cli: "claude", model: "anthropic.claude-3-5-sonnet-20241022-v2:0" },
    loadPreset("claude"),
    mockParentEnv
  );

  // Model override variables MUST be stripped
  assert.equal(cleanEnv.ANTHROPIC_MODEL, undefined);
  assert.equal(cleanEnv.CLAUDE_MODEL, undefined);
  assert.ok(strippedEnvVars.includes("ANTHROPIC_MODEL"));
  assert.ok(strippedEnvVars.includes("CLAUDE_MODEL"));

  // Amazon Bedrock environment variables MUST be preserved
  assert.equal(cleanEnv.CLAUDE_CODE_USE_BEDROCK, "1");
  assert.equal(cleanEnv.AWS_REGION, "us-west-2");
  assert.equal(cleanEnv.AWS_DEFAULT_REGION, "us-west-2");
  assert.equal(cleanEnv.AWS_PROFILE, "swarm-bedrock-profile");
  assert.equal(cleanEnv.AWS_ACCESS_KEY_ID, "ASIAEXAMPLEKEY123");
  assert.equal(cleanEnv.AWS_SECRET_ACCESS_KEY, "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  assert.equal(cleanEnv.AWS_SESSION_TOKEN, "mock-session-token-xyz");
});

test("Stage 5: config lookup order prioritizes local swarm.config.json, falls back to %USERPROFILE%/.swarm/swarm.config.json, and preserves current working directory", () => {
  const tempProjectDir = path.join(REPO_ROOT, ".test-project-space dir");
  const tempGlobalHome = path.join(REPO_ROOT, ".test-global-home");
  const tempGlobalSwarmDir = path.join(tempGlobalHome, ".swarm");

  try {
    fs.mkdirSync(tempProjectDir, { recursive: true });
    fs.mkdirSync(tempGlobalSwarmDir, { recursive: true });

    const globalConfig = {
      default_cli: "kilocode",
      orchestrator: { cli: "claude", model: "sonnet" },
      workers: [{ cli: "kilocode", model: "river/Qwen/Qwen3.8-27B-FP8" }]
    };
    fs.writeFileSync(
      path.join(tempGlobalSwarmDir, "swarm.config.json"),
      JSON.stringify(globalConfig, null, 2),
      "utf8"
    );

    // 1. When local does NOT exist, falls back to global config
    const globalLoaded = loadSwarmConfig(null, {
      currentDir: tempProjectDir,
      homeDir: tempGlobalHome
    });
    assert.equal(globalLoaded.source, "global");
    assert.equal(
      globalLoaded.configPath,
      path.join(tempGlobalSwarmDir, "swarm.config.json")
    );
    // Crucial check: All panes must use the project's CURRENT directory, NOT the global directory
    for (const pane of globalLoaded.panes) {
      assert.equal(
        pane.cwd,
        tempProjectDir,
        `Expected pane ${pane.id} cwd to be current project dir ${tempProjectDir}`
      );
    }

    // 2. When local DOES exist, local takes precedence over global
    const localConfig = {
      default_cli: "kilocode",
      orchestrator: { cli: "claude", model: "anthropic.claude-3-5-sonnet-20241022-v2:0" },
      workers: [{ cli: "kilocode", model: "river/deepseek-ai/DeepSeek-V4.1-Flash" }]
    };
    fs.writeFileSync(
      path.join(tempProjectDir, "swarm.config.json"),
      JSON.stringify(localConfig, null, 2),
      "utf8"
    );

    const localLoaded = loadSwarmConfig(null, {
      currentDir: tempProjectDir,
      homeDir: tempGlobalHome
    });
    assert.equal(localLoaded.source, "local");
    assert.equal(localLoaded.configPath, path.join(tempProjectDir, "swarm.config.json"));
    assert.equal(localLoaded.panes[0].model, "anthropic.claude-3-5-sonnet-20241022-v2:0");

    // 3. Explicit config path takes highest precedence
    const explicitLoaded = loadSwarmConfig(path.join(tempGlobalSwarmDir, "swarm.config.json"), {
      currentDir: tempProjectDir,
      homeDir: tempGlobalHome
    });
    assert.equal(explicitLoaded.source, "explicit");

    // 4. Missing both local and global throws descriptive error
    fs.unlinkSync(path.join(tempProjectDir, "swarm.config.json"));
    fs.unlinkSync(path.join(tempGlobalSwarmDir, "swarm.config.json"));

    assert.throws(
      () => resolveSwarmConfigPath(null, tempProjectDir, tempGlobalHome),
      /No swarm\.config\.json found in current directory/
    );
  } finally {
    fs.rmSync(tempProjectDir, { recursive: true, force: true });
    fs.rmSync(tempGlobalHome, { recursive: true, force: true });
  }
});

test("Stage 5: install.ps1 and uninstall.ps1 operate on temporary fake PATH without touching real User PATH, avoid duplicates, and handle spaces", (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell installer test requires Windows");
    return;
  }
  const installScript = path.join(REPO_ROOT, "scripts", "install.ps1");
  const uninstallScript = path.join(REPO_ROOT, "scripts", "uninstall.ps1");
  assert.ok(fs.existsSync(installScript), "scripts/install.ps1 must exist");
  assert.ok(fs.existsSync(uninstallScript), "scripts/uninstall.ps1 must exist");

  // Query real User PATH before testing to verify it is never touched
  const queryRealUserPath = () => {
    const res = spawnSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      '[Environment]::GetEnvironmentVariable("Path", "User")'
    ], { encoding: "utf8" });
    return (res.stdout ?? "").trim();
  };

  const realPathBefore = queryRealUserPath();
  const fakeInitialPath = "C:\\Existing\\Tools;C:\\AppData\\Local\\Programs";
  const targetBinWithSpaces = path.join(REPO_ROOT, "bin");

  // 1. Run install.ps1 in isolated test mode (-CustomUserPath, -PassThru)
  const installRes = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    installScript,
    "-TargetBinDir",
    targetBinWithSpaces,
    "-CustomUserPath",
    fakeInitialPath,
    "-PassThru"
  ], { encoding: "utf8" });

  assert.equal(installRes.status, 0, `install.ps1 failed: ${installRes.stderr}`);
  const installOutput = installRes.stdout;
  assert.ok(
    installOutput.includes("Successfully added to User PATH"),
    `Expected success message in output: ${installOutput}`
  );
  assert.ok(installOutput.includes("Commands:        swarm, team"));
  assert.ok(installOutput.includes("Background/Auto: NONE"));

  // Resulting path must contain the target bin directory
  const lines = installOutput.trim().split(/\r?\n/);
  const installedPath = lines[lines.length - 1];
  assert.ok(installedPath.includes(targetBinWithSpaces));

  // 2. Run install.ps1 a second time on the resulting PATH to test idempotency / duplicate avoidance
  const installAgainRes = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    installScript,
    "-TargetBinDir",
    targetBinWithSpaces,
    "-CustomUserPath",
    installedPath,
    "-PassThru"
  ], { encoding: "utf8" });

  assert.equal(installAgainRes.status, 0);
  assert.ok(
    installAgainRes.stdout.includes("Already installed"),
    `Expected already installed duplicate avoidance: ${installAgainRes.stdout}`
  );
  const pathAfterSecondInstall = installAgainRes.stdout.trim().split(/\r?\n/).pop();
  assert.equal(pathAfterSecondInstall, installedPath, "Second install should not duplicate path");

  // 3. Run uninstall.ps1 in isolated test mode
  const uninstallRes = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    uninstallScript,
    "-TargetBinDir",
    targetBinWithSpaces,
    "-CustomUserPath",
    installedPath,
    "-PassThru"
  ], { encoding: "utf8" });

  assert.equal(uninstallRes.status, 0, `uninstall.ps1 failed: ${uninstallRes.stderr}`);
  const uninstallOutput = uninstallRes.stdout;
  assert.ok(
    uninstallOutput.includes("Successfully removed from User PATH"),
    `Expected removal message in output: ${uninstallOutput}`
  );
  assert.ok(uninstallOutput.includes(targetBinWithSpaces));
  const uninstalledPath = uninstallOutput.trim().split(/\r?\n/).pop();
  assert.equal(uninstalledPath, fakeInitialPath, "Uninstall should restore initial fake PATH exactly");

  // 4. Run uninstall.ps1 when target is already absent
  const uninstallAgainRes = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    uninstallScript,
    "-TargetBinDir",
    targetBinWithSpaces,
    "-CustomUserPath",
    uninstalledPath,
    "-PassThru"
  ], { encoding: "utf8" });

  assert.equal(uninstallAgainRes.status, 0);
  assert.ok(uninstallAgainRes.stdout.includes("Nothing removed"));

  // 5. PROVE: Real registry User PATH was never modified
  const realPathAfter = queryRealUserPath();
  assert.equal(
    realPathAfter,
    realPathBefore,
    "Real User PATH in registry must remain completely untouched during test"
  );
});

test("Stage 5: swarm --version and swarm help CLI commands", () => {
  const swarmJs = path.join(REPO_ROOT, "bin", "swarm.js");

  // 1. Test swarm --version and -v
  const resVer = spawnSync(process.execPath, [swarmJs, "--version"], { encoding: "utf8" });
  assert.equal(resVer.status, 0);
  assert.ok(resVer.stdout.includes("swarm-engine-team v0.1.0"));

  const resShortVer = spawnSync(process.execPath, [swarmJs, "-v"], { encoding: "utf8" });
  assert.equal(resShortVer.status, 0);
  assert.ok(resShortVer.stdout.includes("0.1.0"));

  // 2. Test swarm help and --help
  const resHelp = spawnSync(process.execPath, [swarmJs, "help"], { encoding: "utf8" });
  assert.equal(resHelp.status, 0);
  assert.ok(resHelp.stdout.includes("Usage:"));
  assert.ok(resHelp.stdout.includes("swarm stop"));
  assert.ok(resHelp.stdout.includes("team <command>"));

  const resFlagHelp = spawnSync(process.execPath, [swarmJs, "--help"], { encoding: "utf8" });
  assert.equal(resFlagHelp.status, 0);
  assert.ok(resFlagHelp.stdout.includes("Usage:"));
});

test("Stage 5: stopSwarmLayout verifies clean shutdown (no leftover processes, temp files, or ports)", async () => {
  // Test clean verification check on clean workspace
  const cleanCheck = await verifyCleanShutdown({ baseDir: REPO_ROOT });
  assert.equal(cleanCheck.clean, true);
  assert.deepEqual(cleanCheck.leftover.processes, []);
  assert.deepEqual(cleanCheck.leftover.tempFiles, []);
  assert.deepEqual(cleanCheck.leftover.openPorts, []);

  // Simulate a leftover temporary file in .swarm/ to verify detector catches it
  const swarmDir = path.join(REPO_ROOT, ".swarm");
  const leftoverTempFile = path.join(swarmDir, "temp-dangling-worker.tmp");
  fs.mkdirSync(swarmDir, { recursive: true });
  fs.writeFileSync(leftoverTempFile, "dangling", "utf8");

  try {
    const dirtyCheck = await verifyCleanShutdown({ baseDir: REPO_ROOT });
    assert.equal(dirtyCheck.clean, false);
    assert.ok(dirtyCheck.leftover.tempFiles.some((f) => f.includes("temp-dangling-worker.tmp")));
  } finally {
    if (fs.existsSync(leftoverTempFile)) {
      fs.unlinkSync(leftoverTempFile);
    }
  }

  // Verify stopSwarmLayout output contains "clean"
  const logs = [];
  const stopResult = await stopSwarmLayout({
    baseDir: REPO_ROOT,
    log: (msg) => logs.push(msg)
  });
  assert.equal(stopResult.ok, true);
  assert.equal(stopResult.clean, true);
  assert.ok(logs.some((l) => l.includes("clean")));
});

test("Model detection strictly follows observable source priority: launch_flag -> cli_status -> configured -> unknown", () => {
  // Priority 1: Launch flag present in args overrides everything else
  const p1 = detectPaneModel({
    cli: "custom",
    args: ["--model", "flag-override-model", "--verbose"],
    configModel: "config-model",
    cliStatusModel: "status-model"
  });
  assert.equal(p1.model, "flag-override-model");
  assert.equal(p1.source, "launch_flag");
  assert.equal(p1.mismatch, true); // differs from configModel

  // Priority 1 with -m shorthand
  const p1Short = detectPaneModel({
    cli: "custom",
    args: ["-m", "short-flag-model"],
    configModel: "short-flag-model"
  });
  assert.equal(p1Short.model, "short-flag-model");
  assert.equal(p1Short.source, "launch_flag");
  assert.equal(p1Short.mismatch, false);

  // Priority 2: CLI status query when no launch flag is in args
  const p2 = detectPaneModel({
    cli: "custom",
    args: ["--verbose"],
    configModel: "config-model",
    cliStatusModel: "cli-reported-model"
  });
  assert.equal(p2.model, "cli-reported-model");
  assert.equal(p2.source, "cli_status");
  assert.equal(p2.mismatch, true);

  // Priority 3: Config value when no launch flag and no CLI status
  const p3 = detectPaneModel({
    cli: "custom",
    args: ["--verbose"],
    configModel: "configured-model",
    cliStatusModel: null
  });
  assert.equal(p3.model, "configured-model");
  assert.equal(p3.source, "configured");
  assert.equal(p3.mismatch, false);

  // Priority 4: Unknown when nothing answers (never invented defaults)
  const p4 = detectPaneModel({
    cli: "custom",
    args: [],
    configModel: null,
    cliStatusModel: null
  });
  assert.equal(p4.model, "unknown");
  assert.equal(p4.source, "unknown");
  assert.equal(p4.mismatch, false);
});

test("Model detection detects mismatch between launch flag and config, and warns in doctor report", () => {
  // 1. Mismatch detected when launch flag and config differ
  const mismatchDetection = detectPaneModel({
    cli: "kilocode",
    args: ["--model", "river/Qwen/Qwen3.8-27B-FP8"],
    configModel: "river/deepseek-ai/DeepSeek-V4.1-Flash"
  });
  assert.equal(mismatchDetection.mismatch, true);
  assert.ok(mismatchDetection.warning.includes("Model mismatch for CLI \"kilocode\""));
  assert.ok(mismatchDetection.warning.includes("Launch flag specifies \"river/Qwen/Qwen3.8-27B-FP8\""));
  assert.ok(mismatchDetection.warning.includes("config specifies \"river/deepseek-ai/DeepSeek-V4.1-Flash\""));

  // 2. formatModelsReport formats warning clearly
  const panes = [
    {
      id: "worker-1",
      role: "worker",
      cli: "kilocode",
      detected: mismatchDetection
    }
  ];
  const report = formatModelsReport(panes);
  assert.ok(report.includes("[source: launch_flag]"));
  assert.ok(report.includes("! WARNING:"));
  assert.ok(report.includes("Doctor check: WARNING — One or more panes have model mismatches"));

  // 3. When launch flag matches config, no warning is generated
  const matchingDetection = detectPaneModel({
    cli: "claude",
    args: ["--model", "sonnet"],
    configModel: "sonnet"
  });
  assert.equal(matchingDetection.mismatch, false);
  assert.equal(matchingDetection.warning, undefined);

  const cleanReport = formatModelsReport([
    { id: "orchestrator", role: "orchestrator", cli: "claude", detected: matchingDetection }
  ]);
  assert.ok(cleanReport.includes("Doctor check: OK — All pane models verified from observable sources."));

  // 4. detectActiveEnvironmentModel picks up KILO_MODEL
  const customEnv = { KILO_MODEL: "river/deepseek-ai/DeepSeek-V4.1-Flash" };
  const detectedEnv = detectActiveEnvironmentModel(customEnv);
  assert.equal(detectedEnv, "river/deepseek-ai/DeepSeek-V4.1-Flash");
});

test("Grid layout rendering produces consistent, aligned ANSI output for 1, 3, and 6 workers", () => {
  // Test 1 Worker
  const dashboard1 = renderFullDashboard({
    terminalWidth: 100,
    terminalHeight: 30,
    sessionName: "swarm-test-1",
    orchestrator: { id: "orchestrator", cli: "claude", model: "sonnet", state: "idle", task: "Build MVP" },
    workers: [
      { id: "worker-1", cli: "kilocode", model: "river/deepseek", state: "idle" }
    ],
    focusedId: "worker-1"
  });

  const plain1 = stripAnsi(dashboard1);
  assert.ok(plain1.includes("orchestrator · orchestrator"));
  assert.ok(plain1.includes("worker-1"));
  assert.equal(plain1.includes("worker-2"), false);
  assert.ok(plain1.includes("[FOCUSED]")); // worker-1 is focused
  assert.ok(plain1.includes("1 workers"));

  // Test 3 Workers (single row of 3 columns)
  const dashboard3 = renderFullDashboard({
    terminalWidth: 120,
    terminalHeight: 30,
    sessionName: "swarm-test-3",
    orchestrator: { id: "orchestrator", cli: "claude", model: "sonnet", state: "working", task: "Coordinate swarm" },
    workers: [
      { id: "worker-1", cli: "kilocode", model: "river/deepseek", state: "working", lastLine: "Parsing AST" },
      { id: "worker-2", cli: "kilocode", model: "river/qwen", state: "idle", lastLine: "Ready" },
      { id: "worker-3", cli: "kilocode", model: "river/nemotron", state: "done", lastLine: "Tests pass" }
    ],
    focusedId: "orchestrator"
  });

  const plain3 = stripAnsi(dashboard3);
  assert.ok(plain3.includes("worker-1"));
  assert.ok(plain3.includes("worker-2"));
  assert.ok(plain3.includes("worker-3"));
  assert.equal(plain3.includes("worker-4"), false);
  assert.ok(plain3.includes("3 workers (1 working, 1 idle)"));

  // Test 6 Workers (2x3 grid)
  const dashboard6 = renderFullDashboard({
    terminalWidth: 120,
    terminalHeight: 40,
    sessionName: "swarm-test-6",
    orchestrator: { id: "orchestrator", cli: "claude", model: "sonnet", state: "idle" },
    workers: [
      { id: "worker-1", cli: "kilocode", model: "m-1", state: "working" },
      { id: "worker-2", cli: "kilocode", model: "m-2", state: "idle" },
      { id: "worker-3", cli: "kilocode", model: "m-3", state: "working" },
      { id: "worker-4", cli: "kilocode", model: "m-4", state: "idle" },
      { id: "worker-5", cli: "kilocode", model: "m-5", state: "idle" },
      { id: "worker-6", cli: "kilocode", model: "m-6", state: "error" }
    ],
    focusedId: "worker-5"
  });

  const plain6 = stripAnsi(dashboard6);
  for (let i = 1; i <= 6; i += 1) {
    assert.ok(plain6.includes(`worker-${i}`), `Expected plain6 to contain worker-${i}`);
  }
  assert.ok(plain6.includes("6 workers (2 working, 3 idle, 1 error)"));

  // Verify box width consistency across rows (no misaligned columns)
  const boxRows = renderBox({
    width: 34,
    height: 6,
    titleLeft: "worker-test",
    titleRight: "model-test",
    lines: ["line 1", "line 2"],
    focused: true
  });
  for (const r of boxRows) {
    assert.equal(stripAnsi(r).length, 34, `Row "${stripAnsi(r)}" is not 34 chars wide`);
  }
});

test("Task pickup detection prioritizes CLI flag, persisted file, git context, and default standby", () => {
  const tempDir = path.join(REPO_ROOT, ".test-task-pickup-space dir");
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // 1. Explicit CLI flag takes highest priority
    const resFlag = resolveInitialTask({
      explicitTask: "refactor database connection pool",
      baseDir: tempDir
    });
    assert.equal(resFlag.task, "refactor database connection pool");
    assert.equal(resFlag.source, "cli_flag");

    // 2. Persisted last-task.txt takes second priority
    saveLastTask("fix memory leak in child streams", tempDir);
    assert.ok(fs.existsSync(getLastTaskFilePath(tempDir)));
    assert.equal(loadLastTask(tempDir), "fix memory leak in child streams");

    const resFile = resolveInitialTask({ baseDir: tempDir });
    assert.equal(resFile.task, "fix memory leak in child streams");
    assert.equal(resFile.source, "last_task_file");

    // Flag still overrides persisted file
    const resFlagOverFile = resolveInitialTask({
      explicitTask: "override flag task",
      baseDir: tempDir
    });
    assert.equal(resFlagOverFile.task, "override flag task");
    assert.equal(resFlagOverFile.source, "cli_flag");

    // 3. Git context is picked up when no flag and no saved file
    clearLastTask(tempDir);
    assert.equal(loadLastTask(tempDir), null);

    // In actual repo (git repo), resolveInitialTask picks up git context when no last-task.txt exists
    const savedRepoLastTask = loadLastTask(REPO_ROOT);
    clearLastTask(REPO_ROOT);
    try {
      const resGit = resolveInitialTask({ baseDir: REPO_ROOT });
      assert.equal(resGit.source, "git_context");
      assert.ok(resGit.task.startsWith("Resume uncommitted") || resGit.task.startsWith("Resume work following:"));
    } finally {
      if (savedRepoLastTask) {
        saveLastTask(savedRepoLastTask, REPO_ROOT);
      }
    }

    // 4. Persistence across sessions: saveLastTask writes, clearLastTask clears
    saveLastTask("work on auth module", tempDir);
    assert.equal(loadLastTask(tempDir), "work on auth module");
    clearLastTask(tempDir);
    assert.equal(loadLastTask(tempDir), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runDoctor accurately identifies configured models and detects launch flag mismatches against config", () => {
  const tempDir = path.join(REPO_ROOT, ".test-doctor-models-dir");
  fs.mkdirSync(tempDir, { recursive: true });

  const testConfigPath = path.join(tempDir, "swarm.config.json");
  const testConfig = {
    default_cli: "custom",
    orchestrator: {
      cli: "claude",
      model: "anthropic.claude-3-5-sonnet-20241022-v2:0"
    },
    workers: [
      {
        cli: "kilocode",
        model: "river/deepseek-ai/DeepSeek-V4.1-Flash"
      },
      {
        cli: "kilocode",
        model: "river/Qwen/Qwen3.8-27B-FP8"
      }
    ]
  };

  fs.writeFileSync(testConfigPath, JSON.stringify(testConfig, null, 2), "utf8");

  try {
    // 1. Without launch flag: all panes report source: "configured" and no mismatch
    const linesNoFlag = [];
    const resNoFlag = runDoctor({
      configPath: testConfigPath,
      models: true,
      stdout: (msg) => linesNoFlag.push(msg)
    });

    assert.equal(resNoFlag.exitCode, 0);
    const reportNoFlag = linesNoFlag.join("\n");
    assert.ok(reportNoFlag.includes("anthropic.claude-3-5-sonnet-20241022-v2:0 [source: configured]"));
    assert.ok(reportNoFlag.includes("river/deepseek-ai/DeepSeek-V4.1-Flash [source: configured]"));
    assert.ok(reportNoFlag.includes("river/Qwen/Qwen3.8-27B-FP8 [source: configured]"));
    assert.ok(reportNoFlag.includes("Doctor check: OK — All pane models verified from observable sources."));
    assert.equal(reportNoFlag.includes("! WARNING:"), false);

    // 2. With launch flag override: reports source: "launch_flag" and warns on mismatch
    const linesWithFlag = [];
    const resWithFlag = runDoctor({
      configPath: testConfigPath,
      model: "override-cli-model",
      models: true,
      stdout: (msg) => linesWithFlag.push(msg)
    });

    const reportWithFlag = linesWithFlag.join("\n");
    assert.ok(reportWithFlag.includes("override-cli-model [source: launch_flag]"));
    assert.ok(reportWithFlag.includes("! WARNING:"));
    assert.ok(reportWithFlag.includes("Launch flag specifies \"override-cli-model\", but config specifies"));
    assert.ok(reportWithFlag.includes("Doctor check: WARNING — One or more panes have model mismatches"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Dashboard ANSI separator line and status bar dynamically adjust to terminal width without hardcoding", () => {
  const orchestrator = { id: "orchestrator", cli: "claude", model: "sonnet", state: "idle" };
  const workers = [{ id: "worker-1", cli: "kilocode", model: "river/deepseek", state: "idle" }];

  for (const width of [60, 100, 140]) {
    const dashboard = renderFullDashboard({
      terminalWidth: width,
      terminalHeight: 30,
      sessionName: "swarm-width-test",
      orchestrator,
      workers,
      focusedId: "orchestrator"
    });

    const plain = stripAnsi(dashboard);
    const lines = plain.split("\n");

    // Separator line above bottom status bar
    const sepLine = lines[lines.length - 2];
    assert.equal(sepLine.length, width - 4, `Expected separator line to be ${width - 4} chars wide at width ${width}, got ${sepLine.length}`);
    assert.ok(/^─+$/.test(sepLine), `Expected separator line to consist entirely of box dashes at width ${width}`);

    // Bottom status bar line
    const barLine = lines[lines.length - 1];
    assert.equal(barLine.length, width - 4, `Expected status bar line to be ${width - 4} chars wide at width ${width}, got ${barLine.length}`);
    assert.ok(barLine.includes("swarm-width-test"));
    if (width >= 90) {
      assert.ok(barLine.includes("[Tab] Focus [Ctrl+Q] Exit"));
    }
  }
});

test("In-terminal TUI session lifecycle: spawn, IPC dispatch, live status query, task pickup, and clean stop", async () => {
  const tempDir = path.join(REPO_ROOT, ".test-tui-session-dir");
  fs.mkdirSync(tempDir, { recursive: true });

  const inbox1 = path.join(tempDir, "inbox1.txt");
  const inbox2 = path.join(tempDir, "inbox2.txt");

  const testConfigPath = path.join(tempDir, "swarm.config.json");
  const testConfig = {
    default_cli: "custom",
    orchestrator: {
      cli: "custom",
      command: process.execPath,
      base_args: [STUB_CLI_PATH, "--pane-id", "orchestrator", "--hold", "10000"],
      model: "orch-model"
    },
    workers: [
      {
        cli: "custom",
        command: process.execPath,
        base_args: [STUB_CLI_PATH, "--pane-id", "worker-1", "--inbox", inbox1, "--hold", "10000"],
        model: "worker-1-model"
      },
      {
        cli: "custom",
        command: process.execPath,
        base_args: [STUB_CLI_PATH, "--pane-id", "worker-2", "--inbox", inbox2, "--hold", "10000"],
        model: "worker-2-model"
      }
    ]
  };

  fs.writeFileSync(testConfigPath, JSON.stringify(testConfig, null, 2), "utf8");

  const session = new TuiSession({
    configPath: testConfigPath,
    baseDir: tempDir,
    headless: true
  });

  try {
    // 1. Start headless TUI session
    await session.start();
    assert.equal(session.running, true);
    assert.equal(session.workingThresholdMs, 3000);

    // Verify .swarm/panes.json was created
    const panesMapPath = getPanesFilePath(tempDir);
    assert.ok(fs.existsSync(panesMapPath), "Expected .swarm/panes.json to exist");

    // 2. Query live session status via getSwarmStatus (which calls Named Pipe IPC)
    const liveStatus = await getSwarmStatus({ baseDir: tempDir });
    assert.equal(liveStatus.running, true);
    assert.equal(liveStatus.workerCount, 2);
    assert.equal(liveStatus.source, "ipc");
    assert.equal(liveStatus.sessionName, "swarm-engine-team");

    // 3. Dispatch task to worker-1 via Named Pipe IPC
    const dispatchRes1 = await dispatchTask({
      target: "@worker-1",
      task: "build-search-index",
      baseDir: tempDir
    });
    assert.equal(dispatchRes1.ok, true);
    assert.equal(dispatchRes1.delivered.length, 1);
    assert.equal(dispatchRes1.delivered[0].worker, "worker-1");

    // Verify task pickup file was saved
    assert.equal(loadLastTask(tempDir), "build-search-index");

    // 4. Dispatch task to all workers
    const dispatchResAll = await dispatchTask({
      target: "@all",
      task: "sync-git-submodules",
      baseDir: tempDir
    });
    assert.equal(dispatchResAll.ok, true);
    assert.equal(dispatchResAll.delivered.length, 2);
    assert.equal(loadLastTask(tempDir), "sync-git-submodules");

    // 5. Dispatch task to worker list (@workers 1,2)
    const dispatchResList = await dispatchTask({
      target: "@workers 1,2",
      task: "run-benchmarks",
      baseDir: tempDir
    });
    assert.equal(dispatchResList.ok, true);
    assert.equal(dispatchResList.delivered.length, 2);

    // 6. Unknown target must be rejected with active workers error
    await assert.rejects(
      async () => {
        await dispatchTask({
          target: "@worker-99",
          task: "invalid",
          baseDir: tempDir
        });
      },
      /Unknown target.*worker-99/
    );

    // 7. Verify stop command via IPC cleanly stops session and cleans panes.json
    const stopIpcRes = await sendIpcMessage({ command: "stop" });
    assert.equal(stopIpcRes.ok, true);
    assert.equal(stopIpcRes.stopped, true);

    // Give session a moment to finalize teardown
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(session.running, false);
    assert.equal(fs.existsSync(panesMapPath), false, "Expected .swarm/panes.json to be cleaned on stop");
  } finally {
    await session.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI parsing supports key=val syntax for all flags (--model=val, --task=val, --workers=val)", () => {
  const scriptPath = path.resolve(REPO_ROOT, "bin", "swarm.js");

  // 1. Swarm help documents CLI usage
  const helpRes = spawnSync(process.execPath, [scriptPath, "--help"], {
    cwd: REPO_ROOT,
    encoding: "utf8"
  });
  assert.equal(helpRes.status, 0);
  assert.ok(helpRes.stdout.includes("--workers <N>"));
  assert.ok(helpRes.stdout.includes("--model <name>"));

  // 2. Swarm dry-run accepts --model=val, --task=val, and --workers=val
  const dryRes = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--dry-run",
      "--model=test-flag-model",
      "--task=test-flag-task",
      "--workers=3"
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8"
    }
  );
  assert.equal(dryRes.status, 0, `Dry run exited with error: ${dryRes.stderr}`);
  assert.ok(dryRes.stdout.includes("Swarm Engine Team — Dry Run"));
  assert.ok(dryRes.stdout.includes("[worker-3]"));
  assert.equal(dryRes.stdout.includes("[worker-4]"), false);
});
