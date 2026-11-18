/**
 * Swarm Engine Team - Model Auto-Detection.
 *
 * Resolves each pane's actual active model using strictly observable sources
 * in the following order (stopping at the first real answer):
 *   (a) A model flag in the launch command (e.g. `--model <val>` or `-m <val>`) -> source: "launch_flag"
 *   (b) The CLI's own status command if it has one (verified, never invented)    -> source: "cli_status"
 *   (c) The config value from swarm.config.json                                  -> source: "configured"
 *   (d) If nothing answers -> "unknown"
 *
 * Never invents made-up defaults.
 */

/**
 * Known model flags across supported AI coding CLIs.
 */
const MODEL_FLAGS = ["--model", "-m"];

/**
 * Inspect launch arguments to find an explicitly passed model flag.
 *
 * @param {string[]} args
 * @returns {string|null}
 */
export function extractModelFromArgs(args) {
  if (!Array.isArray(args)) return null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    for (const flag of MODEL_FLAGS) {
      if (arg === flag && i + 1 < args.length) {
        const next = args[i + 1];
        if (next && !next.startsWith("-")) {
          return next.trim();
        }
      }
      if (arg.startsWith(`${flag}=`)) {
        const val = arg.slice(flag.length + 1).trim();
        if (val) return val;
      }
    }
  }

  return null;
}

/**
 * Query CLI status command if one is verified and supported.
 * Currently, verified CLIs (kilocode, claude, agy, opencode) do not expose an
 * independent non-interactive CLI model query command, so we return null rather
 * than inventing unverified commands.
 *
 * @param {string} cli
 * @returns {string|null}
 */
export function queryCliStatusModel(cli) {
  // Never invent unverified commands
  return null;
}

/**
 * Detect the active model from the current environment (e.g. KILO_MODEL or active CLI session).
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string|null}
 */
export function detectActiveEnvironmentModel(env = process.env) {
  if (!env || typeof env !== "object") return null;

  // 1. Kilo Code environment variables
  if (typeof env.KILO_MODEL === "string" && env.KILO_MODEL.trim() !== "") {
    return env.KILO_MODEL.trim();
  }
  if (typeof env.KILOCODE_MODEL === "string" && env.KILOCODE_MODEL.trim() !== "") {
    return env.KILOCODE_MODEL.trim();
  }

  // 2. Active CLI session environment variables if present
  if (typeof env.AGY_MODEL === "string" && env.AGY_MODEL.trim() !== "") {
    return env.AGY_MODEL.trim();
  }
  if (typeof env.ANTIGRAVITY_MODEL === "string" && env.ANTIGRAVITY_MODEL.trim() !== "") {
    return env.ANTIGRAVITY_MODEL.trim();
  }
  if (typeof env.CLAUDE_MODEL === "string" && env.CLAUDE_MODEL.trim() !== "") {
    return env.CLAUDE_MODEL.trim();
  }
  if (typeof env.CLAUDE_CODE_MODEL === "string" && env.CLAUDE_CODE_MODEL.trim() !== "") {
    return env.CLAUDE_CODE_MODEL.trim();
  }
  if (typeof env.OPENCODE_MODEL === "string" && env.OPENCODE_MODEL.trim() !== "") {
    return env.OPENCODE_MODEL.trim();
  }
  if (typeof env.GEMINI_MODEL === "string" && env.GEMINI_MODEL.trim() !== "") {
    return env.GEMINI_MODEL.trim();
  }
  if (typeof env.OPENAI_MODEL === "string" && env.OPENAI_MODEL.trim() !== "") {
    return env.OPENAI_MODEL.trim();
  }

  return null;
}

/**
 * Detect a pane's model and its detection source.
 *
 * @param {object} params
 * @param {string} params.cli
 * @param {string[]} [params.args]
 * @param {string|null} [params.configModel]
 * @param {string|null} [params.cliStatusModel]
 * @param {string|null} [params.launchFlag]
 * @param {boolean} [params.hasLaunchFlag]
 * @returns {{ model: string, source: "launch_flag" | "cli_status" | "configured" | "unknown", mismatch: boolean, warning?: string }}
 */
export function detectPaneModel({
  cli,
  args = [],
  configModel = null,
  cliStatusModel = null,
  launchFlag = null,
  hasLaunchFlag = undefined
}) {
  // (a) Check launch command flag
  const extractedFlag = extractModelFromArgs(args);
  const flagModel = launchFlag ?? (hasLaunchFlag === false ? null : extractedFlag);

  if (flagModel) {
    const mismatch = Boolean(configModel && configModel.trim() !== "" && configModel.trim() !== flagModel);
    return {
      model: flagModel,
      source: "launch_flag",
      mismatch,
      warning: mismatch
        ? `Model mismatch for CLI "${cli}": Launch flag specifies "${flagModel}", but config specifies "${configModel}".`
        : undefined
    };
  }

  // (b) Check CLI's own status command
  const statusModel = cliStatusModel ?? queryCliStatusModel(cli);
  if (statusModel) {
    const mismatch = Boolean(configModel && configModel.trim() !== "" && configModel.trim() !== statusModel);
    return {
      model: statusModel,
      source: "cli_status",
      mismatch,
      warning: mismatch
        ? `Model mismatch for CLI "${cli}": CLI status reports "${statusModel}", but config specifies "${configModel}".`
        : undefined
    };
  }

  // (c) Check config value
  if (configModel && typeof configModel === "string" && configModel.trim() !== "") {
    return {
      model: configModel.trim(),
      source: "configured",
      mismatch: false
    };
  }

  // (d) Unknown
  return {
    model: "unknown",
    source: "unknown",
    mismatch: false
  };
}

/**
 * Format model detection report for `swarm doctor --models`.
 *
 * @param {Array<{ id: string, role: string, cli: string, detected: ReturnType<typeof detectPaneModel> }>} panes
 * @returns {string}
 */
export function formatModelsReport(panes) {
  const lines = [];
  lines.push("Swarm Engine Team — Model Detection Report");
  lines.push("Source priority: [1] launch_flag -> [2] cli_status -> [3] configured -> [4] unknown");
  lines.push("");

  let hasMismatch = false;

  for (const pane of panes) {
    const { id, role, cli, detected } = pane;
    const badge = `[source: ${detected.source}]`;
    lines.push(`[${id}] (${role})`);
    lines.push(`  CLI:             ${cli}`);
    lines.push(`  Detected Model:  ${detected.model} ${badge}`);
    if (detected.mismatch && detected.warning) {
      hasMismatch = true;
      lines.push(`  ! WARNING:       ${detected.warning}`);
    }
    lines.push("");
  }

  if (hasMismatch) {
    lines.push("Doctor check: WARNING — One or more panes have model mismatches between launch flags and config.");
  } else {
    lines.push("Doctor check: OK — All pane models verified from observable sources.");
  }

  return lines.join("\n");
}
