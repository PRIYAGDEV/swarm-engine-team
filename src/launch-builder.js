/**
 * Per-pane launch command builder.
 *
 * CRITICAL ISOLATION INVARIANT:
 * `buildLaunchCommand(paneConfig)` derives every command, argument list, working
 * directory, and environment map ONLY from the single `paneConfig` passed to it.
 * There are NO shared global model variables, NO reused command strings, and NO
 * loop variables captured by reference.
 */

import path from "node:path";
import { loadPreset } from "./presets.js";
import { buildCleanPaneEnv } from "./env.js";

/**
 * Quote a single CLI argument for readable shell display.
 * Does not affect spawn args (which are always passed as an exact argv array).
 *
 * @param {string} value
 * @returns {string}
 */
export function quoteShellArg(value) {
  const str = String(value);
  if (str === "") {
    return '""';
  }
  if (/^[a-zA-Z0-9_./:=@#+-]+$/.test(str)) {
    return str;
  }
  return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Resolve a pane's preset exclusively from that pane's own config entry.
 * Supports:
 * 1. Inline `paneConfig.preset` object
 * 2. Custom command (`paneConfig.command` or `paneConfig.cli === "custom"`)
 * 3. Named preset from `/presets/<cli>.json`
 *
 * @param {object} paneConfig
 * @returns {object} Fresh preset object scoped to this single call.
 */
function resolvePresetForPane(paneConfig) {
  if (paneConfig.preset && typeof paneConfig.preset === "object") {
    return JSON.parse(JSON.stringify(paneConfig.preset));
  }

  const isCustomCommand =
    Boolean(paneConfig.command) ||
    String(paneConfig.cli ?? "").trim().toLowerCase() === "custom";

  if (isCustomCommand) {
    const customCmd =
      typeof paneConfig.command === "string" && paneConfig.command.trim() !== ""
        ? paneConfig.command.trim()
        : null;

    if (!customCmd) {
      throw new Error(
        `Pane "${paneConfig.id ?? "pane"}" uses cli="custom" without a "command" string.`
      );
    }

    const modelMethod = paneConfig.model_env
      ? "env"
      : paneConfig.model_flag === null && !paneConfig.model
        ? "none"
        : "flag";

    return {
      name: "custom",
      display_name: `Custom Command (${customCmd})`,
      command: customCmd,
      verified: null,
      verification: {
        installed_locally: null,
        notes: "Custom user-defined command."
      },
      model_passing: {
        method: modelMethod,
        flag: modelMethod === "flag" ? (paneConfig.model_flag ?? "--model") : null,
        env_var: modelMethod === "env" ? paneConfig.model_env : null,
        config_file: null,
        requires_subcommand: null
      },
      non_interactive: {
        type: paneConfig.non_interactive_subcommand ? "subcommand" : "flag",
        subcommand: paneConfig.non_interactive_subcommand ?? null,
        flag: paneConfig.non_interactive_flag ?? null,
        prompt_mode: "positional",
        auto_approve_flag: paneConfig.auto_approve_flag ?? null
      },
      env_strip: Array.isArray(paneConfig.env_strip) ? [...paneConfig.env_strip] : []
    };
  }

  return loadPreset(paneConfig.cli);
}

/**
 * Build the complete, isolated launch specification for ONE pane.
 * Reads ONLY from `paneConfig` (plus the referenced preset file if not inline).
 *
 * @param {object} paneConfig - Single pane config entry.
 * @returns {object} Frozen launch descriptor for this pane.
 */
export function buildLaunchCommand(paneConfig) {
  if (!paneConfig || typeof paneConfig !== "object" || Array.isArray(paneConfig)) {
    throw new Error("buildLaunchCommand(paneConfig) requires a paneConfig object.");
  }

  // Defensively snapshot scalar fields from this paneConfig into local constants.
  const paneId = typeof paneConfig.id === "string" && paneConfig.id.trim() !== ""
    ? paneConfig.id.trim()
    : "pane";
  const paneRole = typeof paneConfig.role === "string" ? paneConfig.role : "pane";
  const paneCli = typeof paneConfig.cli === "string" && paneConfig.cli.trim() !== ""
    ? paneConfig.cli.trim()
    : paneConfig.command
      ? "custom"
      : null;

  if (!paneCli) {
    throw new Error(`Pane "${paneId}" is missing "cli" (or custom "command").`);
  }

  const paneModel =
    typeof paneConfig.model === "string" && paneConfig.model.trim() !== ""
      ? paneConfig.model.trim()
      : null;
  const paneCwd = path.resolve(
    typeof paneConfig.cwd === "string" && paneConfig.cwd.trim() !== ""
      ? paneConfig.cwd
      : "."
  );
  const wantsNonInteractive = Boolean(paneConfig.non_interactive);
  const wantsAutoApprove = Boolean(paneConfig.auto_approve);
  const panePrompt =
    typeof paneConfig.prompt === "string" && paneConfig.prompt.length > 0
      ? paneConfig.prompt
      : null;

  const preset = resolvePresetForPane({ ...paneConfig, id: paneId, cli: paneCli });
  const executable = preset.command;

  // Fresh argument array scoped exclusively to this single pane.
  const args = [];

  if (Array.isArray(paneConfig.base_args)) {
    for (const item of paneConfig.base_args) {
      args.push(String(item));
    }
  }

  // Determine whether a subcommand (such as `run` or `exec`) is needed.
  const requiresModelSubcommand =
    Boolean(paneModel) &&
    typeof preset.model_passing?.requires_subcommand === "string" &&
    preset.model_passing.requires_subcommand.trim() !== "";

  const nonInteractiveSpec = preset.non_interactive ?? {};
  const needsSubcommand =
    (wantsNonInteractive && nonInteractiveSpec.type === "subcommand" && nonInteractiveSpec.subcommand) ||
    requiresModelSubcommand;

  if (needsSubcommand) {
    const subcommand =
      (wantsNonInteractive && nonInteractiveSpec.subcommand) ||
      preset.model_passing.requires_subcommand;
    args.push(subcommand);
  }

  // Add non-interactive flag when configured and the preset uses a flag.
  let promptAlreadyConsumed = false;
  if (wantsNonInteractive && nonInteractiveSpec.type === "flag" && nonInteractiveSpec.flag) {
    args.push(nonInteractiveSpec.flag);
    if (nonInteractiveSpec.prompt_mode === "flag_value") {
      args.push(panePrompt ?? "");
      promptAlreadyConsumed = true;
    }
  }

  // Pass the pane's model strictly according to this pane's preset.
  const modelMethod = preset.model_passing?.method ?? "none";
  const modelFlag = preset.model_passing?.flag ?? null;
  const modelEnvVar = preset.model_passing?.env_var ?? null;
  const modelConfigFile = preset.model_passing?.config_file ?? null;

  if (paneModel && modelMethod === "flag") {
    if (!modelFlag) {
      throw new Error(`Preset "${preset.name}" specifies method="flag" but has no flag.`);
    }
    args.push(modelFlag, paneModel);
  }

  // Optional auto-approve flag when explicitly requested by this pane.
  if (wantsAutoApprove && nonInteractiveSpec.auto_approve_flag) {
    args.push(nonInteractiveSpec.auto_approve_flag);
  }

  // Extra per-pane CLI arguments.
  if (Array.isArray(paneConfig.args)) {
    for (const extraArg of paneConfig.args) {
      args.push(String(extraArg));
    }
  }

  // Positional prompt argument if provided and not already passed as a flag value.
  if (panePrompt !== null && !promptAlreadyConsumed) {
    args.push(panePrompt);
  }

  // Construct an isolated environment stripped of parent shell model vars.
  const { env, strippedEnvVars, injectedEnvVars } = buildCleanPaneEnv(
    { ...paneConfig, id: paneId, cli: paneCli, model: paneModel },
    preset
  );

  // Build readable shell command string strictly from this pane's command + args.
  const commandParts = [executable, ...args].map(quoteShellArg);
  const envPrefixParts = Object.entries(injectedEnvVars).map(
    ([k, v]) => `${k}=${quoteShellArg(v)}`
  );
  const fullCommand = [...envPrefixParts, ...commandParts].join(" ");

  const modelDescription = !paneModel
    ? "none (default)"
    : modelMethod === "flag"
      ? `flag: ${modelFlag} ${quoteShellArg(paneModel)}`
      : modelMethod === "env"
        ? `env: ${modelEnvVar}=${quoteShellArg(paneModel)}`
        : modelMethod === "config_file"
          ? `config_file: ${modelConfigFile} (${paneModel})`
          : "none";

  return Object.freeze({
    id: paneId,
    role: paneRole,
    cli: paneCli,
    command: executable,
    args: Object.freeze([...args]),
    fullCommand,
    model: paneModel,
    modelPassing: Object.freeze({
      method: modelMethod,
      flag: modelMethod === "flag" ? modelFlag : null,
      envVar: modelMethod === "env" ? modelEnvVar : null,
      configFile: modelConfigFile,
      description: modelDescription
    }),
    cwd: paneCwd,
    env: Object.freeze(env),
    strippedEnvVars: Object.freeze([...strippedEnvVars]),
    injectedEnvVars: Object.freeze({ ...injectedEnvVars }),
    presetVerified: preset.verified ?? null,
    presetInstalledLocally: preset.verification?.installed_locally ?? null,
    presetNotes: preset.verification?.notes ?? null
  });
}

/**
 * Build independent launch specifications for all panes in a normalized config.
 * Uses pure mapping so no loop variable can be captured or shared across panes.
 *
 * @param {object[]} paneConfigs
 * @returns {object[]}
 */
export function buildAllLaunchCommands(paneConfigs) {
  if (!Array.isArray(paneConfigs)) {
    throw new Error("buildAllLaunchCommands(paneConfigs) expects an array of pane configs.");
  }
  return paneConfigs.map((paneConfig) => buildLaunchCommand(paneConfig));
}
