import { rename, unlink } from "node:fs/promises";

/**
 * Run `fn` with a temporary path that has `.partial` inserted before the final
 * extension (e.g. `clip.h264.mp4` → `clip.h264.partial.mp4`). On success,
 * atomically rename the partial to `finalPath`. On error, best-effort delete
 * the partial and rethrow.
 *
 * This is the durability seam for every encoder: a kill mid-encode (SIGTERM,
 * SIGKILL, parent agent exit) leaves a `.partial.<ext>` file the cache check
 * never sees, instead of a truncated `<final>` file that `statIfFresh` would
 * happily keep serving until `--force`.
 *
 * The extension is preserved because ffmpeg / gifski / HandBrake pick their
 * muxer from the output path's extension; appending `.partial` to the end
 * would defeat that detection.
 */
export async function withAtomicWrite<T>(
  finalPath: string,
  fn: (tempPath: string) => Promise<T>,
): Promise<T> {
  const tempPath = partialPath(finalPath);
  try {
    const result = await fn(tempPath);
    await rename(tempPath, finalPath);
    return result;
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}

function partialPath(finalPath: string): string {
  const match = finalPath.match(/^(.*)(\.[^./\\]+)$/);
  if (!match) return `${finalPath}.partial`;
  return `${match[1]}.partial${match[2]}`;
}
