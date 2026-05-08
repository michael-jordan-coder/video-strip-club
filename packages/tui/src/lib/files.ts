import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);

export interface VideoFile {
  name: string;
  path: string;
  sizeBytes: number;
}

export async function listVideos(dir: string): Promise<VideoFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const candidates: VideoFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const path = join(dir, entry.name);
    const s = await stat(path);
    candidates.push({ name: entry.name, path, sizeBytes: s.size });
  }
  candidates.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return candidates;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}m ${s}s`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return formatDuration(ms / 1000);
}
