import { mkdir, stat } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { probe } from "../lib/probe.ts";
import { checkDeps, makeHas } from "../lib/deps.ts";
import type { HasDep } from "../lib/deps.ts";
import { CommandError } from "../lib/exec.ts";
import { encodeVideo, extractPoster, buildGifWithPalette } from "../encoders/ffmpeg.ts";
import { buildGifWithGifski } from "../encoders/gifski.ts";
import { encodeWithHandbrake } from "../encoders/handbrake.ts";
import { applyOverrides, getPreset } from "../presets/web.ts";
import { c, formatBytes } from "../lib/log.ts";
import { JsonReporter, PrettyReporter, fileTap } from "../lib/reporter.ts";
import type { Reporter } from "../lib/reporter.ts";
import { writePreview } from "../lib/preview.ts";
import { VIDEO_SOURCE_ORDER, videoSourceLines } from "../lib/codec.ts";
import type {
  Codec,
  CompressedArtifact,
  Encoder,
  GifSpec,
  OutputSpec,
  PosterArtifact,
  PosterSpec,
  Preset,
  PresetId,
  PresetOverrides,
  ProbeResult,
  ProgressEvent,
  VideoArtifact,
} from "../types.ts";
import type { CompressResult } from "../types.ts";

const STDERR_TAIL_LINES = 20;

export interface CompressOptions {
  preset: PresetId;
  outDir?: string | undefined;
  encoder?: Encoder | undefined;
  noSnippet?: boolean | undefined;
  has?: HasDep | undefined;
  /** Emit NDJSON events to stdout instead of human pretty output. */
  jsonMode?: boolean | undefined;
  /** Tee every event to this file (works in either mode). */
  progressFile?: string | undefined;
  /** Re-encode every output even when an up-to-date version exists. */
  force?: boolean | undefined;
  /** Inject a custom reporter (used by batch). Overrides jsonMode/progressFile. */
  reporter?: Reporter | undefined;
  /**
   * Produce only the primary output of the preset (the first video output, or
   * the gif for gif-only presets), and skip posters + HTML preview. Output is
   * named `<basename>.optimized.<ext>` to make intent obvious to consumers.
   */
  single?: boolean | undefined;
  /**
   * Per-call adjustments to the preset (resize, codec filter, audio drop,
   * AV1 encoder pick). Applied before phases are built so cache lookups
   * remain correct.
   */
  overrides?: PresetOverrides | undefined;
  /**
   * Maximum number of phases to run concurrently. `1` preserves the original
   * sequential behavior. Defaults to `2`. Capped internally at
   * `os.cpus().length` to avoid oversubscription.
   */
  concurrency?: number | undefined;
}

interface VideoPhase {
  kind: "video";
  name: string;
  outPath: string;
  spec: OutputSpec;
  codec: OutputSpec["codec"];
  container: OutputSpec["container"];
}

interface PosterPhase {
  kind: "poster";
  name: string;
  outPath: string;
  spec: PosterSpec;
  posterFormat: "jpg" | "webp";
}

interface GifPhase {
  kind: "gif";
  name: string;
  outPath: string;
  spec: GifSpec;
}

type PhaseInfo = VideoPhase | PosterPhase | GifPhase;

