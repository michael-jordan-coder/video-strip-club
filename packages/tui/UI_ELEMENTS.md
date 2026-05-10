# TUI UI Elements

The TUI is implemented with Ink, not Go Bubble Tea. These elements mirror the
interaction patterns from `charmbracelet/bubbles` while staying inside the
existing TypeScript runtime.

This terminal UI is the v1 product surface. The local web app should come after
this flow is stable, so the web version can port a validated workflow instead
of inventing product behavior in parallel.

| Element | When it appears | Why it appears |
| --- | --- | --- |
| Viewport | The transcript is taller than the terminal, or the user presses `PgUp` / `PgDn`. | Keeps chat, tool calls, slash output, and progress readable without dropping older context. The viewport is row-aware, so tall command outputs count more than short one-line events. |
| List | `/presets` returns available presets. | Presets are a choice set, not prose. The filterable list lets the user narrow by id or summary and press `enter` to select. |
| File picker | `/list [dir]` or `/files [dir]` finds videos. | Video paths are tedious to type. The picker filters detected video files and inserts the selected path into the normal agent flow. |
| Table | `/list`, `/presets`, and `/estimate` return structured results. | Sizes, phase names, encoders, and preset attributes scan better in columns than in padded prose. |
| Doctor output | `/doctor` runs from the slash palette or composer. | Dependency issues are a first-run blocker. Showing the same required/optional tool check inside the TUI keeps users from dropping to the shell to diagnose missing ffmpeg or ffprobe. |
| Help | The footer is always visible; press `?` to expand it. | The active keys change by state, so the footer is generated from key bindings instead of hard-coded text. |
| Key bindings | Normal chat, picker mode, textarea mode, and busy mode each expose their own footer keys. | Avoids stale instructions. For example, `↑/↓` means history in chat mode but movement in picker mode. |
| Slash palette | Type `/` in the composer. | Shows the available slash commands before submit, like Codex. The list filters as you type; `enter` or `1`-`9` inserts the highlighted command, then the next `enter` runs it. |
| Progress | `compress_video` streams encode events. | Each phase gets a compact progress bar, and the overall encode gets a wider bar. This makes multi-phase encodes visible without parsing NDJSON events. |
| Result review | `compress_video` completes with an output artifact. | Turns completion into a decision point: inspect the original/optimized sizes, saved percentage, format, preset, and output path, then choose an action. |
| Action list | The latest result review is active and the composer is empty. | Provides post-compression actions: open again, keep file, copy path, insert a retry prompt, or delete the output. Older result cards stay visible but their action lists are inactive. |
| Stopwatch | A tool call is running or has finished. | Long probes and encodes need elapsed time. Finished tool cards keep their final elapsed duration for later comparison. |
| Textarea | Press `ctrl+n` in chat mode. | Longer prompts need line breaks. Textarea mode uses `enter` for a newline, `ctrl+s` to send, and `esc` to return to the single-line composer. |
| Auto-open | `compress_video` finishes with an output artifact. | The compressed output opens in the default system viewer immediately, so the user can inspect it without running `/open`. If launching fails, the tool still succeeds and shows the open error in the summary. |

## State Notes

- Picker mode starts only from slash commands that return picker options.
- Slash palette mode starts while the single-line composer begins with `/` and
  has not reached command arguments yet.
- Pressing `enter` in a picker submits the highlighted payload as the next
  input, so the agent can continue with the selected path or preset id.
- Pressing `1` through `9` inserts that option into the composer for editing;
  `shift` plus the number submits it immediately.
- `esc` cancels the most local thing first: running agent turn, active picker,
  scrolled viewport, or textarea mode.
- During a running encode, `esc` aborts the agent turn and terminates the local
  `vsc compress` child process.
- `PgUp` and `PgDn` always operate on the transcript viewport.
- Compression outputs are still ephemeral even when auto-opened; rename or copy
  the output if it should survive the TUI session.
- `Keep file` removes the output from session cleanup. `Delete output` removes it
  immediately and marks the result card as deleted.
