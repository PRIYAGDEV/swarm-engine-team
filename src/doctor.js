/**
 * `swarm doctor` implementation.
 * Inspects every configured pane, prints per-pane launch details, verifies
 * preset verification status and clean environment isolation, and fails loudly
 * if panes meant to differ produce identical launch commands.
 */

import { loadSwarmConfig, checkModelCompatibility } from "./config.js";
import { buildAllLaunchCommands } from "./launch-builder.js";
import { detectPaneModel, formatModelsReport, extractModelFromArgs } from "./model-detect.js";

/**
 * Determine whether two pane configurations are meant to produce different commands.
 *
 * @param {object} paneA
 * @param {object} paneB
 * @returns {{ differ: boolean, reasons: string[] }}
 */
function checkIfPanesMeantToDiffer(paneA, paneB) {
  const reasons = [];

  if (paneA.cli !== paneB.cli) {
    reasons.push(`cli (${paneA.cli} vs ${paneB.cli})`);
  }
  if ((paneA.model ?? null) !== (paneB.model ?? null)) {
    reasons.push(`model (${paneA.model ?? "none"} vs ${paneB.model ?? "none"})`);
  }
  if ((paneA.command ?? null) !== (paneB.command ?? null)) {
    reasons.push(`command (${paneA.command ?? "preset"} vs ${paneB.command ?? "preset"})`);
  }
  if (Boolean(paneA.non_interactive) !== Boolean(paneB.non_interactive)) {
    reasons.push(
      `non_interactive (${Boolean(paneA.non_interactive)} vs ${Boolean(paneB.non_interactive)})`
    );
  }
  if (Boolean(paneA.auto_approve) !== Boolean(paneB.auto_approve)) {
    reasons.push(`auto_approve (${Boolean(paneA.auto_approve)} vs ${Boolean(paneB.auto_approve)})`);
  }
  if ((paneA.prompt ?? null) !== (paneB.prompt ?? null)) {
    reasons.push("prompt");
  }
  if (JSON.stringify(paneA.base_args ?? []) !== JSON.stringify(paneB.base_args ?? [])) {
    reasons.push("base_args");
  }
  if (JSON.stringify(paneA.args ?? []) !== JSON.stringify(paneB.args ?? [])) {
    reasons.push("args");
  }
  if ((paneA.model_flag ?? null) !== (paneB.model_flag ?? null)) {
    reasons.push(`model_flag (${paneA.model_flag ?? "default"} vs ${paneB.model_flag ?? "default"})`);
  }
  if ((paneA.model_env ?? null) !== (paneB.model_env ?? null)) {
    reasons.push(`model_env (${paneA.model_env ?? "none"} vs ${paneB.model_env ?? "none"})`);
  }

  return {
    differ: reasons.length > 0,
    reasons
  };
}

/**
 * Compute a canonical signature for a built launch descriptor.
 *
 * @param {object} launch
 * @returns {string}
 */
function getLaunchSignature(launch) {
  return JSON.stringify({
    command: launch.command,
    args: launch.args,
    injectedEnvVars: launch.injectedEnvVars
  });
}

/**
 * Validate built pane launches for collisions and dropped models.
 *
 * @param {object[]} paneConfigs
 * @param {object[]} launches
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validatePaneLaunches(paneConfigs, launches) {
  const errors = [];
  const warnings = [];

  if (paneConfigs.length !== launches.length) {
    errors.push(
      `Pane count mismatch: ${paneConfigs.length} config(s) vs ${launches.length} launch(es).`
    );
    return { ok: false, errors, warnings };
  }

  // Check duplicate pane IDs and verify each pane's own model made it into the launch.
  const seenIds = new Set();
  for (let i = 0; i < launches.length; i += 1) {
    const pane = paneConfigs[i];
    const launch = launches[i];

    if (seenIds.has(launch.id)) {
      errors.push(`Duplicate pane id "${launch.id}". Each pane must have a unique id.`);
    }
    seenIds.add(launch.id);

    if (pane.model && launch.modelPassing.method !== "config_file") {
      const inArgs = launch.args.includes(pane.model);
      const inEnv = Object.values(launch.injectedEnvVars).includes(pane.model);
      if (!inArgs && !inEnv) {
        errors.push(
          `Pane "${launch.id}" requested model "${pane.model}", ` +
            `but that model is missing from both args and injected env vars.`
        );
      }
    }

    if (launch.presetVerified === false) {
      warnings.push(
        `Pane "${launch.id}" uses preset "${launch.cli}" which is marked UNVERIFIED ` +
          `(CLI is not installed locally; verify flags with \`${launch.command} --help\`).`
      );
    }

    if (pane.model && pane.cli) {
      const compat = checkModelCompatibility(pane.cli, pane.model);
      if (!compat.compatible && compat.warning) {
        warnings.push(`Pane "${launch.id}": ${compat.warning}`);
      }
    }
  }

  // Check every pair of panes: if meant to differ, identical commands must fail loudly.
  for (let i = 0; i < launches.length; i += 1) {
    for (let j = i + 1; j < launches.length; j += 1) {
      const { differ, reasons } = checkIfPanesMeantToDiffer(paneConfigs[i], paneConfigs[j]);
      if (!differ) {
        continue;
      }

      const sigA = getLaunchSignature(launches[i]);
      const sigB = getLaunchSignature(launches[j]);
      if (sigA === sigB || launches[i].fullCommand === launches[j].fullCommand) {
        errors.push(
          `COMMAND COLLISION: Panes "${launches[i].id}" and "${launches[j].id}" are meant to differ ` +
            `[${reasons.join(", ")}] but produced identical launch commands: ${launches[i].fullCommand}`
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Format the `swarm doctor` diagnostic report as text.
 *
 * @param {object} params
 * @param {string} params.configPath
 * @param {object[]} params.launches
 * @param {{ ok: boolean, errors: string[], warnings: string[] }} params.validation
 * @returns {string}
 */