export async function compressCommand(
  input: string,
  options: CompressOptions,
): Promise<CompressResult> {
  const inputAbs = resolve(input);
  const basePreset = getPreset(options.preset);
  const preset = options.overrides ? applyOverrides(basePreset, options.overrides) : basePreset;
  const probed = await probe(inputAbs);
  const inputStat = await stat(inputAbs);
  const baseName = basename(inputAbs, extname(inputAbs));
  const outDirAbs = resolve(
    options.outDir ?? join(dirname(inputAbs), "out", baseName),
  );
  await mkdir(outDirAbs, { recursive: true });

  const has = options.has ?? makeHas(await checkDeps());
  const encoderChoice: Encoder = options.encoder ?? "ffmpeg";
  const force = options.force ?? false;
  const jsonMode = options.jsonMode ?? false;
  const single = options.single ?? false;

  const reporter =
    options.reporter ??
    (jsonMode
      ? new JsonReporter(options.progressFile ? { tap: fileTap(options.progressFile) } : {})
      : new PrettyReporter(options.progressFile ? { tap: fileTap(options.progressFile) } : {}));

  const phases = buildPhases(preset, baseName, outDirAbs, single);
  const startedAt = Date.now();

  type StartPhase = Extract<ProgressEvent, { type: "start" }>["phases"][number];
  reporter.emit({
    type: "start",
    input: inputAbs,
    preset: preset.id,
    outDir: outDirAbs,
    inputSizeBytes: probed.format.sizeBytes,
    inputDurationSec: probed.format.durationSec,
    phases: phases.map((p): StartPhase =>
      p.kind === "video"
        ? { name: p.name, kind: p.kind, codec: p.codec, container: p.container }
        : { name: p.name, kind: p.kind },
    ),
  });

  const artifactSlots: Array<CompressedArtifact | null> = phases.map(() => null);
  const counters: SharedCounters = { phasesDone: 0, total: phases.length };
  let cachedPhases = 0;
  let encodedPhases = 0;
  const concurrencyCap = Math.max(1, cpus().length);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, concurrencyCap));

  const errors: { err: unknown; phase: PhaseInfo }[] = [];
  let bail = false;

  let nextIndex = 0;
  const workerCount = Math.min(concurrency, phases.length);
  const lanes: Promise<void>[] = [];
  for (let lane = 0; lane < workerCount; lane++) {
    lanes.push(
      (async () => {
        while (!bail) {
          const idx = nextIndex++;
          if (idx >= phases.length) return;
          const phase = phases[idx];
          if (!phase) return;
          try {
            const result = await runPhase({
              phase,
              input: inputAbs,
              probed,
              inputMtimeMs: inputStat.mtimeMs,
              force,
              encoderChoice,
              has,
              reporter,
              counters,
            });
            artifactSlots[idx] = result.artifact;
            if (result.cached) cachedPhases += 1;
            else encodedPhases += 1;
            counters.phasesDone += 1;

            if (
              result.artifact.kind === "video" &&
              result.artifact.sizeBytes > probed.format.sizeBytes
            ) {
              reporter.emit({
                type: "warning",
                message: `${result.artifact.codec}/${result.artifact.container} (${formatBytes(result.artifact.sizeBytes)}) is larger than the input (${formatBytes(probed.format.sizeBytes)}).`,
                codec: result.artifact.codec,
              });
            }
          } catch (err) {
            bail = true;
            errors.push({ err, phase });
            return;
          }
        }
      })(),
    );
  }

  await Promise.all(lanes);

  if (errors.length > 0) {
    const first = errors[0];
    if (!first) throw new Error("phase failed without recording an error"); // unreachable
    const { err, phase } = first;
    const errorEvent: Extract<ProgressEvent, { type: "error" }> = {
      type: "error",
      phase: phase.name,
      message: err instanceof Error ? err.message : String(err),
      stderrTail: err instanceof CommandError ? err.stderrTail(STDERR_TAIL_LINES) : "",
    };
    if (phase.kind === "video") errorEvent.codec = phase.codec;
    reporter.emit(errorEvent);
    await reporter.close();
    throw err;
  }

  const artifacts: CompressedArtifact[] = artifactSlots.filter(
    (a): a is CompressedArtifact => a != null,
  );

  let htmlPreviewPath: string | null = null;
  if (artifacts.length > 0 && !single) {
    htmlPreviewPath = await writePreview({
      outDir: outDirAbs,
      baseName,
      preset,
      artifacts,
      inputSizeBytes: probed.format.sizeBytes,
    });
  }

  const oversizedCodecs = artifacts
    .filter((a): a is VideoArtifact => a.kind === "video" && a.sizeBytes > probed.format.sizeBytes)
    .map((a) => a.codec);

  reporter.emit({
    type: "done",
    artifacts,
    durationMs: Date.now() - startedAt,
    htmlPreviewPath,
    oversizedCodecs,
    cachedPhases,
    encodedPhases,
  });

  if (!jsonMode && !options.reporter) {
    printSummary(probed, preset, artifacts, outDirAbs);
    if (htmlPreviewPath) {
      process.stdout.write(
        `\n${c.bold("Preview")}\n  ${c.dim("open")} ${c.cyan(htmlPreviewPath)}\n`,
      );
    }
    if (!options.noSnippet && artifacts.some((a) => a.kind === "video")) {
      printHtmlSnippet(baseName, preset, artifacts);
    }
  }

  await reporter.close();
  return { input: inputAbs, preset: preset.id, outDir: outDirAbs, artifacts };
}

function buildPhases(
  preset: Preset,
  baseName: string,
  outDir: string,
  single: boolean,
): PhaseInfo[] {
  if (single) return buildSinglePhase(preset, baseName, outDir);

  const phases: PhaseInfo[] = [];
  for (const out of preset.outputs) {
    phases.push({
      name: `${out.codec}/${out.container}`,
      kind: "video",
      outPath: join(outDir, `${baseName}.${out.suffix}.${out.container}`),
      codec: out.codec,
      container: out.container,
      spec: out,
    });
  }
  if (preset.poster) {
    for (const fmt of preset.poster.formats) {
      phases.push({
        name: `poster (${fmt})`,
        kind: "poster",
        outPath: join(outDir, `${baseName}.poster.${fmt}`),
        spec: preset.poster,
        posterFormat: fmt,
      });
    }
  }
  if (preset.gif) {
    phases.push({
      name: "gif",
      kind: "gif",
      outPath: join(outDir, `${baseName}.preview.gif`),
      spec: preset.gif,
    });
  }
  return phases;
}

