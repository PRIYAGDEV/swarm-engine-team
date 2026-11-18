/**
 * `swarm --dry-run` implementation.
 * Builds and prints every pane's launch command without spawning any process
 * or opening any terminal layout.
 */

import { loadSwarmConfig } from "./config.js";
import { buildAllLaunchCommands } from "./launch-builder.js";

/**
 * Format dry-run output for all panes.
 *
 * @param {object} params
 * @param {string} params.configPath
 * @param {object[]} params.launches
 * @returns {string}
 */
export function formatDryRunOutput({ configPath, launches }) {
  const lines = [];
  lines.push("Swarm Engine Team — Dry Run (no processes or panes opened)");
  lines.push(`Config: ${configPath}`);
  lines.push("");

  for (const launch of launches) {
    lines.push(`[${launch.id}] (${launch.role}) cli=${launch.cli} cwd=${launch.cwd}`);
    lines.push(`  ${launch.fullCommand}`);
  }

  return lines.join("\n");
}

/**
 * Execute `swarm --dry-run`. Opens nothing.
 *
 * @param {object} [options]
 * @param {string} [options.configPath]
 * @param {Function} [options.stdout]
 * @returns {{ exitCode: number, output: string, launches: object[] }}
 */
export function runDryRun(options = {}) {
  const writeOut = options.stdout ?? ((msg) => console.log(msg));
  const { configPath, panes } = loadSwarmConfig(options.configPath, {
    workerCount: options.workers,
    forcedCli: options.cli,
    onWarning: (w) => writeOut(w)
  });
  const launches = buildAllLaunchCommands(panes);
  const output = formatDryRunOutput({ configPath, launches });

  writeOut(output);

  return {
    exitCode: 0,
    output,
    launches
  };
}