export function formatDoctorReport({ configPath, launches, validation }) {
  const lines = [];
  lines.push("Swarm Engine Team — Doctor Report");
  lines.push(`Loaded config: ${configPath}`);
  lines.push(`Config: ${configPath}`);
  lines.push(`Panes:  ${launches.length}`);
  lines.push("");

  for (const launch of launches) {
    const verificationBadge =
      launch.presetVerified === true
        ? "verified"
        : launch.presetVerified === false
          ? "UNVERIFIED (not installed locally)"
          : "custom";

    lines.push(`[${launch.id}] (${launch.role})`);
    lines.push(`  CLI:            ${launch.cli} [${verificationBadge}]`);
    lines.push(`  Full Command:   ${launch.fullCommand}`);
    lines.push(`  Model Flag/Env: ${launch.modelPassing.description}`);
    lines.push(`  Working Dir:    ${launch.cwd}`);
    lines.push(
      `  Clean Env:      isolated (stripped ${launch.strippedEnvVars.length} inherited model env var(s))`
    );
    lines.push("");
  }

  if (validation.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of validation.warnings) {
      lines.push(`  ! ${warning}`);
    }
    lines.push("");
  }

  if (!validation.ok) {
    lines.push("FAILED CHECKS:");
    for (const error of validation.errors) {
      lines.push(`  ERROR: ${error}`);
    }
  } else {
    lines.push("Doctor status: OK — all panes have isolated configs and distinct launch commands.");
  }

  return lines.join("\n");
}

/**
 * Execute `swarm doctor` against a config file (or pre-loaded config/launches).
 *
 * @param {object} [options]
 * @param {string} [options.configPath]
 * @param {Function} [options.stdout]
 * @param {Function} [options.stderr]
 * @returns {{ exitCode: number, report: string, validation: object, launches: object[] }}
 */
export function runDoctor(options = {}) {
  const writeOut = options.stdout ?? ((msg) => console.log(msg));
  const writeErr = options.stderr ?? ((msg) => console.error(msg));

  const { configPath, panes } = loadSwarmConfig(options.configPath, {
    workerCount: options.workers,
    forcedCli: options.cli,
    forcedModel: options.model,
    activeModel: options.activeModel,
    onWarning: (w) => writeOut(w)
  });
  const launches = buildAllLaunchCommands(panes);

  // If `swarm doctor --models` is requested
  if (options.models) {
    const detectedPanes = launches.map((launch, idx) => {
      const paneConfig = panes[idx];
      const explicitFlagInArgs =
        extractModelFromArgs(paneConfig.base_args) ?? extractModelFromArgs(paneConfig.args);
      const effectiveLaunchFlag = paneConfig.launch_model ?? explicitFlagInArgs ?? null;
      const originalConfigModel = paneConfig.config_model ?? null;

      const detected = detectPaneModel({
        cli: launch.cli,
        args: launch.args,
        configModel: originalConfigModel,
        cliStatusModel: paneConfig.active_model ?? null,
        launchFlag: effectiveLaunchFlag,
        hasLaunchFlag: Boolean(effectiveLaunchFlag)
      });
      return {
        id: launch.id,
        role: launch.role,
        cli: launch.cli,
        detected
      };
    });

    const modelsReport = formatModelsReport(detectedPanes);
    writeOut(modelsReport);
    return {
      exitCode: 0,
      report: modelsReport,
      detectedPanes
    };
  }

  const validation = validatePaneLaunches(panes, launches);
  const report = formatDoctorReport({ configPath, launches, validation });

  if (validation.ok) {
    writeOut(report);
  } else {
    writeErr(report);
  }

  return {
    exitCode: validation.ok ? 0 : 1,
    report,
    validation,
    launches
  };
}
