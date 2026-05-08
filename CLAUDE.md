# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo shape

This is an npm-workspaces monorepo (`workspaces: ["packages/*"]`). Packages today:

- `@vsc/cli` at `packages/cli/` — the encoding engine (commander CLI, NDJSON event stream, ffmpeg/HandBrake/gifski wrappers).
- `@vsc/tui` at `packages/tui/` — Ink TUI that embeds the Claude Agent SDK (`@anthropic-ai/sdk` + `betaZodTool` + `client.beta.messages.toolRunner` with `stream: true`). The user types natural language; Claude calls vsc-shaped tools (`list_videos`, `analyze_video`, `list_presets`, `compress_video`) which spawn `@vsc/cli` as subprocesses and stream NDJSON events back into React state.

Run `npm install` from the repo root to bootstrap; npm hoists shared deps and symlinks both bins (`node_modules/.bin/vsc`, `node_modules/.bin/vsc-ui`).

`@vsc/tui` requires `ANTHROPIC_API_KEY` in the environment — the SDK reads it via the default `new Anthropic()` constructor. The TUI surfaces a clean error screen at startup if the var is missing.

### Agent + caching strategy in `@vsc/tui`

- Model: `claude-haiku-4-5` (low latency for an interactive chat surface; tool calls here are simple enum/file picks).
- Caching: top-level `cache_control: {type: "ephemeral"}` on every `toolRunner` call lets the API auto-cache the system prompt + tool definitions. Don't interpolate per-request volatile content (timestamps, UUIDs) into the system prompt — it would silently invalidate the cache prefix. The cwd lives there because it's stable across a session.
- Conversation history is text-only (`{role, content: string}` pairs) — within-turn tool_use/tool_result roundtrips are handled by the runner; we don't reconstruct them across turns.
- Tools push live state to React via an `AgentSubscriber` ref (`onToolStart` / `onToolProgress` / `onToolEnd`). The `compress_video` tool's `run` returns a Promise that resolves on the `done` event so the agent loop properly awaits encoding.

The TUI duplicates a small subset of `@vsc/cli`'s wire types (`PresetId`, `ProgressEvent`, etc.) at `packages/tui/src/types.ts`. When a third consumer (e.g. a web frontend) appears, extract those types into a shared `@vsc/core` package — the TUI's `types.ts` has a comment marking the boundary.

## Commands

```bash
npm install              # bootstrap (run from repo root)
npm run typecheck        # delegates to all workspaces' typecheck scripts
npm run vsc -- <args>    # delegates to @vsc/cli's vsc script
./node_modules/.bin/vsc doctor         # verify ffmpeg/ffprobe/HandBrake/gifski/svt-av1 presence
./node_modules/.bin/vsc presets        # list valid preset IDs
./node_modules/.bin/vsc analyze <file> [--json]
./node_modules/.bin/vsc compress <file> --preset <id> [--json] [--progress-file <path>] [--force] [--out-dir <dir>]
./node_modules/.bin/vsc batch <dir>   --preset <id> [--json] [--force]
```

