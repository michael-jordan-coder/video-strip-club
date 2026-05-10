import { spawn } from "node:child_process";
import { basename, resolve as resolvePath } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { listVideos, formatBytes, formatDuration } from "./files.ts";
import { probe, runVscJson, startEncode } from "./vsc.ts";
import type { EncodeHandle } from "./vsc.ts";
import type { CompressedArtifact, PresetId, ProgressEvent } from "../types.ts";

interface RecentEntry {
  input: string;
  preset: PresetId;
  primaryOutputPath: string | null;
  htmlPreviewPath: string | null;
  artifacts: CompressedArtifact[];
  cachedPhases: number;
  encodedPhases: number;
  durationMs: number;
  completedAt: number;
}

const RECENT_LIMIT = 5;
const recentCompressions = new Map<string, RecentEntry>();

function rememberCompression(entry: RecentEntry): void {
  const key = entry.input;
  recentCompressions.delete(key);
  recentCompressions.set(key, entry);
  while (recentCompressions.size > RECENT_LIMIT) {
    const oldest = recentCompressions.keys().next().value;
    if (oldest === undefined) break;
    recentCompressions.delete(oldest);
  }
}

function recentDigest(): string {
  if (recentCompressions.size === 0) return "";
  const entries = Array.from(recentCompressions.values()).map((e) => ({
    input: e.input,
    basename: basename(e.input),
    preset: e.preset,
    primaryOutputPath: e.primaryOutputPath,
    htmlPreviewPath: e.htmlPreviewPath,
    cachedPhases: e.cachedPhases,
    encodedPhases: e.encodedPhases,
    durationMs: e.durationMs,
  }));
  return JSON.stringify(entries);
}

/** Exposed for tests / debugging only — the agent should not call this. */
export function __resetRecentCompressionsForTests(): void {
  recentCompressions.clear();
}

/**
 * Clear the in-process recent-compressions map. Used by `/clear` slash
 * command to reset session state (transcript, history, recent work).
 */
export function clearRecentCompressions(): void {
  recentCompressions.clear();
}

/**
 * Look up a recent compression by basename or absolute path. Used by
 * `open_preview` and the `/open` slash command. Returns the preview path
 * if available, otherwise the primary output path; null if no match.
 */
export function lookupRecentTarget(input: { path?: string | undefined; basename?: string | undefined }): string | null {
  if (input.path) return input.path;
  if (input.basename) {
    const wanted = input.basename;
    const entries = Array.from(recentCompressions.values()).reverse();
    const match = entries.find((e) => basename(e.input) === wanted);
    if (match) return match.htmlPreviewPath ?? match.primaryOutputPath;
  }
  return null;
}

/**
 * Open a path in the user's default viewer using the platform-appropriate
 * launcher (xdg-open / open / start). Returns once the child has spawned;
 * does not wait for the viewer to close.
 */
export function openInDefaultViewer(path: string): Promise<void> {
  return openPath(path);
}

/**
 * The TUI subscribes to agent activity through this surface. Each tool's
 * `run` function pushes start / progress / end events synchronously so the
 * Ink layer renders live, even while the agent loop is awaiting a long
 * encode. Returned IDs are TUI-scoped, not Anthropic tool_use IDs — the
 * Tool Runner doesn't expose those to `run`.
 *
 * `onOutputCreated` lets the App track encoded files so it can sweep them
 * on session exit — outputs are intentionally ephemeral; users copy/rename
 * to keep them.
 */
export interface AgentSubscriber {
  onAssistantText(delta: string): void;
  onToolStart(id: string, name: string, input: unknown): void;
  onToolProgress(id: string, event: ProgressEvent): void;
  onToolEnd(id: string, summary: string, isError: boolean): void;
  onOutputCreated(path: string): void;
}

export interface AgentTurnResult {
  assistantText: string;
}

const MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT = `You are the video-strip-club encoding assistant — an interactive helper that compresses videos for web delivery using the local \`vsc\` CLI.

You are running inside a TUI on the user's machine. The cwd is the user's project root.

You have these tools:

- list_videos — find video files (.mp4, .mov, .mkv, .webm, .m4v, .avi). Always start here when the user references "this video" / "the video" / "my video" without naming a file.
- analyze_video — probe a specific file. Returns duration, resolution, size, audio presence. Run before recommending a preset.
- list_presets — get the available web delivery presets and their summaries (sourced from the CLI). Reference them only by id once you've seen this list.
- estimate_compression — predict output size and encode duration without encoding. Run this before compress_video on inputs longer than 30s, or whenever the user asks "how big will it be?" / "how long will it take?".
- compress_video — encode the video to ONE optimized file written to the user's current directory. Streams progress to the UI, automatically opens the output in the user's default viewer on success, and returns the output path on completion. Accepts an optional \`overrides\` object to tweak the preset (resize, drop audio, single codec, AV1 encoder choice).
- open_preview — open a previously-compressed file in the user's default viewer. Use this when the user asks "show me the result" / "open it" after a compression. Identify the artifact by \`path\` (returned by compress_video) or by \`basename\` (the input video's filename — looks up the matching entry from this session).

You will receive a "Recent compressions in this session" message at the start of every turn after the first compression. Use it to answer follow-up requests ("compress that one again at 720p") without re-running list_videos.

The output is one optimized file (no fallback codec bundle, no poster, no HTML preview). It is saved directly in the user's current directory and is **deleted automatically when the session ends** — so when reporting completion, tell the user to copy or rename the file if they want to keep it.

Decision rules for preset selection (apply in order):

1. User intent contains "thumbnail / preview / email / gif" → web-thumbnail-gif.
2. User intent contains "demo / walkthrough / tutorial / screen recording" → web-product-demo (ask if duration < 15s — product-demo is tuned for ≥ 30s).
3. User intent contains "hero / loop / banner / background" → web-hero-loop if no audio, else web-hero-cinematic.
4. Duration < 15s and no audio → web-hero-loop.
5. Duration < 15s and has audio → web-hero-cinematic.
6. Duration ≥ 30s → web-product-demo.
7. Duration 15–30s with audio → ask the user (hero-cinematic vs product-demo).

Style:
- Be concise. This is a TUI — every line costs vertical space.
- Announce your preset choice in one sentence ("Going with web-hero-cinematic — 12s clip with audio.") then encode.
- After compress_video returns, tell the user the output path, mention that it was opened automatically, and remind them the file is ephemeral. Single-file mode does not produce an HTML preview, so don't promise one.
- If cachedPhases > 0, mention it in one short clause ("3/4 reused from cache").
- Don't run raw ffmpeg or speculate about encoder internals. The CLI owns encoding strategy.
- If the user asks something off-topic, politely steer back to video encoding.

Always be willing to ask one short clarifying question when the input is genuinely ambiguous — better than guessing the wrong preset.`;

