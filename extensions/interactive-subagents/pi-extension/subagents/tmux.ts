/**
 * Multiplexer surface layer.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping tmux/psmux differences isolated here means
 * index.ts stays testable without a multiplexer running and Windows is not a
 * pile of Unix-shell compatibility hacks.
 *
 * Panes are identified by tmux-compatible pane ids (e.g. `%12`). Splits always
 * target the parent pi's pane (`$TMUX_PANE`/psmux-compatible env) so they follow
 * the agent rather than the user's focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();
let cachedMuxCommand: string | undefined;

export type MuxBackend = "tmux" | "psmux";

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync(command, ["-V"], { stdio: "ignore" });
    available = true;
  } catch {
    const extensions = process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
    const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    available = dirs.some((dir) => extensions.some((ext) => existsSync(join(dir, command + ext))));
  }

  commandAvailability.set(command, available);
  return available;
}

function muxCommand(): string {
  if (cachedMuxCommand) return cachedMuxCommand;

  // On Windows psmux installs tmux/pmux aliases, but selecting the native
  // binary keeps backend detection unambiguous and lets us use psmux-specific
  // safe paste / PowerShell launch paths below.
  const candidates = process.env.PSMUX_SESSION || process.platform === "win32"
    ? ["psmux", "pmux", "tmux"]
    : ["tmux", "psmux", "pmux"];

  for (const command of candidates) {
    if (hasCommand(command)) {
      cachedMuxCommand = command;
      return command;
    }
  }
  return "tmux";
}

export function muxBackend(): MuxBackend {
  const command = muxCommand();
  // Select the native psmux execution model only for panes that are actually
  // running under psmux. Merely having psmux on PATH (common on Windows, where
  // it also ships a tmux alias) is not enough: unit tests and non-mux helper
  // processes should keep the POSIX/tmux quoting semantics.
  return process.env.PSMUX_SESSION && (command === "psmux" || command === "pmux" || command === "tmux")
    ? "psmux"
    : "tmux";
}

/**
 * True when running inside a tmux-compatible multiplexer with a CLI on PATH.
 * tmux and psmux both set TMUX/TMUX_PANE in child panes; psmux also sets PSMUX_SESSION.
 */
export function isTmuxAvailable(): boolean {
  return !!(process.env.TMUX || process.env.PSMUX_SESSION) && ["tmux", "psmux", "pmux"].some(hasCommand);
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`) or psmux (`psmux new-session -s pi`).";
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux/psmux is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  if (muxBackend() === "psmux") {
    // PowerShell single-quoted string. Native psmux panes use PowerShell by
    // default; do not rely on Git Bash being installed just to launch agents.
    return "'" + s.replace(/'/g, "''") + "'";
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function envAssignment(name: string, value: string): string {
  return muxBackend() === "psmux"
    ? `$env:${name}=${shellEscape(value)}`
    : `${name}=${shellEscape(value)}`;
}

export function envPrefix(assignments: string[]): string {
  if (assignments.length === 0) return "";
  return muxBackend() === "psmux"
    ? `${assignments.join("; ")}; `
    : `${assignments.join(" ")} `;
}

export function cdPrefix(cwd: string | null | undefined): string {
  if (!cwd) return "";
  return muxBackend() === "psmux"
    ? `Set-Location -LiteralPath ${shellEscape(cwd)}; `
    : `cd ${shellEscape(cwd)} && `;
}

export function withExitSentinel(command: string): string {
  if (muxBackend() !== "psmux") return `${command}; echo '__SUBAGENT_DONE_'$?'__'`;

  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    command,
    "  $pi_subagent_exit_code = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }",
    "} catch {",
    "  Write-Error $_",
    "  $pi_subagent_exit_code = 1",
    "}",
    'Write-Output "__SUBAGENT_DONE_$($pi_subagent_exit_code)__"',
  ].join("\n");
}

// ── Pane layout ──

/**
 * tmux layout applied to the subagent window to keep panes evenly sized.
 * Switchable: "even-horizontal" (equal columns, matches Ctrl+b Alt+1),
 * "main-vertical" (big main pane + tiled column), "tiled" (grid).
 */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven widths.
 * Applies SUBAGENT_TMUX_LAYOUT to the parent pi window. Debounced so a burst
 * of parallel spawns or staggered exits collapses into a single layout call,
 * and non-fatal: a cosmetic resize must never break spawning or watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      // -t <pane> resolves to that pane's window; does not change focus.
      execFileSync(muxCommand(), ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent: a right split off the parent pi's pane,
 * so new panes follow the agent rather than the user's focus.
 * See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurface(name: string): string {
  return createSurfaceSplit(name, "right", process.env.TMUX_PANE);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  requireTmux();

  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  if (muxBackend() === "psmux" && name.trim()) {
    args.push("-T", name.trim());
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync(muxCommand(), args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  if (muxBackend() === "psmux") {
    const payload = Buffer.from(command, "utf8").toString("base64");
    execFileSync(muxCommand(), ["send-paste", "-t", surface, payload], { encoding: "utf8" });
    execFileSync(muxCommand(), ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
    return;
  }
  execFileSync(muxCommand(), ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync(muxCommand(), ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const backend = muxBackend();
  const extension = backend === "psmux" ? "ps1" : "sh";
  const scriptPath = options?.scriptPath
    ? backend === "psmux"
      ? options.scriptPath.replace(/\.sh$/i, ".ps1")
      : options.scriptPath
    : join(
        tmpdir(),
        "pi-subagent-scripts",
        `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${extension}`,
      );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = backend === "psmux" ? [] : ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  if (backend === "psmux") {
    const ps = hasCommand("pwsh") ? "pwsh" : "powershell";
    sendCommand(surface, `${ps} -NoProfile -ExecutionPolicy Bypass -File ${shellEscape(scriptPath)}`);
  } else {
    sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  }
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    muxCommand(),
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    muxCommand(),
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireTmux();
  execFileSync(muxCommand(), ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces();
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
