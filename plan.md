# TUI v1 — flow-first redesign

## Context

The TUI today is **chat-first**: it boots into a blank composer with a pink mascot above it. Every meaningful action — picking a file, recommending a preset, compressing — flows through a Claude agent loop with text rules baked into the system prompt. The result is a powerful but uncertain UX: the user has to invent a prompt to do anything, the recommendation logic is invisible, and the post-compression "result moment" buries the most important action ("Keep file") behind four others.

This plan turns the TUI into **flow-first with chat available**:

- A persistent home action menu sits above the composer at all times (`Pick a video` / `Check setup` / `View recent outputs` / `Ask the assistant`).
- The default path becomes **Pick → Analyze → Recommend → Trust card → Compress → Review**, so most users never have to compose a prompt.
- Preset selection becomes a **trust card** with `bestFor`, `keepsAudio`, `expectedOutput`, and `tradeoff` so users know what they're choosing before they spend ffmpeg time.
- The result moment becomes the emotional peak: **Keep file first**, with explicit `temporary / kept / deleted` status visible at all times so the cleanup-on-exit behavior never surprises anyone.
- `/recent`, smarter `/doctor` failure UX, richer progress, and a 5-video dogfood pass round it out.

The encoding engine doesn't change. All the work happens in `packages/tui` plus a small set of additive metadata fields on the CLI side (preset card data + a pure `recommendPreset` function pulled out of the agent prompt).

Scope: `packages/tui/*` and additive changes to `packages/cli/src/types.ts`, `packages/cli/src/presets/web.ts`, `packages/cli/src/commands/presets.ts`, and one new file `packages/cli/src/lib/recommend.ts`. No changes to encoders, the NDJSON wire protocol, or the existing tool surface.

---

## Architecture decisions

1. **Home renders above the composer (not a separate screen).** `Header()` in `packages/tui/src/App.tsx:690` is replaced by a `<HomePanel>` that contains the mascot, the action menu, and an inline recent strip. The transcript renders below it as today. This keeps the existing single-`useInput()` model (`App.tsx:324`) and the existing modal-stacking pattern — no screen routing layer needed.

2. **Home menu is keyboard-focusable when no other modal is active and the composer is empty.** ↑/↓ moves the home cursor; `enter` triggers the action; typing any character moves focus back to the composer. This composes cleanly with the existing condition cascade (`busy` → `activePicker` → `slashPaletteOpen` → `activeReviewId` → default).

3. **Home actions are slash commands under the hood.** `Pick a video` → runs the existing `/files` flow. `Check setup` → `/doctor`. `View recent outputs` → new `/recent`. `Ask the assistant` → focuses the composer with a hint placeholder. This means the home menu is a thin keyboard shortcut layer over `runSlash()` in `packages/tui/src/lib/slash.ts:200`, not a new control plane.

4. **The guided flow is a state machine layered on top of the existing tool plumbing.** A new `GuidedFlow` reducer drives `idle → picking → analyzing → trust-card → compressing → review`. Each step calls the existing primitives in `packages/tui/src/lib/vsc.ts` (`probe`, `startEncode`, `runVscJson`) directly — bypassing the agent loop, exactly as the slash commands already do. The agent loop is only re-entered when the user explicitly types into the composer or chooses `Ask the assistant`.

5. **`/recent` stays in-memory.** The existing `recentCompressions` Map in `packages/tui/src/lib/agent.ts:11–79` becomes the source of truth for both the agent context digest and the new `/recent` slash command + the home recent strip. No JSON store, no filesystem reconciliation. This matches the ephemeral-by-default cleanup model: outputs are gone after exit, so a persisted recent list would lie about what's still on disk.

6. **Preset card data lives on `Preset` itself, not in a sibling map.** Add optional `bestFor`, `keepsAudio`, `expectedOutput`, `tradeoff` fields to the `Preset` interface in `packages/cli/src/types.ts:100`. Populate them in `packages/cli/src/presets/web.ts`. Pipe them through `PresetSummary` in `packages/cli/src/commands/presets.ts` so `vsc presets --json` exposes them. One source of truth, no sync issues, agent and TUI both consume the same shape.

