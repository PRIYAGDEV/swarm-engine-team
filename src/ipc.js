/**
 * Swarm Engine Team - Named Pipe IPC.
 *
 * Provides cross-process communication between `swarm send` and the active
 * in-terminal TUI dashboard over a Windows Named Pipe or Unix domain socket.
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Get the platform-appropriate Named Pipe or socket path.
 *
 * @param {string} [name="swarm-engine-team"]
 * @returns {string}
 */
export function getIpcPipePath(name = "swarm-engine-team") {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${name}`;
  }
  return path.join(os.tmpdir(), `${name}.sock`);
}

/**
 * Start an IPC server to listen for dispatch commands.
 *
 * @param {object} options
 * @param {string} [options.pipePath]
 * @param {Function} options.onDispatch - Callback receiving ({ target, task }) and returning response object.
 * @param {Function} [options.log]
 * @returns {Promise<{ server: net.Server, close: () => Promise<void> }>}
 */
export function startIpcServer({ pipePath = getIpcPipePath(), onDispatch, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = "";

      socket.on("data", async (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep remainder

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            const response = await onDispatch(message);
            socket.write(JSON.stringify(response) + "\n");
          } catch (err) {
            socket.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
          }
        }
      });

      socket.on("error", () => {
        // Handle client disconnects gracefully
      });
    });

    server.on("error", (err) => {
      reject(err);
    });

    server.listen(pipePath, () => {
      resolve({
        server,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          })
      });
    });
  });
}

/**
 * Send a dispatch command to the active Swarm IPC server.
 *
 * @param {object} params
 * @param {string} params.target
 * @param {string} params.task
 * @param {string} [params.pipePath]
 * @param {number} [params.timeoutMs=5000]
 * @returns {Promise<{ ok: boolean, delivered?: Array<{ worker: string }>, error?: string }>}
 */
export function sendIpcMessage(message, options = {}) {
  const pipePath =
    options?.pipePath ??
    (typeof message === "object" && message ? message.pipePath : null) ??
    getIpcPipePath();

  const timeoutMs =
    options?.timeoutMs ??
    (typeof message === "object" && message ? message.timeoutMs : null) ??
    5000;

  return new Promise((resolve, reject) => {
    const client = net.createConnection(pipePath);
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        client.destroy();
        reject(new Error("Timeout waiting for response from active Swarm session."));
      }
    }, timeoutMs);

    client.on("connect", () => {
      const payload = typeof message === "string" ? message + "\n" : JSON.stringify(message) + "\n";
      client.write(payload);
    });

    client.on("data", (data) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        const response = JSON.parse(data.toString("utf8").trim());
        client.end();
        resolve(response);
      } catch (err) {
        client.end();
        reject(new Error(`Failed to parse response from Swarm IPC server: ${err.message}`));
      }
    });

    client.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        reject(new Error("No active Swarm session found. Start one with `swarm` first."));
      } else {
        reject(err);
      }
    });
  });
}
