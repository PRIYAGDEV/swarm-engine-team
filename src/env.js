/**
 * Isolated environment builder for swarm panes.
 * Guarantees each pane gets its own clean environment object and never
 * inherits model selection variables from the parent shell.
 */

/**
 * Known model-selection environment variables across supported AI CLIs.
 * All of these are stripped from every pane's inherited parent environment.
 */
export const GLOBAL_MODEL_ENV_VARS = Object.freeze([
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_MODEL",
  "CLAUDE_CODE_MODEL",
  "KILO_MODEL",
  "KILOCODE_MODEL",
  "OPENCODE_MODEL",
  "OPENCODE_CONFIG_CONTENT",
  "OPENAI_MODEL",
  "CODEX_MODEL",
  "GEMINI_MODEL",
  "GOOGLE_GEMINI_MODEL",
  "AIDER_MODEL",
  "AIDER_WEAK_MODEL",
  "AIDER_EDITOR_MODEL",
  "LLM_MODEL",
  "MODEL",
  "DEFAULT_MODEL",
  "AI_MODEL",
  "SWARM_MODEL",
  "AGY_MODEL",
  "ANTIGRAVITY_MODEL"
]);

/**
 * Build a fresh, isolated environment object for a single pane.
 * Strips all parent model variables so no pane inherits a model from the parent shell,
 * then applies only that pane's own explicit env overrides and (if applicable) model env var.
 *
 * @param {object} paneConfig - Single pane configuration.
 * @param {object} [preset] - Resolved preset for this pane.
 * @param {NodeJS.ProcessEnv} [parentEnv] - Parent environment (defaults to process.env).
 * @returns {{ env: Record<string, string>, strippedEnvVars: string[], injectedEnvVars: Record<string, string> }}
 */
export function buildCleanPaneEnv(paneConfig, preset = {}, parentEnv = process.env) {
  // Build the set of uppercase variable names to strip (case-insensitive for Windows safety).
  const stripSet = new Set(GLOBAL_MODEL_ENV_VARS.map((name) => name.toUpperCase()));

  if (Array.isArray(preset?.env_strip)) {
    for (const name of preset.env_strip) {
      if (typeof name === "string" && name.trim() !== "") {
        stripSet.add(name.trim().toUpperCase());
      }
    }
  }

  if (Array.isArray(paneConfig?.env_strip)) {
    for (const name of paneConfig.env_strip) {
      if (typeof name === "string" && name.trim() !== "") {
        stripSet.add(name.trim().toUpperCase());
      }
    }
  }

  // Copy parent environment into a brand-new object, skipping stripped model vars.
  const cleanEnv = {};
  const strippedEnvVars = [];

  for (const [key, value] of Object.entries(parentEnv ?? {})) {
    if (value === undefined) {
      continue;
    }
    if (stripSet.has(key.toUpperCase())) {
      strippedEnvVars.push(key);
      continue;
    }
    cleanEnv[key] = String(value);
  }

  // Apply explicit pane-specific env overrides (never shared across panes).
  const injectedEnvVars = {};
  if (paneConfig?.env && typeof paneConfig.env === "object") {
    for (const [key, value] of Object.entries(paneConfig.env)) {
      if (value !== undefined && value !== null) {
        const strValue = String(value);
        cleanEnv[key] = strValue;
        injectedEnvVars[key] = strValue;
      }
    }
  }

  // If this pane passes its model via an env var, inject only this pane's model.
  const modelMethod = preset?.model_passing?.method;
  const modelEnvVar = preset?.model_passing?.env_var;
  if (
    modelMethod === "env" &&
    typeof modelEnvVar === "string" &&
    modelEnvVar.trim() !== "" &&
    typeof paneConfig?.model === "string" &&
    paneConfig.model.trim() !== ""
  ) {
    const varName = modelEnvVar.trim();
    const modelValue = paneConfig.model.trim();
    cleanEnv[varName] = modelValue;
    injectedEnvVars[varName] = modelValue;
  }

  return {
    env: cleanEnv,
    strippedEnvVars: strippedEnvVars.sort(),
    injectedEnvVars
  };
}
