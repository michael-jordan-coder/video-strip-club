import { run } from "../lib/exec.ts";
import { withAtomicWrite } from "../lib/atomic.ts";
import type { OutputSpec, ProbeResult } from "../types.ts";

export interface HandbrakeEncodeOptions {
  spec: OutputSpec;
  probe: ProbeResult;
}

/**
 * Optional alternative HEVC/H.264 encoder via HandBrakeCLI.
 * Not used by the default web presets — exposed via `--encoder handbrake`
 * for users who prefer HandBrake's defaults for archival quality.
 */
export async function encodeWithHandbrake(
  input: string,
  output: string,
  options: HandbrakeEncodeOptions,
): Promise<void> {
  const { spec } = options;

  await withAtomicWrite(output, async (tempPath) => {
    const args: string[] = ["-i", input, "-o", tempPath];

    switch (spec.codec) {
      case "h264":
        args.push("-e", "x264", "-q", String(spec.crf ?? 22));
        break;
      case "h265":
        args.push("-e", "x265", "-q", String(spec.crf ?? 24));
        break;
      case "av1":
      case "vp9":
        throw new Error(
          `HandBrake encoder only supports h264 and h265 in this CLI; got ${spec.codec}`,
        );
    }

    if (spec.longestEdge != null) {
      args.push("--maxWidth", String(spec.longestEdge), "--maxHeight", String(spec.longestEdge));
    }
    if (spec.maxFps != null) {
      args.push("-r", String(spec.maxFps), "--pfr");
    }
    if (spec.dropAudio) {
      args.push("--audio", "none");
    } else {
      args.push("-E", "ca_aac", "-B", "128");
    }

    args.push("--optimize"); // moov atom at front (mp4 faststart equivalent)

    await run("HandBrakeCLI", args);
  });
}
