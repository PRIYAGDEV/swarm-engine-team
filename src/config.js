/**
 * Swarm configuration loader and normalizer.
 * Reads swarm.config.json and produces isolated, immutable per-pane configs.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getKiloWorkerModels, getKiloSubagents } from "./model-detect.js";

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
 * Verify whether a model name is compatible with a given CLI.
 * Enforces:
 *   - River AI models ("river/...") belong exclusively to Kilo Code.
 *   - Claude Code uses Anthropic and Amazon Bedrock provided models
 *     (e.g. "anthropic.claude-3-5-sonnet-20241022-v2:0", "us.anthropic.claude-3-5-sonnet-20241022-v2:0", "sonnet", "opus", "haiku").
 *
 * @param {string} cli
 * @param {string} model
 * @returns {{ compatible: boolean, warning?: string }}
 */
export function checkModelCompatibility(cli, model) {
  if (!cli || !model) return { compatible: true };
  const c = cli.toLowerCase().trim();
  const m = model.toLowerCase().trim();

  // Rule 1: River AI models belong exclusively to Kilo Code
  const isRiverModel = m.startsWith("river/") || m.includes("/river/");
  if (isRiverModel) {
    if (c !== "kilocode" && c !== "kilo") {
      if (c === "claude") {
        return {
          compatible: false,
          warning:
            `River AI models ("${model}") belong exclusively to Kilo Code. ` +
            `Claude Code uses Amazon Bedrock provided models (e.g. "anthropic.claude-3-5-sonnet-20241022-v2:0", ` +
            `"us.anthropic.claude-3-5-sonnet-20241022-v2:0", "sonnet", "opus", "haiku").`
        };
      }
      return {
        compatible: false,
        warning: `River AI models ("${model}") belong exclusively to Kilo Code and cannot be used with CLI "${cli}".`
      };
    }
    // River AI model on Kilo Code is valid!
    return { compatible: true };
  }

  // Rule 2: Claude Code supports Anthropic & Amazon Bedrock provided models
  if (c === "claude") {
    const isBedrockModel =
      m.startsWith("anthropic.claude") ||
      m.includes(".anthropic.claude") || // cross-region inference profiles: us.anthropic.claude-*, eu.anthropic.claude-*
      m.startsWith("bedrock/") ||
      m.startsWith("arn:aws:bedrock");

    const isClaudeAlias =
      m.includes("claude") ||
      m.includes("sonnet") ||
      m.includes("opus") ||
      m.includes("haiku");

    if (!isBedrockModel && !isClaudeAlias) {
      return {
        compatible: false,
        warning:
          `Model "${model}" does not match recognized Claude Code models or Amazon Bedrock provided models ` +
          `(e.g. "sonnet", "anthropic.claude-3-5-sonnet-20241022-v2:0", "us.anthropic.claude-3-5-sonnet-20241022-v2:0").`
      };
    }
    return { compatible: true };
  }

  if (c === "agy" || c === "antigravity") {
    const fits =
      m.startsWith("gemini-") ||
      m.startsWith("claude-") ||
      m.startsWith("gpt-oss-") ||
      m.includes("antigravity");
    if (!fits) {
      return {
        compatible: false,
        warning: `Model "${model}" is not in the list of recognized Antigravity models (see \`agy models\`).`
      };
    }
  }

  if (c === "gemini") {
    const fits = m.includes("gemini");
    if (!fits) {
      return {
        compatible: false,
        warning: `Model "${model}" does not match expected Gemini models (e.g. "gemini-2.0-flash", "gemini-1.5-pro").`
      };
    }
  }

  if (c === "codex") {
    const fits = m.includes("gpt") || m.includes("codex") || m.includes("o1") || m.includes("o3");
    if (!fits) {
      return {
        compatible: false,
        warning: `Model "${model}" does not match expected Codex models (e.g. "gpt-4o", "o3-mini").`
      };
    }
  }

  if (c === "kilocode" || c === "kilo") {
    return { compatible: true };
  }

  return { compatible: true };
}

/**
 * Clone a single raw pane entry into an isolated, self-contained paneConfig object.
 * Never shares arrays, env maps, or preset objects with any other pane.
 *
 * @param {object} rawPane - Raw orchestrator or worker entry from swarm.config.json.
 * @param {object} meta - Metadata for this specific pane ({ id, role, defaultCli, baseDir, forcedCli, onWarning }).
 * @returns {object} Frozen, self-contained paneConfig.
 */
