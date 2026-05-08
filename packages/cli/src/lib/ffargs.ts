/**
 * Shared ffmpeg argument helpers used by every encoder module.
 * Keeping these in one place avoids subtle drift between encoders
 * (e.g. one path adds `-stats` and another forgets it).
 */

export const FFMPEG_BASE_ARGS: readonly string[] = [
  "-y",
  "-hide_banner",
  "-loglevel",
  "error",
];

/**
 * Constrains the longest edge of the video to N pixels, preserving aspect
 * ratio and forcing even dimensions (required by yuv420p in libx264/x265).
 * Won't upscale: `min(N, iw/ih)` keeps the smaller of source size and N.
 */
export function buildLongestEdgeScale(longestEdge: number): string {
  const N = longestEdge;
  return `scale='if(gt(iw,ih),min(${N},iw),-2)':'if(gt(iw,ih),-2,min(${N},ih))'`;
}

/**
 * Returns ffmpeg `-t <sec>` args when the GIF/preview spec requests a trim
 * shorter than the source duration. Empty array when no trim is needed.
 */
export function trimArgs(durationSec: number, sourceDurationSec: number): string[] {
  return durationSec > 0 && durationSec < sourceDurationSec
    ? ["-t", String(durationSec)]
    : [];
}
