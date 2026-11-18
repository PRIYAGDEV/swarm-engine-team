#!/usr/bin/env node
/**
 * Swarm Engine Team CLI entrypoint.
 *
 * Usage:
 *   swarm [--config <path>]            Start the multi-pane terminal layout in WezTerm
 *   swarm stop                         Close all active panes and terminate session cleanly
 *   swarm doctor [--config <path>]     Inspect per-pane CLI, command, model flag/env, cwd
 *   swarm --dry-run [--config <path>]  Print all pane launch commands without opening anything
 *   swarm --help                       Show this help message
 */

import path from "node:path";
import fs from "node:fs";
import { runDoctor } from "../src/doctor.js";
import { runDryRun } from "../src/dry-run.js";
import { startSwarmLayout, stopSwarmLayout } from "../src/layout.js";
import { dispatchTask, parseDispatchLine } from "../src/dispatch.js";
import { getSwarmStatus, printSwarmStatus } from "../src/status.js";
import { TuiSession } from "../src/tui-session.js";
import { sendIpcMessage } from "../src/ipc.js";
import { detectActiveEnvironmentModel } from "../src/model-detect.js";

function getVersion() {
  try {
    const pkgPath = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function printHelp() {
  console.log(
    [
      `Swarm Engine Team v${getVersion()}`,
      "",
      "Usage:",
      "  swarm [--config <path>] [--workers N] [--cli <name>] [--model <name>] [--task <text>]",
      "                                     Open dashboard in current terminal (Ctrl+Q to exit)",
      "  swarm status                       Inspect current session status and per-worker states",
      "  swarm send <target> \"<task>\"       Dispatch task to worker(s) (e.g. @worker-3, @all, @workers 1,2)",
      "  swarm stop                         Close all active panes and verify zero leftover processes",
      "  swarm doctor [--models]            Inspect per-pane launch commands and observable models",
      "  swarm --dry-run                    Print all pane launch commands without opening anything",
      "  swarm --version, -v                Print Swarm version",
      "  swarm help, --help, -h             Show this help message",
      "",
      "Flags:",
      "  --workers <N>, -w <N>              Override worker pane count (1-6)",
      "  --cli <name>                       Force all panes to use the specified CLI (e.g. kilocode, claude)",
      "  --model <name>, -m <name>          Override active model (auto-detected from environment if omitted)",
      "  --task <text>, -t <text>           Initial task text (auto-resumed from last session or git if omitted)",
      "  --boost, /boost                    Enable high-speed boost mode (fast refresh and auto-approval)",
      "  --models                           In doctor: print observable model and detection source",
      "  --background, -b                   Run session in background mode without taking over terminal",
      "  --config <path>, -c <path>         Explicit config path (defaults to ./swarm.config.json, then ~/.swarm/swarm.config.json)",
      "",
      "Keybindings (In-Terminal Dashboard):",
      "  Tab / Shift+Tab                    Cycle focused pane",
      "  Typing                             Forwarded directly to focused pane",
      "  Ctrl+Q                             Clean exit and return to shell prompt",
      "",
      "Aliases:",
      "  team <command>                     Short alias for `swarm`"
    ].join("\n")
  );
}

/**
 * Parse CLI arguments into an action and optional config path.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  let command = "start";
  let configPath = null;
  let target = null;
  let task = null;
  let workerCount = null;
  let forcedCli = null;
  let forcedModel = null;
  let showModels = false;
  let background = false;
  let boost = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-v" || arg === "--version" || arg === "version") {
      return { command: "version" };
    }
    if (arg === "-h" || arg === "--help" || arg === "help") {
      return { command: "help", configPath, workerCount, forcedCli, forcedModel };
    }
    if (arg === "start") {
      command = "start";
      continue;
    }
    if (arg === "status") {
      command = "status";
      continue;
    }
    if (arg === "stop") {
      command = "stop";
      continue;
    }
    if (arg === "doctor") {
      command = "doctor";
      continue;
    }
    if (arg === "--models") {
      showModels = true;
      continue;
    }
    if (arg === "--boost" || arg === "/boost") {
      boost = true;
      continue;
    }
    if (arg === "--background" || arg === "-b") {
      background = true;
      continue;
    }
    if (arg === "--dry-run") {
      command = "dry-run";
      continue;
    }
    if (arg === "--workers" || arg === "-w") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error(`Flag "${arg}" requires a number between 1 and 6.`);
      }
      const parsed = parseInt(next, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 6) {
        throw new Error(`Invalid worker count: "${next}". Must be an integer between 1 and 6.`);
      }
      workerCount = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--workers=") || arg.startsWith("-w=")) {
      const val = arg.slice(arg.indexOf("=") + 1).trim();
      const parsed = parseInt(val, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 6) {
        throw new Error(`Invalid worker count: "${val}". Must be an integer between 1 and 6.`);
      }
      workerCount = parsed;
      continue;
    }
    if (arg === "--cli") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error(`Flag "${arg}" requires a CLI name.`);
      }
      forcedCli = next.trim();
      i += 1;
      continue;
    }
    if (arg.startsWith("--cli=")) {
      forcedCli = arg.slice(arg.indexOf("=") + 1).trim();
      continue;
    }
    if (arg === "--model" || arg === "-m") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(`Flag "${arg}" requires a model name.`);
      }
      forcedModel = next.trim();
      i += 1;
      continue;
    }
    if (arg.startsWith("--model=") || arg.startsWith("-m=")) {
      const val = arg.slice(arg.indexOf("=") + 1).trim();
      if (!val) {
        throw new Error(`Flag "${arg}" requires a model name.`);
      }
      forcedModel = val;
      continue;
    }
    if (arg === "--task" || arg === "-t") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error(`Flag "${arg}" requires a task description.`);
      }
      task = next.trim();
      i += 1;
      continue;
    }
    if (arg.startsWith("--task=") || arg.startsWith("-t=")) {
      const val = arg.slice(arg.indexOf("=") + 1).trim();
      if (!val) {
        throw new Error(`Flag "${arg}" requires a task description.`);
      }
      task = val;
      continue;
    }
    if (arg === "send") {
      command = "send";
      const sendArgs = argv.slice(i + 1);
      if (sendArgs.length === 0) {
        throw new Error(
          'Usage: swarm send <target> "<task>"\nExamples:\n  swarm send @worker-3 "build project"\n  swarm send worker-2 "say hi"\n  swarm send @all "npm test"\n  swarm send @workers 1,2,5 "refactor"'
        );
      }

      // Check if sendArgs is e.g. ["@workers", "1,2", "task..."]
      if ((sendArgs[0] === "@workers" || sendArgs[0] === "workers") && sendArgs.length >= 3) {
        target = `${sendArgs[0]} ${sendArgs[1]}`;
        task = sendArgs.slice(2).join(" ");
      } else if (sendArgs.length === 1) {
        const lineParsed = parseDispatchLine(sendArgs[0]);
        if (lineParsed) {
          target = lineParsed.target;
          task = lineParsed.task;
        } else {
          throw new Error('Missing task description. Usage: swarm send <target> "<task>"');
        }
      } else {
        target = sendArgs[0];
        task = sendArgs.slice(1).join(" ");
      }
      break;
    }
    if (arg === "--config" || arg === "-c") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error(`Flag "${arg}" requires a file path.`);
      }
      configPath = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--config=") || arg.startsWith("-c=")) {
      configPath = path.resolve(process.cwd(), arg.slice(arg.indexOf("=") + 1).trim());
      continue;
    }
    throw new Error(`Unknown argument "${arg}". Run \`swarm --help\` for usage.`);
  }

  return { command, configPath, target, task, workerCount, forcedCli, forcedModel, showModels, background, boost };
}

async function main() {
  try {
    const { command, configPath, target, task, workerCount, forcedCli, forcedModel, showModels, background, boost } = parseArgs(
      process.argv.slice(2)
    );

    // Auto-detect model from active environment if no explicit --model flag passed
    const activeEnvModel = detectActiveEnvironmentModel();

    if (command === "version") {
      console.log(`swarm-engine-team v${getVersion()}`);
      process.exitCode = 0;
      return;
    }

    if (command === "help") {
      printHelp();
      process.exitCode = 0;
      return;
    }

    if (command === "status") {
      const statusResult = await getSwarmStatus();
      printSwarmStatus(statusResult);
      process.exitCode = 0;
      return;
    }

    if (command === "doctor") {
      const result = runDoctor({
        configPath,
        workers: workerCount,
        cli: forcedCli,
        model: forcedModel,
        activeModel: activeEnvModel,
        models: showModels
      });
      process.exitCode = result.exitCode;
      return;
    }

    if (command === "dry-run") {
      const result = runDryRun({
        configPath,
        workers: workerCount,
        cli: forcedCli,
        model: forcedModel,
        activeModel: activeEnvModel
      });
      process.exitCode = result.exitCode;
      return;
    }

    if (command === "stop") {
      // Notify active IPC server to stop if running
      try {
        await sendIpcMessage({ command: "stop", target: "@all", task: "__swarm_stop__" }).catch(() => {});
      } catch {}
      await stopSwarmLayout();
      process.exitCode = 0;
      return;
    }

    if (command === "send") {
      await dispatchTask({ target, task });
      process.exitCode = 0;
      return;
    }

    if (command === "start") {
      const sessionOptions = {
        configPath,
        workerCount,
        forcedCli,
        forcedModel,
        activeModel: activeEnvModel,
        task,
        boost
      };

      // In interactive terminal, start in-terminal dashboard
      if (process.stdin.isTTY && !background) {
        const session = new TuiSession(sessionOptions);
        await session.start();
        await session.waitUntilExit();
      } else {
        // In background or non-interactive mode, launch headless session without hanging shell
        const session = new TuiSession({
          ...sessionOptions,
          headless: true
        });
        await session.start();
        console.log("Swarm Engine Team: Active in-terminal session running in background.");
        console.log("Use `swarm status` to observe states, `swarm send` to dispatch, or `swarm stop` to terminate.");
      }
      process.exitCode = 0;
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

main();
