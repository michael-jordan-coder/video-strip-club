# video-strip-club

Open-source video optimization for web delivery, packaged two ways:

- **`vsc`** — a Node CLI that wraps ffmpeg / svt-av1 / gifski / HandBrake behind opinionated web-delivery presets, with poster extraction and a ready-to-paste `<video>` snippet.
- **`video-optimizer`** — a Claude Code subagent (`.claude/agents/video-optimizer.md`) that drives the CLI, picking presets based on the input's duration, audio, and the user's intent.

The CLI is the engine. The agent is the orchestrator. They share the same set of presets in `src/presets/web.ts`.

## Product direction

The terminal experience is the v1 product surface. Finish and harden it before
building another UI. The TUI is the fastest place to validate the core workflow
because it already uses local files, the real encoder, live progress events, and
the same output lifecycle that a local web app would need.

The next UI surface should be a local web app, not a hosted service. A local web
app can wrap the same CLI/event stream behind a browser interface without taking
on uploads, cloud storage, job queues, worker capacity, or billing. Build it
after the TUI flow is stable enough to port rather than while the interaction
model is still changing.

### TUI v1 checklist

- Main flow works end-to-end: open `/files` or `/list`, pick a video, analyze,
  choose or confirm a preset, compress, auto-open, and review the result.
- Result review is reliable: open again, keep, copy path, compress again, and
  delete behave predictably.
- Preset choice is trustworthy: the UI or agent explains the choice using
  duration, audio, intended use, and expected output.
- Failure states are actionable: missing dependencies, bad input paths,
  unsupported media, encode failures, auto-open failures, and clipboard failures
  all tell the user what happened and what to do next.
- A new user can complete a compression from `npm run strip-club` without knowing
  the lower-level CLI.
- README and TUI docs match the actual workflow.

### Local web app later

When the TUI reaches v1, add a `packages/web` local app:

```text
React UI
  -> local Node server
  -> existing vsc CLI / NDJSON event stream
  -> ffmpeg encoders
```

Start with a deterministic browser UI: file list, analyze, preset selection,
compress, live progress, result review, and open/keep/delete actions. Add an
agent or chat layer only after that workflow is working as a normal tool.

## Quickstart

```bash
npm install
./node_modules/.bin/vsc doctor               # check ffmpeg/HandBrake/gifski/svt-av1
./node_modules/.bin/vsc presets              # list available presets
./node_modules/.bin/vsc analyze video.mp4    # codec, resolution, duration, bitrate
./node_modules/.bin/vsc compress video.mp4 --preset web-hero-loop

./node_modules/.bin/vsc-ui                   # Ink TUI: chat with Claude, watch tool calls + live encode
```

The TUI is an agent loop: you type natural language ("compress hero.mp4 for the landing page"), Claude calls `vsc` tools (`list_videos`, `analyze_video`, `list_presets`, `compress_video`) and surfaces each call + its result inline, with per-phase progress bars during the encode. Requires `ANTHROPIC_API_KEY` — get one at console.anthropic.com.
Successful TUI compressions automatically open the output video in the system
default viewer.

The Ink TUI includes Charm/Bubbles-style UI elements for transcript scrolling,
filterable slash/file/preset pickers, tables, generated key help, progress bars,
result review actions, elapsed timers, and a multiline composer. See
[`packages/tui/UI_ELEMENTS.md`](packages/tui/UI_ELEMENTS.md) for when each
element appears and why.

Every successful run also writes a self-contained `<basename>.html` preview page next to the artifacts — `open` it to see the encoded video, file sizes, and a copy-paste `<video>` snippet.

Outputs land in `./out/<basename>/` next to the input by default. Override with `--out-dir`.

To make `vsc` available globally:

```bash
npm --workspace @vsc/cli link    # then `vsc compress …` from anywhere
```

### Caching

Re-running `vsc compress` skips outputs whose mtime is newer than the input — useful when iterating on one preset knob without re-encoding the whole bundle. Pass `--force` to re-encode regardless.

### Machine-readable mode

Both `analyze` and `compress` accept `--json`:

```bash
./node_modules/.bin/vsc analyze video.mp4 --json
# {"format": {...}, "video": {...}, "audios": [...]}

./node_modules/.bin/vsc compress video.mp4 --preset web-hero-loop --json
# NDJSON event stream: start → phase-start → progress → phase-done → ... → done
```

The Claude Code subagent uses `--json` plus `Bash(run_in_background: true)` and `Monitor` to surface live progress to the user during long encodes. Add `--progress-file <path>` to also tee the event stream to a file.

Event types: `start`, `phase-start`, `progress`, `phase-done`, `warning`, `done`, `error` — see `src/types.ts` for the full discriminated union.

## Presets

| ID                    | When to use                                                                  | Codecs in bundle                |
| --------------------- | ---------------------------------------------------------------------------- | ------------------------------- |
| `web-hero-loop`       | Muted, autoplaying, looping background hero (no audio).                      | h264 + h265 + AV1 + VP9 + poster |
| `web-hero-cinematic`  | Brand cinematic with audio. Higher bitrate budget.                           | h264 + h265 + AV1 + VP9 + poster |
| `web-product-demo`    | Talking-head / screen recording / longer demo. 720p balanced.                | h264 + h265 + VP9 + poster       |
| `web-thumbnail-gif`   | Email-safe / thumbnail / preview. Looping GIF + poster.                      | gif (gifski → ffmpeg fallback) + poster |

