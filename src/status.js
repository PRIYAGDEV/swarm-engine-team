/**
 * Swarm Status and Health Monitoring System (Stage 4).
 *
 * Responsibilities:
 * 1. Tracks observable lifecycle state for each worker pane:
 *    - `idle`: Process alive, awaiting its first task.
 *    - `working`: Task received; output actively changing or changed within last N seconds.
 *    - `done`: Task received; output stabilized for >= N seconds with process alive.
 *    - `error`: Process terminated, pane missing, or fatal error encountered.
 * 2. Independent of any CLI-specific API (uses only process liveness, task dispatch events,
 *    and output delta sampling via `wezterm cli get-text`).
 * 3. Renders the bottom/tab status bar in WezTerm (session name, worker count, per-worker states).
 * 4. Powers `swarm status` from any terminal.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  findWezTerm,
  listWezTermPanes,
  getWezTermPaneText,
  setWezTermTabTitle,
  setWezTermWindowTitle
} from "./wezterm.js";
import { loadPanesMap, getPanesFilePath, SWARM_DIR } from "./state.js";
import { sendIpcMessage } from "./ipc.js";

export const SESSION_NAME = "swarm-engine-team";
export const STATUS_FILENAME = "status.json";
export const DEFAULT_STABILITY_SECONDS = 3;

/**
 * Compute a fast SHA-256 hash of text content for change detection.
 * @param {string} text
 * @returns {string}
 */
export function hashText(text) {
  return crypto.createHash("sha256").update(text ?? "").digest("hex");
}

/**
 * Get path to .swarm/status.json.
 * @param {string} [baseDir]
 * @returns {string}
 */
export function getStatusFilePath(baseDir = process.cwd()) {
  return path.resolve(baseDir, SWARM_DIR, STATUS_FILENAME);
}

/**
 * Save persistent status tracking metadata to .swarm/status.json.
 * @param {object} statusData
 * @param {string} [baseDir]
 */
export function saveStatusState(statusData, baseDir = process.cwd()) {
  const dir = path.resolve(baseDir, SWARM_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, STATUS_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify(statusData, null, 2), "utf8");
}

/**
 * Load persistent status tracking metadata from .swarm/status.json.
 * @param {string} [baseDir]
 * @returns {object|null}
 */
export function loadStatusState(baseDir = process.cwd()) {
  const filePath = getStatusFilePath(baseDir);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Clear .swarm/status.json on swarm stop.
 * @param {string} [baseDir]
 */
export function clearStatusState(baseDir = process.cwd()) {
  const filePath = getStatusFilePath(baseDir);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore
    }
  }
}

/**
 * Record a dispatched task event for a worker in .swarm/status.json.
 *
 * @param {string} workerName
 * @param {string} taskText
 * @param {string} [baseDir]
 */
export function recordTaskDispatched(workerName, taskText, baseDir = process.cwd()) {
  const existing = loadStatusState(baseDir) ?? {
    sessionName: SESSION_NAME,
    workers: {}
  };

  const now = Date.now();
  const workerRecord = existing.workers[workerName] ?? {
    taskCount: 0,
    lastTaskSentAt: null,
    lastOutputHash: null,
    lastOutputChangedAt: null,
    state: "idle"
  };

  workerRecord.taskCount = (workerRecord.taskCount || 0) + 1;
  workerRecord.lastTaskSentAt = now;
  workerRecord.lastOutputChangedAt = now;
  workerRecord.lastTask = taskText;
  workerRecord.state = "working";

  existing.workers[workerName] = workerRecord;
  existing.updatedAt = now;

  saveStatusState(existing, baseDir);
}

/**
 * Evaluate a worker's observable state based on process liveness,
 * task dispatch history, and output stabilization.
 *
 * @param {object} params
 * @param {boolean} params.isAlive - Whether the pane is currently active in WezTerm.
 * @param {string|null} params.currentText - Current text retrieved via get-text.
 * @param {object} [params.previousRecord] - Stored snapshot from .swarm/status.json.
 * @param {number} [params.stabilitySec=3] - Output stability window in seconds.
 * @param {number} [params.now=Date.now()] - Current epoch timestamp.
 * @returns {{ state: "idle"|"working"|"done"|"error", record: object }}
 */