7. **Recommendation moves out of the system prompt and into a pure function.** A new `packages/cli/src/lib/recommend.ts` exports `recommendPreset(probe: ProbeResult): { presetId: PresetId; reason: string }`. The TUI's guided flow calls it directly. The agent's system prompt is reduced to "use the `recommend_preset` tool" — and a thin tool wrapper is added to `packages/tui/src/lib/agent.ts` so chat can use it too. This makes the recommendation logic testable, debuggable, and consistent across both surfaces.

---

## Phase 1 — Foundation (one PR)

**Goal:** the TUI opens into a usable home menu, `/recent` works, the result review puts Keep file first and shows ephemeral status.

### 1a. Home panel above the composer

- Replace `Header()` in `packages/tui/src/App.tsx:690` with a new `<HomePanel>` component (new file `packages/tui/src/components/HomePanel.tsx`). Renders:
  - The existing `<Mascot>` from `packages/tui/src/components/Mascot.tsx` (kept — committed recently in `fdf6c4b`).
  - Title + tagline (current copy is fine — `video-strip-club · agent`, `chat to encode`; tagline can be tightened to `the terminal video assistant`).
  - "What do you want to optimize?" with 4 numbered actions: `Pick a video`, `Check setup`, `View recent outputs`, `Ask the assistant`.
  - Inline "Recent:" strip showing up to 3 entries from `recentCompressions` (basename + optimized size + status glyph). Hidden when empty.
- New cursor state in `Chat`: `homeCursor: number` (0–3). Initial value 0.
- Extend the input handler at `App.tsx:324` with a new branch:
  - Active when `!busy && !activePicker && !slashPaletteOpen && !activeReviewId && input.length === 0`.
  - ↑/↓ moves `homeCursor`. `enter` runs the corresponding action. `1`–`4` jumps directly. Any other printable character falls through to the composer (existing behavior).
- `Pick a video` dispatches `runSlash({ kind: "files", args: [], raw: "/files" }, ctx)`.
- `Check setup` dispatches `runSlash({ kind: "doctor", ... }, ctx)`.
- `View recent outputs` dispatches the new `/recent` (Phase 1c).
- `Ask the assistant` sets a transient placeholder on the composer (`compose your request…`) and focuses it; no transcript change.
- Update `helpBindings()` to include the home-mode keys: `↑↓ select · enter open · 1–4 jump · / commands · ? help`.

### 1b. Result review — Keep file first + visible ephemeral status

- Reorder `REVIEW_ACTIONS` in `packages/tui/src/App.tsx:75`:
  ```
  { id: "keep",   label: "Keep file" },
  { id: "open",   label: "Open again" },
  { id: "copy",   label: "Copy path" },
  { id: "again",  label: "Compress again" },
  { id: "delete", label: "Delete output" },
  ```
- Default `reviewCursor` should land on `keep` whenever the artifact is `temporary`. If it's already `kept` or `deleted`, default to `open` instead (current `disabled`/`detail` logic in `reviewActionOptions` already handles the visual state — extend it to drive cursor placement on first render).
- Add a single status line above the action list inside `<CompressionReview>` at `App.tsx:1049`:
  - `temporary · auto-cleanup on exit unless kept` (muted)
  - `kept · saved at <path>` (green)
  - `deleted · output removed` (red)
- Add a one-line note at the top of the result card the very first time a compression completes in a session: `tip: this output is temporary — Keep file to preserve it.` Drive this off a `hasShownEphemeralTip` ref in `Chat`.
- Status state is already tracked via `keptOutputs` and `deletedOutputs` Sets — just expose it on the card.

### 1c. `/recent` slash command

