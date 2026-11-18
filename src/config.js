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
    if (!m.includes("/") && !m.includes("kilo")) {
      return {
        compatible: false,
        warning: `Model "${model}" does not include a provider prefix (e.g. River AI models: "river/<provider>/<model>").`
      };
    }
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
function createPaneConfig(rawPane, { id, role, defaultCli, baseDir, forcedCli, onWarning }) {
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

  // Verify model compatibility and warn if it does not fit
  if (forcedCli && typeof rawPane.model === "string" && rawPane.model.trim() !== "") {
    const check = checkModelCompatibility(forcedCli, rawPane.model);
    if (!check.compatible && typeof onWarning === "function") {
      onWarning(
        `Warning: Model "${rawPane.model}" for pane "${id}" may not be compatible with forced CLI "${forcedCli}". ${check.warning}`
      );
    }
  } else if (resolvedCli && typeof rawPane.model === "string" && rawPane.model.trim() !== "") {
    const check = checkModelCompatibility(resolvedCli, rawPane.model);
    if (!check.compatible && typeof onWarning === "function") {
      onWarning(
        `Warning: Model "${rawPane.model}" for pane "${id}" may not be compatible with CLI "${resolvedCli}": ${check.warning}`
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

  if (rawConfig.orchestrator !== undefined) {
    panes.push(
      createPaneConfig(rawConfig.orchestrator, {
        id: "orchestrator",
        role: "orchestrator",
        defaultCli,
        baseDir,
        forcedCli,
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

    for (let index = 0; index < rawWorkers.length; index += 1) {
      const workerEntry = rawWorkers[index];
      panes.push(
        createPaneConfig(workerEntry, {
          id: `worker-${index + 1}`,
          role: "worker",
          defaultCli,
          baseDir,
          forcedCli,
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
 * Load and validate swarm.config.json from disk.
 *
 * @param {string} [configPath] - Path to config file (defaults to ./swarm.config.json).
 * @param {object} [overrides] - Optional overrides ({ workerCount, forcedCli, onWarning }).
 * @returns {{ configPath: string, rawConfig: object, panes: object[] }}
 */
export function loadSwarmConfig(
  configPath = path.resolve(process.cwd(), "swarm.config.json"),
  overrides = {}
) {
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
  const panes = normalizePaneConfigs(rawConfig, baseDir, overrides);

  return {
    configPath: resolvedPath,
    rawConfig,
    panes
  };
}