export function evaluateWorkerState({
  isAlive,
  currentText,
  previousRecord = {},
  stabilitySec = DEFAULT_STABILITY_SECONDS,
  now = Date.now()
}) {
  // 1. Process / pane liveness check
  if (!isAlive) {
    return {
      state: "error",
      record: {
        ...previousRecord,
        state: "error",
        lastCheckedAt: now
      }
    };
  }

  // 2. Task dispatch check: if no task has ever been sent, worker is idle
  const lastTaskSentAt = previousRecord.lastTaskSentAt;
  if (!lastTaskSentAt) {
    return {
      state: "idle",
      record: {
        ...previousRecord,
        lastOutputHash: currentText ? hashText(currentText) : previousRecord.lastOutputHash,
        lastCheckedAt: now,
        state: "idle"
      }
    };
  }

  // 3. Output change check via text hashing
  const currentHash = currentText !== null ? hashText(currentText) : null;
  const previousHash = previousRecord.lastOutputHash;
  const outputChanged = currentHash !== null && previousHash !== null && currentHash !== previousHash;

  let lastOutputChangedAt = previousRecord.lastOutputChangedAt || lastTaskSentAt;
  if (outputChanged) {
    lastOutputChangedAt = now;
  }

  const timeSinceTaskSec = (now - lastTaskSentAt) / 1000;
  const timeSinceChangeSec = (now - lastOutputChangedAt) / 1000;

  let computedState = "idle";

  // Check for fatal error messages in pane text
  if (
    currentText &&
    (/\b(FATAL ERROR|UnhandledPromiseRejection|Panic|Segmentation fault)\b/i.test(currentText) ||
      /\bCommand not found\b/i.test(currentText))
  ) {
    computedState = "error";
  } else if (timeSinceTaskSec < stabilitySec) {
    // Recently received a task -> actively working
    computedState = "working";
  } else if (outputChanged || timeSinceChangeSec < stabilitySec) {
    // Output changed within the last N seconds -> working
    computedState = "working";
  } else {
    // Output has remained stable for >= N seconds after task delivery -> done
    computedState = "done";
  }

  return {
    state: computedState,
    record: {
      ...previousRecord,
      lastOutputHash: currentHash ?? previousHash,
      lastOutputChangedAt,
      lastCheckedAt: now,
      state: computedState
    }
  };
}

/**
 * Format status bar line for WezTerm tab/window title.
 * Format: "swarm-engine-team | 3 workers | worker-1: idle | worker-2: working | worker-3: done"
 *
 * @param {object} statusResult
 * @returns {string}
 */
export function formatStatusBar(statusResult) {
  if (!statusResult || !statusResult.running) {
    return `${SESSION_NAME} · not running`;
  }

  const workerStates = (statusResult.workers || [])
    .map((w) => `${w.id}: ${w.state}`)
    .join(" · ");

  const countStr = `${statusResult.workerCount} worker${statusResult.workerCount === 1 ? "" : "s"}`;
  return `${statusResult.sessionName} · ${countStr} · ${workerStates}`;
}

/**
 * Update the WezTerm tab and window title to reflect the live status bar.
 *
 * @param {string} weztermPath
 * @param {object} statusResult
 * @param {Record<string, number>} panesMap
 * @returns {Promise<boolean>}
 */
export async function updateWezTermStatusBar(weztermPath, statusResult, panesMap) {
  if (!panesMap || !weztermPath) return false;
  const orchId = panesMap["orchestrator"] ?? Object.values(panesMap)[0];
  if (orchId === undefined || orchId === null) return false;

  const barText = formatStatusBar(statusResult);
  await setWezTermTabTitle(weztermPath, orchId, barText);
  await setWezTermWindowTitle(weztermPath, orchId, barText);
  return true;
}

/**
 * Inspect the live status of all workers in the active Swarm session.
 *
 * @param {object} [options]
 * @param {string} [options.baseDir]
 * @param {string} [options.weztermPath]
 * @param {number} [options.stabilitySec=3]
 * @returns {Promise<{ running: boolean, sessionName: string, workerCount: number, workers: Array<object>, message?: string }>}
 */