- Add `"recent"` to `SlashKind` in `packages/tui/src/lib/slash.ts:1` (top of file). Add to `SLASH_COMMANDS` array. Add case in `matchKind()` and `runSlash()`.
- Implementation `runRecent()`:
  - Read from `recentCompressions` (export an iterator helper from `packages/tui/src/lib/agent.ts` — currently `recentDigest()` reads it for the agent; add `listRecent(): RecentEntry[]`).
  - Render as a `DataTable` with columns: `input · preset · output size · status · age`.
  - Status reads `keptOutputs`/`deletedOutputs` (lift these into the slash context so `runRecent` can see them — extend `SlashContext` in `slash.ts`).
  - Empty state: `no compressions yet — pick a video to get started`.
- Wire `/recent` from the home menu's "View recent outputs".

### Phase 1 verification

- `npm run typecheck` passes.
- Boot the TUI. Confirm:
  - Mascot + home menu + composer all visible.
  - ↑/↓ moves home cursor; enter on each item works (Pick → file picker; Check setup → doctor output; View recent outputs → empty state; Ask the assistant → composer focused).
  - Pressing `a` on empty composer types into composer, doesn't move home cursor.
- Compress a short test clip (`packages/cli/test_files/` if any, else any local `.mov`).
  - Result card shows `Keep file` first, `temporary · auto-cleanup on exit unless kept` line, ephemeral tip.
  - Press enter on `Keep file` → status flips to `kept`, action becomes disabled.
  - Quit; confirm kept file survives, others are deleted.
- Compress a second clip; run `/recent`. Two entries with correct status glyphs.

---

## Phase 2 — Guided flow + preset trust card (one PR)

**Goal:** the default path is `Pick → Analyze → Recommend → Trust card → Compress → Review` with no agent loop in between.

### 2a. Preset card metadata on the CLI

- Extend `Preset` interface in `packages/cli/src/types.ts:100`:
  ```ts
  bestFor?: string;        // "Short muted clips for headers and backgrounds"
  keepsAudio?: boolean;    // explicit; not derived from outputs[].dropAudio
  expectedOutput?: string; // "1080p · h264/h265/AV1/VP9 · ~2–6 MB for 10s"
  tradeoff?: string;       // "Slowest preset — 4 codec encodes per video"
  ```
- Populate all 4 presets in `packages/cli/src/presets/web.ts`. Copy is non-trivial — match the user-facing voice in the spec (no jargon, no marketing). Suggested first pass:
  - `web-hero-loop`: bestFor "Muted background loops for hero sections", tradeoff "4 codec encodes — slow but maximum browser coverage", keepsAudio false.
  - `web-hero-cinematic`: bestFor "Brand or product hero with sound", tradeoff "Larger files than the muted loop preset", keepsAudio true.
  - `web-product-demo`: bestFor "Walkthroughs, tutorials, screen recordings", tradeoff "Skips AV1 to keep encode time reasonable", keepsAudio true.
  - `web-thumbnail-gif`: bestFor "Email thumbnails, embeds, looping previews", tradeoff "GIF only — large for the size, no audio", keepsAudio false.
- Pipe the new fields through `PresetSummary` in `packages/cli/src/commands/presets.ts:51` so `vsc presets --json` returns them. Keep them optional on the wire so older CLIs still work.
- TUI types: `packages/tui/src/types.ts` mirrors a subset of CLI types (per `CLAUDE.md`). Add the same optional fields here so the trust card can read them.

### 2b. `recommendPreset()` as a pure function

- New file `packages/cli/src/lib/recommend.ts`:
  ```ts
  export interface Recommendation {
    presetId: PresetId;
    reason: string; // user-facing one-liner
    confidence: "high" | "medium" | "low";
  }
  export function recommendPreset(probe: ProbeResult): Recommendation { ... }
  ```
- Port the rules from `packages/tui/src/lib/agent.ts:132–150` (system prompt) verbatim:
  1. duration < 4s + has-audio false → `web-thumbnail-gif` (high)
  2. duration < 15s + has-audio false → `web-hero-loop` (high)
  3. duration < 15s + has-audio true → `web-hero-cinematic` (high)
  4. duration ≥ 30s → `web-product-demo` (high)
  5. duration 15–30s + has-audio true → `web-hero-cinematic` (medium, with reason hinting "could also be web-product-demo for longer demos")
  6. duration 15–30s + has-audio false → `web-hero-loop` (medium)
