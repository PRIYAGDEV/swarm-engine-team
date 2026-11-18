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
import { runDoctor } from "../src/doctor.js";
import { runDryRun } from "../src/dry-run.js";
import { startSwarmLayout, stopSwarmLayout } from "../src/layout.js";
import { dispatchTask, parseDispatchLine } from "../src/dispatch.js";

function printHelp() {
  console.log(
    [
      "Swarm Engine Team",
      "",
      "Usage:",
      "  swarm [--config <path>]            Open full-width orchestrator + 2x3 worker grid in WezTerm",
      "  swarm send <target> \"<task>\"       Dispatch task to worker(s) (e.g. @worker-3, @all, @workers 1,2)",
      "  swarm stop                         Close all active panes and leave no leftover processes",
      "  swarm doctor [--config <path>]     Inspect per-pane CLI, command, model flag/env, cwd",
      "  swarm --dry-run [--config <path>]  Print all pane launch commands without opening anything",
      "  swarm --help                       Show this help message"
    ].join("\n")
  );
}

/**
 * Parse CLI arguments into an action and optional config path.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  let command = "start";
  let configPath = path.resolve(process.cwd(), "swarm.config.json");
  let target = null;
  let task = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      return { command: "help", configPath };
    }
    if (arg === "start") {
      command = "start";
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
    if (arg === "--dry-run") {
      command = "dry-run";
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
    throw new Error(`Unknown argument "${arg}". Run \`swarm --help\` for usage.`);
  }

  return { command, configPath, target, task };
}

async function main() {
  try {
    const { command, configPath, target, task } = parseArgs(process.argv.slice(2));

    if (command === "help") {
      printHelp();
      process.exitCode = 0;
      return;
    }

    if (command === "doctor") {
      const result = runDoctor({ configPath });
      process.exitCode = result.exitCode;
      return;
    }

    if (command === "dry-run") {
      const result = runDryRun({ configPath });
      process.exitCode = result.exitCode;
      return;
    }

    if (command === "stop") {
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
      await startSwarmLayout({ configPath });
      process.exitCode = 0;
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

main();
