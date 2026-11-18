# Swarm Engine Team

A terminal orchestrator that runs multiple AI coding CLIs (Kilo Code, Claude Code, Antigravity, OpenCode, Codex, Gemini, Aider, or custom commands) in parallel terminal panes within a structured WezTerm layout.

Each pane runs in its own isolated environment with its own dedicated model selection, preventing cross-pane environment variable leakage or shared parent state.

---

## Architecture & Layout

```
+------------------------------------------------------------------------+
|                     ORCHESTRATOR PANE (Full Width)                     |
|                   claude · amazon bedrock / sonnet                     |
+------------------------------------+-----------------------------------+
|  WORKER 1 (Bottom Left)            |  WORKER 2 (Bottom Mid)            |
|  kilocode · river deepseek         |  kilocode · river qwen            |
+------------------------------------+-----------------------------------+
|  WORKER 3 (Bottom Right)           |  WORKER 4 ... (up to 6 workers)   |
|  kilocode · river nemotron         |  ...                              |
+------------------------------------+-----------------------------------+
```

*(Screenshot Placeholder: Orchestrator at top, 2x3 worker grid below with live status bar)*

---

## Requirements

- **Operating System**: Windows 10 or Windows 11
- **Shell**: PowerShell 5.1+ or PowerShell 7+
- **Runtime**: Node.js >= 20.0.0
- **Terminal**: [WezTerm](https://wezfurlong.org/wezterm/installation.html)
- **AI Coding CLIs**: At least one installed AI coding agent CLI (e.g. `kilocode`, `claude`, `agy`, `opencode`)

---

## Installation & Uninstallation

### Installation

To add `swarm` and the short alias `team` to your User `PATH` (no administrator privileges needed):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

> **Note**: This modifies only the current user's environment variable. It sets up **no** background services, **no** scheduled tasks, **no** daemons, and **no** startup items.

### Uninstallation

To completely remove Swarm from your User `PATH`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

---

## Quick Start

1. Create a configuration file in your project directory:
   ```powershell
   Copy-Item swarm.config.example.json swarm.config.json
   ```
2. Edit `swarm.config.json` with your desired CLIs and models.
3. Validate your pane launch commands:
   ```powershell
   swarm doctor
   ```
4. Start the swarm layout in WezTerm:
   ```powershell
   swarm
   ```
5. Check status from any terminal:
   ```powershell
   swarm status
   ```
6. Dispatch a task to worker 3:
   ```powershell
   swarm send @worker-3 "Analyze database schema for performance bottlenecks"
   ```
7. When finished, cleanly close all panes and verify zero leftover processes:
   ```powershell
   swarm stop
   ```

---

## Configuration Reference

Swarm resolves configuration in this order:
1. Explicit path passed via `--config <path>`
2. Local `./swarm.config.json` in the current project directory
3. Global user fallback in `%USERPROFILE%\.swarm\swarm.config.json`

Even when loaded from the global fallback, each pane's working directory defaults to the current directory where `swarm` was launched.

### Example `swarm.config.json`:

```json
{
  "default_cli": "kilocode",
  "orchestrator": {
    "cli": "claude",
    "model": "anthropic.claude-3-5-sonnet-20241022-v2:0",
    "cwd": "."
  },
  "workers": [
    {
      "cli": "kilocode",
      "model": "river/deepseek-ai/DeepSeek-V4.1-Flash",
      "cwd": "."
    },
    {
      "cli": "kilocode",
      "model": "river/Qwen/Qwen3.8-27B-FP8",
      "cwd": "."
    },
    {
      "cli": "kilocode",
      "model": "river/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
      "cwd": "."
    }
  ]
}
```

---

## Supported CLIs

| CLI Name | Preset Key | Model Passing Method | Non-Interactive Mode | Verification Status |
| :--- | :--- | :--- | :--- | :--- |
| **Kilo Code** | `kilocode`, `kilo` | `--model <provider/model>` | `kilocode run <prompt>` | Verified locally (v7.8.27) |
| **Claude Code** | `claude` | `--model <id/alias>` | `claude --print <prompt>` | Verified locally (v2.1.319) |
| **Antigravity** | `agy`, `antigravity` | `--model <model>` | `agy --print <prompt>` | Verified locally (v1.5.9) |
| **OpenCode** | `opencode` | `--model <model>` | `opencode run <prompt>` | Verified locally (v1.1.28) |
| **Codex CLI** | `codex` | `--model <model>` | `codex exec <prompt>` | Preset included (unverified) |
| **Gemini CLI** | `gemini` | `--model <model>` | `gemini query <prompt>` | Preset included (unverified) |
| **Aider** | `aider` | `--model <model>` | `aider --message <prompt>` | Preset included (unverified) |

---

## Task Dispatch System

You can send tasks directly from the orchestrator pane or from any external terminal using `swarm send`:

- **Target Single Worker**:
  ```powershell
  swarm send @worker-3 "Run database migration step 4"
  ```
- **Broadcast to All Workers**:
  ```powershell
  swarm send @all "Run git status and report changes"
  ```
- **Target Specific Workers**:
  ```powershell
  swarm send "@workers 1,2" "Review pull request diff"
  ```

Tasks are delivered via WezTerm CLI IPC directly to the target terminal's stdin stream without relying on proprietary CLI APIs.

---

## Command Reference

| Command / Flag | Description |
| :--- | :--- |
| `swarm` | Start the orchestrator and worker grid layout in WezTerm. |
| `swarm stop` | Cleanly terminate all active panes, state files, and verify zero leftover processes. |
| `swarm status` | Print current session status and observe each worker's state (`idle`, `working`, `done`, `error`). |
| `swarm send <target> "<task>"` | Dispatch a task to targeted worker panes. |
| `swarm doctor` | Inspect per-pane CLI, launch command, model flag, and clean environment isolation. Fails loudly on command collisions. |
| `swarm --dry-run` | Print all pane launch commands without starting any processes or panes. |
| `swarm --workers <1-6>` | Override the number of worker panes (e.g. `swarm --workers 4`). |
| `swarm --cli <name>` | Force all panes to use the specified CLI while preserving models from config. |
| `swarm --version`, `-v` | Display the installed Swarm Engine Team version. |
| `swarm help`, `--help` | Display usage and help documentation. |

---

## Troubleshooting

### 1. Same Model in Every Pane
- **Diagnosis**: Run `swarm doctor`.
- **Cause**: Some CLIs ignore the `--model` CLI flag if an internal global configuration file (such as `~/.config` or `~/.claude.json`) has a fixed default, or if the CLI uses an undocumented flag format.
- **Solution**: Confirm with `swarm doctor` that each pane received its intended `--model` flag. If the CLI ignores the flag, check the CLI's configuration file or specify model parameters via `presets/<cli>.json`.

### 2. Model No Longer Available
- **Diagnosis**: Hosted cloud models get updated or retired by providers.
- **Verification**: Test the model directly in non-interactive mode:
  ```powershell
  kilocode run --model river/deepseek-ai/DeepSeek-V4.1-Flash "ok"
  ```
- **Solution**: Update the model identifier in `swarm.config.json` to an active model ID.

### 3. WezTerm Not Found
- **Cause**: WezTerm is not installed or `wezterm.exe` is not in your system `PATH`.
- **Solution**: Install WezTerm from [https://wezfurlong.org/wezterm/](https://wezfurlong.org/wezterm/) or via winget:
  ```powershell
  winget install wez.wezterm
  ```
  Restart your terminal after installation.

### 4. PowerShell Script Blocked
- **Cause**: Windows PowerShell default execution policy restricts unsigned scripts (`ExecutionPolicy Restricted`).
- **Solution**: Bypass execution policy for the current PowerShell process:
  ```powershell
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
  ```
  Then run `.\scripts\install.ps1`.
