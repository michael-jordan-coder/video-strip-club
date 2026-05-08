import { resolve } from "node:path";
import { probe, fpsFromRational } from "../lib/probe.ts";
import { c, formatBytes, formatDuration } from "../lib/log.ts";

export interface AnalyzeOptions {
  jsonMode?: boolean | undefined;
}

export async function analyzeCommand(input: string, options: AnalyzeOptions = {}): Promise<void> {
  const abs = resolve(input);
  const result = await probe(abs);

  if (options.jsonMode) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  const lines: string[] = [];
  lines.push(c.bold(result.format.filename));
  lines.push(
    `  ${c.dim("format")}    ${result.format.formatName}` +
      `   ${c.dim("size")} ${formatBytes(result.format.sizeBytes)}` +
      `   ${c.dim("dur")} ${formatDuration(result.format.durationSec)}` +
      (result.format.bitRate
        ? `   ${c.dim("avg br")} ${(result.format.bitRate / 1000).toFixed(0)} kbps`
        : ""),
  );

  if (result.video) {
    const v = result.video;
    const fps = fpsFromRational(v.rFrameRate);
    const fpsLabel = fps != null ? `${fps.toFixed(2)} fps` : "? fps";
    lines.push(
      `  ${c.dim("video")}     ${c.cyan(v.codecName)}  ${v.width}x${v.height}  ${fpsLabel}` +
        `   ${c.dim("pix_fmt")} ${v.pixFmt ?? "?"}` +
        (v.bitRate ? `   ${c.dim("br")} ${(v.bitRate / 1000).toFixed(0)} kbps` : ""),
    );
  } else {
    lines.push(`  ${c.dim("video")}     ${c.yellow("no video stream")}`);
  }

  if (result.audios.length === 0) {
    lines.push(`  ${c.dim("audio")}     ${c.dim("none")}`);
  } else {
    for (const a of result.audios) {
      lines.push(
        `  ${c.dim("audio")}     ${c.cyan(a.codecName)}  ${a.channels}ch  ${a.sampleRate} Hz` +
          (a.bitRate ? `   ${c.dim("br")} ${(a.bitRate / 1000).toFixed(0)} kbps` : ""),
      );
    }
  }

  process.stdout.write(lines.join("\n") + "\n");
}
