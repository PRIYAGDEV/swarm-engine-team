/**
 * Swarm Task Dispatch System (Stage 3).
 *
 * Enables dispatching tasks from the orchestrator (or from any normal terminal
 * via `swarm send <target> "<task>"`) to worker panes.
 *
 * Syntax supported:
 *   - `@worker-3 <task>`       -> Sends task to worker-3
 *   - `@all <task>`            -> Broadcasts task to all active workers
 *   - `@workers 1,2,5 <task>`  -> Sends task to worker-1, worker-2, and worker-5
 *   - Also accepts targets without leading '@' (e.g. `worker-2`, `all`, `workers 1,2`)
 *
 * Delivery:
 *   - Typed into target pane using `wezterm cli send-text --pane-id <id> --no-paste`
 *   - Appends Enter keypress (\r\n) so the command executes in the target CLI
 *   - Works universally for ANY AI coding CLI or shell
 *   - Pure argument array invocation; never builds shell strings
 */

import { findWezTerm, runWezTermCli, getWezTermNotFoundMessage } from "./wezterm.js";
import { loadPanesMap } from "./state.js";

/**
 * Parse a raw input line using the @target syntax into target and task components.
 * Examples:
 *   "@worker-3 write tests"       -> { target: "@worker-3", task: "write tests" }
 *   "@all git status"             -> { target: "@all", task: "git status" }
 *   "@workers 1,2,5 run build"    -> { target: "@workers 1,2,5", task: "run build" }
 *
 * @param {string} line
 * @returns {{ target: string, task: string }|null}
 */
export function parseDispatchLine(line) {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith("@")) return null;

  // Pattern: @workers 1,2,5 <task...>
  const workersMultiMatch = trimmed.match(/^@(workers?)\s+([\d,\s]+)\s+([\s\S]+)$/i);
  if (workersMultiMatch) {
    const rawNumbers = workersMultiMatch[2].replace(/\s+/g, "");
    return {
      target: `@workers ${rawNumbers}`,
      task: workersMultiMatch[3].trim()
    };
  }

  // Pattern: @all <task...>
  const allMatch = trimmed.match(/^@all\s+([\s\S]+)$/i);
  if (allMatch) {
    return {
      target: "@all",
      task: allMatch[1].trim()
    };
  }

  // Pattern: @<name> <task...> (e.g. @worker-3 <task>)
  const singleMatch = trimmed.match(/^@([\w-]+)\s+([\s\S]+)$/);
  if (singleMatch) {
    return {
      target: `@${singleMatch[1]}`,
      task: singleMatch[2].trim()
    };
  }

  return null;
}

/**
 * Resolve target specification into a list of verified worker names.
 * Rejects unknown targets with a clear error containing active worker names.
 *
 * @param {string} targetSpec - Target selector (e.g. "@worker-3", "worker-3", "@all", "@workers 1,2").
 * @param {Record<string, number>} panesMap - Map of worker name to pane ID.
 * @returns {string[]} List of valid worker names to target.
 */
export function resolveTargetWorkers(targetSpec, panesMap) {
  if (!panesMap || typeof panesMap !== "object") {
    throw new Error("Invalid panes map: expected an active worker mapping object.");
  }

  // Available worker names are keys starting with "worker-"
  const allWorkerNames = Object.keys(panesMap)
    .filter((k) => k.startsWith("worker-"))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ""), 10) || 0;
      const numB = parseInt(b.replace(/\D/g, ""), 10) || 0;
      return numA - numB;
    });

  if (allWorkerNames.length === 0) {
    throw new Error("No active worker panes found in the current swarm session.");
  }

  const raw = String(targetSpec ?? "").trim();
  if (!raw) {
    throw new Error(
      `Target cannot be empty. Available workers: ${allWorkerNames.join(", ")}`
    );
  }

  // Normalize: strip leading '@'
  const normalized = raw.startsWith("@") ? raw.slice(1).trim() : raw;

  // Case 1: "all" -> broadcast to all workers
  if (normalized.toLowerCase() === "all") {
    return [...allWorkerNames];
  }

  // Case 2: "workers 1,2,5" or "worker 1,2,5"
  const multiWorkerMatch = normalized.match(/^workers?\s+([\d,\s]+)$/i);
  if (multiWorkerMatch) {
    const numbers = multiWorkerMatch[1]
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (numbers.length === 0) {
      throw new Error(
        `Invalid @workers specification "${raw}". Expected format: @workers 1,2,5`
      );
    }

    const resolved = [];
    for (const num of numbers) {
      const workerName = `worker-${num}`;
      if (!allWorkerNames.includes(workerName)) {
        throw new Error(
          `Unknown target: "${workerName}". Active workers: ${allWorkerNames.join(", ")}`
        );
      }
      if (!resolved.includes(workerName)) {
        resolved.push(workerName);
      }
    }
    return resolved;
  }

  // Case 3: Comma-separated numbers without the word "workers" (e.g. "1,2,5")
  if (/^\d+(\s*,\s*\d+)+$/.test(normalized)) {
    const numbers = normalized
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const resolved = [];
    for (const num of numbers) {
      const workerName = `worker-${num}`;
      if (!allWorkerNames.includes(workerName)) {
        throw new Error(
          `Unknown target: "${workerName}". Active workers: ${allWorkerNames.join(", ")}`
        );
      }
      if (!resolved.includes(workerName)) {
        resolved.push(workerName);
      }
    }
    return resolved;
  }

  // Case 4: Single worker ID: "worker-3" or "worker3" or plain number "3"
  let singleName = normalized.toLowerCase();
  if (/^\d+$/.test(singleName)) {
    singleName = `worker-${singleName}`;
  } else if (/^worker\d+$/i.test(singleName)) {
    singleName = singleName.replace(/^worker/i, "worker-");
  }

  if (allWorkerNames.includes(singleName)) {
    return [singleName];
  }

  // Case 5: Target matches another known key in panesMap (e.g. "orchestrator")
  if (panesMap[singleName] !== undefined) {
    return [singleName];
  }

  // Unrecognized target: reject loudly with active workers
  throw new Error(
    `Unknown target: "${raw}". Active workers: ${allWorkerNames.join(", ")}`
  );
}

