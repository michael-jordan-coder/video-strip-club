import type { Codec, OutputSpec, Preset, PresetId, PresetOverrides } from "../types.ts";
import { PRESET_IDS } from "../types.ts";

/**
 * Capped-CRF web delivery presets.
 *
 * Strategy: CRF is the primary quality knob. `bitrateKbps` is used as a max-rate cap
 * for h264 (smooths out spikes for predictable streaming). h265, AV1, VP9 are CRF-driven.
 *
 * Browser support reference (2026):
 *  - h264 mp4 → universal fallback, autoplay-friendly
 *  - h265 mp4 (hvc1) → Safari (desktop+iOS), Edge, Chrome on supported HW
 *  - AV1 mp4 → Chrome, Firefox, Edge; Safari 17.4+ on supported HW
 *  - VP9 webm → Chrome, Firefox; not Safari
 *
 * Pick order in <video><source>: AV1 → h265 → VP9 webm → h264 mp4 (fallback).
 */
export const webPresets: Preset[] = [
  {
    id: "web-hero-loop",
    title: "Web hero — autoplay loop",
    summary: "Muted, autoplaying, looping background hero. 1080p, tight encode, no audio.",
    mutedAutoplay: true,
    outputs: [
      {
        suffix: "h264",
        codec: "h264",
        container: "mp4",
        bitrateKbps: 2000,
        crf: 26,
        longestEdge: 1920,
        dropAudio: true,
        speed: "medium",
      },
      {
        suffix: "h265",
        codec: "h265",
        container: "mp4",
        bitrateKbps: 1200,
        crf: 30,
        longestEdge: 1920,
        dropAudio: true,
        speed: "medium",
        tag: "hvc1",
      },
      {
        suffix: "av1",
        codec: "av1",
        container: "mp4",
        bitrateKbps: 900,
        crf: 35,
        longestEdge: 1920,
        dropAudio: true,
        speed: "6",
      },
      {
        suffix: "vp9",
        codec: "vp9",
        container: "webm",
        bitrateKbps: 1100,
        crf: 33,
        longestEdge: 1920,
        dropAudio: true,
        speed: "good",
      },
    ],
    poster: {
      positionFraction: 0.3,
      formats: ["jpg", "webp"],
      longestEdge: 1920,
      jpegQ: 3,
      webpQ: 82,
    },
  },
  {
    id: "web-hero-cinematic",
    title: "Web hero — cinematic with audio",
    summary: "Brand cinematic with audio. 1080p, higher bitrate budget, all four codecs.",
    mutedAutoplay: false,
    outputs: [
      {
        suffix: "h264",
        codec: "h264",
        container: "mp4",
        bitrateKbps: 4000,
        crf: 22,
        longestEdge: 1920,
        dropAudio: false,
        speed: "medium",
      },
      {
        suffix: "h265",
        codec: "h265",
        container: "mp4",
        bitrateKbps: 2500,
        crf: 26,
        longestEdge: 1920,
        dropAudio: false,
        speed: "medium",
        tag: "hvc1",
      },
      {
        suffix: "av1",
        codec: "av1",
        container: "mp4",
        bitrateKbps: 1800,
        crf: 30,
        longestEdge: 1920,
        dropAudio: false,
        speed: "6",
      },
      {
        suffix: "vp9",
        codec: "vp9",
        container: "webm",
        bitrateKbps: 2200,
        crf: 30,
        longestEdge: 1920,
        dropAudio: false,
        speed: "good",
      },
    ],
    poster: {
      positionFraction: 0.1,
      formats: ["jpg", "webp"],
      longestEdge: 1920,
      jpegQ: 2,
      webpQ: 85,
    },
  },
  {
    id: "web-product-demo",
    title: "Web product demo",
    summary: "Longer-form demo at 720p. h264 + h265 + VP9 (skips AV1 to keep encode time reasonable).",
    mutedAutoplay: false,
    outputs: [
      {
        suffix: "h264",
        codec: "h264",
        container: "mp4",
        bitrateKbps: 2200,
        crf: 23,
        longestEdge: 1280,
        dropAudio: false,
        speed: "medium",
      },
      {
        suffix: "h265",
        codec: "h265",
        container: "mp4",
        bitrateKbps: 1400,
        crf: 27,
        longestEdge: 1280,
        dropAudio: false,
        speed: "medium",
        tag: "hvc1",
      },
      {
        suffix: "vp9",
        codec: "vp9",
        container: "webm",
        bitrateKbps: 1500,
        crf: 32,
        longestEdge: 1280,
        dropAudio: false,
        speed: "good",
      },
    ],
    poster: {
      positionFraction: 0.1,
      formats: ["jpg", "webp"],
      longestEdge: 1280,
      jpegQ: 3,
      webpQ: 82,
    },
  },
  {
    id: "web-thumbnail-gif",
    title: "Web thumbnail — looping GIF",
    summary: "Small high-quality looping GIF preview for email, thumbnails, embeds. 480px wide, 12fps, 4s.",
    mutedAutoplay: true,
    outputs: [],
    gif: {
      width: 480,
      fps: 12,
      durationSec: 4,
      quality: 90,
    },
    poster: {
      positionFraction: 0.2,
      formats: ["jpg"],
      longestEdge: 480,
      jpegQ: 4,
    },
  },
];

