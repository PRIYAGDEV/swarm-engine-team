/**
 * State management for active Swarm sessions.
 * Records pane IDs, process IDs, and creation timestamps in a local
 * .swarm-state.json file so `swarm stop` can cleanly terminate all panes.
 */

import fs from "node:fs";
import path from "node:path";

const STATE_FILENAME = ".swarm-state.json";

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
