/**
 * WezTerm Swarm Layout Manager (Stage 2).
 *
 * Opens:
 *   - One full-width orchestrator pane on top
 *   - Below it: a 2x3 grid of worker panes (worker-1 to worker-6)
 *   - If config has fewer workers, only those worker panes are opened
 *
 * Rules:
 *   - Each pane runs the command from buildLaunchCommand for its own config entry
 *   - Pane titles show "<name> · <cli> · <model>", derived from the exact launch command
 *   - Paths with spaces work cleanly; all arguments are passed as arrays
 *   - Clean process lifecycle tracking and shutdown via `swarm stop`
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadSwarmConfig } from "./config.js";
import { buildAllLaunchCommands } from "./launch-builder.js";
import {
  findWezTerm,
  findWezTermGui,
  getWezTermNotFoundMessage,
  runWezTermCli,
  listWezTermPanes,
  killWezTermPane
} from "./wezterm.js";
import {
  saveSessionState,
  loadSessionState,
  clearSessionState,
  savePanesMap,
  clearPanesMap
} from "./state.js";
import { clearStatusState, getSwarmStatus } from "./status.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PANE_RUNNER_PATH = path.resolve(__dirname, "pane-runner.js");

/**
 * Format a pane's title derived directly from its launch specification.
 * Format: "<name> · <cli> · <model>"
 *
 * @param {object} launch - Pane launch descriptor.
 * @returns {string}
 */
export function formatPaneTitle(launch) {
  const name = launch.id ?? "pane";
  const cli = launch.cli ?? "cli";
  const model = launch.model ?? "default";
  return `${name} · ${cli} · ${model}`;
}

/**
 * Build the execution arguments array for a single pane through pane-runner.js.
 * Arguments are always arrays; paths with spaces work natively without shell escaping.
 *
 * @param {object} launch - Pane launch descriptor.
 * @returns {string[]} Arguments array for spawn/exec.
 */
export function buildPaneSpawnArgs(launch) {
  const title = formatPaneTitle(launch);
  const cwd = path.resolve(launch.cwd ?? process.cwd());

  return [
    process.execPath,
    PANE_RUNNER_PATH,
    "--title",
    title,
    "--cwd",
    cwd,
    "--",
    launch.command,
    ...launch.args
  ];
}

/**
 * Wait for WezTerm's IPC socket to become responsive and return the swarm orchestrator pane.
 *
 * @param {string} weztermPath
 * @param {string} [workspace="swarm"]
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<object>}
 */
async function waitForWezTermReady(weztermPath, workspace = "swarm", timeoutMs = 10000) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt += 1;
    try {
      const panes = await listWezTermPanes(weztermPath);
      if (Array.isArray(panes) && panes.length > 0) {
        const match = panes.find((p) => p.workspace === workspace) ?? panes[0];
        if (match) {
          return match;
        }
      }
    } catch {
      // Continue polling
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Timed out waiting for WezTerm GUI to initialize.");
}

/**
 * Open the WezTerm swarm layout.
 *
 * @param {object} [options]
 * @param {string} [options.configPath] - Optional path to swarm.config.json.
 * @param {string} [options.weztermOverride] - Optional override for wezterm executable path.
 * @param {Function} [options.log] - Log sink.
 * @returns {Promise<{ ok: boolean, panes: Array<object>, configPath: string }>}
 */
