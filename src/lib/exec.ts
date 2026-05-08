import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Called with each chunk of stderr (used for ffmpeg progress parsing). */
  onStderr?: (chunk: string) => void;
  /** Called with each chunk of stdout. */
  onStdout?: (chunk: string) => void;
  /**
   * Cap the captured stdout/stderr at this many bytes (last bytes win).
   * Long ffmpeg encodes can emit MBs of stderr; the tail is all that matters
   * for error reporting.
   */
  tailBytes?: number;
}

const DEFAULT_TAIL_BYTES = 256 * 1024;

const HEADLINE_TAIL_LINES = 8;

export class CommandError extends Error {
  constructor(
    public command: string,
    public args: string[],
    public result: RunResult,
  ) {
    super(
      `\`${command}\` exited with code ${result.code}.\n${tailLines(result.stderr, HEADLINE_TAIL_LINES)}`,
    );
    this.name = "CommandError";
  }

  /** Last `n` lines of stderr (trimmed). Used for the JSON `error` event payload. */
  stderrTail(n: number): string {
    return tailLines(this.result.stderr, n);
  }
}

function tailLines(s: string, n: number): string {
  return s.split("\n").slice(-n).join("\n").trim();
}

export class TailBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(private max: number) {}
  push(s: string): void {
    this.chunks.push(s);
    this.size += s.length;
    while (this.size > this.max && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
  }
  read(): string {
    return this.chunks.join("");
  }
}

export function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const cap = options.tailBytes ?? DEFAULT_TAIL_BYTES;
    const stdout = new TailBuffer(cap);
    const stderr = new TailBuffer(cap);

    child.stdout.on("data", (data: Buffer) => {
      const s = data.toString("utf8");
      stdout.push(s);
      options.onStdout?.(s);
    });

    child.stderr.on("data", (data: Buffer) => {
      const s = data.toString("utf8");
      stderr.push(s);
      options.onStderr?.(s);
    });

    child.on("error", reject);

    child.on("close", (code) => {
      const result: RunResult = {
        code: code ?? -1,
        stdout: stdout.read(),
        stderr: stderr.read(),
      };
      if (code === 0) resolve(result);
      else reject(new CommandError(command, args, result));
    });
  });
}

export interface FfmpegProgress {
  /** Current output time in seconds. */
  outSec: number;
  /** Encoded fps reported by ffmpeg. */
  fps: number | null;
  /** Encoder speed multiplier (1.0 = realtime). */
  speed: number | null;
  /** Output bitrate kbps as ffmpeg reports it. */
  bitrateKbps: number | null;
  /** Output size so far. */
  sizeKb: number | null;
}

const PROGRESS_RE = /(\w+)=\s*([^\s]+)/g;

export function parseFfmpegProgress(line: string): FfmpegProgress | null {
  if (!line.includes("time=")) return null;
  const fields: Record<string, string> = {};
  let m: RegExpExecArray | null;
  PROGRESS_RE.lastIndex = 0;
  while ((m = PROGRESS_RE.exec(line)) !== null) {
    fields[m[1]!] = m[2]!;
  }
  const time = fields.time;
  if (!time) return null;
  const outSec = parseTimecode(time);
  if (outSec == null) return null;
  return {
    outSec,
    fps: numOrNull(fields.fps),
    speed: speedOrNull(fields.speed),
    bitrateKbps: bitrateKbpsOrNull(fields.bitrate),
    sizeKb: sizeKbOrNull(fields.size),
  };
}

export function parseTimecode(t: string): number | null {
  if (t === "N/A") return null;
  const [hh, mm, ss] = t.split(":");
  if (hh == null || mm == null || ss == null) return null;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
}

function numOrNull(v: string | undefined): number | null {
  if (v == null || v === "N/A") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function speedOrNull(v: string | undefined): number | null {
  if (v == null || v === "N/A") return null;
  const n = Number(v.replace("x", ""));
  return Number.isFinite(n) ? n : null;
}

function bitrateKbpsOrNull(v: string | undefined): number | null {
  if (v == null || v === "N/A") return null;
  const m = /^([\d.]+)\s*kbits\/s$/i.exec(v);
  if (m) return Number(m[1]);
  return null;
}

function sizeKbOrNull(v: string | undefined): number | null {
  if (v == null || v === "N/A") return null;
  const m = /^([\d.]+)(KiB|kB|MiB)$/i.exec(v);
  if (!m) return null;
  const num = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (unit === "kib" || unit === "kb") return num;
  if (unit === "mib") return num * 1024;
  return null;
}
