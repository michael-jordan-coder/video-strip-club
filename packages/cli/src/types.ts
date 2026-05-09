export type Codec = "h264" | "h265" | "av1" | "vp9";

export type Container = "mp4" | "webm";

export const ENCODERS = ["ffmpeg", "handbrake"] as const;
export type Encoder = typeof ENCODERS[number];

export const PRESET_IDS = [
  "web-hero-loop",
  "web-hero-cinematic",
  "web-product-demo",
  "web-thumbnail-gif",
] as const;
export type PresetId = typeof PRESET_IDS[number];

export interface VideoStreamInfo {
  index: number;
  codecName: string;
  width: number;
  height: number;
  pixFmt: string | null;
  rFrameRate: string;
  bitRate: number | null;
  durationSec: number | null;
}

export interface AudioStreamInfo {
  index: number;
  codecName: string;
  channels: number;
  sampleRate: number;
  bitRate: number | null;
}

export interface ProbeResult {
  format: {
    filename: string;
    formatName: string;
    durationSec: number;
    sizeBytes: number;
    bitRate: number | null;
  };
  video: VideoStreamInfo | null;
  audios: AudioStreamInfo[];
}

export interface OutputSpec {
  /** Suffix appended before the extension, e.g. "h264" → name.h264.mp4 */
  suffix: string;
  codec: Codec;
  container: Container;
  /** Mean bitrate in kbps. Used for VBR target. */
  bitrateKbps: number;
  /** Optional max bitrate cap for VBR (kbps). */
  maxBitrateKbps?: number;
  /** CRF/quality. Lower is better quality. Tool-specific scale. */
  crf?: number;
  /** Resize the longer edge to this many pixels (keeps aspect). */
  longestEdge?: number;
  /** Cap framerate. */
  maxFps?: number;
  /** Drop audio entirely. */
  dropAudio: boolean;
  /** Preset speed (encoder-specific). */
  speed?: string;
  /** Tag for compatibility (e.g. hvc1 for HEVC in Safari). */
  tag?: string;
  /**
   * Choose the AV1 encoder when `codec === "av1"`. `svt` is libsvtav1 (fast,
   * default when available); `aom` is libaom-av1 (reference, slow). Ignored
   * for non-AV1 codecs.
   */
  av1Encoder?: "svt" | "aom";
}

export interface PosterSpec {
  /** Fraction of duration where to grab the frame, 0..1. */
  positionFraction: number;
  /** Output formats to generate. */
  formats: Array<"jpg" | "webp">;
  /** Resize the longer edge of the poster. */
  longestEdge?: number;
  /** JPEG quality 1..31 (ffmpeg -q:v scale, lower is better). */
  jpegQ?: number;
  /** WebP quality 0..100 (higher is better). */
  webpQ?: number;
}

export interface GifSpec {
  /** Loopable preview width in px. */
  width: number;
  /** Frames per second of GIF. */
  fps: number;
  /** Trim to this many seconds from start. 0 = full duration. */
  durationSec: number;
  /** gifski quality 1..100. */
  quality: number;
}

export interface Preset {
  id: PresetId;
  title: string;
  summary: string;
  /** When true, the preset is intended for muted autoplay (no audio). */
  mutedAutoplay: boolean;
  outputs: OutputSpec[];
  poster?: PosterSpec;
  gif?: GifSpec;
}

/**
 * Per-call adjustments layered on top of a chosen preset. Lets the agent
 * iterate on a preset without us shipping a new entry in `web.ts` for every
 * variant ("compress at 720p", "drop audio", "h264 only").
 *
 * `singleCodec` filters `preset.outputs` to that codec only — orthogonal to
 * the existing `--single` flag, which always picks the preset's primary
 * output. Use `--override singleCodec=h264` when you want a one-codec bundle
 * (still produces poster + HTML preview); use `--single` when you want the
 * single-file no-extras shape.
 */
export interface PresetOverrides {
  maxEdge?: number;
  crf?: number;
  bitrateKbps?: number;
  dropAudio?: boolean;
  singleCodec?: Codec;
  /**
   * Choose between the SVT-AV1 (fast) and libaom (reference) AV1 encoders.
   * Only applies to AV1 outputs. Defaults to `svt` when SVT-AV1 is detected
   * by `vsc doctor`, otherwise `aom`.
   */
  av1Encoder?: "svt" | "aom";
}

export interface VideoArtifact {
  kind: "video";
  path: string;
  codec: Codec;
  container: Container;
  sizeBytes: number;
}

export interface PosterArtifact {
  kind: "poster";
  path: string;
  format: "jpg" | "webp";
  sizeBytes: number;
}

export interface GifArtifact {
  kind: "gif";
  path: string;
  sizeBytes: number;
}

export type CompressedArtifact = VideoArtifact | PosterArtifact | GifArtifact;

export interface CompressResult {
  input: string;
  preset: PresetId;
  outDir: string;
  artifacts: CompressedArtifact[];
}

/**
 * NDJSON progress events emitted during `vsc compress`.
 *
 * The Reporter abstraction (`src/lib/reporter.ts`) translates these into either
 * human spinner output (PrettyReporter) or one-event-per-line JSON to stdout
 * (JsonReporter). The agent uses the JSON form via Monitor on a backgrounded
 * `vsc compress --json` invocation.
 */
export type ProgressEvent =
  | {
      type: "start";
      input: string;
      preset: PresetId;
      outDir: string;
      inputSizeBytes: number;
      inputDurationSec: number;
      phases: Array<{ name: string; codec?: Codec; container?: Container; kind: "video" | "poster" | "gif" }>;
    }
  | { type: "phase-start"; phase: string }
  | {
      type: "progress";
      phase: string;
      currentPct: number;
      speedX: number | null;
      overall: { phasesDone: number; phasesTotal: number; pct: number };
    }
  | {
      type: "phase-done";
      phase: string;
      sizeBytes: number;
      path: string;
      cached: boolean;
    }
  | { type: "warning"; message: string; codec?: Codec }
  | {
      type: "done";
      artifacts: CompressedArtifact[];
      durationMs: number;
      htmlPreviewPath: string | null;
      oversizedCodecs: Codec[];
      /**
       * Number of phases satisfied from the on-disk cache (input mtime older
       * than output mtime, no re-encode performed). Aggregated from each
       * `phase-done.cached` boolean.
       */
      cachedPhases: number;
      /** Number of phases that ran the encoder. */
      encodedPhases: number;
    }
  | {
      type: "error";
      phase: string;
      codec?: Codec;
      message: string;
      stderrTail: string;
    };