/**
 * Single-output mode: pick the preset's primary deliverable (first video
 * output, or the gif for gif-only presets) and skip everything else —
 * posters, alternate codecs, HTML preview. The artifact name is
 * `<basename>.optimized.<ext>` so the intent reads cleanly to end users.
 */
function buildSinglePhase(preset: Preset, baseName: string, outDir: string): PhaseInfo[] {
  const primary = preset.outputs[0];
  if (primary) {
    return [
      {
        name: `${primary.codec}/${primary.container}`,
        kind: "video",
        outPath: join(outDir, `${baseName}.optimized.${primary.container}`),
        codec: primary.codec,
        container: primary.container,
        spec: primary,
      },
    ];
  }
  if (preset.gif) {
    return [
      {
        name: "gif",
        kind: "gif",
        outPath: join(outDir, `${baseName}.optimized.gif`),
        spec: preset.gif,
      },
    ];
  }
  throw new Error(`Preset ${preset.id} has no primary output to encode`);
}

interface SharedCounters {
  phasesDone: number;
  total: number;
}

interface RunPhaseArgs {
  phase: PhaseInfo;
  input: string;
  probed: ProbeResult;
  inputMtimeMs: number;
  force: boolean;
  encoderChoice: Encoder;
  has: HasDep;
  reporter: Reporter;
  counters: SharedCounters;
}

interface RunPhaseResult {
  artifact: CompressedArtifact;
  cached: boolean;
}

async function runPhase(args: RunPhaseArgs): Promise<RunPhaseResult> {
  const { phase, input, probed, inputMtimeMs, force, encoderChoice, has, reporter } = args;

  if (!force) {
    const cached = await statIfFresh(phase.outPath, inputMtimeMs);
    if (cached) {
      reporter.emit({
        type: "phase-done",
        phase: phase.name,
        sizeBytes: cached.size,
        path: phase.outPath,
        cached: true,
      });
      return { artifact: artifactFromPhase(phase, cached.size), cached: true };
    }
  }

  reporter.emit({ type: "phase-start", phase: phase.name });

  switch (phase.kind) {
    case "video":
      await runVideo(phase, args);
      break;
    case "poster":
      await runPoster(phase, input, probed);
      break;
    case "gif":
      await runGif(phase, input, probed, has, reporter);
      break;
  }

  const s = await stat(phase.outPath);
  reporter.emit({
    type: "phase-done",
    phase: phase.name,
    sizeBytes: s.size,
    path: phase.outPath,
    cached: false,
  });
  return { artifact: artifactFromPhase(phase, s.size), cached: false };
}

async function runVideo(phase: VideoPhase, args: RunPhaseArgs): Promise<void> {
  const { input, probed, encoderChoice, has, reporter, counters } = args;
  const totalSec = probed.format.durationSec;
  const resolved = resolveEncoder(encoderChoice, phase.codec, has);

  if (resolved.fallback) {
    reporter.emit({ type: "warning", message: resolved.fallback });
  }

  if (resolved.encoder === "handbrake") {
    await encodeWithHandbrake(input, phase.outPath, { spec: phase.spec, probe: probed });
    return;
  }

  await encodeVideo(input, phase.outPath, {
    spec: phase.spec,
    probe: probed,
    onProgress: (p) => {
      const pct = totalSec > 0 ? Math.min(100, Math.round((p.outSec / totalSec) * 100)) : 0;
      // Overall percentage is computed from the live shared counter so
      // parallel phases don't all report a stale snapshot from when their
      // phase started.
      const overallPct =
        counters.total > 0
          ? Math.round(((counters.phasesDone + pct / 100) / counters.total) * 100)
          : 0;
      reporter.emit({
        type: "progress",
        phase: phase.name,
        currentPct: pct,
        speedX: p.speed,
        overall: {
          phasesDone: counters.phasesDone,
          phasesTotal: counters.total,
          pct: overallPct,
        },
      });
    },
  });
}

async function runPoster(phase: PosterPhase, input: string, probed: ProbeResult): Promise<void> {
  await extractPoster(input, phase.outPath, phase.posterFormat, { spec: phase.spec, probe: probed });
}

async function runGif(
  phase: GifPhase,
  input: string,
  probed: ProbeResult,
  has: HasDep,
  reporter: Reporter,
): Promise<void> {
  const useGifski = has("gifski");
  if (!useGifski) {
    reporter.emit({
      type: "warning",
      message: "gifski not installed — falling back to ffmpeg palettegen (lower quality).",
    });
    await buildGifWithPalette(input, phase.outPath, { spec: phase.spec, probe: probed });
  } else {
    await buildGifWithGifski(input, phase.outPath, { spec: phase.spec, probe: probed });
  }
}

