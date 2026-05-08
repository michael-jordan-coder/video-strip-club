import { webPresets } from "../presets/web.ts";
import { c } from "../lib/log.ts";

export function presetsCommand(): void {
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
