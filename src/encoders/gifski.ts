import { spawn } from "node:child_process";
import { TailBuffer } from "../lib/exec.ts";
import { FFMPEG_BASE_ARGS, trimArgs } from "../lib/ffargs.ts";
import { withAtomicWrite } from "../lib/atomic.ts";
import type { GifSpec, ProbeResult } from "../types.ts";

const STDERR_TAIL_BYTES = 8 * 1024;

export interface GifskiOptions {
  spec: GifSpec;
  probe: ProbeResult;
}

/**
 * Build a GIF by piping ffmpeg-decoded frames into gifski.
 * Gifski produces noticeably better GIF quality than ffmpeg's paletteuse
 * because it uses a per-frame perceptual palette.
 */
export async function buildGifWithGifski(
  input: string,
  output: string,
  options: GifskiOptions,
): Promise<void> {
  const { spec, probe } = options;

  await withAtomicWrite(output, (tempPath) => runFfmpegToGifski(input, tempPath, spec, probe));
}

function runFfmpegToGifski(
  input: string,
  tempPath: string,
  spec: GifSpec,
  probe: ProbeResult,
): Promise<void> {
  const ffmpegArgs = [
    ...FFMPEG_BASE_ARGS,
    ...trimArgs(spec.durationSec, probe.format.durationSec),
    "-i",
    input,
    "-vf",
    `fps=${spec.fps},scale=${spec.width}:-2:flags=lanczos`,
    "-f",
    "image2pipe",
    "-vcodec",
    "ppm",
    "-",
  ];

  const gifskiArgs = [
    "--fps",
    String(spec.fps),
    "--width",
    String(spec.width),
    "--quality",
    String(spec.quality),
    "-o",
    tempPath,
    "-",
  ];

  return new Promise<void>((resolve, reject) => {
    const ff = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const gif = spawn("gifski", gifskiArgs, { stdio: ["pipe", "pipe", "pipe"] });

    const ffErr = new TailBuffer(STDERR_TAIL_BYTES);
    const gifErr = new TailBuffer(STDERR_TAIL_BYTES);

    let settled = false;
    let ffDone = false;
    let gifDone = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      if (!ff.killed) ff.kill();
      if (!gif.killed) gif.kill();
      reject(err);
    };

    const maybeResolve = () => {
      if (settled) return;
      if (ffDone && gifDone) {
        settled = true;
        resolve();
      }
    };

    ff.stdout.pipe(gif.stdin);
    // Without these handlers, an EPIPE on the bridging stream becomes an
    // uncaught exception (when gifski exits early) or hangs ffmpeg silently.
    ff.stdout.on("error", fail);
    gif.stdin.on("error", fail);

    ff.stderr.on("data", (b: Buffer) => ffErr.push(b.toString("utf8")));
    gif.stderr.on("data", (b: Buffer) => gifErr.push(b.toString("utf8")));

    ff.on("error", fail);
    gif.on("error", fail);

    ff.on("close", (code) => {
      if (code !== 0 && code !== null) {
        return fail(new Error(`ffmpeg exited ${code}\n${tailLines(ffErr.read(), 5)}`));
      }
      ffDone = true;
      maybeResolve();
    });

    gif.on("close", (code) => {
      if (code !== 0) {
        return fail(new Error(`gifski exited ${code}\n${tailLines(gifErr.read(), 5)}`));
      }
      gifDone = true;
      maybeResolve();
    });
  });
}

function tailLines(s: string, n: number): string {
  return s.split("\n").slice(-n).join("\n").trim();
}