interface ToolFactoryArgs {
  cwd: string;
  subscriberRef: { current: AgentSubscriber | null };
  signal?: AbortSignal | undefined;
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function formatProbeSummary(p: {
  durationSec: number;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
}): string {
  const parts = [formatDuration(p.durationSec), formatBytes(p.sizeBytes)];
  if (p.width != null && p.height != null) parts.push(`${p.width}×${p.height}`);
  parts.push(p.hasAudio ? "with audio" : "no audio");
  return parts.join(" · ");
}

function formatArtifact(a: CompressedArtifact): string {
  if (a.kind === "video") return `${a.codec}/${a.container} ${formatBytes(a.sizeBytes)}`;
  if (a.kind === "poster") return `poster ${a.format} ${formatBytes(a.sizeBytes)}`;
  return `gif ${formatBytes(a.sizeBytes)}`;
}

export function createTools({ cwd, subscriberRef, signal }: ToolFactoryArgs) {
  const listTool = betaZodTool({
    name: "list_videos",
    description:
      "List video files (.mp4, .mov, .mkv, .webm, .m4v, .avi) in a directory. Defaults to the user's current working directory. Use this first when the user references a video without naming the file.",
    inputSchema: z.object({
      dir: z
        .string()
        .optional()
        .describe(
          "Absolute or cwd-relative directory to scan. Defaults to the user's current working directory.",
        ),
    }),
    run: async (input) => {
      const id = makeId();
      const sub = subscriberRef.current;
      const targetDir = input.dir ?? cwd;
      sub?.onToolStart(id, "list_videos", { dir: targetDir });
      try {
        const videos = await listVideos(targetDir);
        const result = JSON.stringify({
          dir: targetDir,
          videos: videos.map((v) => ({
            path: v.path,
            name: v.name,
            sizeBytes: v.sizeBytes,
            sizeHuman: formatBytes(v.sizeBytes),
          })),
        });
        const summary =
          videos.length === 0
            ? `no videos in ${targetDir}`
            : `${videos.length} video${videos.length === 1 ? "" : "s"}: ${videos.map((v) => `${v.name} (${formatBytes(v.sizeBytes)})`).join(", ")}`;
        sub?.onToolEnd(id, summary, false);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sub?.onToolEnd(id, message, true);
        throw err;
      }
    },
  });

  const analyzeTool = betaZodTool({
    name: "analyze_video",
    description:
      "Probe a video to learn its duration, resolution, size, and whether it has audio. Run this before recommending a preset.",
    inputSchema: z.object({
      path: z.string().describe("Absolute or cwd-relative path to the video file."),
    }),
    run: async (input) => {
      const id = makeId();
      const sub = subscriberRef.current;
      sub?.onToolStart(id, "analyze_video", input);
      try {
        const summary = await probe(input.path);
        const result = JSON.stringify({
          path: input.path,
          durationSec: summary.durationSec,
          sizeBytes: summary.sizeBytes,
          width: summary.width,
          height: summary.height,
          hasAudio: summary.hasAudio,
          videoCodec: summary.videoCodec,
        });
        sub?.onToolEnd(id, formatProbeSummary(summary), false);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sub?.onToolEnd(id, message, true);
        throw err;
      }
    },
  });

  const presetsTool = betaZodTool({
    name: "list_presets",
    description:
      "List the available web delivery presets and what each one is tuned for. The list is sourced from `vsc presets --json` so it always matches the CLI.",
    inputSchema: z.object({}),
    run: async () => {
      const id = makeId();
      const sub = subscriberRef.current;
      sub?.onToolStart(id, "list_presets", {});
      try {
        const data = await runVscJson<{
          schemaVersion: number;
          presets: Array<{
            id: string;
            title: string;
            summary: string;
            mutedAutoplay: boolean;
            codecs: string[];
            containers: string[];
            hasGif: boolean;
            hasPoster: boolean;
            maxEdge: number | null;
            audio: "preserved" | "dropped" | "mixed" | "n/a";
          }>;
        }>(["presets", "--json"]);
        sub?.onToolEnd(id, `${data.presets.length} presets`, false);
        return JSON.stringify(data.presets);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sub?.onToolEnd(id, message, true);
        throw err;
      }
    },
  });

  const presetSchema = z.enum([
    "web-hero-loop",
    "web-hero-cinematic",
    "web-product-demo",
    "web-thumbnail-gif",
  ]);

  const estimateOverridesSchema = z
    .object({
      maxEdge: z.number().int().positive().optional(),
      crf: z.number().positive().optional(),
      bitrateKbps: z.number().positive().optional(),
      dropAudio: z.boolean().optional(),
      singleCodec: z.enum(["h264", "h265", "av1", "vp9"]).optional(),
      av1Encoder: z.enum(["svt", "aom"]).optional(),
    })
    .optional();

  const estimateTool = betaZodTool({
    name: "estimate_compression",
    description:
      "Predict output sizes and encode duration for a preset without actually encoding. Use this before `compress_video` on long inputs (>30s) so the user can confirm scope before committing to the encode. Calls `vsc estimate --json`.",
    inputSchema: z.object({
      path: z.string().describe("Absolute or cwd-relative path to the video file."),
      preset: presetSchema.describe("Preset id to estimate."),
      overrides: estimateOverridesSchema,
    }),
    run: async (input) => {
      const id = makeId();
      const sub = subscriberRef.current;
      sub?.onToolStart(id, "estimate_compression", input);
      try {
        const args = ["estimate", input.path, "--preset", input.preset];
        if (input.overrides) {
          for (const [k, v] of Object.entries(input.overrides)) {
            if (v == null) continue;
            args.push("--override", `${k}=${String(v)}`);
          }
        }
        const data = await runVscJson<{
          schemaVersion: number;
          input: string;
          preset: string;
          durationSec: number;
          inputSizeBytes: number;
          totalBytes: number;
          totalSeconds: number;
          phases: Array<{
            name: string;
            kind: string;
            estimatedSizeBytes: number;
            estimatedSeconds: number;
            encoder: string;
          }>;
        }>(args);
        const summary = `~${formatBytes(data.totalBytes)} total · ~${Math.round(data.totalSeconds)}s encode (${data.phases.length} phases)`;
        sub?.onToolEnd(id, summary, false);
        return JSON.stringify(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sub?.onToolEnd(id, message, true);
        throw err;
      }
    },
  });

  const overridesSchema = z
    .object({
      maxEdge: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Resize the longer edge to this many pixels (keeps aspect)."),
      crf: z.number().positive().optional().describe("CRF/quality. Lower is better; encoder-specific scale."),
      bitrateKbps: z.number().positive().optional().describe("Target bitrate in kbps."),
      dropAudio: z.boolean().optional().describe("Drop audio entirely."),
      singleCodec: z
        .enum(["h264", "h265", "av1", "vp9"])
        .optional()
        .describe("Filter the preset's outputs to just this codec."),
      av1Encoder: z
        .enum(["svt", "aom"])
        .optional()
        .describe("Choose the AV1 encoder. 'svt' is much faster than 'aom'."),
    })
    .optional();

  const compressTool = betaZodTool({
    name: "compress_video",
    description:
      "Encode a video to ONE optimized file using a preset. The file is written into the user's current directory as <basename>.optimized.<ext>, automatically opened in the user's default viewer on success, and will be deleted when this TUI session ends — tell the user to copy or rename it if they want to keep it. Streams progress events live to the UI. Use `overrides` to adjust the preset (e.g. lower resolution, drop audio, pick a single codec) without switching presets.",
    inputSchema: z.object({
      path: z.string().describe("Absolute or cwd-relative path to the video file."),
      preset: presetSchema.describe("Preset id to use."),
      overrides: overridesSchema,
    }),
    run: async (input) => {
      const id = makeId();
      const sub = subscriberRef.current;
      sub?.onToolStart(id, "compress_video", input);
      return new Promise<string>((resolve, reject) => {
        if (signal?.aborted) {
          const message = "aborted";
          sub?.onToolEnd(id, message, true);
          reject(new Error(message));
          return;
        }
        const overrides = input.overrides ?? {};
        let handle: EncodeHandle | null = null;
        let settled = false;
        const settleReject = (message: string) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abortEncode);
          sub?.onToolEnd(id, message, true);
          reject(new Error(message));
        };
        const abortEncode = () => {
          handle?.abort();
          settleReject("aborted");
        };
        signal?.addEventListener("abort", abortEncode, { once: true });
        handle = startEncode(
          input.path,
          input.preset as PresetId,
          { outDir: cwd, single: true, overrides },
          (event) => {
            if (settled) return;
            sub?.onToolProgress(id, event);
            if (event.type === "done") {
              settled = true;
              signal?.removeEventListener("abort", abortEncode);
              void finishCompression({
                event,
                inputPath: input.path,
                preset: input.preset as PresetId,
                sub,
                toolId: id,
                resolve,
              });
            } else if (event.type === "error") {
              const message = `${event.phase}: ${event.message}`;
              settleReject(message);
            }
          },
          (message) => {
            settleReject(message);
          },
        );
      });
    },
  });

