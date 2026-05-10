import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ProbeResult, ProgressEvent, PresetId } from "../types.ts";

/**
 * Resolve the `vsc` executable by walking up from this file's location
 * looking for `node_modules/.bin/vsc`. Mirrors the bin script's resolution
 * logic so the TUI works regardless of where it's invoked from.
 */
export function findVscBin(): string {
  let dir = dirname(new URL(import.meta.url).pathname);
  while (dir !== "/") {
    const candidate = join(dir, "node_modules", ".bin", "vsc");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("vsc binary not found — run `npm install` in the monorepo root");
}

export interface ProbeSummary {
  durationSec: number;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  videoCodec: string | null;
}

export async function probe(file: string): Promise<ProbeSummary> {
  const bin = findVscBin();
  const out = await runCapture(bin, ["analyze", resolve(file), "--json"]);
  const parsed = JSON.parse(out) as ProbeResult;
  return {
    durationSec: parsed.format.durationSec,
    sizeBytes: parsed.format.sizeBytes,
    width: parsed.video?.width ?? null,
    height: parsed.video?.height ?? null,
    hasAudio: parsed.audios.length > 0,
    videoCodec: parsed.video?.codecName ?? null,
  };
}

export interface EncodeHandle {
  abort: () => void;
}

/**
 * Spawn `vsc compress --json` and feed each parsed NDJSON event to `onEvent`.
 * `onError` fires for stderr-only failures (process exit non-zero with no
 * `error` event already emitted). On normal completion neither callback is
 * called after the `done` event — the consumer cleans up there.
 */
export interface CompressOverrides {
  maxEdge?: number | undefined;
  crf?: number | undefined;
  bitrateKbps?: number | undefined;
  dropAudio?: boolean | undefined;
  singleCodec?: "h264" | "h265" | "av1" | "vp9" | undefined;
  av1Encoder?: "svt" | "aom" | undefined;
}

export interface StartEncodeOptions {
  outDir: string;
  single?: boolean | undefined;
  overrides?: CompressOverrides | undefined;
  concurrency?: number | undefined;
}

export function startEncode(
  file: string,
  preset: PresetId,
  options: StartEncodeOptions,
  onEvent: (event: ProgressEvent) => void,
  onError: (message: string) => void,
): EncodeHandle {
  const bin = findVscBin();
  const args = [
    "compress",
    resolve(file),
    "--preset",
    preset,
    "--out-dir",
    resolve(options.outDir),
    "--json",
  ];
  if (options.single ?? true) args.push("--single");
  if (options.concurrency != null) args.push("--concurrency", String(options.concurrency));
  if (options.overrides) {
    for (const [k, v] of Object.entries(options.overrides)) {
      if (v == null) continue;
      args.push("--override", `${k}=${String(v)}`);
    }
  }
  const child = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderrTail = "";
  let sawError = false;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let nl: number;
    while ((nl = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, nl).trim();
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line) as ProgressEvent;
        if (event.type === "error") sawError = true;
        onEvent(event);
      } catch {
        // Non-JSON line on stdout — ignore. Real protocol violations show up
        // as missing 'done' which the UI surfaces via the close handler below.
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4096);
  });

  child.on("close", (code) => {
    if (code !== 0 && !sawError) {
      onError(stderrTail.trim() || `vsc exited with code ${code}`);
    }
  });

  child.on("error", (err) => onError(err.message));

  return {
    abort: () => {
      if (!child.killed) child.kill("SIGINT");
    },
  };
}

/**
 * Run `vsc <args>` and parse its stdout as a single JSON object. Used for
 * `vsc presets --json` and `vsc estimate ... --json` — anything that returns
 * structured output rather than an NDJSON stream.
 */
export async function runVscJson<T>(args: string[]): Promise<T> {
  const bin = findVscBin();
  const out = await runCapture(bin, args);
  return JSON.parse(out) as T;
}

export interface VscCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runVsc(args: string[]): Promise<VscCommandResult> {
  const bin = findVscBin();
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("close", (code) => {
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", rejectRun);
  });
}

function runCapture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("close", (code) => {
      if (code === 0) resolveCapture(stdout);
      else rejectCapture(new Error(stderr.trim() || `vsc exited with code ${code}`));
    });
    child.on("error", rejectCapture);
  });
}
