import { resolve as resolvePath } from "node:path";
import { listVideos, formatBytes } from "./files.ts";
import { runVscJson } from "./vsc.ts";
import {
  clearRecentCompressions,
  lookupRecentTarget,
  openInDefaultViewer,
} from "./agent.ts";
import type { ProgressEvent } from "../types.ts";

/**
 * Slash commands run in the TUI without invoking Claude — same render
 * surface as agent-driven tool cards, but cheap and immediate. Anything the
 * user can describe in one short verb-noun should have one. The dispatcher
 * parses minimally and dispatches to existing helpers; never re-implement
 * encoding logic here.
 */

export type SlashKind =
  | "help"
  | "clear"
  | "list"
  | "presets"
  | "estimate"
  | "open"
  | "quit";

export interface SlashCommand {
  kind: SlashKind;
  args: string[];
  raw: string;
}

export interface PickerOption {
  key: string;
  label: string;
  payload: string;
}

export interface SlashOk {
  ok: true;
  /** Card name shown in the tool-card header. */
  card: string;
  /** Human-readable summary line under the card. */
  summary: string;
  /** Optional inline picker (numbered 1-9). */
  picker?: { kind: "files" | "presets"; options: PickerOption[] };
  /** Optional secondary lines to render inside the card. */
  details?: string[];
}

export interface SlashErr {
  ok: false;
  card: string;
  message: string;
}

export type SlashResult = SlashOk | SlashErr;

export interface SlashContext {
  cwd: string;
  /** Called when /clear runs so the caller can reset chat items + history. */
  onClear: () => void;
  /** Called when /quit runs. */
  onQuit: () => void;
  /** Forwarded to the tool-card progress slot for slash commands that emit live events (none today, but reserved). */
  emitProgress?: (event: ProgressEvent) => void;
}

const HELP_LINES = [
  "/help                                    show this list",
  "/list [dir]                              scan a directory for videos (numbered picker)",
  "/presets                                 list web delivery presets (numbered picker)",
  "/estimate <file> --preset <id> [--override k=v ...]   predict size + encode time",
  "/open <basename|path>                    open a recent compression (or any path) in the default viewer",
  "/clear                                   reset transcript and recent-work memory",
  "/quit                                    exit",
];

export function parseSlash(raw: string): SlashCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  if (!head) return null;
  const kind = matchKind(head);
  if (!kind) return null;
  return { kind, args: rest, raw: trimmed };
}

function matchKind(head: string): SlashKind | null {
  switch (head.toLowerCase()) {
    case "help":
    case "?":
      return "help";
    case "clear":
      return "clear";
    case "list":
    case "ls":
      return "list";
    case "presets":
      return "presets";
    case "estimate":
    case "est":
      return "estimate";
    case "open":
      return "open";
    case "quit":
    case "exit":
      return "quit";
    default:
      return null;
  }
}

export async function runSlash(
  cmd: SlashCommand,
  ctx: SlashContext,
): Promise<SlashResult> {
  switch (cmd.kind) {
    case "help":
      return {
        ok: true,
        card: "/help",
        summary: `${HELP_LINES.length} slash commands · type to use directly without invoking the agent`,
        details: HELP_LINES,
      };
    case "clear":
      ctx.onClear();
      clearRecentCompressions();
      return { ok: true, card: "/clear", summary: "transcript and recent-work memory cleared" };
    case "quit":
      ctx.onQuit();
      return { ok: true, card: "/quit", summary: "bye" };
    case "list":
      return runList(cmd.args, ctx);
    case "presets":
      return runPresets();
    case "estimate":
      return runEstimate(cmd.args);
    case "open":
      return runOpen(cmd.args);
  }
}

async function runList(args: string[], ctx: SlashContext): Promise<SlashResult> {
  const dir = args[0] ? resolvePath(args[0]) : ctx.cwd;
  try {
    const videos = await listVideos(dir);
    if (videos.length === 0) {
      return { ok: true, card: `/list ${dir}`, summary: "no videos found" };
    }
    const options: PickerOption[] = videos.slice(0, 9).map((v, i) => ({
      key: String(i + 1),
      label: `${v.name} · ${formatBytes(v.sizeBytes)}`,
      payload: v.path,
    }));
    const overflow = videos.length > 9 ? ` (+${videos.length - 9} more)` : "";
    return {
      ok: true,
      card: `/list ${dir}`,
      summary: `${videos.length} video${videos.length === 1 ? "" : "s"}${overflow} · press 1-9 to pick`,
      picker: { kind: "files", options },
    };
  } catch (err) {
    return { ok: false, card: `/list ${dir}`, message: err instanceof Error ? err.message : String(err) };
  }
}