There is no test runner and no lint config. `tsc --noEmit` is the gate. Strict TS is enforced (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`) — match those constraints when editing.

Module resolution is ESM with `allowImportingTsExtensions`: imports use explicit `.ts` extensions (e.g. `from "../types.ts"`). Keep that convention.

## Architecture

This repo ships **one engine** (the `vsc` CLI) and **one orchestrator** (the `video-optimizer` Claude Code subagent at `.claude/agents/video-optimizer.md`). They share state through `packages/cli/src/presets/web.ts` and communicate through a typed NDJSON event stream. Understanding the seams between them is the key to making coherent changes.

### The CLI is the only encoder caller

All ffmpeg / svt-av1 / gifski / HandBrake invocations go through `packages/cli/src/encoders/*.ts`. The agent is constrained (in its frontmatter `tools:` list) to `Bash, Read, Glob, Monitor, AskUserQuestion` — it cannot call ffmpeg directly. **If you need to change encoding behavior, edit a preset or an encoder; do not bypass the CLI.**

### Reporter abstraction is how `--json` and pretty output coexist

`packages/cli/src/lib/reporter.ts` defines `Reporter` with two implementations:

- `PrettyReporter` — drives spinners + colored stderr lines for human terminals (default).
- `JsonReporter` — emits one `ProgressEvent` per line to **stdout** (used by the agent under `Bash(run_in_background: true)` + `Monitor`).

Both accept an optional `FileTap` (from `--progress-file`) that mirrors every event to a file regardless of mode. `JsonReporter` throttles `progress` events on the stdout stream (~2/sec/phase) but the file tap gets every event — keep that asymmetry intact if you touch this file.

`compressCommand` in `packages/cli/src/commands/compress.ts` always emits the full event sequence through whichever reporter is wired in. Pretty-only summary printing (the table + HTML snippet at the end) is gated behind `!jsonMode && !options.reporter` so JSON consumers get a clean stream.

### `ProgressEvent` is the CLI ↔ agent contract

The discriminated union in `packages/cli/src/types.ts` (`start | phase-start | progress | phase-done | warning | done | error`) is **the** API surface between CLI and agent. The agent's "Translating events" table in `.claude/agents/video-optimizer.md` is keyed off these tags. When you change the union:

1. Update `packages/cli/src/types.ts`.
2. Update both reporters in `packages/cli/src/lib/reporter.ts`.
3. Update the agent's event translation table.
4. Update the top-level catch in `packages/cli/src/cli.ts` if you add new error shapes.

`cli.ts` tracks a `jsonMode` flag at module scope so its top-level `parseAsync` catch can render preflight errors as JSON `{type:"error", phase:"preflight", ...}` instead of plain stderr — preserving the invariant that `--json` produces nothing but NDJSON on stdout.

### Phase model and caching

`compress` builds a flat array of `PhaseInfo` (video × N + poster × M + optional gif) from the preset, then runs them sequentially. Each phase is cached by output-mtime > input-mtime; `--force` bypasses. Overall progress percentage is computed as `(phasesDone + currentPhasePct/100) / phasesTotal`.

Adding a new artifact kind = new branch in the `PhaseInfo` union + `buildPhases` + `runPhase` switch + `artifactFromPhase` + the `CompressedArtifact` union in `types.ts`. The `start` event's `phases` array also needs the new `kind`.

### Source-order invariant

`packages/cli/src/lib/codec.ts` defines `VIDEO_SOURCE_ORDER` (AV1 → h265 → VP9 → h264). Both the terminal HTML snippet (`compress.ts`) and the standalone preview page (`packages/cli/src/lib/preview.ts`) sort by this order. The agent docs assert the same. Don't reorder.

### Encoder fallback rules

`resolveEncoder` in `compress.ts` only honors `--encoder handbrake` for h264/h265; AV1 and VP9 always fall through to ffmpeg. Missing HandBrake silently falls back with a `warning` event. Tool detection lives in `packages/cli/src/lib/deps.ts` (memoized).

## Adding a preset / encoder

(From the README — kept here so it isn't missed.)

- New preset → append to `webPresets` in `packages/cli/src/presets/web.ts`. First add the id to `PRESET_IDS` in `packages/cli/src/types.ts` so the `Preset.id: PresetId` constraint is satisfied. Then `npm run typecheck` and `./node_modules/.bin/vsc presets` to confirm.
- New codec → branch in `packages/cli/src/encoders/ffmpeg.ts` and extend the `Codec` union in `packages/cli/src/types.ts`. Update `VIDEO_SOURCE_ORDER` in `packages/cli/src/lib/codec.ts` to slot it into the picking order.
- New encoder tool → one file in `packages/cli/src/encoders/` exporting `(input, output, opts) => Promise<void>`. Wire it into `packages/cli/src/commands/compress.ts`'s `runVideo` (the only consumer) and into `resolveEncoder`'s fallback logic.

## Output layout

Default output dir is `./out/<basename>/` next to the input. Each successful `compress` writes a self-contained `<basename>.html` preview page alongside the artifacts. The `out/` and `compressed/` directories at the repo root exist for ad-hoc encoding runs and are not source.