- Reasons are written in user voice: "short clip with audio, suitable for brand/hero placement"; "long demo with audio — product-demo preset balances quality and encode time".
- Strip the corresponding rules from `SYSTEM_PROMPT` in `agent.ts` and replace with: "When the user asks for a recommendation, call the `recommend_preset` tool and present its `reason` to the user."
- Add a thin `recommend_preset` tool to `agent.ts` that takes `path` and returns `recommendPreset(await probe(path))`. This keeps chat-mode parity with the guided flow.

### 2c. Guided flow state machine

- New file `packages/tui/src/lib/guidedFlow.ts`. Pure reducer:
  ```ts
  type GuidedState =
    | { kind: "idle" }
    | { kind: "picking" }
    | { kind: "analyzing"; path: string }
    | { kind: "trust-card"; path: string; probe: ProbeResult; recommendation: Recommendation; selectedPreset: PresetId }
    | { kind: "estimating"; path: string; preset: PresetId; probe: ProbeResult; recommendation: Recommendation }
    | { kind: "compressing"; toolId: string; path: string; preset: PresetId }
    | { kind: "review"; toolId: string };
  ```
- New `<GuidedFlow>` component in `packages/tui/src/components/GuidedFlow.tsx` consumes the state and renders each step using existing primitives:
  - `picking` → existing `PickerPanel` populated by `listVideos()`.
  - `analyzing` → small spinner + `Analyzing IMG_1208.mov…`.
  - `trust-card` → new `<TrustCard>` showing:
    ```
    IMG_1208.mov
    84.2 MB · 1080p · 22s · audio

    Recommended: web-hero-cinematic
    Why: short clip with audio, suitable for brand/hero placement

    Best for: brand or product hero with sound
    Output: 1080p · h264/h265/AV1/VP9
    Audio: kept
    Tradeoff: larger files than the muted loop preset

    > Compress with recommendation
      Choose another preset
      Estimate first
      Cancel
    ```
  - `estimating` → calls `runVscJson(["estimate", ...])`, renders the result, then offers the same Compress / Choose / Cancel actions.
  - `compressing` → reuses the existing `<CompressProgress>` from `App.tsx:1203` (no rewrite — see Phase 3 for richer progress).
  - `review` → routes to the existing `<CompressionReview>` (already updated in Phase 1).
- Wiring: `Pick a video` from the home menu now sets the guided flow to `picking` instead of dispatching `/files` directly. `/files` slash command remains as an escape hatch.
- `Choose another preset` opens the existing `/presets` picker but keyed for guided-flow context: on selection it returns to a `trust-card` state with `selectedPreset` updated and a different "user override — preset chosen manually" reason.
- All transitions go through the reducer; no scattered `setState` chains.

### 2d. Bypass the agent for guided flow tools

- The guided flow calls `probe()`, `runVscJson()`, and `startEncode()` from `packages/tui/src/lib/vsc.ts` directly — these are the same primitives the agent's tools wrap. The `AgentSubscriber` ref in `App.tsx:439` is reused so progress events still feed the existing transcript items (the review card etc. light up identically).
- `compress_video` results from the guided flow get the same `rememberCompression()` call so `/recent` and the home strip update.

### Phase 2 verification

- `npm run typecheck` passes (root, both workspaces).
- `./node_modules/.bin/vsc presets --json` returns the new fields.
- Unit-spike (no test runner exists; verify by hand): instantiate `recommendPreset` against 6 hand-crafted `ProbeResult` fixtures matching each rule → check the returned id+reason+confidence.
- End-to-end:
  - From home, pick a short muted clip → trust card shows `web-hero-loop` recommendation with full card data.
  - Pick a long clip with audio → recommends `web-product-demo`.
  - On the trust card, "Choose another preset" → presets picker → pick one → trust card returns with the manual override reason.
  - "Estimate first" → estimate result → can still proceed to compress.
  - Compress completes → review card (Phase 1 layout) → Keep file → quit → file survives.