interface PresetSummary {
  id: string;
  title: string;
  summary: string;
  codecs: string[];
  hasGif: boolean;
  maxEdge: number | null;
}

async function runPresets(): Promise<SlashResult> {
  try {
    const data = await runVscJson<{ presets: PresetSummary[] }>(["presets", "--json"]);
    const options: PickerOption[] = data.presets.slice(0, 9).map((p, i) => ({
      key: String(i + 1),
      label: `${p.id} · ${p.summary}`,
      payload: p.id,
    }));
    return {
      ok: true,
      card: "/presets",
      summary: `${data.presets.length} presets · press 1-9 to pick`,
      picker: { kind: "presets", options },
    };
  } catch (err) {
    return { ok: false, card: "/presets", message: err instanceof Error ? err.message : String(err) };
  }
}

interface EstimateResult {
  durationSec: number;
  totalBytes: number;
  totalSeconds: number;
  phases: Array<{
    name: string;
    encoder: string;
    estimatedSizeBytes: number;
    estimatedSeconds: number;
  }>;
}

interface ParsedEstimateArgs {
  file: string;
  preset: string;
  overrides: string[];
}

async function runEstimate(args: string[]): Promise<SlashResult> {
  const parsed = parseEstimateArgs(args);
  if ("error" in parsed) {
    return { ok: false, card: "/estimate", message: parsed.error };
  }
  const cliArgs = ["estimate", parsed.file, "--preset", parsed.preset];
  for (const o of parsed.overrides) cliArgs.push("--override", o);
  try {
    const data = await runVscJson<EstimateResult>(cliArgs);
    const details = data.phases.map(
      (p) =>
        `  ${p.name.padEnd(14)} ~${formatBytes(p.estimatedSizeBytes).padStart(9)}  ~${p.estimatedSeconds.toFixed(1)}s  (${p.encoder})`,
    );
    return {
      ok: true,
      card: `/estimate ${parsed.preset}`,
      summary: `~${formatBytes(data.totalBytes)} total · ~${data.totalSeconds.toFixed(0)}s encode · ${data.phases.length} phases`,
      details,
    };
  } catch (err) {
    return { ok: false, card: `/estimate ${parsed.preset}`, message: err instanceof Error ? err.message : String(err) };
  }
}

function parseEstimateArgs(
  args: string[],
): ParsedEstimateArgs | { error: string } {
  let file: string | null = null;
  let preset: string | null = null;
  const overrides: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a === "--preset" || a === "-p") {
      preset = args[++i] ?? null;
    } else if (a === "--override" || a === "-o") {
      const kv = args[++i];
      if (kv) overrides.push(kv);
    } else if (!a.startsWith("--") && file == null) {
      file = a;
    }
  }
  if (!file) return { error: "missing <file>. Usage: /estimate <file> --preset <id> [--override k=v ...]" };
  if (!preset) return { error: "missing --preset <id>. Run /presets to pick one." };
  return { file: resolvePath(file), preset, overrides };
}

async function runOpen(args: string[]): Promise<SlashResult> {
  const target = args[0];
  if (!target) {
    return { ok: false, card: "/open", message: "missing <basename|path>. Examples: /open hero.mp4 · /open /tmp/preview.html" };
  }
  const isPath = target.includes("/") || target.startsWith(".");
  const resolved = isPath ? resolvePath(target) : lookupRecentTarget({ basename: target });
  if (!resolved) {
    return { ok: false, card: `/open ${target}`, message: "no recent compression matching that basename. Pass an explicit path instead." };
  }
  try {
    await openInDefaultViewer(resolved);
    return { ok: true, card: `/open`, summary: `opened ${resolved}` };
  } catch (err) {
    return { ok: false, card: `/open`, message: err instanceof Error ? err.message : String(err) };
  }
}