function artifactFromPhase(phase: PhaseInfo, sizeBytes: number): CompressedArtifact {
  switch (phase.kind) {
    case "video":
      return {
        kind: "video",
        path: phase.outPath,
        codec: phase.codec,
        container: phase.container,
        sizeBytes,
      };
    case "poster":
      return {
        kind: "poster",
        path: phase.outPath,
        format: phase.posterFormat,
        sizeBytes,
      };
    case "gif":
      return { kind: "gif", path: phase.outPath, sizeBytes };
  }
}

async function statIfFresh(
  outPath: string,
  inputMtimeMs: number,
): Promise<{ size: number } | null> {
  try {
    const s = await stat(outPath);
    if (s.size > 0 && s.mtimeMs > inputMtimeMs) return { size: s.size };
    return null;
  } catch {
    return null;
  }
}

function resolveEncoder(
  requested: Encoder,
  codec: Codec,
  has: HasDep,
): { encoder: Encoder; fallback?: string } {
  if (requested !== "handbrake") return { encoder: "ffmpeg" };
  if (codec !== "h264" && codec !== "h265") {
    // HandBrake doesn't speak AV1/VP9; ffmpeg silently takes those.
    return { encoder: "ffmpeg" };
  }
  if (!has("HandBrakeCLI")) {
    return { encoder: "ffmpeg", fallback: "HandBrakeCLI not installed — using ffmpeg." };
  }
  return { encoder: "handbrake" };
}

function printSummary(
  probed: ProbeResult,
  preset: Preset,
  artifacts: CompressedArtifact[],
  outDir: string,
): void {
  const inSize = probed.format.sizeBytes;
  process.stdout.write("\n" + c.bold("Outputs") + "\n");
  process.stdout.write(`  ${c.dim("input size")}  ${formatBytes(inSize)}\n`);
  process.stdout.write(`  ${c.dim("out dir   ")}  ${outDir}\n\n`);

  for (const a of artifacts) {
    const rel = relative(outDir, a.path);
    const ratio = inSize > 0 ? `${((a.sizeBytes / inSize) * 100).toFixed(1)}%` : "—";
    const tag = artifactTag(a);
    process.stdout.write(
      `  ${c.cyan(tag.padEnd(11))}  ${formatBytes(a.sizeBytes).padStart(9)}  ${c.dim(ratio.padStart(6) + " of input")}  ${c.dim(rel)}\n`,
    );
  }

  const oversized = artifacts.filter(
    (a): a is VideoArtifact => a.kind === "video" && a.sizeBytes > inSize,
  );
  if (oversized.length > 0) {
    const list = oversized.map((a) => `${a.codec}/${a.container}`).join(", ");
    process.stdout.write(
      "\n" +
        c.yellow("!") +
        " " +
        c.yellow(`${list} ended up larger than the input.`) +
        "\n" +
        c.dim(
          "  This usually means the input is already heavily compressed. The other codecs\n" +
          "  in the bundle (h265/AV1/VP9) typically still win — drop the oversized one(s)\n" +
          "  from your <video> sources, or re-run from a higher-bitrate master if you have one.\n",
        ),
    );
  }
}

function artifactTag(a: CompressedArtifact): string {
  switch (a.kind) {
    case "video":
      return `${a.codec}/${a.container}`;
    case "poster":
      return "poster";
    case "gif":
      return "gif";
  }
}

function printHtmlSnippet(
  baseName: string,
  preset: Preset,
  artifacts: CompressedArtifact[],
): void {
  const videos = artifacts.filter((a): a is VideoArtifact => a.kind === "video");
  if (videos.length === 0) return;

  const sorted = [...videos].sort(
    (a, b) => VIDEO_SOURCE_ORDER[a.codec] - VIDEO_SOURCE_ORDER[b.codec],
  );

  const poster = artifacts.find(
    (a): a is PosterArtifact => a.kind === "poster" && a.format === "jpg",
  );
  const attrs = preset.mutedAutoplay
    ? "autoplay muted loop playsinline"
    : "controls playsinline";

  process.stdout.write("\n" + c.bold("HTML snippet") + "\n");
  process.stdout.write(c.dim("  (relative paths — adjust to your asset host)\n\n"));
  const lines: string[] = [];
  lines.push(`<video ${attrs}${poster ? ` poster="${baseName}.poster.jpg"` : ""}>`);
  for (const line of videoSourceLines(sorted, { indent: "  " })) lines.push(line);
  lines.push("</video>");
  for (const l of lines) process.stdout.write("  " + l + "\n");
  process.stdout.write("\n");
}
