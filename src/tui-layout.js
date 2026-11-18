/**
 * Swarm Engine Team - In-Terminal TUI Layout Engine.
 *
 * Renders the orchestrator top box, tree connector lines, and worker grid
 * directly in the terminal using ANSI escape codes, matching the visual
 * architecture from the reference screenshot.
 */

// ANSI Color Helpers
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const PURPLE = "\x1b[38;5;177m";
const PEACH = "\x1b[38;5;216m";
const CYAN = "\x1b[38;5;117m";
const GREEN = "\x1b[38;5;120m";
const YELLOW = "\x1b[38;5;221m";
const RED = "\x1b[38;5;203m";
const MUTED = "\x1b[38;5;242m";
const BORDER_DIM = "\x1b[38;5;238m";
const BORDER_FOCUS = "\x1b[38;5;51m"; // Bright Cyan for focused pane

/**
 * Strip ANSI escape codes to measure string display width.
 * @param {string} str
 * @returns {number}
 */
export function stripAnsi(str) {
  if (typeof str !== "string") return "";
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Truncate or pad string to exact visible width.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
export function fitWidth(str, width) {
  const visible = stripAnsi(str);
  if (visible.length > width) {
    return visible.slice(0, Math.max(0, width - 1)) + "…";
  }
  return str + " ".repeat(Math.max(0, width - visible.length));
}

/**
 * Draw a single box with border, header, and content.
 *
 * @param {object} params
 * @param {number} params.width
 * @param {number} params.height
 * @param {string} params.titleLeft
 * @param {string} params.titleRight
 * @param {string[]} params.lines
 * @param {boolean} [params.focused=false]
 * @param {string} [params.headerColor=PURPLE]
 * @returns {string[]} Array of formatted terminal rows
 */
export function renderBox({
  width,
  height,
  titleLeft,
  titleRight,
  lines,
  focused = false,
  headerColor = PURPLE
}) {
  const borderCol = focused ? BORDER_FOCUS : BORDER_DIM;
  const totalWidth = Math.max(12, width);
  const innerWidth = totalWidth - 2;
  const contentWidth = Math.max(8, innerWidth - 2);
  const rows = [];

  // Top border with titles and focus tag
  const focusTag = focused ? ` ${BORDER_FOCUS}[FOCUSED]${RESET}` : "";
  const leftStr = ` ${headerColor}${BOLD}${titleLeft}${RESET}${focusTag} `;
  const rightStr = titleRight ? ` ${MUTED}${titleRight}${RESET} ` : "";
  const leftLen = stripAnsi(leftStr).length;
  const rightLen = stripAnsi(rightStr).length;

  let topMiddle = "";
  const midDashes = innerWidth - leftLen - rightLen;
  if (midDashes >= 0) {
    topMiddle = leftStr + `${borderCol}${"─".repeat(midDashes)}${RESET}` + rightStr;
  } else {
    topMiddle = fitWidth(leftStr + rightStr, innerWidth);
  }

  rows.push(`${borderCol}┌${RESET}${topMiddle}${borderCol}┐${RESET}`);

  // Inner lines
  const contentHeight = Math.max(2, height - 2);
  const displayLines = lines.slice(-contentHeight);
  while (displayLines.length < contentHeight) {
    displayLines.unshift("");
  }

  for (let i = 0; i < contentHeight; i += 1) {
    const rawLine = displayLines[i] ?? "";
    const content = fitWidth(rawLine, contentWidth);
    rows.push(`${borderCol}│${RESET} ${content} ${borderCol}│${RESET}`);
  }

  // Bottom border
  rows.push(`${borderCol}└${"─".repeat(innerWidth)}┘${RESET}`);

  return rows;
}

/**
 * Format a tree connector line branching from top center to worker columns.
 *
 * @param {number} totalWidth
 * @param {number[]} colCenters
 * @returns {string[]} 2 rows of tree connectors
 */
export function renderTreeConnectors(totalWidth, colCenters) {
  if (!colCenters || colCenters.length === 0) return [];
  const minCol = Math.min(...colCenters);
  const maxCol = Math.max(...colCenters);
  const rootCenter = Math.floor(totalWidth / 2);

  const row1 = new Array(totalWidth).fill(" ");
  const row2 = new Array(totalWidth).fill(" ");

  if (colCenters.length === 1) {
    const center = colCenters[0];
    row1[center] = "│";
    row2[center] = "│";
    return [
      `${MUTED}${row1.join("")}${RESET}`,
      `${MUTED}${row2.join("")}${RESET}`
    ];
  }

  // Horizontal bar connecting min to max column
  for (let c = minCol; c <= maxCol; c += 1) {
    row1[c] = "─";
  }

  // Root connector from top orchestrator
  row1[rootCenter] = "┴";

  // Branch drop points
  for (const center of colCenters) {
    if (center === minCol) {
      row1[center] = "┌";
    } else if (center === maxCol) {
      row1[center] = "┐";
    } else {
      row1[center] = "┬";
    }
    row2[center] = "│";
  }

  return [
    `${MUTED}${row1.join("")}${RESET}`,
    `${MUTED}${row2.join("")}${RESET}`
  ];
}

/**
 * Render the full TUI screen matching the reference photo layout.
 *
 * @param {object} params
 * @param {number} params.terminalWidth
 * @param {number} params.terminalHeight
 * @param {string} params.sessionName
 * @param {object} params.orchestrator
 * @param {object[]} params.workers
 * @param {string} params.focusedId
 * @returns {string} Full ANSI string to write to terminal
 */
export function renderFullDashboard({
  terminalWidth = 100,
  terminalHeight = 30,
  sessionName = "swarm-engine-team",
  orchestrator,
  workers = [],
  focusedId = "orchestrator"
}) {
  const width = Math.max(40, terminalWidth);
  const out = [];

  // Clear alternate buffer and position cursor at home (0,0) without flicker
  out.push("\x1b[H");

  // 1. Orchestrator Box (Full Width)
  const orchBox = renderBox({
    width: width - 4,
    height: 6,
    titleLeft: `${orchestrator.id} · orchestrator`,
    titleRight: orchestrator.model,
    lines: orchestrator.displayLines ?? [
      `> Active task: ${orchestrator.task ?? "Standby for orchestrator prompts"}`,
      `* Status: ${orchestrator.state ?? "idle"} · ${orchestrator.cli}`,
      ">"
    ],
    focused: focusedId === orchestrator.id,
    headerColor: PURPLE
  });
  out.push(...orchBox);

  // 2. Tree Connectors
  const workerCount = workers.length;
  const cols = workerCount <= 3 ? workerCount : (workerCount === 4 ? 2 : 3);
  const colWidth = Math.floor((width - 4) / Math.max(1, cols));

  const colCenters = [];
  for (let i = 0; i < cols; i += 1) {
    colCenters.push(Math.floor(i * colWidth + colWidth / 2));
  }
  const connectors = renderTreeConnectors(width - 4, colCenters);
  out.push(...connectors);

  // 3. Worker Boxes (Grid)
  const rows = Math.ceil(workerCount / cols);
  const boxHeight = Math.max(5, Math.floor((terminalHeight - 14) / Math.max(1, rows)));

  for (let r = 0; r < rows; r += 1) {
    const rowWorkers = workers.slice(r * cols, (r + 1) * cols);
    const renderedColBoxes = rowWorkers.map((w) =>
      renderBox({
        width: colWidth - 2,
        height: boxHeight,
        titleLeft: w.id,
        titleRight: w.model,
        lines: w.displayLines ?? [
          w.state === "working" ? `● Working on task...` : `○ idle`,
          `* Last output: ${w.lastLine || "Ready for tasks"}`,
          ">"
        ],
        focused: focusedId === w.id,
        headerColor: PEACH
      })
    );

    // Combine columns horizontally row by row
    const rowLinesCount = renderedColBoxes[0]?.length ?? 0;
    for (let lineIdx = 0; lineIdx < rowLinesCount; lineIdx += 1) {
      let combined = "";
      for (const box of renderedColBoxes) {
        combined += (box[lineIdx] ?? "") + " ";
      }
      out.push(combined);
    }
  }

  // 4. Bottom Status Bar
  const workingCount = workers.filter((w) => w.state === "working").length;
  const idleCount = workers.filter((w) => w.state === "idle").length;
  const errorCount = workers.filter((w) => w.state === "error").length;

  const leftStatus = `${BOLD}${sessionName}${RESET} · ${orchestrator.cli} + ${workerCount} workers (${workingCount} working, ${idleCount} idle${errorCount ? `, ${errorCount} error` : ""})`;
  const rightStatus = `[Tab] Focus [Ctrl+Q] Exit`;

  const statusPadding = Math.max(0, width - 4 - stripAnsi(leftStatus).length - stripAnsi(rightStatus).length);
  let barLine = `${leftStatus}${" ".repeat(statusPadding)}${MUTED}${rightStatus}${RESET}`;
  if (stripAnsi(barLine).length > width - 4) {
    barLine = fitWidth(barLine, width - 4);
  }

  out.push("");
  out.push(`${DIM}${"─".repeat(Math.max(10, width - 4))}${RESET}`);
  out.push(barLine);

  return out.join("\n");
}
