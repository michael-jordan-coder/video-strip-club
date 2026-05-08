import { basename } from "node:path";
import type { Codec, Container, VideoArtifact } from "../types.ts";

/**
 * Browsers walk <source> tags top-to-bottom and pick the first they can decode.
 * Modern → legacy gives the smallest payload to capable browsers.
 */
export const VIDEO_SOURCE_ORDER: Record<Codec, number> = {
  av1: 0,
  h265: 1,
  vp9: 2,
  h264: 3,
};

/**
 * Codec strings are unquoted: Chrome's <source type> matcher rejects
 * single-quoted codecs entirely, and unquoted is RFC 6381-permissive
 * and avoids any HTML-attribute quoting headaches.
 */
export function mimeFor(codec: Codec, container: Container): string {
  if (container === "webm") return `video/webm; codecs=vp9`;
  switch (codec) {
    case "h264":
      return `video/mp4; codecs=avc1.640028,mp4a.40.2`;
    case "h265":
      return `video/mp4; codecs=hvc1.1.6.L120.90`;
    case "av1":
      return `video/mp4; codecs=av01.0.05M.08`;
    case "vp9":
      return `video/mp4; codecs=vp09.00.10.08`;
  }
}

export interface VideoSourceLineOptions {
  indent: string;
  /** Escape function applied to filename + MIME — pass through identity in trusted contexts. */
  escape?: (s: string) => string;
}

/** One `<source ...>` line per video artifact, in source-pick order. */
export function videoSourceLines(
  sortedVideos: VideoArtifact[],
  options: VideoSourceLineOptions,
): string[] {
  const e = options.escape ?? ((s) => s);
  return sortedVideos.map(
    (v) =>
      `${options.indent}<source src="${e(basename(v.path))}" type="${e(mimeFor(v.codec, v.container))}" />`,
  );
}
