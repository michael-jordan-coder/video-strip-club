import { resolve } from "node:path";
import { probe } from "../lib/probe.ts";
import { applyOverrides, getPreset } from "../presets/web.ts";
import type {
  Codec,
  Container,
  PresetId,
  PresetOverrides,
} from "../types.ts";

const SCHEMA_VERSION = 1;

/**
 * Per-encoder realtime multiplier. `realtime > 1` means faster than realtime
 * (a 60s clip encodes in `60 / realtime` seconds). Values are conservative
 * single-thread estimates on a modern laptop CPU; actual numbers vary
 * substantially with content and `--concurrency`. The estimate is meant to
 * answer "is this 30 seconds or 30 minutes?", not predict to the second.
 */
const ENCODER_REALTIME: Record<string, number> = {
  libx264: 4.0,
  libx265: 1.5,
  libaom_av1: 0.15,
  libsvtav1: 1.2,
  libvpx_vp9: 0.6,
  poster: 50,
  gif: 0.5,
};

interface PhaseEstimate {
  name: string;
  kind: "video" | "poster" | "gif";
  codec?: Codec;
  container?: Container;
  encoder: string;
  estimatedSizeBytes: number;
  estimatedSeconds: number;
}

interface EstimateResult {
  schemaVersion: number;
  input: string;
  preset: PresetId;
  durationSec: number;
  inputSizeBytes: number;
  phases: PhaseEstimate[];
  totalBytes: number;
  totalSeconds: number;
}

export interface EstimateOptions {
  preset: PresetId;
  overrides?: PresetOverrides | undefined;
  json?: boolean | undefined;
}

export async function estimateCommand(
  input: string,
  options: EstimateOptions,
): Promise<EstimateResult> {
  const inputAbs = resolve(input);
  const basePreset = getPreset(options.preset);
  const preset = options.overrides ? applyOverrides(basePreset, options.overrides) : basePreset;
  const probed = await probe(inputAbs);
  const durationSec = probed.format.durationSec;

  const phases: PhaseEstimate[] = [];

  for (const out of preset.outputs) {
    const encoder = encoderForCodec(out.codec, out.av1Encoder);
    const realtime = ENCODER_REALTIME[encoder] ?? 1;
    phases.push({
      name: `${out.codec}/${out.container}`,
      kind: "video",
      codec: out.codec,
      container: out.container,
      encoder,
      estimatedSizeBytes: Math.round((out.bitrateKbps * 1000 * durationSec) / 8),
      estimatedSeconds: realtime > 0 ? durationSec / realtime : 0,
    });
  }
  if (preset.poster) {
    for (const fmt of preset.poster.formats) {
      phases.push({
        name: `poster (${fmt})`,
        kind: "poster",
        encoder: "poster",
        estimatedSizeBytes: posterSizeEstimate(fmt, preset.poster.longestEdge ?? 1920),
        estimatedSeconds: durationSec / (ENCODER_REALTIME["poster"] ?? 50),
      });
    }
  }
  if (preset.gif) {
    const gifSec = preset.gif.durationSec > 0 ? Math.min(preset.gif.durationSec, durationSec) : durationSec;
    phases.push({
      name: "gif",
      kind: "gif",
      encoder: "gif",
      estimatedSizeBytes: gifSizeEstimate(preset.gif.width, preset.gif.fps, gifSec, preset.gif.quality),
      estimatedSeconds: gifSec / (ENCODER_REALTIME["gif"] ?? 0.5),
    });
  }

  const totalBytes = phases.reduce((acc, p) => acc + p.estimatedSizeBytes, 0);
  const totalSeconds = phases.reduce((acc, p) => acc + p.estimatedSeconds, 0);

  const result: EstimateResult = {
    schemaVersion: SCHEMA_VERSION,
    input: inputAbs,
    preset: options.preset,
    durationSec,
    inputSizeBytes: probed.format.sizeBytes,
    phases,
    totalBytes,
    totalSeconds,
  };

  if (options.json !== false) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    printPretty(result);
  }
  return result;
}

function encoderForCodec(codec: Codec, av1Encoder: "svt" | "aom" | undefined): string {
  switch (codec) {
    case "h264":
      return "libx264";
    case "h265":
      return "libx265";
    case "av1":
      return av1Encoder === "aom" ? "libaom_av1" : "libsvtav1";
    case "vp9":
      return "libvpx_vp9";
  }
}

function posterSizeEstimate(format: "jpg" | "webp", longestEdge: number): number {
  const pixels = longestEdge * (longestEdge * 9) / 16;
  const bpp = format === "webp" ? 0.4 : 0.6;
  return Math.round((pixels * bpp) / 8);
}

function gifSizeEstimate(width: number, fps: number, durationSec: number, quality: number): number {
  const frames = Math.max(1, Math.round(fps * durationSec));
  const height = Math.round((width * 9) / 16);
  const bytesPerPixel = 0.6 * (quality / 100);
  return Math.round(frames * width * height * bytesPerPixel);
}

function printPretty(r: EstimateResult): void {
  process.stdout.write(`Estimate for ${r.input}\n`);
  process.stdout.write(`  preset: ${r.preset} · duration: ${r.durationSec.toFixed(1)}s · input: ${formatBytes(r.inputSizeBytes)}\n\n`);
  for (const p of r.phases) {
    process.stdout.write(
      `  ${p.name.padEnd(18)} ~${formatBytes(p.estimatedSizeBytes).padStart(8)}  ~${p.estimatedSeconds.toFixed(1)}s (${p.encoder})\n`,
    );
  }
  process.stdout.write(`\n  total ~${formatBytes(r.totalBytes)}  ~${r.totalSeconds.toFixed(1)}s\n`);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