  const openPreviewTool = betaZodTool({
    name: "open_preview",
    description:
      "Open a previously-compressed output (or its HTML preview if available) in the user's default viewer. Use after a compress_video call when the user asks to see the result. Identify the artifact by `path` (an absolute path that compress_video returned) or by `basename` (the input video's basename — looks up the most recent matching compression in this session).",
    inputSchema: z.object({
      path: z.string().optional().describe("Absolute path to the file to open."),
      basename: z
        .string()
        .optional()
        .describe(
          "Basename of the input video (e.g. 'hero.mp4'). Looks up the most recent compression for that input.",
        ),
    }),
    run: async (input) => {
      const id = makeId();
      const sub = subscriberRef.current;
      sub?.onToolStart(id, "open_preview", input);
      const target = resolveOpenTarget(input);
      if (!target) {
        const message =
          "No matching compression. Provide an explicit `path`, or pass the basename of an input that was compressed in this session.";
        sub?.onToolEnd(id, message, true);
        throw new Error(message);
      }
      try {
        await openPath(target);
        sub?.onToolEnd(id, `opened ${target}`, false);
        return JSON.stringify({ opened: true, path: target });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sub?.onToolEnd(id, message, true);
        throw err;
      }
    },
  });

  return [listTool, analyzeTool, presetsTool, estimateTool, compressTool, openPreviewTool];
}

