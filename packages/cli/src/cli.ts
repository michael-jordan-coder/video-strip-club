#!/usr/bin/env node
import { Command, Option } from "commander";
import { analyzeCommand } from "./commands/analyze.ts";
import { compressCommand } from "./commands/compress.ts";
import { batchCommand } from "./commands/batch.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { presetsCommand } from "./commands/presets.ts";
import { ENCODERS, PRESET_IDS } from "./types.ts";
import type { Encoder, PresetId } from "./types.ts";
import { error } from "./lib/log.ts";
import { CommandError } from "./lib/exec.ts";

const STDERR_TAIL_LINES = 20;

// Set by `--json`-aware action handlers before they delegate. The top-level
// catch reads this to decide whether to render a final error as a JSON line
// or as a stderr message — single source of truth, no argv re-scanning.
let jsonMode = false;

const program = new Command();

const presetOption = () =>
  new Option("-p, --preset <id>", "preset id")
    .choices(Array.from(PRESET_IDS))
    .makeOptionMandatory();

const encoderOption = () =>
  new Option("--encoder <name>", "force encoder for h264/h265 outputs")
    .choices(Array.from(ENCODERS))
    .default("ffmpeg");

program
  .name("vsc")
  .description("video-strip-club: open-source video optimization for web delivery")
  .version("0.1.0");

program
  .command("analyze <input>")
  .description("Print codec, resolution, duration, bitrate of a video.")
  .option("--json", "emit a single JSON object (ProbeResult shape)")
  .action(async (input: string, opts: { json?: boolean }) => {
    jsonMode = opts.json === true;
    await analyzeCommand(input, { jsonMode });
  });

program
  .command("compress <input>")
  .description("Compress a video using a web delivery preset.")
  .addOption(presetOption())
  .option("-o, --out-dir <dir>", "output directory (default: ./out/<basename>/)")
  .addOption(encoderOption())
  .option("--no-snippet", "skip the HTML <video> snippet output")
  .option("--json", "emit NDJSON progress events to stdout instead of pretty output")
  .option("--progress-file <path>", "tee NDJSON progress events to this file (works in either mode)")
  .option("--force", "re-encode every output even if an up-to-date version exists")
  .option("--single", "produce only the primary output (skip alternate codecs, posters, HTML preview); names the file <basename>.optimized.<ext>")
  .action(async (input: string, opts: {
    preset: PresetId;
    outDir?: string;
    encoder: Encoder;
    snippet?: boolean;
    json?: boolean;
    progressFile?: string;
    force?: boolean;
    single?: boolean;
  }) => {
    jsonMode = opts.json === true;
    await compressCommand(input, {
      preset: opts.preset,
      outDir: opts.outDir,
      encoder: opts.encoder,
      noSnippet: opts.snippet === false,
      jsonMode,
      progressFile: opts.progressFile,
      force: opts.force === true,
      single: opts.single === true,
    });
  });

program
  .command("batch <inputDir>")
  .description("Apply a preset to every video in a directory.")
  .addOption(presetOption())
  .option("-o, --out-dir <dir>", "shared output directory")
  .addOption(encoderOption())
  .option("--json", "emit NDJSON progress events to stdout for every input")
  .option("--progress-file <path>", "tee NDJSON progress events to this file")
  .option("--force", "re-encode every output even if an up-to-date version exists")
  .action(async (inputDir: string, opts: {
    preset: PresetId;
    outDir?: string;
    encoder: Encoder;
    json?: boolean;
    progressFile?: string;
    force?: boolean;
  }) => {
    jsonMode = opts.json === true;
    await batchCommand(inputDir, {
      preset: opts.preset,
      outDir: opts.outDir,
      encoder: opts.encoder,
      jsonMode,
      progressFile: opts.progressFile,
      force: opts.force === true,
    });
  });

program
  .command("presets")
  .description("List available web delivery presets.")
  .action(() => {
    presetsCommand();
  });

program
  .command("doctor")
  .description("Check that all required CLI tools are installed.")
  .action(async () => {
    const code = await doctorCommand();
    process.exit(code);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (jsonMode) {
    const stderrTail = err instanceof CommandError ? err.stderrTail(STDERR_TAIL_LINES) : "";
    process.stdout.write(
      JSON.stringify({ type: "error", phase: "preflight", message: msg, stderrTail }) + "\n",
    );
  } else {
    error(msg);
  }
  process.exit(1);
});
