/**
 * Swarm Engine Team - In-Terminal TUI Session.
 *
 * Manages child processes, real-time output streams, input forwarding,
 * Named Pipe IPC dispatch, and ANSI dashboard rendering inside the current terminal.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { loadSwarmConfig } from "./config.js";
import { buildAllLaunchCommands } from "./launch-builder.js";
import { detectPaneModel, extractModelFromArgs, getKiloSubagents } from "./model-detect.js";
import { renderFullDashboard } from "./tui-layout.js";
import { startIpcServer, getIpcPipePath } from "./ipc.js";
import { resolveTargetWorkers, parseDispatchLine } from "./dispatch.js";
import { savePanesMap, clearPanesMap, saveSessionState, clearSessionState } from "./state.js";
import { resolveInitialTask, saveLastTask } from "./task-pickup.js";

/**
 * In-Terminal TUI Session Manager.
 */
export class TuiSession {
  /**
   * @param {object} options
   * @param {string} [options.configPath]
   * @param {number} [options.workerCount]
   * @param {string} [options.forcedCli]
   * @param {string} [options.forcedModel]
   * @param {string} [options.activeModel]
   * @param {string} [options.task]
   * @param {number} [options.workingThresholdMs=3000] - Seconds threshold for 'working' status.
   * @param {string} [options.baseDir]
   */
  constructor(options = {}) {
    this.options = options;
    this.baseDir = options.baseDir ?? process.cwd();
    this.workingThresholdMs = options.workingThresholdMs ?? 3000;
    this.renderIntervalMs = 100;

    const initialTaskResult = resolveInitialTask({
      explicitTask: options.task,
      baseDir: this.baseDir
    });
    this.activeTask = initialTaskResult.task;
    this.taskSource = initialTaskResult.source;

    this.panes = [];
    this.focusedIndex = 0;
    this.running = false;
    this.ipcServer = null;
    this.renderTimer = null;
    this.stdinRawOriginal = false;

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /**
   * Promise that resolves when the session terminates.
   * @returns {Promise<void>}
   */
  waitUntilExit() {
    return this.exitPromise;
  }

  /**
   * Initialize and start the in-terminal session.
   */
  async start() {
    const { configPath, source, panes: paneConfigs } = loadSwarmConfig(this.options.configPath, {
      workerCount: this.options.workerCount,
      forcedCli: this.options.forcedCli,
      forcedModel: this.options.forcedModel,
      activeModel: this.options.activeModel,
      currentDir: this.baseDir
    });

    const launches = buildAllLaunchCommands(paneConfigs);
    const kiloData = getKiloSubagents();

    // Initialize pane records
    this.panes = launches.map((launch, idx) => {
      const paneConfig = paneConfigs[idx];
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

      const workerIndex = launch.role === "worker" ? idx - 1 : -1;
      const subagent = workerIndex >= 0 && kiloData?.workers ? kiloData.workers[workerIndex] : null;

      let initialOutputLines = [];
      let initialLastLine = "";

      if (launch.role === "orchestrator") {
        if (this.activeTask) {
          initialOutputLines.push(`> [Active Task] ${this.activeTask}`);
        }
      } else if (subagent) {
        initialOutputLines.push(`> [Subagent] ${subagent.title}`);
        initialOutputLines.push(`* Ready for dispatch`);
        initialLastLine = subagent.title;
      } else {
        initialOutputLines.push(`* Ready for dispatch`);
        initialLastLine = "Ready";
      }

      return {
        id: launch.id,
        role: launch.role,
        cli: launch.cli,
        model: detected.model,
        modelSource: detected.source,
        mismatch: detected.mismatch,
        warning: detected.warning,
        launch,
        child: null,
        state: "idle",
        lastOutputAt: null,
        inputBuffer: "",
        outputLines: initialOutputLines,
        lastLine: initialLastLine
      };
    });

    // Save runtime map for CLI dispatch
    const panesMap = {};
    for (const p of this.panes) {
      panesMap[p.id] = p.id;
    }
    savePanesMap(panesMap, this.baseDir);
    saveSessionState({ baseDir: this.baseDir, panes: this.panes.map((p) => ({ id: p.id, role: p.role })) }, this.baseDir);

    // Spawn child processes
    for (const p of this.panes) {
      this.spawnPaneProcess(p);
    }

    // Start IPC server for remote dispatch (`swarm send`, `swarm status`, `swarm stop`)
    this.ipcServer = await startIpcServer({
      onDispatch: async (msg) => this.handleIpcMessage(msg)
    });

    this.running = true;

    // If running in an interactive terminal, initialize TUI alternate screen buffer
    if (process.stdin.isTTY && !this.options.headless) {
      this.initInteractiveTui();
    }
  }

  /**
   * Spawn a single pane process and pipe its streams.
   * @param {object} pane
   */
  spawnPaneProcess(pane) {
    const { launch } = pane;
    try {
      const useShell = process.platform === "win32";
      const child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: { ...launch.env },
        shell: useShell,
        stdio: ["pipe", "pipe", "pipe"]
      });

      pane.child = child;

      const appendOutput = (data) => {
        const text = data.toString("utf8");
        if (text.includes("Gi=31337") || text.includes("\x1b[?1049h")) {
          return;
        }
        const lines = text.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
          if (clean && !clean.startsWith("Gi=") && !clean.includes("DEP0190")) {
            pane.lastOutputAt = Date.now();
            pane.state = "working";
            pane.outputLines.push(clean);
            if (pane.outputLines.length > 50) {
              pane.outputLines = pane.outputLines.slice(-50);
            }
            pane.lastLine = clean;
          }
        }
      };