/**
 * Deliver task text to a single WezTerm pane by typing it in with `send-text`
 * and appending an Enter keystroke.
 *
 * @param {string} weztermPath - Path to wezterm executable.
 * @param {number} paneId - Target WezTerm pane ID.
 * @param {string} taskText - Raw task text to send.
 * @returns {Promise<void>}
 */
export async function sendTextToPane(weztermPath, paneId, taskText) {
  if (typeof paneId !== "number" || isNaN(paneId)) {
    throw new Error(`Invalid paneId "${paneId}" passed to sendTextToPane.`);
  }

  const rawText = String(taskText ?? "");
  if (!rawText) {
    throw new Error("Cannot send empty task to pane.");
  }

  // Ensure trailing newline / Enter so the receiving CLI or shell executes the command
  const textWithEnter = rawText.endsWith("\n") || rawText.endsWith("\r")
    ? rawText
    : `${rawText}\r\n`;

  // Verified against `wezterm cli send-text --help`:
  // wezterm cli send-text --pane-id <PANE_ID> --no-paste [TEXT]
  await runWezTermCli(weztermPath, [
    "cli",
    "send-text",
    "--pane-id",
    String(paneId),
    "--no-paste",
    "--",
    textWithEnter
  ]);
}

/**
 * Dispatch a task to target worker(s).
 *
 * @param {object} options
 * @param {string} options.target - Target specifier (@worker-3, @all, @workers 1,2,5).
 * @param {string} options.task - Task text to deliver.
 * @param {string} [options.baseDir] - Workspace base directory containing .swarm/panes.json.
 * @param {string} [options.weztermPath] - Optional override for wezterm executable.
 * @param {Function} [options.log] - Log callback.
 * @returns {Promise<{ ok: boolean, delivered: Array<{ worker: string, paneId: number, task: string }> }>}
 */
export async function dispatchTask(options) {
  const log = options.log ?? ((msg) => console.log(msg));
  const baseDir = options.baseDir ?? process.cwd();
  const weztermPath = options.weztermPath ?? findWezTerm();

  if (!weztermPath) {
    throw new Error(getWezTermNotFoundMessage());
  }

  const panesMap = loadPanesMap(baseDir);
  if (!panesMap || typeof panesMap !== "object") {
    throw new Error(
      "No active swarm session found. Run `swarm` first to start the terminal layout."
    );
  }

  const targetWorkers = resolveTargetWorkers(options.target, panesMap);

  const delivered = [];
  for (const workerName of targetWorkers) {
    const paneId = panesMap[workerName];
    if (paneId === undefined || paneId === null) {
      throw new Error(`Worker "${workerName}" does not have an active pane ID in .swarm/panes.json.`);
    }

    await sendTextToPane(weztermPath, paneId, options.task);
    delivered.push({
      worker: workerName,
      paneId,
      task: options.task
    });
    log(`[dispatch] Sent task to ${workerName} (pane ${paneId}): "${options.task.replace(/\r?\n/g, "\\n")}"`);
  }

  return {
    ok: true,
    delivered
  };
}
