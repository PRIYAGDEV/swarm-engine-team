# Contributing to Swarm Engine Team

Contributions are welcome! This document explains the project structure and how to add support for new AI coding CLIs.

---

## Adding a New CLI Preset

Swarm Engine Team loads CLI presets dynamically from the `presets/` directory. Each supported CLI has a dedicated JSON descriptor matching its CLI name (e.g., `presets/kilocode.json`, `presets/claude.json`).

### Step 1: Verify the CLI's Flags

Before creating or editing a preset, you **must** verify the exact flags and commands supported by the CLI locally:

```powershell
<cli> --help
<cli> <subcommand> --help
```

> **Important**: Never guess flags. If the CLI is not installed locally on your system, set `"verified": false` and mark it unverified in the descriptor.

### Step 2: Create `presets/<cli-name>.json`

Create a new JSON file adhering to the following schema:

```json
{
  "name": "mycli",
  "display_name": "My CLI Tool",
  "command": "mycli",
  "aliases": ["mc"],
  "verified": true,
  "verification": {
    "installed_locally": true,
    "installed_version": "1.0.0",
    "verified_via": [
      "mycli --help",
      "https://example.com/docs"
    ],
    "verified_at": "2026-11-18",
    "notes": "Verified against local installation. Model passed via --model flag."
  },
  "model_passing": {
    "method": "flag",
    "flag": "--model",
    "short_flag": "-m",
    "format": "provider/model_id",
    "requires_subcommand": null,
    "env_var": null,
    "config_file": null
  },
  "non_interactive": {
    "type": "flag",
    "subcommand": null,
    "flag": "--print",
    "short_flag": "-p",
    "prompt_mode": "positional",
    "auto_approve_flag": "--yes",
    "notes": "Runs non-interactively when passed -p / --print."
  },
  "env_strip": [
    "MYCLI_MODEL"
  ]
}
```

### Step 3: Add Model Compatibility Rules (if applicable)

If the CLI has specific model naming conventions or exclusive model providers (for example, River AI models exclusive to Kilo Code, or Amazon Bedrock models for Claude Code), update `checkModelCompatibility` in `src/config.js` to provide clear guidance when an incompatible model is configured.

### Step 4: Run Tests

Run the automated test suite to verify your changes:

```powershell
npm test
```

Ensure all tests pass and that `swarm doctor` produces distinct commands for your new preset without collisions.