function createPaneConfig(rawPane, { id, role, defaultCli, baseDir, forcedCli, forcedModel, activeModel, onWarning }) {
  if (!rawPane || typeof rawPane !== "object" || Array.isArray(rawPane)) {
    throw new Error(`Invalid pane configuration for "${id}": expected an object.`);
  }

  const resolvedCli =
    typeof forcedCli === "string" && forcedCli.trim() !== ""
      ? forcedCli.trim()
      : typeof rawPane.cli === "string" && rawPane.cli.trim() !== ""
        ? rawPane.cli.trim()
        : typeof defaultCli === "string" && defaultCli.trim() !== ""
          ? defaultCli.trim()
          : null;

  if (!resolvedCli && !rawPane.command) {
    throw new Error(
      `Pane "${id}" has neither "cli" (nor top-level "default_cli") nor a custom "command".`
    );
  }

  const rawConfigModel =
    typeof rawPane.model === "string" && rawPane.model.trim() !== ""
      ? rawPane.model.trim()
      : null;

  const rawLaunchModel =
    typeof forcedModel === "string" && forcedModel.trim() !== ""
      ? forcedModel.trim()
      : null;

  const rawActiveModel =
    typeof activeModel === "string" && activeModel.trim() !== ""
      ? activeModel.trim()
      : null;

  // Observable priority: [1] launch flag -> [2] configured model -> [3] active environment -> [4] null
  const resolvedModel = rawLaunchModel ?? rawConfigModel ?? rawActiveModel ?? null;

  // Verify model compatibility and warn if it does not fit
  if (forcedCli && typeof resolvedModel === "string" && resolvedModel.trim() !== "") {
    const check = checkModelCompatibility(forcedCli, resolvedModel);
    if (!check.compatible && typeof onWarning === "function") {
      onWarning(
        `Warning: Model "${resolvedModel}" for pane "${id}" may not be compatible with forced CLI "${forcedCli}". ${check.warning}`
      );
    }
  } else if (resolvedCli && typeof resolvedModel === "string" && resolvedModel.trim() !== "") {
    const check = checkModelCompatibility(resolvedCli, resolvedModel);
    if (!check.compatible && typeof onWarning === "function") {
      onWarning(
        `Warning: Model "${resolvedModel}" for pane "${id}" may not be compatible with CLI "${resolvedCli}": ${check.warning}`
      );
    }
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
    model: resolvedModel,
    config_model: rawConfigModel,
    launch_model: rawLaunchModel,
    active_model: rawActiveModel,
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
 * Supports optional runtime overrides:
 *   - overrides.workerCount: Override number of workers (integer 1-6)
 *   - overrides.forcedCli: Force all panes to use the specified CLI
 *   - overrides.onWarning: Callback for model compatibility warnings
 *
 * @param {object} rawConfig - Parsed swarm.config.json object.
 * @param {string} [baseDir] - Base directory for resolving relative working dirs.
 * @param {object} [overrides] - Optional runtime overrides ({ workerCount, forcedCli, onWarning }).
 * @returns {object[]} Array of frozen paneConfig objects.
 */
export function normalizePaneConfigs(rawConfig, baseDir = process.cwd(), overrides = {}) {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new Error("Swarm config must be a JSON object.");
  }

  const forcedCli =
    typeof overrides.forcedCli === "string" && overrides.forcedCli.trim() !== ""
      ? overrides.forcedCli.trim()
      : null;

  const forcedModel =
    typeof overrides.forcedModel === "string" && overrides.forcedModel.trim() !== ""
      ? overrides.forcedModel.trim()
      : null;

  const activeModel =
    typeof overrides.activeModel === "string" && overrides.activeModel.trim() !== ""
      ? overrides.activeModel.trim()
      : null;

  const onWarning = typeof overrides.onWarning === "function" ? overrides.onWarning : null;

  // Validate --workers N if provided
  let overrideWorkerCount = null;
  if (overrides.workerCount !== undefined && overrides.workerCount !== null) {
    const parsedCount = parseInt(overrides.workerCount, 10);
    if (isNaN(parsedCount) || parsedCount < 1 || parsedCount > 6) {
      throw new Error(
        `Invalid worker count: "${overrides.workerCount}". Must be an integer between 1 and 6.`
      );
    }
    overrideWorkerCount = parsedCount;
  }

  const defaultCli =
    forcedCli ??
    (typeof rawConfig.default_cli === "string" ? rawConfig.default_cli.trim() : null);

  const panes = [];

  const kiloData = getKiloSubagents();
  const effectiveOrchModel =
    rawConfig.orchestrator?.model ? null : (activeModel ?? kiloData?.parentModel ?? null);

  if (rawConfig.orchestrator !== undefined) {
    panes.push(
      createPaneConfig(rawConfig.orchestrator, {
        id: "orchestrator",
        role: "orchestrator",
        defaultCli,
        baseDir,
        forcedCli,
        forcedModel,
        activeModel: effectiveOrchModel,
        onWarning
      })
    );
  }

  if (rawConfig.workers !== undefined || overrideWorkerCount !== null) {
    let rawWorkers = Array.isArray(rawConfig.workers) ? [...rawConfig.workers] : [];

    if (overrideWorkerCount !== null) {
      if (rawWorkers.length > overrideWorkerCount) {
        rawWorkers = rawWorkers.slice(0, overrideWorkerCount);
      } else if (rawWorkers.length < overrideWorkerCount) {
        const template = rawWorkers[rawWorkers.length - 1] ?? {
          cli: defaultCli ?? "kilocode"
        };
        while (rawWorkers.length < overrideWorkerCount) {
          rawWorkers.push(JSON.parse(JSON.stringify(template)));
        }
      }
    }

    const kiloWorkerModels = getKiloWorkerModels();

    for (let index = 0; index < rawWorkers.length; index += 1) {
      const workerEntry = rawWorkers[index];
      const workerActiveModel =
        workerEntry.model ? null : (kiloWorkerModels[index] ?? effectiveOrchModel ?? activeModel);
      panes.push(
        createPaneConfig(workerEntry, {
          id: `worker-${index + 1}`,
          role: "worker",
          defaultCli,
          baseDir,
          forcedCli,
          forcedModel,
          activeModel: workerActiveModel,
          onWarning
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
 * Resolve the configuration file path following the lookup order:
 * 1. Explicit path passed by caller (e.g. --config <path>)
 * 2. Current working directory: ./swarm.config.json
 * 3. Global user profile fallback: %USERPROFILE%/.swarm/swarm.config.json
 *
 * @param {string} [explicitPath] - Optional path explicitly provided via --config / options.
 * @param {string} [currentDir] - Working directory to search first (defaults to process.cwd()).
 * @param {string} [homeDir] - User home directory for global config (defaults to os.homedir()).
 * @returns {{ resolvedPath: string, source: "explicit" | "local" | "global" }}
 */
export function resolveSwarmConfigPath(
  explicitPath,
  currentDir = process.cwd(),
  homeDir = os.homedir()
) {
  if (explicitPath && typeof explicitPath === "string" && explicitPath.trim() !== "") {
    const resolved = path.resolve(currentDir, explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Config file not found at "${resolved}".`);
    }
    return { resolvedPath: resolved, source: "explicit" };
  }

  // 1. Check local project directory first
  const localPath = path.resolve(currentDir, "swarm.config.json");
  if (fs.existsSync(localPath)) {
    return { resolvedPath: localPath, source: "local" };
  }

  // 2. Check global user profile: %USERPROFILE%/.swarm/swarm.config.json
  const globalPath = path.resolve(homeDir, ".swarm", "swarm.config.json");
  if (fs.existsSync(globalPath)) {
    return { resolvedPath: globalPath, source: "global" };
  }

  throw new Error(
    `No swarm.config.json found in current directory ("${localPath}") ` +
      `or global directory ("${globalPath}"). ` +
      `Copy swarm.config.example.json to swarm.config.json or pass --config <path>.`
  );
}

/**
 * Load and validate swarm.config.json from disk following local -> global lookup order.
 * Ensures the CURRENT folder is used as the working directory for all panes.
 *
 * @param {string} [configPath] - Optional explicit path to config file.
 * @param {object} [overrides] - Optional overrides ({ workerCount, forcedCli, onWarning, currentDir, homeDir }).
 * @returns {{ configPath: string, source: "explicit" | "local" | "global", rawConfig: object, panes: object[] }}
 */
export function loadSwarmConfig(configPath, overrides = {}) {
  const currentDir = overrides.currentDir ?? process.cwd();
  const homeDir = overrides.homeDir ?? os.homedir();

  const { resolvedPath, source } = resolveSwarmConfigPath(configPath, currentDir, homeDir);

  const rawText = fs.readFileSync(resolvedPath, "utf8");
  const rawConfig = JSON.parse(rawText);

  // Requirement 4: swarm must use the CURRENT folder as the working directory,
  // even when loaded from the global config.
  const baseDir = currentDir;
  const panes = normalizePaneConfigs(rawConfig, baseDir, overrides);

  return {
    configPath: resolvedPath,
    source,
    rawConfig,
    panes
  };
}
