import { webPresets } from "../presets/web.ts";
import { c } from "../lib/log.ts";
import type { Codec, Container } from "../types.ts";

const SCHEMA_VERSION = 1;

interface PresetSummary {
  id: string;
  title: string;
  summary: string;
  mutedAutoplay: boolean;
  codecs: Codec[];
  containers: Container[];
  hasGif: boolean;
  hasPoster: boolean;
  maxEdge: number | null;
  audio: "preserved" | "dropped" | "mixed" | "n/a";
}

function summarize(): PresetSummary[] {
  return webPresets.map((p): PresetSummary => {
    const codecs = p.outputs.map((o) => o.codec);
    const containers = Array.from(new Set(p.outputs.map((o) => o.container)));
    const edges = p.outputs.map((o) => o.longestEdge ?? 0).filter((n) => n > 0);
    const maxEdge = edges.length > 0 ? Math.max(...edges) : (p.gif?.width ?? null);
    const audio = audioMode(p.outputs.map((o) => o.dropAudio));
    return {
      id: p.id,
      title: p.title,
      summary: p.summary,
      mutedAutoplay: p.mutedAutoplay,
      codecs,
      containers,
      hasGif: p.gif != null,
      hasPoster: p.poster != null,
      maxEdge,
      audio: p.outputs.length === 0 ? "n/a" : audio,
    };
  });
}

function audioMode(drops: boolean[]): "preserved" | "dropped" | "mixed" {
  if (drops.length === 0) return "dropped";
  const allDrop = drops.every((d) => d);
  const noneDrop = drops.every((d) => !d);
  if (allDrop) return "dropped";
  if (noneDrop) return "preserved";
  return "mixed";
}

export function presetsCommand(opts: { json?: boolean } = {}): void {
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, presets: summarize() }) + "\n",
    );
    return;
  }
  process.stdout.write(c.bold("Available presets\n\n"));
  for (const p of webPresets) {
    process.stdout.write(`  ${c.cyan(p.id)}  ${c.dim("·")} ${p.title}\n`);
    process.stdout.write(`    ${c.dim(p.summary)}\n`);
    if (p.outputs.length) {
      const codecs = p.outputs.map((o) => `${o.codec}/${o.container}`).join(", ");
      process.stdout.write(`    ${c.dim("outputs:")} ${codecs}\n`);
    }
    if (p.gif) {
      process.stdout.write(`    ${c.dim("gif:")} ${p.gif.width}px @ ${p.gif.fps}fps · ${p.gif.durationSec}s\n`);
    }
    if (p.poster) {
      process.stdout.write(`    ${c.dim("poster:")} ${p.poster.formats.join(" + ")} @ ${(p.poster.positionFraction * 100).toFixed(0)}%\n`);
    }
    process.stdout.write("\n");
  }
}
