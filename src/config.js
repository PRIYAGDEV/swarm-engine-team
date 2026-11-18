/**
 * Swarm configuration loader and normalizer.
 * Reads swarm.config.json and produces isolated, immutable per-pane configs.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Deep-freeze an object graph so nothing can mutate a pane config after creation.
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  for (const value of Object.values(obj)) {
    deepFreeze(value);
  }
  return Object.freeze(obj);
}

/**
 * Clone a single raw pane entry into an isolated, self-contained paneConfig object.
 * Never shares arrays, env maps, or preset objects with any other pane.
 *
 * @param {object} rawPane - Raw orchestrator or worker entry from swarm.config.json.
 * @param {object} meta - Metadata for this specific pane ({ id, role, defaultCli, baseDir }).
 * @returns {object} Frozen, self-contained paneConfig.
 */
function createPaneConfig(rawPane, { id, role, defaultCli, baseDir }) {
  if (!rawPane || typeof rawPane !== "object" || Array.isArray(rawPane)) {
    throw new Error(`Invalid pane configuration for "${id}": expected an object.`);
  }

  const resolvedCli =
    typeof rawPane.cli === "string" && rawPane.cli.trim() !== ""
      ? rawPane.cli.trim()
      : typeof defaultCli === "string" && defaultCli.trim() !== ""
        ? defaultCli.trim()
        : null;

  if (!resolvedCli && !rawPane.command) {
    throw new Error(
      `Pane "${id}" has neither "cli" (nor top-level "default_cli") nor a custom "command".`
    );
  }

  const resolvedCwd = path.resolve(
    baseDir,
    typeof rawPane.cwd === "string" && rawPane.cwd.trim() !== "" ? rawPane.cwd : "."
  );

  // Build an independent copy of every field so no references leak across panes.
  const paneConfig = {
    id: typeof rawPane.id === "string" && rawPane.id.trim() !== "" ? rawPane.id.trim() : id,
    role,
    cli: resolvedCli ?? "custom",
    model: typeof rawPane.model === "string" ? rawPane.model : null,
    cwd: resolvedCwd,
    non_interactive: Boolean(rawPane.non_interactive),
    auto_approve: Boolean(rawPane.auto_approve),
    prompt: typeof rawPane.prompt === "string" ? rawPane.prompt : null,
    command: typeof rawPane.command === "string" ? rawPane.command : null,
    base_args: Array.isArray(rawPane.base_args) ? rawPane.base_args.map(String) : [],
    args: Array.isArray(rawPane.args) ? rawPane.args.map(String) : [],
    model_flag: typeof rawPane.model_flag === "string" ? rawPane.model_flag : null,
    model_env: typeof rawPane.model_env === "string" ? rawPane.model_env : null,
    non_interactive_flag:
      typeof rawPane.non_interactive_flag === "string" ? rawPane.non_interactive_flag : null,
    non_interactive_subcommand:
      typeof rawPane.non_interactive_subcommand === "string"
        ? rawPane.non_interactive_subcommand
        : null,
    auto_approve_flag:
      typeof rawPane.auto_approve_flag === "string" ? rawPane.auto_approve_flag : null,
    env: rawPane.env && typeof rawPane.env === "object" ? { ...rawPane.env } : {},
    env_strip: Array.isArray(rawPane.env_strip) ? rawPane.env_strip.map(String) : [],
    preset: rawPane.preset && typeof rawPane.preset === "object"
      ? JSON.parse(JSON.stringify(rawPane.preset))
      : null
  };

  return deepFreeze(paneConfig);
}

/**
 * Normalize a parsed swarm config object into an array of independent pane configs.
 *
 * @param {object} rawConfig - Parsed swarm.config.json object.
 * @param {string} [baseDir] - Base directory for resolving relative working dirs.
 * @returns {object[]} Array of frozen paneConfig objects.
 */
export function normalizePaneConfigs(rawConfig, baseDir = process.cwd()) {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new Error("Swarm config must be a JSON object.");
  }

  const defaultCli =
    typeof rawConfig.default_cli === "string" ? rawConfig.default_cli.trim() : null;

  const panes = [];

  if (rawConfig.orchestrator !== undefined) {
    panes.push(
      createPaneConfig(rawConfig.orchestrator, {
        id: "orchestrator",
        role: "orchestrator",
        defaultCli,
        baseDir
      })
    );
  }

  if (rawConfig.workers !== undefined) {
    if (!Array.isArray(rawConfig.workers)) {
      throw new Error('Swarm config field "workers" must be an array.');
    }
    for (let index = 0; index < rawConfig.workers.length; index += 1) {
      const workerEntry = rawConfig.workers[index];
      panes.push(
        createPaneConfig(workerEntry, {
          id: `worker-${index + 1}`,
          role: "worker",
          defaultCli,
          baseDir
        })
      );
    }
  }

  if (panes.length === 0) {
    throw new Error(
      'Swarm config must define an "orchestrator" and/or at least one entry in "workers".'
    );
  }

  return panes;
}

/**
 * Load and validate swarm.config.json from disk.
 *
 * @param {string} [configPath] - Path to config file (defaults to ./swarm.config.json).
 * @returns {{ configPath: string, rawConfig: object, panes: object[] }}
 */
export function loadSwarmConfig(configPath = path.resolve(process.cwd(), "swarm.config.json")) {
  const resolvedPath = path.resolve(configPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Config file not found at "${resolvedPath}". ` +
        `Copy swarm.config.example.json to swarm.config.json or pass --config <path>.`
    );
  }

  const rawText = fs.readFileSync(resolvedPath, "utf8");
  const rawConfig = JSON.parse(rawText);
  const baseDir = path.dirname(resolvedPath);
  const panes = normalizePaneConfigs(rawConfig, baseDir);

  return {
    configPath: resolvedPath,
    rawConfig,
    panes
  };
}