export async function getSwarmStatus(options = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  const weztermPath = options.weztermPath ?? findWezTerm();
  const stabilitySec = options.stabilitySec ?? DEFAULT_STABILITY_SECONDS;

  // 1. Check active Named Pipe IPC session first (in-terminal TUI session)
  try {
    const ipcRes = await sendIpcMessage({ command: "status" }, { timeoutMs: 1200 });
    if (ipcRes && ipcRes.ok && ipcRes.running) {
      return {
        running: true,
        sessionName: ipcRes.sessionName ?? SESSION_NAME,
        workerCount: ipcRes.workerCount ?? (ipcRes.workers?.length || 0),
        workers: ipcRes.workers ?? [],
        activeTask: ipcRes.activeTask,
        source: "ipc"
      };
    }
  } catch {
    // IPC not running, continue with WezTerm status inspection
  }

  const panesMap = loadPanesMap(baseDir);
  if (!panesMap || typeof panesMap !== "object") {
    return {
      running: false,
      sessionName: SESSION_NAME,
      workerCount: 0,
      workers: [],
      message: "not running"
    };
  }

  const workerNames = Object.keys(panesMap)
    .filter((k) => k.startsWith("worker-"))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ""), 10) || 0;
      const numB = parseInt(b.replace(/\D/g, ""), 10) || 0;
      return numA - numB;
    });

  if (workerNames.length === 0) {
    return {
      running: false,
      sessionName: SESSION_NAME,
      workerCount: 0,
      workers: [],
      message: "not running"
    };
  }

  const activePanes = weztermPath ? await listWezTermPanes(weztermPath) : [];
  const activePaneIds = new Set(activePanes.map((p) => p.pane_id));

  // If none of our tracked panes are alive, the session is dead
  const anyAlive = Object.values(panesMap).some((id) => activePaneIds.has(id));
  if (!anyAlive && activePanes.length > 0) {
    return {
      running: false,
      sessionName: SESSION_NAME,
      workerCount: 0,
      workers: [],
      message: "not running"
    };
  }

  const statusState = loadStatusState(baseDir) ?? {
    sessionName: SESSION_NAME,
    workers: {}
  };

  const now = Date.now();
  const evaluatedWorkers = [];

  for (const workerName of workerNames) {
    const paneId = panesMap[workerName];
    const isAlive = activePaneIds.has(paneId);
    let currentText = null;

    if (isAlive && weztermPath) {
      currentText = await getWezTermPaneText(weztermPath, paneId);
    }

    const previousRecord = statusState.workers[workerName] ?? {};
    const { state, record } = evaluateWorkerState({
      isAlive,
      currentText,
      previousRecord,
      stabilitySec,
      now
    });

    statusState.workers[workerName] = record;
    evaluatedWorkers.push({
      id: workerName,
      paneId,
      state
    });
  }

  statusState.updatedAt = now;
  saveStatusState(statusState, baseDir);

  const result = {
    running: true,
    sessionName: SESSION_NAME,
    workerCount: evaluatedWorkers.length,
    workers: evaluatedWorkers
  };

  // Synchronize WezTerm status bar area (tab title & window title)
  if (weztermPath) {
    await updateWezTermStatusBar(weztermPath, result, panesMap).catch(() => {});
  }

  return result;
}

/**
 * Print human-readable status report for `swarm status`.
 *
 * @param {object} statusResult
 * @param {Function} [log]
 */
export function printSwarmStatus(statusResult, log = console.log) {
  if (!statusResult || !statusResult.running) {
    log("Swarm Engine Team: not running");
    return;
  }

  log(`Swarm Engine Team — Session Status`);
  log(`Session:      ${statusResult.sessionName}`);
  log(`Workers:      ${statusResult.workerCount} active worker(s)`);
  log(`Status:`);
  for (const worker of statusResult.workers) {
    const stateColor =
      worker.state === "working"
        ? "[working]"
        : worker.state === "done"
          ? "[done]   "
          : worker.state === "error"
            ? "[error]  "
            : "[idle]   ";
    log(`  ${worker.id.padEnd(12)} (pane ${String(worker.paneId).padStart(2)})  ${stateColor}`);
  }
}