export function getPreset(id: PresetId): Preset {
  const preset = webPresets.find((p) => p.id === id);
  if (!preset) {
    throw new Error(`Preset registered in PRESET_IDS but missing from webPresets: ${id}`);
  }
  return preset;
}

export function isPresetId(s: string): s is PresetId {
  return (PRESET_IDS as readonly string[]).includes(s);
}

export function listPresetIds(): readonly PresetId[] {
  return PRESET_IDS;
}

/**
 * Apply per-call overrides to a preset, returning a new `Preset` value (the
 * original is not mutated). Cache keys remain stable for the matching
 * configuration: changing `crf` or `maxEdge` produces a different file but
 * the path is preset-derived, so the cached check still compares mtimes
 * correctly. Callers should always run this *before* `buildPhases`.
 */
export function applyOverrides(preset: Preset, overrides: PresetOverrides): Preset {
  if (isEmptyOverrides(overrides)) return preset;
  const filteredOutputs = overrides.singleCodec
    ? preset.outputs.filter((o) => o.codec === overrides.singleCodec)
    : preset.outputs;
  if (overrides.singleCodec && filteredOutputs.length === 0) {
    throw new Error(
      `Preset ${preset.id} has no output for codec ${overrides.singleCodec} — singleCodec override has nothing to encode.`,
    );
  }
  const outputs = filteredOutputs.map((o) => applyOutputOverrides(o, overrides));
  return { ...preset, outputs };
}

function applyOutputOverrides(out: OutputSpec, overrides: PresetOverrides): OutputSpec {
  const next: OutputSpec = { ...out };
  if (overrides.maxEdge != null) next.longestEdge = overrides.maxEdge;
  if (overrides.crf != null) next.crf = overrides.crf;
  if (overrides.bitrateKbps != null) next.bitrateKbps = overrides.bitrateKbps;
  if (overrides.dropAudio != null) next.dropAudio = overrides.dropAudio;
  if (overrides.av1Encoder && out.codec === "av1") next.av1Encoder = overrides.av1Encoder;
  return next;
}

function isEmptyOverrides(o: PresetOverrides): boolean {
  return (
    o.maxEdge == null &&
    o.crf == null &&
    o.bitrateKbps == null &&
    o.dropAudio == null &&
    o.singleCodec == null &&
    o.av1Encoder == null
  );
}

const OVERRIDE_KEYS = [
  "maxEdge",
  "crf",
  "bitrateKbps",
  "dropAudio",
  "singleCodec",
  "av1Encoder",
] as const;
type OverrideKey = (typeof OVERRIDE_KEYS)[number];

const VALID_CODECS: readonly Codec[] = ["h264", "h265", "av1", "vp9"];
const VALID_AV1_ENCODERS = ["svt", "aom"] as const;

/**
 * Parse repeated `key=value` strings (from `--override key=value`) into a
 * typed `PresetOverrides`. Throws on unknown keys or malformed values so the
 * agent gets immediate feedback rather than silently mis-encoding.
 */
export function parseOverrideArgs(pairs: string[]): PresetOverrides {
  const out: PresetOverrides = {};
  for (const raw of pairs) {
    const eq = raw.indexOf("=");
    if (eq < 0) throw new Error(`Override must be key=value, got: ${raw}`);
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (!isOverrideKey(key)) {
      throw new Error(`Unknown override key '${key}'. Allowed: ${OVERRIDE_KEYS.join(", ")}`);
    }
    switch (key) {
      case "maxEdge":
      case "crf":
      case "bitrateKbps": {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`Override ${key} must be a positive number, got '${value}'`);
        out[key] = n;
        break;
      }
      case "dropAudio": {
        if (value === "true") out.dropAudio = true;
        else if (value === "false") out.dropAudio = false;
        else throw new Error(`Override dropAudio must be 'true' or 'false', got '${value}'`);
        break;
      }
      case "singleCodec": {
        if (!(VALID_CODECS as readonly string[]).includes(value)) {
          throw new Error(`Override singleCodec must be one of ${VALID_CODECS.join(", ")}, got '${value}'`);
        }
        out.singleCodec = value as Codec;
        break;
      }
      case "av1Encoder": {
        if (!(VALID_AV1_ENCODERS as readonly string[]).includes(value)) {
          throw new Error(`Override av1Encoder must be 'svt' or 'aom', got '${value}'`);
        }
        out.av1Encoder = value as "svt" | "aom";
        break;
      }
    }
  }
  return out;
}

function isOverrideKey(key: string): key is OverrideKey {
  return (OVERRIDE_KEYS as readonly string[]).includes(key);
}
