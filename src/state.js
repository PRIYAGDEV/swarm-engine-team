/**
 * State management for active Swarm sessions.
 * Records pane IDs, process IDs, and creation timestamps in a local
 * .swarm-state.json file so `swarm stop` can cleanly terminate all panes.
 */

import fs from "node:fs";
import path from "node:path";

const STATE_FILENAME = ".swarm-state.json";
export const SWARM_DIR = ".swarm";
export const PANES_FILENAME = "panes.json";

/**
 * Get the path to .swarm/panes.json.
 * @param {string} [baseDir]
 * @returns {string}
 */
export function getPanesFilePath(baseDir = process.cwd()) {
  return path.resolve(baseDir, SWARM_DIR, PANES_FILENAME);
}

/**
 * Save worker name to WezTerm pane ID mapping to .swarm/panes.json.
 *
 * @param {Record<string, number>} panesMap - Object mapping worker name (e.g. "worker-1") to pane ID.
 * @param {string} [baseDir]
 * @returns {string} Path to written panes.json file.
 */
export function savePanesMap(panesMap, baseDir = process.cwd()) {
  const dir = path.resolve(baseDir, SWARM_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, PANES_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify(panesMap, null, 2), "utf8");
  return filePath;
}

/**
 * Load .swarm/panes.json mapping from disk.
 *
 * @param {string} [baseDir]
 * @returns {Record<string, number>|null}
 */
export function loadPanesMap(baseDir = process.cwd()) {
  const filePath = getPanesFilePath(baseDir);
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
 * Remove .swarm/panes.json on swarm stop.
 * Also cleans up .swarm directory if empty.
 *
 * @param {string} [baseDir]
 */
export function clearPanesMap(baseDir = process.cwd()) {
  const filePath = getPanesFilePath(baseDir);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore
    }
  }
  const dir = path.resolve(baseDir, SWARM_DIR);
  if (fs.existsSync(dir)) {
    try {
      const remaining = fs.readdirSync(dir);
      if (remaining.length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {
      // Ignore
    }
  }
}

/**
 * Get the path to the state file relative to the project root.
 * @param {string} [baseDir]
 * @returns {string}
 */
export function getStateFilePath(baseDir = process.cwd()) {
  return path.resolve(baseDir, STATE_FILENAME);
}

/**
 * Save active session state to disk.
 *
 * @param {object} state - Session metadata ({ panes: Array<{ id, paneId, role, title, pid }>, launchedAt, baseDir }).
 * @param {string} [baseDir]
 */
export function saveSessionState(state, baseDir = process.cwd()) {
  const filePath = getStateFilePath(baseDir);
  const data = JSON.stringify(
    {
      version: 1,
      launchedAt: new Date().toISOString(),
      baseDir: path.resolve(baseDir),
      ...state
    },
    null,
    2
  );
  fs.writeFileSync(filePath, data, "utf8");
}

/**
 * Load the active session state from disk if it exists.
 *
 * @param {string} [baseDir]
 * @returns {object|null}
 */
export function loadSessionState(baseDir = process.cwd()) {
  const filePath = getStateFilePath(baseDir);
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
 * Remove the active session state file.
 *
 * @param {string} [baseDir]
 */
export function clearSessionState(baseDir = process.cwd()) {
  const filePath = getStateFilePath(baseDir);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Ignore errors on unlink
    }
  }
}
