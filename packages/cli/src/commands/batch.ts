import { readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { compressCommand } from "./compress.ts";
import { checkDeps, makeHas } from "../lib/deps.ts";
import { c, info, success, warn } from "../lib/log.ts";
import type { Encoder, PresetId } from "../types.ts";

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]);

export interface BatchOptions {
  preset: PresetId;
  outDir?: string | undefined;
  encoder?: Encoder | undefined;
  jsonMode?: boolean | undefined;
  progressFile?: string | undefined;
  force?: boolean | undefined;
}

export async function batchCommand(
  inputDir: string,
  options: BatchOptions,
): Promise<void> {
  const dirAbs = resolve(inputDir);
  const s = await stat(dirAbs);
  if (!s.isDirectory()) {
    throw new Error(`Not a directory: ${dirAbs}`);
  }

  const entries = await readdir(dirAbs, { withFileTypes: true });
  const videos = entries
    .filter((e) => e.isFile() && VIDEO_EXTS.has(extname(e.name).toLowerCase()))
    .map((e) => join(dirAbs, e.name))
    .sort();

  if (videos.length === 0) {
    warn(`No videos found in ${dirAbs}`);
    return;
  }

  info(`Batch: ${videos.length} file${videos.length === 1 ? "" : "s"} · preset ${c.cyan(options.preset)}`);

  const has = makeHas(await checkDeps());

  let ok = 0;
  for (const v of videos) {
    try {
      await compressCommand(v, {
        preset: options.preset,
        outDir: options.outDir,
        encoder: options.encoder,
        noSnippet: true,
        has,
        jsonMode: options.jsonMode,
        progressFile: options.progressFile,
        force: options.force,
      });
      ok += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${c.red("✗")} ${v}: ${msg}\n`);
    }
  }

  success(`Batch complete · ${ok}/${videos.length} succeeded.`);
}