      child.stdout.on("data", appendOutput);
      child.stderr.on("data", appendOutput);

      child.on("close", (code) => {
        pane.state = "idle";
        if (code !== 0 && pane.outputLines.length === 0) {
          pane.outputLines.push(`* Ready (idle)`);
          pane.lastLine = `Ready`;
        }
      });

      child.on("error", (err) => {
        pane.state = "idle";
        pane.lastLine = `Ready`;
        if (pane.outputLines.length === 0) {
          pane.outputLines.push(`* Ready (idle)`);
        }
      });
    } catch (err) {
      pane.state = "idle";
      pane.lastLine = `Ready`;
      if (pane.outputLines.length === 0) {
        pane.outputLines.push(`* Ready (idle)`);
      }
    }
  }

  /**
   * Execute a worker task via non-interactive run subcommand.
   * @param {object} pane
   * @param {string} task
   */
  executeWorkerTask(pane, task) {
    pane.state = "working";
    pane.lastOutputAt = Date.now();
    const cleanTask = task.replace(/\r?\n/g, " ").trim();
    pane.outputLines.push(`> [Task] ${cleanTask}`);
    pane.lastLine = cleanTask;

    const useShell = process.platform === "win32";
    const args =
      pane.cli === "kilocode" || pane.cli === "kilo"
        ? ["run", "--model", pane.model, "--auto", cleanTask]
        : ["run", cleanTask];

    try {
      const child = spawn(pane.launch.command, args, {
        cwd: pane.launch.cwd,
        env: { ...pane.launch.env },
        shell: useShell,
        stdio: ["pipe", "pipe", "pipe"]
      });

      pane.child = child;

      const appendOutput = (data) => {
        const text = data.toString("utf8");
        const lines = text.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
          if (clean && !clean.includes("DEP0190") && !clean.startsWith("Gi=")) {
            pane.lastOutputAt = Date.now();
            pane.state = "working";
            pane.outputLines.push(clean);
            if (pane.outputLines.length > 50) pane.outputLines = pane.outputLines.slice(-50);
            pane.lastLine = clean;
          }
        }
      };

      child.stdout.on("data", appendOutput);
      child.stderr.on("data", appendOutput);

      child.on("close", (code) => {
        pane.state = "idle";
        if (code === 0) {
          pane.outputLines.push(`* Completed`);
          pane.lastLine = `Completed`;
        }
      });
    } catch (err) {
      pane.state = "idle";
      pane.outputLines.push(`! Error: ${err.message}`);
    }
  }

  /**
   * Handle incoming IPC command from Named Pipe IPC.
   * @param {object} msg
   */
  async handleIpcMessage(msg) {
    if (!msg || typeof msg !== "object") {
      return { ok: false, error: "Invalid IPC payload: expected object." };
    }

    // Stop command: cleanly shut down session
    if (msg.command === "stop" || msg.task === "__swarm_stop__") {
      setTimeout(() => {
        this.stop().catch(() => {});
      }, 50);
      return { ok: true, stopped: true };
    }

    // Status query: return real-time observable states of all panes
    if (msg.command === "status" || msg.action === "status") {
      this.updateStates();
      const orch = this.panes.find((p) => p.role === "orchestrator") ?? this.panes[0];
      const workers = this.panes.filter((p) => p.role === "worker");
      return {
        ok: true,
        running: this.running,
        sessionName: this.isBoost ? "swarm-engine-team [BOOST]" : "swarm-engine-team",
        activeTask: this.activeTask,
        workerCount: workers.length,
        orchestrator: orch
          ? { id: orch.id, cli: orch.cli, model: orch.model, state: orch.state }
          : null,
        workers: workers.map((w, idx) => ({
          id: w.id,
          paneId: idx + 1,
          role: w.role,
          cli: w.cli,
          model: w.model,
          state: w.state,
          lastLine: w.lastLine
        }))
      };
    }

    return this.handleIpcDispatch(msg);
  }

  /**
   * Handle an incoming dispatch command from Named Pipe IPC.
   * @param {{ target: string, task: string }} msg
   */
  async handleIpcDispatch({ target, task }) {
    if (!target || !task) {
      return { ok: false, error: 'Usage: swarm send <target> "<task>"' };
    }

    if (task === "__swarm_stop__") {
      setTimeout(() => this.stop().catch(() => {}), 50);
      return { ok: true, stopped: true };
    }

    const panesMap = {};
    for (const p of this.panes) {
      panesMap[p.id] = p.id;
    }

    let targetWorkers = [];
    try {
      targetWorkers = resolveTargetWorkers(target, panesMap);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    if (task) {
      this.activeTask = task;
      saveLastTask(task, this.baseDir);
    }

    const delivered = [];
    for (const workerId of targetWorkers) {
      const pane = this.panes.find((p) => p.id === workerId);
      if (pane) {
        if (pane.child && pane.child.stdin && pane.child.stdin.writable && !pane.child.killed) {
          pane.child.stdin.write(task + "\r\n");
          pane.state = "working";
          pane.lastOutputAt = Date.now();
          pane.outputLines.push(`> [Dispatch] ${task}`);
          pane.lastLine = task;
        } else {
          this.executeWorkerTask(pane, task);
        }
        delivered.push({ worker: workerId });
      }
    }

    return { ok: true, delivered };
  }

  /**
   * Update pane states based on the activity timeout threshold.
   */
  updateStates() {
    const now = Date.now();
    for (const p of this.panes) {
      if (p.state === "working" && p.lastOutputAt) {
        if (now - p.lastOutputAt > this.workingThresholdMs) {
          p.state = "idle";
        }
      }
    }
  }

  /**
   * Initialize interactive TUI screen, raw keyboard input, and render loop.
   */
  initInteractiveTui() {
    // Switch to alternate screen buffer and hide cursor
    process.stdout.write("\x1b[?1049h\x1b[?25l");

    this.stdinRawOriginal = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    // Keypress handler
    process.stdin.on("data", (key) => this.handleInput(key));

    // Handle terminal resize events
    process.stdout.on("resize", () => this.draw());

    // Regular render interval
    this.renderTimer = setInterval(() => {
      this.updateStates();
      this.draw();
    }, this.renderIntervalMs);

    this.draw();
  }

  /**
   * Handle interactive keyboard input.
   * @param {string} key
   */
  handleInput(key) {
    // Ctrl+Q: Exit cleanly and return to shell
    if (key === "\u0011") {
      this.stop();
      return;
    }

    // Ctrl+C: Exit cleanly
    if (key === "\u0003") {
      this.stop();
      return;
    }

    // Tab: Cycle focus forward
    if (key === "\t") {
      this.focusedIndex = (this.focusedIndex + 1) % this.panes.length;
      this.draw();
      return;
    }

    // Shift+Tab: Cycle focus backward
    if (key === "\x1b[Z") {
      this.focusedIndex = (this.focusedIndex - 1 + this.panes.length) % this.panes.length;
      this.draw();
      return;
    }

    const focusedPane = this.panes[this.focusedIndex];
    if (!focusedPane) return;

    // Enter: Send typed command to child process
    if (key === "\r" || key === "\n") {
      const buffer = focusedPane.inputBuffer ? focusedPane.inputBuffer.trim() : "";
      if (buffer) {
        if (focusedPane.role === "orchestrator") {
          const dispatch = parseDispatchLine(buffer);
          if (dispatch) {
            this.handleIpcDispatch(dispatch);
            focusedPane.outputLines.push(`> ${buffer}`);
            focusedPane.inputBuffer = "";
            this.draw();
            return;
          }
        }
        if (focusedPane.child && focusedPane.child.stdin && focusedPane.child.stdin.writable && !focusedPane.child.killed) {
          focusedPane.child.stdin.write(`${buffer}\r\n`);
          focusedPane.outputLines.push(`> ${buffer}`);
          focusedPane.state = "working";
          focusedPane.lastOutputAt = Date.now();
        } else if (focusedPane.role === "worker") {
          this.executeWorkerTask(focusedPane, buffer);
        } else {
          focusedPane.outputLines.push(`> ${buffer}`);
        }
        focusedPane.inputBuffer = "";
      } else if (focusedPane.child && focusedPane.child.stdin && focusedPane.child.stdin.writable) {
        focusedPane.child.stdin.write("\r\n");
      }
      this.draw();
      return;
    }

    // Backspace: Delete previous char
    if (key === "\x08" || key === "\x7f") {
      if (focusedPane.inputBuffer && focusedPane.inputBuffer.length > 0) {
        focusedPane.inputBuffer = focusedPane.inputBuffer.slice(0, -1);
        this.draw();
      }
      return;
    }

    // Printable characters
    if (key.length === 1 && key >= " ") {
      focusedPane.inputBuffer = (focusedPane.inputBuffer || "") + key;
      this.draw();
      return;
    }

    // Other control sequences: forward raw to child stdin
    if (focusedPane.child && focusedPane.child.stdin && focusedPane.child.stdin.writable) {
      focusedPane.child.stdin.write(key);
    }
  }

  /**
   * Draw the dashboard to the terminal.
   */
  draw() {
    if (!this.running || !process.stdin.isTTY) return;

    const termWidth = process.stdout.columns || 100;
    const termHeight = process.stdout.rows || 30;

    const orch = this.panes.find((p) => p.role === "orchestrator") ?? this.panes[0];
    const workers = this.panes.filter((p) => p !== orch);
    const focusedId = this.panes[this.focusedIndex]?.id ?? orch.id;

    const sessionTitle = "swarm-engine-team";

    const rendered = renderFullDashboard({
      terminalWidth: termWidth,
      terminalHeight: termHeight,
      sessionName: sessionTitle,
      orchestrator: {
        id: orch.id,
        cli: orch.cli,
        model: orch.model,
        state: orch.state,
        task: this.activeTask,
        displayLines: [
          ...orch.outputLines.slice(-3),
          `> ${orch.inputBuffer || ""}`
        ].slice(-3)
      },
      workers: workers.map((w) => ({
        id: w.id,
        cli: w.cli,
        model: w.model,
        state: w.state,
        lastLine: w.lastLine,
        displayLines: [
          ...w.outputLines.slice(-3),
          `> ${w.inputBuffer || ""}`
        ].slice(-3)
      })),
      focusedId
    });

    process.stdout.write(rendered);
  }

  /**
   * Stop the session, kill all processes, and restore the terminal.
   */
  async stop() {
    this.running = false;

    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }

    // Close IPC server
    if (this.ipcServer) {
      await this.ipcServer.close().catch(() => {});
      this.ipcServer = null;
    }

    // Terminate all child processes
    for (const p of this.panes) {
      if (p.child) {
        try {
          p.child.kill("SIGTERM");
        } catch {}
      }
    }

    // Restore terminal alternate screen and show cursor
    if (process.stdin.isTTY && !this.options.headless) {
      try {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } catch {}
      process.stdout.write("\x1b[?1049l\x1b[?25h");
    }

    // Persist active task on exit
    if (this.activeTask) {
      saveLastTask(this.activeTask, this.baseDir);
    }

    // Clear runtime files
    clearPanesMap(this.baseDir);
    clearSessionState(this.baseDir);

    if (typeof this.resolveExit === "function") {
      this.resolveExit();
      this.resolveExit = null;
    }
  }
}
