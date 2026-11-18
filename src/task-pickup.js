/**
 * Swarm Engine Team - Task Pickup & Context Auto-Detection.
 *
 * Resolves the initial active task for the session using observable sources:
 *   (1) Explicit launch flag (--task <text> or -t <text>)
 *   (2) Persistent file from previous session exit (.swarm/last-task.txt)
 *   (3) Git context (uncommitted changes or recent commit message `git log -1 --pretty=%s`)
 *   (4) Default standby prompt if none of the above exist
 *
 * Persists the last active task on exit or dispatch so the team immediately
 * resumes work right where it stopped without hardcoding.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const SWARM_DIR = ".swarm";
export const LAST_TASK_FILENAME = "last-task.txt";

/**
 * Get path to .swarm/last-task.txt.
 * @param {string} [baseDir=process.cwd()]
 * @returns {string}
 */
export function getLastTaskFilePath(baseDir = process.cwd()) {
  return path.resolve(baseDir, SWARM_DIR, LAST_TASK_FILENAME);
}

/**
 * Save the last active task to .swarm/last-task.txt.
 *
 * @param {string} task
 * @param {string} [baseDir=process.cwd()]
 * @returns {boolean}
 */
export function saveLastTask(task, baseDir = process.cwd()) {
  if (typeof task !== "string" || !task.trim()) {
    return false;
  }
  try {
    const dir = path.resolve(baseDir, SWARM_DIR);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, LAST_TASK_FILENAME);
    fs.writeFileSync(filePath, task.trim(), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the last saved task from .swarm/last-task.txt.
 *
 * @param {string} [baseDir=process.cwd()]
 * @returns {string|null}
 */
export function loadLastTask(baseDir = process.cwd()) {
  const filePath = getLastTaskFilePath(baseDir);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/**
 * Clear the saved last-task.txt file.
 *
 * @param {string} [baseDir=process.cwd()]
 */
export function clearLastTask(baseDir = process.cwd()) {
  const filePath = getLastTaskFilePath(baseDir);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }
}

/**
 * Extract recent task context from git repository (uncommitted changes or last commit).
 *
 * @param {string} [baseDir=process.cwd()]
 * @returns {string|null}
 */
export function getGitTaskContext(baseDir = process.cwd()) {
  try {
    // 1. Check for uncommitted working tree changes
    const statusRes = spawnSync("git", ["status", "--porcelain"], {
      cwd: baseDir,
      encoding: "utf8",
      windowsHide: true
    });

    if (statusRes.status === 0 && typeof statusRes.stdout === "string") {
      const lines = statusRes.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      if (lines.length > 0) {
        const fileNames = lines
          .map((l) => l.replace(/^[MADRCU?!]{1,2}\s+/, "").trim())
          .filter((name) => Boolean(name) && !name.startsWith(".swarm") && !name.includes("/.swarm") && !name.includes("\\.swarm"));
        const preview = fileNames.slice(0, 3).join(", ");
        const extra = fileNames.length > 3 ? ` (+${fileNames.length - 3} more)` : "";
        return `Resume uncommitted changes in ${preview}${extra}`;
      }
    }

    // 2. Fall back to most recent commit message
    const logRes = spawnSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: baseDir,
      encoding: "utf8",
      windowsHide: true
    });

    if (logRes.status === 0 && typeof logRes.stdout === "string") {
      const commitMsg = logRes.stdout.trim();
      if (commitMsg.length > 0) {
        return `Resume work following: ${commitMsg}`;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the initial active task for a session following strict priority order:
 *   (1) Explicit launch flag (--task <text> / -t <text>)
 *   (2) Persisted last task (.swarm/last-task.txt)
 *   (3) Git context (uncommitted changes / recent commit)
 *   (4) Default standby prompt
 *
 * @param {object} [options]
 * @param {string} [options.explicitTask]
 * @param {string} [options.baseDir=process.cwd()]
 * @returns {{ task: string, source: "cli_flag" | "last_task_file" | "git_context" | "default" }}
 */
export function resolveInitialTask({ explicitTask, baseDir = process.cwd() } = {}) {
  // 1. Explicit task flag
  if (typeof explicitTask === "string" && explicitTask.trim().length > 0) {
    return {
      task: explicitTask.trim(),
      source: "cli_flag"
    };
  }

  // 2. Persisted last task from previous session
  const lastTask = loadLastTask(baseDir);
  if (lastTask) {
    return {
      task: lastTask,
      source: "last_task_file"
    };
  }

  // 3. Git repository context
  const gitContext = getGitTaskContext(baseDir);
  if (gitContext) {
    return {
      task: gitContext,
      source: "git_context"
    };
  }

  // 4. Standby default
  return {
    task: "Standby for orchestrator prompts",
    source: "default"
  };
}
