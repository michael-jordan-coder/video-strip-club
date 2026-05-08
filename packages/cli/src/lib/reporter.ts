import { appendFile } from "node:fs/promises";
import { basename } from "node:path";
import { Spinner, c, formatBytes, info, success, warn } from "./log.ts";
import type { ProgressEvent } from "../types.ts";

export interface Reporter {
  emit(event: ProgressEvent): void;
  close(): Promise<void>;
}

const PROGRESS_THROTTLE_MS = 500;

export interface ReporterOptions {
  tap?: FileTap;
}

/**
 * Drives the existing Spinner / info / success / warn output for human terminals.
 * Maintains one Spinner per active phase so the user sees codec-by-codec progress.
 */
export class PrettyReporter implements Reporter {
  private spinners = new Map<string, Spinner>();
  private tap: FileTap | undefined;

  constructor(opts: ReporterOptions = {}) {
    this.tap = opts.tap;
  }

  emit(event: ProgressEvent): void {
    switch (event.type) {
      case "start":
        info(
          `Compressing ${c.bold(basename(event.input))} with preset ${c.cyan(event.preset)} → ${c.dim(event.outDir)}`,
        );
        break;
      case "phase-start": {
        const sp = new Spinner(event.phase);
        sp.start();
        this.spinners.set(event.phase, sp);
        break;
      }
      case "progress": {
        const sp = this.spinners.get(event.phase);
        if (!sp) break;
        const speed = event.speedX != null ? `${event.speedX.toFixed(2)}x` : "";
        sp.update(`${event.currentPct}%  ${speed}`);
        break;
      }
      case "phase-done": {
        const sp = this.spinners.get(event.phase);
        const tag = event.cached ? c.dim("(cached)") : "";
        const line = `${c.green("✓")} ${event.phase} ${c.dim(formatBytes(event.sizeBytes))}  ${tag}`.trimEnd();
        if (sp) {
          sp.stop(line);
          this.spinners.delete(event.phase);
        } else {
          process.stderr.write(line + "\n");
        }
        break;
      }
      case "warning":
        warn(event.message);
        break;
      case "done":
        success(
          `Done. ${event.artifacts.length} artifact${event.artifacts.length === 1 ? "" : "s"} produced in ${formatMs(event.durationMs)}.`,
        );
        break;
      case "error": {
        const sp = this.spinners.get(event.phase);
        if (sp) {
          sp.stop(`${c.red("✗")} ${event.phase} failed`);
          this.spinners.delete(event.phase);
        }
        break;
      }
    }
    this.tap?.callback(event);
  }

  async close(): Promise<void> {
    for (const sp of this.spinners.values()) sp.stop();
    this.spinners.clear();
    await this.tap?.flush();
  }
}

/**
 * Writes one-event-per-line JSON to stdout. The agent reads this via Monitor
 * on a backgrounded `vsc compress --json` invocation.
 *
 * `progress` events are throttled to ~2/sec per phase — ffmpeg's per-second
 * callback would otherwise flood the agent with hundreds of identical-shape events.
 */
export class JsonReporter implements Reporter {
  private lastProgressAt = new Map<string, number>();
  private tap: FileTap | undefined;

  constructor(opts: ReporterOptions = {}) {
    this.tap = opts.tap;
  }

  emit(event: ProgressEvent): void {
    if (event.type === "progress") {
      const now = Date.now();
      const last = this.lastProgressAt.get(event.phase) ?? 0;
      if (now - last < PROGRESS_THROTTLE_MS && event.currentPct < 100) {
        // Tap still gets every event — only the stdout stream is throttled,
        // so a `--progress-file` consumer can have full granularity if they want it.
        this.tap?.callback(event);
        return;
      }
      this.lastProgressAt.set(event.phase, now);
    }
    process.stdout.write(JSON.stringify(event) + "\n");
    this.tap?.callback(event);
  }

  async close(): Promise<void> {
    await this.tap?.flush();
  }
}

/**
 * Returns a tap callback that appends NDJSON lines to a file. Used by the
 * `--progress-file` flag. Works with both PrettyReporter and JsonReporter
 * so a human can watch the spinner while the agent (or another process)
 * tails the file.
 *
 * Writes are serialized through a single-slot promise chain so concurrent
 * `appendFile` calls cannot interleave (real risk under busy event loops),
 * and any I/O error (ENOSPC, EACCES) surfaces on `flushTap` instead of being
 * silently swallowed.
 */
export interface FileTap {
  callback: (event: ProgressEvent) => void;
  flush: () => Promise<void>;
}

export function fileTap(path: string): FileTap {
  let queue: Promise<void> = Promise.resolve();
  let lastError: Error | null = null;
  return {
    callback(event) {
      queue = queue.then(() =>
        appendFile(path, JSON.stringify(event) + "\n", "utf8").catch((err: unknown) => {
          lastError = err instanceof Error ? err : new Error(String(err));
        }),
      );
    },
    async flush() {
      await queue;
      if (lastError) throw lastError;
    },
  };
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}