async function finishCompression({
  event,
  inputPath,
  preset,
  sub,
  toolId,
  resolve,
}: {
  event: Extract<ProgressEvent, { type: "done" }>;
  inputPath: string;
  preset: PresetId;
  sub: AgentSubscriber | null;
  toolId: string;
  resolve: (value: string) => void;
}): Promise<void> {
  const primary = event.artifacts[0];
  if (primary) sub?.onOutputCreated(primary.path);

  let autoOpen: { opened: boolean; error: string | null } = { opened: false, error: null };
  if (primary) {
    try {
      await openPath(primary.path);
      autoOpen = { opened: true, error: null };
    } catch (err) {
      autoOpen = {
        opened: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const total = event.cachedPhases + event.encodedPhases;
  const cacheNote =
    event.cachedPhases > 0 && total > 0
      ? ` · ${event.cachedPhases}/${total} reused from cache`
      : "";
  const openNote = autoOpen.opened
    ? " · opened"
    : autoOpen.error
      ? ` · auto-open failed: ${autoOpen.error}`
      : "";
  const summary = primary
    ? `done in ${Math.round(event.durationMs / 100) / 10}s · ${formatArtifact(primary)} → ${primary.path}${cacheNote}${openNote}`
    : `done in ${Math.round(event.durationMs / 100) / 10}s${cacheNote}`;

  sub?.onToolEnd(toolId, summary, false);
  rememberCompression({
    input: resolvePath(inputPath),
    preset,
    primaryOutputPath: primary?.path ?? null,
    htmlPreviewPath: event.htmlPreviewPath,
    artifacts: event.artifacts,
    cachedPhases: event.cachedPhases,
    encodedPhases: event.encodedPhases,
    durationMs: event.durationMs,
    completedAt: Date.now(),
  });
  resolve(
    JSON.stringify({
      outputPath: primary?.path ?? null,
      sizeBytes: primary?.sizeBytes ?? null,
      durationMs: event.durationMs,
      htmlPreviewPath: event.htmlPreviewPath,
      cachedPhases: event.cachedPhases,
      encodedPhases: event.encodedPhases,
      oversizedCodecs: event.oversizedCodecs,
      autoOpened: autoOpen.opened,
      autoOpenError: autoOpen.error,
      ephemeralReminder:
        "This file will be deleted when the TUI session ends. The user should copy or rename it if they want to keep it.",
    }),
  );
}

function resolveOpenTarget(input: { path?: string | undefined; basename?: string | undefined }): string | null {
  if (input.path) return input.path;
  if (input.basename) {
    const wanted = input.basename;
    const entries = Array.from(recentCompressions.values()).reverse();
    const match = entries.find((e) => basename(e.input) === wanted);
    if (match) return match.htmlPreviewPath ?? match.primaryOutputPath;
  }
  return null;
}

function openPath(path: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", path] : [path];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export interface RunTurnArgs {
  client: Anthropic;
  cwd: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userInput: string;
  subscriber: AgentSubscriber;
  signal?: AbortSignal;
}

/**
 * Run one turn of the agent: append the user's input to history, kick off
 * the Tool Runner with streaming, surface text deltas + tool activity to the
 * subscriber, and return the final assistant text so the caller can append
 * it to history for the next turn.
 *
 * Tool definitions, system prompt, and full message history are sent on
 * every turn — top-level `cache_control` lets the API serve everything
 * stable from cache, so only the new user turn is billed at full input rate.
 */
export async function runTurn({
  client,
  cwd,
  history,
  userInput,
  subscriber,
  signal,
}: RunTurnArgs): Promise<AgentTurnResult> {
  const subscriberRef: { current: AgentSubscriber | null } = { current: subscriber };
  const tools = createTools({ cwd, subscriberRef, signal });

  // Inject a separate "recent work" user-role turn so the model can refer to
  // prior compressions ("compress that one again at 720p") without re-running
  // list_videos. Kept out of SYSTEM_PROMPT so the cache prefix stays stable.
  const recentDigestStr = recentDigest();
  const recentTurns = recentDigestStr
    ? [
        {
          role: "user" as const,
          content: `Recent compressions in this session (most recent last):\n${recentDigestStr}`,
        },
        {
          role: "assistant" as const,
          content: "Acknowledged — I'll reference these by basename if you ask about them again.",
        },
      ]
    : [];

  const messages = [
    ...recentTurns,
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: userInput },
  ];

  let assistantText = "";

  const runner = client.beta.messages.toolRunner(
    {
      model: MODEL,
      max_tokens: 8192,
      system: `Working directory: ${cwd}\n\n${SYSTEM_PROMPT}`,
      tools,
      messages,
      cache_control: { type: "ephemeral" },
      stream: true,
    },
    signal ? { signal } : undefined,
  );

  for await (const messageStream of runner) {
    for await (const event of messageStream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        const delta = event.delta.text;
        assistantText += delta;
        subscriber.onAssistantText(delta);
      }
    }
  }

  return { assistantText };
}

export function createClient(): Anthropic {
  return new Anthropic();
}

export const AGENT_MODEL = MODEL;