- Chat parity: type "what preset should I use for this video?" with a path — the agent calls `recommend_preset` and surfaces the same reason text.

---

## Phase 3 — Polish (one PR)

**Goal:** progress feels alive, doctor failures point to a fix, dogfood reveals the rough edges.

### 3a. Richer progress

- Update `<CompressProgress>` in `packages/tui/src/App.tsx:1203` (and `<PhaseRow>` siblings) to display per the spec:
  ```
  Encoding IMG_1208.mov

  h264/mp4      ███████░░░ 72% · 1.8x
  overall       █████░░░░░ 48%

  2 of 4 phases complete · 38s elapsed · ~22s remaining
  esc abort
  ```
- ETA: linear extrapolation from completed-phase wall time. Hide if confidence is low (first 5 seconds of first phase, or no phases done yet).
- "1.8x" is encoding speed: derive from `progress` event fields if present (ffmpeg emits `speed=1.8x` in stderr — check whether `ProgressEvent` already surfaces it; if not, add it as an optional field on `progress` events at the CLI side, behind a TS-safe optional).
- "2 of 4 phases complete" already trivially derivable from `phase-done` event count.
- "esc abort" remains; abort already wired via `EncodeHandle.abort()`.

### 3b. `/doctor` failure UX

- When `runDoctor()` in `packages/tui/src/lib/slash.ts:317` returns non-zero, render a `<DoctorFailureCard>` instead of the bare details list:
  ```
  ffmpeg is missing

  Required for: video encoding and poster extraction
  Install: brew install ffmpeg

  > Run doctor again
    Copy install command
    Quit
  ```
- Card uses the existing `<ActionList>` primitive at `bubbles.tsx:169`. Action handlers:
  - `Run doctor again` → re-dispatches `/doctor`.
  - `Copy install command` → copy via the existing clipboard helper (see how `copy: "Copy path"` works in `App.tsx:274–322`).
  - `Quit` → `process.exit(0)`.
- Map missing-tool name → install hint in a tiny `packages/tui/src/lib/installHints.ts`:
  ```
  ffmpeg → brew install ffmpeg
  ffprobe → brew install ffmpeg (bundled)
  HandBrakeCLI → brew install handbrake
  gifski → brew install gifski
  svt-av1 → brew install svt-av1
  ```
- On startup, **silently** run `vsc doctor`; only surface a one-line banner above the home menu (`setup incomplete — press 2 to fix`) if anything is missing. No modal interruption.

### 3c. Dogfood checklist

Run the redesigned TUI against 5 hand-picked clips and capture results in a short note (not a doc — chat reply or PR description):

1. **Short muted clip** (~5s, no audio) — expect `web-hero-loop`.
2. **Short with audio** (~10s, music or voiceover) — expect `web-hero-cinematic`.
3. **Long demo** (~60s screen recording with audio) — expect `web-product-demo`.
4. **Already compressed file** (a small h264 mp4 already optimized) — should still complete; flag if size goes UP, which would be a real concern for ad-hoc usage.
5. **GIF target** (very short, ≤4s, muted) — expect `web-thumbnail-gif`.

For each: confirm trust card copy reads naturally, recommendation matches expectation, progress bar feels useful, result card highlights savings clearly, Keep file first works.

### Phase 3 verification

- `npm run typecheck` passes.
- Manually `mv /opt/homebrew/bin/ffmpeg ~/.ffmpeg-bak` (or rename in `PATH`) → boot TUI → see banner → press `2` → see install card. Restore.
- Run a long compression (~30s clip, all 4 codecs) → ETA appears within 5–10s, decreases monotonically (within reason), 1.8x-style speed shown.
- Dogfood pass complete.

---

## Files touched (summary)

