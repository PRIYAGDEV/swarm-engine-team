/**
 * Preset loader for supported AI coding CLIs.
 * Reads one JSON file per CLI from the repository's /presets directory.
 * Never caches mutable objects across calls so callers cannot mutate shared state.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the /presets directory. */
export const PRESETS_DIR = path.resolve(__dirname, "..", "presets");

/**
 * Deep-clone a JSON-serializable object so no caller holds a shared reference.
 * @param {unknown} value
 * @returns {any}
 */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * List all available preset names in /presets (filename without .json).
 * @param {string} [presetsDir]
 * @returns {string[]}
 */
export function listPresetNames(presetsDir = PRESETS_DIR) {
  if (!fs.existsSync(presetsDir)) {
    return [];
  }
  return fs
    .readdirSync(presetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .sort();
}

/**
 * Load a single CLI preset JSON by name or alias.
 * Returns a fresh clone every time it is called.
 *
 * @param {string} cliName - Preset name (e.g. "kilocode", "claude") or alias (e.g. "kilo").
 * @param {string} [presetsDir] - Optional override for presets directory.
 * @returns {object} Parsed preset definition.
 */
export function loadPreset(cliName, presetsDir = PRESETS_DIR) {
  if (typeof cliName !== "string" || cliName.trim() === "") {
    throw new Error("Preset name must be a non-empty string.");
  }

  const normalized = cliName.trim().toLowerCase();
  const directPath = path.join(presetsDir, `${normalized}.json`);

  if (fs.existsSync(directPath)) {
    const raw = fs.readFileSync(directPath, "utf8");
    return cloneJson(JSON.parse(raw));
  }

  // Fall back to matching declared aliases inside existing preset files.
  for (const name of listPresetNames(presetsDir)) {
    const candidatePath = path.join(presetsDir, `${name}.json`);
    const parsed = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
    const aliases = Array.isArray(parsed.aliases)
      ? parsed.aliases.map((a) => String(a).toLowerCase())
      : [];
    if (aliases.includes(normalized)) {
      return cloneJson(parsed);
    }
  }

  const available = listPresetNames(presetsDir).join(", ") || "(none)";
  throw new Error(
    `Unknown CLI preset "${cliName}". Available presets: ${available}. ` +
      `For a custom command, set "command" explicitly in the pane config.`
  );
}
