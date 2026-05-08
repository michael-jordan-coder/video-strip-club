import { run, parseFfmpegProgress } from "../lib/exec.ts";
import type { FfmpegProgress } from "../lib/exec.ts";
import {
  FFMPEG_BASE_ARGS,
  buildLongestEdgeScale,
  trimArgs,
} from "../lib/ffargs.ts";
import { withAtomicWrite } from "../lib/atomic.ts";
import type { OutputSpec, PosterSpec, GifSpec, ProbeResult } from "../types.ts";

// Capped-CRF VBV tuning. h264 honors -maxrate/-bufsize to bound bitrate spikes
// without giving up CRF's quality target.
const VBV_MAXRATE_MULTIPLIER = 1.5;
const VBV_BUFSIZE_MULTIPLIER = 2;

// Pull the poster frame this many seconds before EOF when the requested
// position is at/past the end — avoids the black/duplicate-final-frame trap.
const POSTER_EOF_SAFETY_SEC = 0.05;

export interface EncodeOptions {
  spec: OutputSpec;
  probe: ProbeResult;
  onProgress?: (p: FfmpegProgress) => void;
}

export async function encodeVideo(
  input: string,
  output: string,
  options: EncodeOptions,
): Promise<void> {
  const { spec, probe, onProgress } = options;

  await withAtomicWrite(output, async (tempPath) => {
    const args: string[] = [...FFMPEG_BASE_ARGS, "-stats", "-i", input];

    const filters = buildVideoFilters(spec);
    if (filters) args.push("-vf", filters);

    args.push(...buildVideoCodecArgs(spec));
    args.push(...buildAudioCodecArgs(spec, probe));
    args.push(...buildContainerArgs(spec));

    args.push(tempPath);

    await run("ffmpeg", args, {
      onStderr: (chunk) => {
        if (!onProgress) return;
        // ffmpeg writes progress as a single carriage-returned line; split on \r and \n.
        const lines = chunk.split(/[\r\n]/);
        for (const line of lines) {
          const p = parseFfmpegProgress(line);
          if (p) onProgress(p);
        }
      },
    });
  });
}

function buildVideoFilters(spec: OutputSpec): string | null {
  const parts: string[] = [];
  if (spec.longestEdge != null) {
    parts.push(buildLongestEdgeScale(spec.longestEdge));
  }
  if (spec.maxFps != null) {
    parts.push(`fps=${spec.maxFps}`);
  }
  // yuv420p in libx264/libx265 requires even dimensions. The scale filter above
  // uses `-2` to enforce that; if no scale was applied we still need to coerce
  // odd-dim sources (rare but real) to even.
  if (parts.length === 0) {
    parts.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");
  }
  return parts.join(",");
}

function buildVideoCodecArgs(spec: OutputSpec): string[] {
  const crf = (defaultCrf: number) => String(spec.crf ?? defaultCrf);
  const maxBitrateK =
    spec.maxBitrateKbps ?? Math.round(spec.bitrateKbps * VBV_MAXRATE_MULTIPLIER);
  const bufSizeK = maxBitrateK * VBV_BUFSIZE_MULTIPLIER;

  switch (spec.codec) {
    case "h264":
      return [
        "-c:v", "libx264",
        "-preset", spec.speed ?? "medium",
        "-crf", crf(23),
        "-maxrate", `${maxBitrateK}k`,
        "-bufsize", `${bufSizeK}k`,
        "-profile:v", "high",
        "-level", "4.0",
        "-pix_fmt", "yuv420p",
      ];
    case "h265":
      return [
        "-c:v", "libx265",
        "-preset", spec.speed ?? "medium",
        "-crf", crf(28),
        "-pix_fmt", "yuv420p",
        // hvc1 tag is required for Safari/QuickTime to play HEVC inside MP4.
        "-tag:v", spec.tag ?? "hvc1",
      ];
    case "av1":
      return [
        "-c:v", "libsvtav1",
        // svt-av1 preset: 0 slowest/best quality, 13 fastest. 6 is a good web default.
        "-preset", spec.speed ?? "6",
        "-crf", crf(32),
        "-pix_fmt", "yuv420p",
      ];
    case "vp9":
      return [
        "-c:v", "libvpx-vp9",
        "-b:v", `${spec.bitrateKbps}k`,
        "-crf", crf(32),
        "-row-mt", "1",
        "-tile-columns", "2",
        "-pix_fmt", "yuv420p",
        "-deadline", spec.speed ?? "good",
        "-cpu-used", "2",
      ];
  }
}

function buildAudioCodecArgs(spec: OutputSpec, probe: ProbeResult): string[] {
  if (spec.dropAudio || probe.audios.length === 0) {
    return ["-an"];
  }
  switch (spec.container) {
    case "webm":
      return ["-c:a", "libopus", "-b:a", "96k"];
    case "mp4":
      return ["-c:a", "aac", "-b:a", "128k", "-ac", "2"];
  }
}

function buildContainerArgs(spec: OutputSpec): string[] {
  switch (spec.container) {
    case "mp4":
      return ["-movflags", "+faststart"];
    case "webm":
      return [];
  }
}

export interface PosterOptions {
  spec: PosterSpec;
  probe: ProbeResult;
}

export async function extractPoster(
  input: string,
  output: string,
  format: "jpg" | "webp",
  options: PosterOptions,
): Promise<void> {
  const { spec, probe } = options;
  const dur = probe.format.durationSec;
  const at = Math.max(0, Math.min(dur - POSTER_EOF_SAFETY_SEC, dur * spec.positionFraction));

  await withAtomicWrite(output, async (tempPath) => {
    const args: string[] = [
      ...FFMPEG_BASE_ARGS,
      "-ss",
      at.toFixed(3),
      "-i",
      input,
      "-frames:v",
      "1",
    ];

    if (spec.longestEdge != null) {
      args.push("-vf", buildLongestEdgeScale(spec.longestEdge));
    }

    if (format === "jpg") {
      args.push("-q:v", String(spec.jpegQ ?? 3));
    } else {
      args.push(
        "-c:v", "libwebp",
        "-quality", String(spec.webpQ ?? 82),
        "-compression_level", "6",
      );
    }

    args.push(tempPath);
    await run("ffmpeg", args);
  });
}

export interface PaletteGifOptions {
  spec: GifSpec;
  probe: ProbeResult;
}

/**
 * Fallback GIF builder using ffmpeg's palettegen/paletteuse two-pass.
 * Used when gifski is not installed.
 */
export async function buildGifWithPalette(
  input: string,
  output: string,
  options: PaletteGifOptions,
): Promise<void> {
  const { spec, probe } = options;

  const filterChain =
    `fps=${spec.fps},scale=${spec.width}:-2:flags=lanczos,split[a][b];` +
    `[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;

  await withAtomicWrite(output, async (tempPath) => {
    const args = [
      ...FFMPEG_BASE_ARGS,
      ...trimArgs(spec.durationSec, probe.format.durationSec),
      "-i",
      input,
      "-filter_complex",
      filterChain,
      "-loop",
      "0",
      tempPath,
    ];

    await run("ffmpeg", args);
  });
}
