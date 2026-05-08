import { run } from "./exec.ts";
import type { ProbeResult, VideoStreamInfo, AudioStreamInfo } from "../types.ts";

interface RawStream {
  index: number;
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  channels?: number;
  sample_rate?: string;
  duration?: string;
}

interface RawFormat {
  filename: string;
  format_name: string;
  duration: string;
  size: string;
  bit_rate?: string;
}

interface RawProbe {
  streams: RawStream[];
  format: RawFormat;
}

export async function probe(filePath: string): Promise<ProbeResult> {
  const r = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  const parsed = parseFfprobe(r.stdout, filePath);
  const videoRaw = parsed.streams.find((s) => s.codec_type === "video");
  const audiosRaw = parsed.streams.filter((s) => s.codec_type === "audio");

  const video: VideoStreamInfo | null = videoRaw
    ? {
        index: videoRaw.index,
        codecName: videoRaw.codec_name,
        width: videoRaw.width ?? 0,
        height: videoRaw.height ?? 0,
        pixFmt: videoRaw.pix_fmt ?? null,
        rFrameRate: videoRaw.r_frame_rate ?? "0/1",
        bitRate: videoRaw.bit_rate ? Number(videoRaw.bit_rate) : null,
        durationSec: videoRaw.duration ? Number(videoRaw.duration) : null,
      }
    : null;

  const audios: AudioStreamInfo[] = audiosRaw.map((a) => ({
    index: a.index,
    codecName: a.codec_name,
    channels: a.channels ?? 0,
    sampleRate: a.sample_rate ? Number(a.sample_rate) : 0,
    bitRate: a.bit_rate ? Number(a.bit_rate) : null,
  }));

  return {
    format: {
      filename: parsed.format.filename,
      formatName: parsed.format.format_name,
      durationSec: Number(parsed.format.duration),
      sizeBytes: Number(parsed.format.size),
      bitRate: parsed.format.bit_rate ? Number(parsed.format.bit_rate) : null,
    },
    video,
    audios,
  };
}

function parseFfprobe(stdout: string, filePath: string): RawProbe {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error(`ffprobe returned non-JSON output for ${filePath}`);
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("streams" in raw) ||
    !Array.isArray((raw as { streams: unknown }).streams) ||
    !("format" in raw) ||
    typeof (raw as { format: unknown }).format !== "object"
  ) {
    throw new Error(`ffprobe output missing expected fields for ${filePath}`);
  }
  return raw as RawProbe;
}

export function fpsFromRational(r: string): number | null {
  const [num, den] = r.split("/").map(Number);
  if (!num || !den) return null;
  return num / den;
}