export async function startSwarmLayout(options = {}) {
  const log = options.log ?? ((msg) => console.log(msg));
  const weztermPath = options.weztermOverride ?? findWezTerm();

  if (!weztermPath) {
    const errorMsg = getWezTermNotFoundMessage();
    throw new Error(errorMsg);
  }

  const { configPath, panes: paneConfigs } = loadSwarmConfig(options.configPath, {
    workerCount: options.workers,
    forcedCli: options.cli,
    onWarning: log
  });
  const launches = buildAllLaunchCommands(paneConfigs);

  const orchLaunch = launches.find((l) => l.role === "orchestrator") ?? launches[0];
  const workerLaunches = launches.filter((l) => l !== orchLaunch).slice(0, 6); // Max 6 workers in 2x3 grid

  log(`Swarm Engine Team: Launching WezTerm layout`);
  log(`Config:       ${configPath}`);
  log(`Orchestrator: ${formatPaneTitle(orchLaunch)}`);
  log(`Workers:      ${workerLaunches.length} pane(s)`);

  const orchArgs = buildPaneSpawnArgs(orchLaunch);

  log(`[layout] Spawning orchestrator pane in WezTerm (workspace: swarm)...`);
  // 1. Spawn orchestrator into a new window in the 'swarm' workspace
  const s0 = await runWezTermCli(weztermPath, [
    "cli",
    "spawn",
    "--new-window",
    "--workspace",
    "swarm",
    "--cwd",
    orchLaunch.cwd,
    "--",
    ...orchArgs
  ]);

  const orchPaneId = parseInt(s0.stdout.trim().split(/\s+/).pop(), 10);
  if (isNaN(orchPaneId)) {
    throw new Error(`Failed to parse orchestrator pane ID from WezTerm output: ${s0.stdout}`);
  }
  log(`[layout] Orchestrator pane ready: ID ${orchPaneId}`);

  const createdPanes = [
    {
      id: orchLaunch.id,
      role: orchLaunch.role,
      cli: orchLaunch.cli,
      model: orchLaunch.model,
      title: formatPaneTitle(orchLaunch),
      paneId: orchPaneId,
      cwd: orchLaunch.cwd
    }
  ];

  const N = workerLaunches.length;

  if (N > 0) {
    // Determine orchestrator height allocation
    // If 1 row of workers (N <= 3), workers get ~65% height. If 2 rows (N >= 4), ~75% height.
    const bottomSplitPercent = N <= 3 ? "65" : "75";

    // Split orchestrator vertically at bottom to create worker-1
    const w1Launch = workerLaunches[0];
    const w1Args = buildPaneSpawnArgs(w1Launch);
    const s1 = await runWezTermCli(weztermPath, [
      "cli",
      "split-pane",
      "--pane-id",
      String(orchPaneId),
      "--bottom",
      "--percent",
      bottomSplitPercent,
      "--cwd",
      w1Launch.cwd,
      "--",
      ...w1Args
    ]);
    const pW1 = parseInt(s1.stdout.trim().split(/\s+/).pop(), 10);
    createdPanes.push({
      id: w1Launch.id,
      role: w1Launch.role,
      cli: w1Launch.cli,
      model: w1Launch.model,
      title: formatPaneTitle(w1Launch),
      paneId: pW1,
      cwd: w1Launch.cwd
    });

    if (N <= 3) {
      // 1 row of workers: W1 (left) | W2 (mid) | W3 (right)
      if (N >= 2) {
        const w2Launch = workerLaunches[1];
        const w2Args = buildPaneSpawnArgs(w2Launch);
        const w2Percent = N === 2 ? "50" : "67";
        const s2 = await runWezTermCli(weztermPath, [
          "cli",
          "split-pane",
          "--pane-id",
          String(pW1),
          "--right",
          "--percent",
          w2Percent,
          "--cwd",
          w2Launch.cwd,
          "--",
          ...w2Args
        ]);
        const pW2 = parseInt(s2.stdout.trim().split(/\s+/).pop(), 10);
        createdPanes.push({
          id: w2Launch.id,
          role: w2Launch.role,
          cli: w2Launch.cli,
          model: w2Launch.model,
          title: formatPaneTitle(w2Launch),
          paneId: pW2,
          cwd: w2Launch.cwd
        });

        if (N === 3) {
          const w3Launch = workerLaunches[2];
          const w3Args = buildPaneSpawnArgs(w3Launch);
          const s3 = await runWezTermCli(weztermPath, [
            "cli",
            "split-pane",
            "--pane-id",
            String(pW2),
            "--right",
            "--percent",
            "50",
            "--cwd",
            w3Launch.cwd,
            "--",
            ...w3Args
          ]);
          const pW3 = parseInt(s3.stdout.trim().split(/\s+/).pop(), 10);
          createdPanes.push({
            id: w3Launch.id,
            role: w3Launch.role,
            cli: w3Launch.cli,
            model: w3Launch.model,
            title: formatPaneTitle(w3Launch),
            paneId: pW3,
            cwd: w3Launch.cwd
          });
        }
      }
    } else {
      // 2 rows of workers (N >= 4, up to 6)
      // Row 1: W1, W2, W3 (top of worker area)
      // Row 2: W4, W5, W6 (bottom of worker area)
      const w4Launch = workerLaunches[3];
      const w4Args = buildPaneSpawnArgs(w4Launch);
      const s4 = await runWezTermCli(weztermPath, [
        "cli",
        "split-pane",
        "--pane-id",
        String(pW1),
        "--bottom",
        "--percent",
        "50",
        "--cwd",
        w4Launch.cwd,
        "--",
        ...w4Args
      ]);
      const pW4 = parseInt(s4.stdout.trim().split(/\s+/).pop(), 10);

      // Finish Row 1 (W2, and W3 if present)
      const w2Launch = workerLaunches[1];
      const w2Args = buildPaneSpawnArgs(w2Launch);
      const s2 = await runWezTermCli(weztermPath, [
        "cli",
        "split-pane",
        "--pane-id",
        String(pW1),
        "--right",
        "--percent",
        "67",
        "--cwd",
        w2Launch.cwd,
        "--",
        ...w2Args
      ]);
      const pW2 = parseInt(s2.stdout.trim().split(/\s+/).pop(), 10);
      createdPanes.push({
        id: w2Launch.id,
        role: w2Launch.role,
        cli: w2Launch.cli,
        model: w2Launch.model,
        title: formatPaneTitle(w2Launch),
        paneId: pW2,
        cwd: w2Launch.cwd
      });

      const w3Launch = workerLaunches[2];
      const w3Args = buildPaneSpawnArgs(w3Launch);
      const s3 = await runWezTermCli(weztermPath, [
        "cli",
        "split-pane",
        "--pane-id",
        String(pW2),
        "--right",
        "--percent",
        "50",
        "--cwd",
        w3Launch.cwd,
        "--",
        ...w3Args
      ]);
      const pW3 = parseInt(s3.stdout.trim().split(/\s+/).pop(), 10);
      createdPanes.push({
        id: w3Launch.id,
        role: w3Launch.role,
        cli: w3Launch.cli,
        model: w3Launch.model,
        title: formatPaneTitle(w3Launch),
        paneId: pW3,
        cwd: w3Launch.cwd
      });

      // Insert W4 into createdPanes in order
      createdPanes.push({
        id: w4Launch.id,
        role: w4Launch.role,
        cli: w4Launch.cli,
        model: w4Launch.model,
        title: formatPaneTitle(w4Launch),
        paneId: pW4,
        cwd: w4Launch.cwd
      });

      // Finish Row 2 (W5, W6 if present)
      if (N >= 5) {
        const w5Launch = workerLaunches[4];
        const w5Args = buildPaneSpawnArgs(w5Launch);
        const w5Percent = N === 5 ? "50" : "67";
        const s5 = await runWezTermCli(weztermPath, [
          "cli",
          "split-pane",
          "--pane-id",
          String(pW4),
          "--right",
          "--percent",
          w5Percent,
          "--cwd",
          w5Launch.cwd,
          "--",
          ...w5Args
        ]);
        const pW5 = parseInt(s5.stdout.trim().split(/\s+/).pop(), 10);
        createdPanes.push({
          id: w5Launch.id,
          role: w5Launch.role,
          cli: w5Launch.cli,
          model: w5Launch.model,
          title: formatPaneTitle(w5Launch),
          paneId: pW5,
          cwd: w5Launch.cwd
        });

        if (N === 6) {
          const w6Launch = workerLaunches[5];
          const w6Args = buildPaneSpawnArgs(w6Launch);
          const s6 = await runWezTermCli(weztermPath, [
            "cli",
            "split-pane",
            "--pane-id",
            String(pW5),
            "--right",
            "--percent",
            "50",
            "--cwd",
            w6Launch.cwd,
            "--",
            ...w6Args
          ]);
          const pW6 = parseInt(s6.stdout.trim().split(/\s+/).pop(), 10);
          createdPanes.push({
            id: w6Launch.id,
            role: w6Launch.role,
            cli: w6Launch.cli,
            model: w6Launch.model,
            title: formatPaneTitle(w6Launch),
            paneId: pW6,
            cwd: w6Launch.cwd
          });
        }
      }
    }
  }

  // Attach GUI window to the swarm workspace so the layout is visible to the user
  let guiPid = null;
  const guiExe = findWezTermGui() ?? weztermPath;
  try {
    const guiProcess = spawn(guiExe, ["start", "--workspace", "swarm", "--attach"], {
      detached: true,
      stdio: "ignore"
    });
    guiProcess.unref();
    guiPid = guiProcess.pid;
  } catch {
    // If GUI spawn fails (e.g. running headless in test or container), CLI panes are still active
  }

  // Clean up any default dummy pane (pane 0 in workspace default) auto-created by mux server
  try {
    const allPanes = await listWezTermPanes(weztermPath);
    const dummy = allPanes.find((p) => p.pane_id === 0 && p.workspace === "default");
    if (dummy && orchPaneId !== 0) {
      await killWezTermPane(weztermPath, 0);
    }
  } catch {
    // Ignore
  }

  // Save session state to disk for clean shutdown via `swarm stop`
  saveSessionState({
    guiPid,
    configPath,
    panes: createdPanes
  });

  // Save .swarm/panes.json map of worker/orchestrator name -> WezTerm pane ID
  const panesMap = {};
  for (const pane of createdPanes) {
    if (pane.id && pane.paneId !== undefined) {
      panesMap[pane.id] = pane.paneId;
    }
  }
  savePanesMap(panesMap);

  // Initialize status bar across WezTerm window / tab areas
  await getSwarmStatus({ weztermPath }).catch(() => {});

  log(`Layout opened successfully in WezTerm (${createdPanes.length} total panes):`);
  for (const pane of createdPanes) {
    log(`  [pane ${pane.paneId}] ${pane.title}`);
  }

  return {
    ok: true,
    panes: createdPanes,
    configPath
  };
}