### TUI
- `packages/tui/src/App.tsx` — replace `Header()` with `<HomePanel>` mount; reorder `REVIEW_ACTIONS`; extend input handler with home-mode branch; add `homeCursor` state; mount `<GuidedFlow>` for guided actions; wire status line in `<CompressionReview>`; ephemeral tip; richer `<CompressProgress>` (Phase 3).
- `packages/tui/src/components/HomePanel.tsx` — **new**. Mascot + title + 4-action menu + recent strip.
- `packages/tui/src/components/GuidedFlow.tsx` — **new**. Renders each guided-flow state.
- `packages/tui/src/components/TrustCard.tsx` — **new**. Preset trust card.
- `packages/tui/src/components/DoctorFailureCard.tsx` — **new**. Phase 3.
- `packages/tui/src/lib/slash.ts` — add `/recent`; extend `SlashContext` to surface `keptOutputs`/`deletedOutputs`; replace `runDoctor` failure path.
- `packages/tui/src/lib/guidedFlow.ts` — **new**. Pure reducer.
- `packages/tui/src/lib/installHints.ts` — **new**. Phase 3.
- `packages/tui/src/lib/agent.ts` — export `listRecent()`; add `recommend_preset` tool wrapper; trim system prompt rules.
- `packages/tui/src/types.ts` — mirror new optional `Preset` fields.

### CLI
- `packages/cli/src/types.ts` — add `bestFor?`, `keepsAudio?`, `expectedOutput?`, `tradeoff?` to `Preset`; optional `speed?: number` on `progress` event variant for the "1.8x" UI (only if not already present).
- `packages/cli/src/presets/web.ts` — populate the 4 new fields on each preset.
- `packages/cli/src/commands/presets.ts` — extend `PresetSummary` to surface the new fields in `--json`.
- `packages/cli/src/lib/recommend.ts` — **new**. `recommendPreset(probe)`.

### Reused without modification
- `packages/tui/src/components/Mascot.tsx` — kept as-is; mounted by `<HomePanel>`.
- `packages/tui/src/components/bubbles.tsx` — `PickerPanel`, `ActionList`, `DataTable`, `ProgressBar`, `Composer` reused as-is.
- `packages/tui/src/lib/vsc.ts` — `probe`, `startEncode`, `runVscJson` called directly by guided flow.
- `packages/tui/src/lib/files.ts` — `listVideos` called by guided-flow `picking` state.
- `packages/tui/src/theme.ts` — palette unchanged.
- `packages/cli/src/encoders/*`, `packages/cli/src/lib/reporter.ts` — unchanged.

---

## End-to-end verification (full plan)

Once all 3 phases land:

1. `npm install && npm run typecheck` passes.
2. `./node_modules/.bin/vsc doctor` passes; `./node_modules/.bin/vsc presets --json | jq '.presets[0].bestFor'` returns a non-empty string for all 4 presets.
3. Boot TUI → home menu visible above the composer; mascot intact; `↑↓ select · enter open · 1–4 jump · / commands · ? help` in footer.
4. Press `1` → file picker opens; pick a video → trust card appears with recommendation + full preset card data.
5. Press enter on default action (Compress with recommendation) → progress runs with elapsed + ETA + speed → result card with **Keep file** as default cursor position and `temporary · auto-cleanup on exit unless kept` status line.
6. Press enter (Keep file) → status flips to `kept · saved at <path>`; action disables.
7. Compress a second video; run `/recent` → both entries with correct status.
8. Quit; confirm kept file survives, ephemeral one is gone.
9. Re-boot; `/recent` is empty (in-memory only — by design).
10. Hide `ffmpeg` from PATH; boot → setup-incomplete banner → press `2` → doctor failure card with install hint and 3 actions.
11. Type "compress IMG_1208.mov" in chat (Ask the assistant) → agent calls `recommend_preset` → surfaces the same reason text the trust card would show. Chat and guided flow stay in sync.
12. Run the 5-clip dogfood pass; capture findings.

If anything in the dogfood pass surfaces real issues (wrong recommendation, confusing copy, progress feels dead), file as Phase 3.5 follow-ups — don't bundle into the same PR.
