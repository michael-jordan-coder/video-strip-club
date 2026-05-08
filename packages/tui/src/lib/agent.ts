import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { listVideos, formatBytes, formatDuration } from "./files.ts";
import { findVscBin, probe, startEncode } from "./vsc.ts";
import type { CompressedArtifact, PresetId, ProgressEvent } from "../types.ts";

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

You have four tools:

- list_videos — find video files (.mp4, .mov, .mkv, .webm, .m4v, .avi). Always start here when the user references "this video" / "the video" / "my video" without naming a file.
- analyze_video — probe a specific file. Returns duration, resolution, size, audio presence. Run before recommending a preset.
- list_presets — get the four web delivery presets and their summaries. Reference them only by id once you've seen this list.
- compress_video — encode the video to ONE optimized file written to the user's current directory. Streams progress to the UI and returns the output path on completion.

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
- After compress_video returns, surface the htmlPreviewPath so the user can open it.
- Don't run raw ffmpeg or speculate about encoder internals. The CLI owns encoding strategy.
- If the user asks something off-topic, politely steer back to video encoding.

Always be willing to ask one short clarifying question when the input is genuinely ambiguous — better than guessing the wrong preset.`;

interface ToolFactoryArgs {
  cwd: string;
  subscriberRef: { current: AgentSubscriber | null };
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

export function createTools({ cwd, subscriberRef }: ToolFactoryArgs) {
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
    description: "List the four web delivery presets and what they're tuned for.",
    inputSchema: z.object({}),
    run: async () => {
      const id = makeId();
      const sub = subscriberRef.current;
      sub?.onToolStart(id, "list_presets", {});
      const presets = [
        {
          id: "web-hero-loop",
          summary: "Muted autoplay loop, 1080p, no audio. h264 + h265 + AV1 + VP9 + poster.",
        },
        {
          id: "web-hero-cinematic",
          summary: "Brand cinematic with audio, 1080p, all four codecs + poster.",
        },
        {
          id: "web-product-demo",
          summary: "Longer-form demo at 720p with audio. h264 + h265 + VP9 + poster.",
        },
        {
          id: "web-thumbnail-gif",
          summary: "480px looping GIF + poster, 12fps, 4s. Email/thumbnail.",
        },
      ];
      sub?.onToolEnd(id, "4 presets", false);
      return JSON.stringify(presets);
    },
  });

  const presetSchema = z.enum([
    "web-hero-loop",
    "web-hero-cinematic",
    "web-product-demo",
    "web-thumbnail-gif",
  ]);

  const compressTool = betaZodTool({
    name: "compress_video",
    description:
      "Encode a video to ONE optimized file using a preset. The file is written into the user's current directory as <basename>.optimized.<ext> and will be deleted when this TUI session ends — tell the user to copy or rename it if they want to keep it. Streams progress events live to the UI.",
    inputSchema: z.object({
      path: z.string().describe("Absolute or cwd-relative path to the video file."),
      preset: presetSchema.describe("Preset id to use."),
    }),
    run: async (input) => {
      const id = makeId();
      const sub = subscriberRef.current;
      sub?.onToolStart(id, "compress_video", input);
      return new Promise<string>((resolve, reject) => {
        startEncode(
          input.path,
          input.preset as PresetId,
          { outDir: cwd, single: true },
          (event) => {
            sub?.onToolProgress(id, event);
            if (event.type === "done") {
              const primary = event.artifacts[0];
              if (primary) sub?.onOutputCreated(primary.path);
              const summary = primary
                ? `done in ${Math.round(event.durationMs / 100) / 10}s · ${formatArtifact(primary)} → ${primary.path}`
                : `done in ${Math.round(event.durationMs / 100) / 10}s`;
              sub?.onToolEnd(id, summary, false);
              resolve(
                JSON.stringify({
                  outputPath: primary?.path ?? null,
                  sizeBytes: primary?.sizeBytes ?? null,
                  durationMs: event.durationMs,
                  oversizedCodecs: event.oversizedCodecs,
                  ephemeralReminder:
                    "This file will be deleted when the TUI session ends. The user should copy or rename it if they want to keep it.",
                }),
              );
            } else if (event.type === "error") {
              const message = `${event.phase}: ${event.message}`;
              sub?.onToolEnd(id, message, true);
              reject(new Error(message));
            }
          },
          (message) => {
            sub?.onToolEnd(id, message, true);
            reject(new Error(message));
          },
        );
      });
    },
  });

  return [listTool, analyzeTool, presetsTool, compressTool];
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
  const tools = createTools({ cwd, subscriberRef });

  const messages = [
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