/**
 * Cleanly close all panes and terminate the swarm session.
 * Leaves no leftover processes.
 *
 * @param {object} [options]
 * @param {string} [options.weztermOverride] - Optional override for wezterm executable path.
 * @param {Function} [options.log] - Log sink.
 * @returns {Promise<{ ok: boolean, closedCount: number }>}
 */
export async function stopSwarmLayout(options = {}) {
  const log = options.log ?? ((msg) => console.log(msg));
  const weztermPath = options.weztermOverride ?? findWezTerm();

  const state = loadSessionState();

  if (!state && !weztermPath) {
    log("No active swarm session found.");
    return { ok: true, closedCount: 0 };
  }

  log("Swarm Engine Team: Stopping active session and closing all panes...");

  const killedPaneIds = new Set();

  if (weztermPath && state?.panes && Array.isArray(state.panes)) {
    // Kill every pane tracked in the session state
    for (const pane of state.panes) {
      if (pane.paneId !== undefined && pane.paneId !== null) {
        const killed = await killWezTermPane(weztermPath, pane.paneId);
        if (killed) {
          killedPaneIds.add(pane.paneId);
        }
      }
    }
  }

  // Also verify if any remaining panes in workspace 'swarm' are still open and close them
  if (weztermPath) {
    try {
      const remaining = await listWezTermPanes(weztermPath);
      for (const p of remaining) {
        if (p.workspace === "swarm" && !killedPaneIds.has(p.pane_id)) {
          const killed = await killWezTermPane(weztermPath, p.pane_id);
          if (killed) {
            killedPaneIds.add(p.pane_id);
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  // If a GUI PID was tracked, give it a moment to exit or kill if orphaned
  if (state?.guiPid) {
    try {
      process.kill(state.guiPid, "SIGTERM");
    } catch {
      // Process already exited cleanly
    }
  }

  // Clean up session state file, .swarm/panes.json, and .swarm/status.json
  clearSessionState();
  clearPanesMap();
  clearStatusState();

  const closedCount = killedPaneIds.size;
  log(`Swarm stopped cleanly. Closed ${closedCount} pane(s); no leftover processes.`);

  return {
    ok: true,
    closedCount
  };
}
