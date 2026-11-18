/**
 * WezTerm detection and CLI interface module.
 *
 * All operations pass CLI arguments strictly as arrays (never joining strings),
 * supporting paths with spaces. On Windows, CLI commands are run with cwd set
 * to the WezTerm socket directory to ensure reliable IPC with the GUI instance.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Common WezTerm installation paths on Windows.
 */
const WINDOWS_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "WezTerm", "wezterm.exe"),
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "WezTerm", "wezterm.exe"),
  path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "WezTerm", "wezterm.exe")
];

/**
 * Locate the WezTerm executable on the host system.
 * Checks PATH first, then well-known installation directories.
 *
 * @returns {string|null} Full path to wezterm executable or null if not found.
 */
export function findWezTerm() {
  // Check if wezterm is directly callable in PATH
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  const exeName = process.platform === "win32" ? "wezterm.exe" : "wezterm";

  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, exeName);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Ignore permission or file system errors while scanning PATH
    }
  }

  // On Windows, check standard installation directories
  if (process.platform === "win32") {
    for (const candidate of WINDOWS_CANDIDATES) {
      try {
        if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Ignore errors
      }
    }
  }

  return null;
}

/**
 * Locate the WezTerm GUI executable.
 * On Windows, this is wezterm-gui.exe located next to wezterm.exe.
 * On other platforms, it is the same wezterm binary.
 *
 * @returns {string|null}
 */
export function findWezTermGui() {
  const cliPath = findWezTerm();
  if (!cliPath) return null;

  if (process.platform === "win32") {
    const guiPath = path.join(path.dirname(cliPath), "wezterm-gui.exe");
    if (fs.existsSync(guiPath)) {
      return guiPath;
    }
  }

  return cliPath;
}

/**
 * Returns a human-friendly error string explaining where to install WezTerm.
 * @returns {string}
 */
export function getWezTermNotFoundMessage() {
  return [
    "Error: WezTerm was not found on your system.",
    "",
    "WezTerm is required to open the swarm terminal layout.",
    "You can get WezTerm here:",
    "  - Windows (winget):   winget install wez.wezterm",
    "  - Windows (portable): https://github.com/wez/wezterm/releases",
    "  - Official website:   https://wezfurlong.org/wezterm/installation.html",
    "",
    "Once installed, ensure `wezterm` is in your PATH and retry."
  ].join("\n");
}

/**
 * Returns the directory containing WezTerm's local communication socket.
 * On Windows, running `wezterm cli` from this directory allows the CLI to
 * connect reliably to the GUI instance.
 *
 * @returns {string}
 */
export function getWezTermSocketDir() {
  const home = os.homedir();
  const socketDir = path.join(home, ".local", "share", "wezterm");
  try {
    if (!fs.existsSync(socketDir)) {
      fs.mkdirSync(socketDir, { recursive: true });
    }
  } catch {
    // Ignore if directory already exists or cannot be created
  }
  return socketDir;
}

/**
 * Clean up any stale WezTerm GUI socket files left behind by terminated instances.
 */
export function cleanStaleWezTermSockets() {
  const dir = getWezTermSocketDir();
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const match = entry.match(/^gui-sock-(\d+)$/);
      if (match) {
        const pid = parseInt(match[1], 10);
        try {
          process.kill(pid, 0);
        } catch {
          try {
            fs.unlinkSync(path.join(dir, entry));
          } catch {
            // Ignore
          }
        }
      }
    }
  } catch {
    // Ignore
  }
}

/**
 * Execute a WezTerm CLI command with arguments passed strictly as an array.
 *
 * @param {string} weztermPath - Path to wezterm executable.
 * @param {string[]} cliArgs - Subcommand and arguments array (e.g. ['cli', 'list', '--format', 'json']).
 * @param {object} [options] - Additional spawn options.
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function runWezTermCli(weztermPath, cliArgs, options = {}) {
  cleanStaleWezTermSockets();
  const socketDir = getWezTermSocketDir();
  const execOptions = {
    cwd: socketDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  };

  return new Promise((resolve, reject) => {
    const child = spawn(weztermPath, cliArgs, execOptions);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", reject);

    child.on("exit", (code) => {
      // Destroy streams immediately to prevent Node's event loop from hanging on
      // background processes (like wezterm-mux-server) that inherited stdout/stderr handles.
      try {
        child.stdout.destroy();
        child.stderr.destroy();
      } catch {
        // Ignore
      }

      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const msg = stderr.trim() || stdout.trim() || `Exit code ${code}`;
        const err = new Error(`WezTerm CLI command failed (${code}): ${msg}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

/**
 * Query active WezTerm panes using `wezterm cli list --format json`.
 *
 * @param {string} weztermPath
 * @returns {Promise<Array<object>>}
 */
export async function listWezTermPanes(weztermPath) {
  try {
    const { stdout } = await runWezTermCli(weztermPath, ["cli", "list", "--format", "json"]);
    // Strip any preceding warning/debug logs before the JSON array
    const jsonStart = stdout.indexOf("[");
    const jsonEnd = stdout.lastIndexOf("]");
    if (jsonStart !== -1 && jsonEnd !== -1) {
      const jsonText = stdout.slice(jsonStart, jsonEnd + 1);
      return JSON.parse(jsonText);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Kill a single WezTerm pane by its pane ID.
 *
 * @param {string} weztermPath
 * @param {number|string} paneId
 * @returns {Promise<boolean>}
 */
export async function killWezTermPane(weztermPath, paneId) {
  try {
    await runWezTermCli(weztermPath, ["cli", "kill-pane", "--pane-id", String(paneId)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Retrieve the current textual content of a WezTerm pane via `wezterm cli get-text`.
 *
 * @param {string} weztermPath
 * @param {number|string} paneId
 * @returns {Promise<string|null>}
 */
export async function getWezTermPaneText(weztermPath, paneId) {
  try {
    const { stdout } = await runWezTermCli(weztermPath, [
      "cli",
      "get-text",
      "--pane-id",
      String(paneId)
    ]);
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Set the tab title for a given pane via `wezterm cli set-tab-title`.
 *
 * @param {string} weztermPath
 * @param {number|string} paneId
 * @param {string} title
 * @returns {Promise<boolean>}
 */
export async function setWezTermTabTitle(weztermPath, paneId, title) {
  try {
    await runWezTermCli(weztermPath, [
      "cli",
      "set-tab-title",
      "--pane-id",
      String(paneId),
      "--",
      title
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Set the window title for a given pane via `wezterm cli set-window-title`.
 *
 * @param {string} weztermPath
 * @param {number|string} paneId
 * @param {string} title
 * @returns {Promise<boolean>}
 */
export async function setWezTermWindowTitle(weztermPath, paneId, title) {
  try {
    await runWezTermCli(weztermPath, [
      "cli",
      "set-window-title",
      "--pane-id",
      String(paneId),
      "--",
      title
    ]);
    return true;
  } catch {
    return false;
  }
}