All MP4 outputs use `+faststart` (moov atom at front, so progressive download streams). HEVC outputs are tagged `hvc1` for Safari/QuickTime compatibility. The HTML snippet emits sources in **AV1 → h265 → VP9 → h264** order — browsers pick the first they can decode.

### Already-compressed inputs

The CLI warns when an output ends up larger than the input. That's expected when re-encoding an already-tightly-compressed source — modern codecs (h265/AV1) typically still win on the same source, but the legacy h264 fallback may not. Drop the oversized output from your `<video>` sources, or re-run from a higher-bitrate master if you have one.

## Tools used

| Tool          | Required | Used for                                                                  | Install                  |
| ------------- | -------- | ------------------------------------------------------------------------- | ------------------------ |
| ffmpeg        | yes      | h264 (libx264), h265 (libx265), AV1 (libsvtav1), VP9 (libvpx-vp9), posters, palette-based GIF fallback | `brew install ffmpeg`    |
| ffprobe       | yes      | Stream analysis                                                            | (bundled with ffmpeg)    |
| svt-av1       | optional | Standalone AV1 encoder. ffmpeg's `libsvtav1` already covers this path.    | `brew install svt-av1`   |
| HandBrakeCLI  | optional | Alternative HEVC encoder via `--encoder handbrake`.                       | `brew install handbrake` |
| gifski        | optional | High-quality GIFs in the `web-thumbnail-gif` preset (better than palettegen). Falls back to ffmpeg if missing. | `brew install gifski`    |

Run `./node_modules/.bin/vsc doctor` to see which are present on your machine.

## Repo layout

This is an npm-workspaces monorepo. Every package lives under `packages/`.

```
packages/
└── cli/                       # @vsc/cli — the encoding engine
    ├── bin/vsc                # bash launcher (resolves to symlinked workspace tsx)
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── cli.ts             # commander entry
        ├── types.ts           # Preset, OutputSpec, ProbeResult, ProgressEvent
        ├── lib/
        │   ├── probe.ts       # ffprobe wrapper
        │   ├── exec.ts        # spawn + ffmpeg progress parser + tail-buffered stderr
        │   ├── deps.ts        # tool detection (memoized)
        │   ├── log.ts         # spinners, colors, byte/duration formatters
        │   ├── reporter.ts    # PrettyReporter + JsonReporter behind a Reporter interface
        │   ├── ffargs.ts      # shared ffmpeg arg helpers (base args, scale, trim)
        │   ├── codec.ts       # VIDEO_SOURCE_ORDER + <source> emitter
        │   ├── atomic.ts      # withAtomicWrite — kill-safe encode-then-rename
        │   └── preview.ts     # generates <basename>.html
        ├── encoders/
        │   ├── ffmpeg.ts      # encodeVideo, extractPoster, palette-GIF fallback
        │   ├── gifski.ts      # ffmpeg → gifski pipe
        │   └── handbrake.ts   # optional HEVC alt
        ├── presets/
        │   └── web.ts         # the four web delivery presets
        └── commands/
            ├── analyze.ts     # human + --json modes
            ├── compress.ts    # encode bundle + caching + HTML preview + event stream
            ├── batch.ts       # apply a preset to a directory
            ├── doctor.ts
            └── presets.ts
```

Run `npm install` from the repo root to bootstrap; npm hoists shared deps and symlinks `node_modules/.bin/vsc` to `packages/cli/bin/vsc` so `./node_modules/.bin/vsc` works from anywhere in the tree.

## The Claude Code agent

The `.claude/agents/video-optimizer.md` subagent activates on prompts like *"optimize this for our hero section"* or *"shrink this product demo"*. Workflow:

1. Bootstraps (`npm install`) on first run if needed.
2. Runs `vsc analyze --json` to get duration / audio / dimensions.
3. Picks a preset from the decision tree, or asks the user when ambiguous (via `AskUserQuestion`).
4. Runs `vsc compress --json` in the background (`Bash` with `run_in_background: true`).
5. Streams progress via `Monitor` — surfaces live one-liners like `[h264/mp4 47%] · 2/6 phases done`.
6. On completion, reports `Preview: open <htmlPreviewPath>` with the artifact list.

It is constrained to **only** invoke the CLI; it will not call ffmpeg directly. Allowed tools: `Bash, Read, Glob, Monitor, AskUserQuestion`. To change encoding behavior, edit `src/presets/web.ts` and re-run `npm run typecheck`.

## Adding a preset

1. Append to `webPresets` in `packages/cli/src/presets/web.ts`.
2. If it needs a codec we don't yet support (e.g. h264-baseline, AV1 with grain synth), add a branch in `packages/cli/src/encoders/ffmpeg.ts` and update the `Codec` union in `packages/cli/src/types.ts`.
3. `npm run typecheck` (runs across all workspaces).
4. `./node_modules/.bin/vsc presets` confirms it shows up.

## Adding a new encoder

`packages/cli/src/encoders/` is one file per tool. Each file exports a single function with the shape `(input: string, output: string, opts) => Promise<void>`. Wire it into `packages/cli/src/commands/compress.ts` — that's the only consumer.
