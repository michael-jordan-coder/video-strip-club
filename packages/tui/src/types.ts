/**
 * Subset of the @vsc/cli ProgressEvent + Preset types, mirrored here as the
 * NDJSON wire contract.
 *
 * Kept narrow on purpose: the TUI only consumes events emitted on stdout,
 * and refers to presets by id. When a third consumer joins (e.g. the web
 * frontend) these types should move to a shared @vsc/core package.
 */

export const PRESET_IDS = [
  "web-hero-loop",
  "web-hero-cinematic",
  "web-product-demo",
  "web-thumbnail-gif",
] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export type Codec = "h264" | "h265" | "av1" | "vp9";
export type Container = "mp4" | "webm";

export interface ProbeResult {
  format: {
    filename: string;
    formatName: string;
    durationSec: number;
    sizeBytes: number;
    bitRate: number | null;
  };
  video: {
    width: number;
    height: number;
    codecName: string;
  } | null;
  audios: Array<{ codecName: string; channels: number }>;
}

export type CompressedArtifact =
  | { kind: "video"; path: string; codec: Codec; container: Container; sizeBytes: number }
  | { kind: "poster"; path: string; format: "jpg" | "webp"; sizeBytes: number }
  | { kind: "gif"; path: string; sizeBytes: number };

export type ProgressEvent =
  | {
      type: "start";
      input: string;
      preset: PresetId;
      outDir: string;
      inputSizeBytes: number;
      inputDurationSec: number;
      phases: Array<{ name: string; kind: "video" | "poster" | "gif" }>;
    }
  | { type: "phase-start"; phase: string }
  | {
      type: "progress";
      phase: string;
      currentPct: number;
      speedX: number | null;
      overall: { phasesDone: number; phasesTotal: number; pct: number };
    }
  | { type: "phase-done"; phase: string; sizeBytes: number; path: string; cached: boolean }
  | { type: "warning"; message: string }
  | {
      type: "done";
      artifacts: CompressedArtifact[];
      durationMs: number;
      htmlPreviewPath: string | null;
      oversizedCodecs: Codec[];
    }
  | { type: "error"; phase: string; message: string; stderrTail: string };
