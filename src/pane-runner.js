#!/usr/bin/env node
/**
 * Per-pane process runner.
 * Invoked by WezTerm layout manager for each pane.
 *
 * Responsibilities:
 * 1. Sets the terminal window/pane title using standard OSC escape sequences
 *    (\x1b]0;TITLE\x07 and \x1b]2;TITLE\x07) and process.title.
 * 2. Inherits clean pane working directory and spawns the pane's exact command
 *    and argv array without shell string concatenation.
 * 3. Bridges signals cleanly so that closing the pane terminates child processes.
 */

import { spawn } from "node:child_process";

function parseRunnerArgs(argv) {
  let title = "Swarm Pane";
  let cwd = process.cwd();
  let cmdIndex = -1;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      cmdIndex = i + 1;
      break;
    }
    if (arg === "--title" && argv[i + 1]) {
      title = argv[i + 1];
      i += 1;
    } else if (arg === "--cwd" && argv[i + 1]) {
      cwd = argv[i + 1];
      i += 1;
    }
  }

  if (cmdIndex === -1 || cmdIndex >= argv.length) {
    throw new Error('pane-runner requires a command after "--".');
  }

  const command = argv[cmdIndex];
  const args = argv.slice(cmdIndex + 1);

  return { title, cwd, command, args };
}

function main() {
  try {
    const { title, cwd, command, args } = parseRunnerArgs(process.argv.slice(2));

    // Emit OSC title escape sequence for WezTerm and set process title
    process.stdout.write(`\x1b]0;${title}\x07\x1b]2;${title}\x07`);
    try {
      process.title = title;
    } catch {
      // Ignore if OS disallows setting process.title
    }

    // On Windows, npm global CLIs (e.g. claude, kilocode, opencode) are .cmd/.bat scripts
    // which require a shell context in Node v20+. Native executables (.exe, node) run with shell: false.
    const isWindows = process.platform === "win32";
    const baseCmd = command.toLowerCase();
    const isNodeOrExe =
      baseCmd === "node" ||
      baseCmd.endsWith(".exe") ||
      baseCmd.endsWith("node.exe");
    const useShell = isWindows && !isNodeOrExe;

    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
      shell: useShell
    });

    child.on("error", (err) => {
      console.error(`[pane-runner] Failed to spawn "${command}":`, err.message);
      process.exit(1);
    });

    const forwardSignal = (sig) => {
      if (!child.killed) {
        child.kill(sig);
      }
    };

    process.on("SIGINT", () => forwardSignal("SIGINT"));
    process.on("SIGTERM", () => forwardSignal("SIGTERM"));

    child.on("close", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
      } else {
        process.exit(code ?? 0);
      }
    });
  } catch (err) {
    console.error(`[pane-runner] Error: ${err.message}`);
    process.exit(1);
  }
}

main();
