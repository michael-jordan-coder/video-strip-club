import { useEffect, useReducer } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { theme, symbols } from "./theme.ts";
import { formatBytes, formatDuration, formatMs, listVideos } from "./lib/files.ts";
import type { VideoFile } from "./lib/files.ts";
import { probe, startEncode } from "./lib/vsc.ts";
import type { EncodeHandle, ProbeSummary } from "./lib/vsc.ts";
import type { CompressedArtifact, PresetId, ProgressEvent } from "./types.ts";

interface PresetChoice {
  id: PresetId;
  title: string;
  hint: string;
}

const PRESETS: PresetChoice[] = [
  { id: "web-hero-loop", title: "Hero loop", hint: "muted autoplay loop, 1080p, no audio" },
  { id: "web-hero-cinematic", title: "Hero cinematic", hint: "audio + 1080p, all four codecs" },
  { id: "web-product-demo", title: "Product demo", hint: "720p with audio, longer-form" },
  { id: "web-thumbnail-gif", title: "Thumbnail GIF", hint: "480px looping GIF + poster" },
];

type Phase = { name: string; pct: number; doneSize: number | null; cached: boolean };

type State =
  | { kind: "loading-files" }
  | { kind: "no-files" }
  | { kind: "pick-file"; files: VideoFile[]; cursor: number }
  | { kind: "probing"; file: VideoFile }
  | { kind: "pick-preset"; file: VideoFile; probeSummary: ProbeSummary; cursor: number }
  | {
      kind: "encoding";
      file: VideoFile;
      preset: PresetId;
      probeSummary: ProbeSummary;
      phases: Phase[];
      overallPct: number;
      warnings: string[];
      handle: EncodeHandle | null;
    }
  | {
      kind: "done";
      file: VideoFile;
      preset: PresetId;
      artifacts: CompressedArtifact[];
      durationMs: number;
      htmlPreviewPath: string | null;
      warnings: string[];
    }
  | { kind: "error"; message: string };

type Action =
  | { type: "files-loaded"; files: VideoFile[] }
  | { type: "file-cursor"; delta: number }
  | { type: "file-confirmed" }
  | { type: "probed"; summary: ProbeSummary }
  | { type: "preset-cursor"; delta: number }
  | { type: "preset-confirmed" }
  | { type: "encode-handle"; handle: EncodeHandle }
  | { type: "vsc-event"; event: ProgressEvent }
  | { type: "fail"; message: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "files-loaded":
      if (action.files.length === 0) return { kind: "no-files" };
      return { kind: "pick-file", files: action.files, cursor: 0 };
    case "file-cursor":
      if (state.kind !== "pick-file") return state;
      return {
        ...state,
        cursor: clamp(state.cursor + action.delta, 0, state.files.length - 1),
      };
    case "file-confirmed": {
      if (state.kind !== "pick-file") return state;
      const file = state.files[state.cursor];
      if (!file) return state;
      return { kind: "probing", file };
    }
    case "probed":
      if (state.kind !== "probing") return state;
      return { kind: "pick-preset", file: state.file, probeSummary: action.summary, cursor: 0 };
    case "preset-cursor":
      if (state.kind !== "pick-preset") return state;
      return { ...state, cursor: clamp(state.cursor + action.delta, 0, PRESETS.length - 1) };
    case "preset-confirmed": {
      if (state.kind !== "pick-preset") return state;
      const choice = PRESETS[state.cursor];
      if (!choice) return state;
      return {
        kind: "encoding",
        file: state.file,
        preset: choice.id,
        probeSummary: state.probeSummary,
        phases: [],
        overallPct: 0,
        warnings: [],
        handle: null,
      };
    }
    case "encode-handle":
      if (state.kind !== "encoding") return state;
      return { ...state, handle: action.handle };
    case "vsc-event": {
      if (state.kind !== "encoding") return state;
      return applyEvent(state, action.event);
    }
    case "fail":
      return { kind: "error", message: action.message };
  }
}

function applyEvent(state: Extract<State, { kind: "encoding" }>, event: ProgressEvent): State {
  switch (event.type) {
    case "start":
      return {
        ...state,
        phases: event.phases.map((p) => ({
          name: p.name,
          pct: 0,
          doneSize: null,
          cached: false,
        })),
      };
    case "phase-start":
      return state;
    case "progress":
      return {
        ...state,
        overallPct: event.overall.pct,
        phases: state.phases.map((p) =>
          p.name === event.phase ? { ...p, pct: event.currentPct } : p,
        ),
      };
    case "phase-done":
      return {
        ...state,
        phases: state.phases.map((p) =>
          p.name === event.phase
            ? { ...p, pct: 100, doneSize: event.sizeBytes, cached: event.cached }
            : p,
        ),
      };
    case "warning":
      return { ...state, warnings: [...state.warnings, event.message] };
    case "done":
      return {
        kind: "done",
        file: state.file,
        preset: state.preset,
        artifacts: event.artifacts,
        durationMs: event.durationMs,
        htmlPreviewPath: event.htmlPreviewPath,
        warnings: state.warnings,
      };
    case "error":
      return {
        kind: "error",
        message: `${event.phase}: ${event.message}\n${event.stderrTail}`.trim(),
      };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function App({ cwd }: { cwd: string }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, { kind: "loading-files" });
  const { exit } = useApp();

  useEffect(() => {
    listVideos(cwd)
      .then((files) => dispatch({ type: "files-loaded", files }))
      .catch((err: Error) => dispatch({ type: "fail", message: err.message }));
  }, [cwd]);

  useEffect(() => {
    if (state.kind !== "probing") return;
    let cancelled = false;
    probe(state.file.path)
      .then((summary) => {
        if (!cancelled) dispatch({ type: "probed", summary });
      })
      .catch((err: Error) => {
        if (!cancelled) dispatch({ type: "fail", message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [state.kind, state.kind === "probing" ? state.file.path : null]);

  const encodingPreset = state.kind === "encoding" ? state.preset : null;
  const encodingHandle = state.kind === "encoding" ? state.handle : null;
  useEffect(() => {
    if (state.kind !== "encoding" || state.handle !== null) return;
    const handle = startEncode(
      state.file.path,
      state.preset,
      (event) => dispatch({ type: "vsc-event", event }),
      (message) => dispatch({ type: "fail", message }),
    );
    dispatch({ type: "encode-handle", handle });
    return () => {
      handle.abort();
    };
    // We intentionally key the effect off the encoding state's identity bits;
    // re-running on every reducer tick would relaunch the subprocess.
  }, [state, encodingPreset, encodingHandle]);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      if (state.kind === "encoding" && state.handle) state.handle.abort();
      exit();
      return;
    }
    if (state.kind === "pick-file") {
      if (key.upArrow) dispatch({ type: "file-cursor", delta: -1 });
      else if (key.downArrow) dispatch({ type: "file-cursor", delta: 1 });
      else if (key.return) dispatch({ type: "file-confirmed" });
    } else if (state.kind === "pick-preset") {
      if (key.upArrow) dispatch({ type: "preset-cursor", delta: -1 });
      else if (key.downArrow) dispatch({ type: "preset-cursor", delta: 1 });
      else if (key.return) dispatch({ type: "preset-confirmed" });
    } else if (state.kind === "done" || state.kind === "error" || state.kind === "no-files") {
      if (key.return) exit();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Header />
      <Box marginTop={1} flexDirection="column">
        {renderState(state)}
      </Box>
      <Footer state={state} />
    </Box>
  );
}

function renderState(state: State): JSX.Element {
  switch (state.kind) {
    case "loading-files":
      return (
        <Text color={theme.muted}>
          <Text color={theme.cyan}>
            <Spinner type="dots" />
          </Text>
          {"  scanning current directory…"}
        </Text>
      );
    case "no-files":
      return (
        <Text color={theme.amber}>
          No video files (.mp4 / .mov / .mkv / .webm) in this directory.
        </Text>
      );
    case "pick-file":
      return <PickFileScreen state={state} />;
    case "probing":
      return (
        <Text color={theme.muted}>
          <Text color={theme.cyan}>
            <Spinner type="dots" />
          </Text>
          {`  probing ${state.file.name}…`}
        </Text>
      );
    case "pick-preset":
      return <PickPresetScreen state={state} />;
    case "encoding":
      return <EncodeScreen state={state} />;
    case "done":
      return <DoneScreen state={state} />;
    case "error":
      return (
        <Box flexDirection="column">
          <Text color={theme.red} bold>
            {symbols.cross} encode failed
          </Text>
          <Text color={theme.muted}>{state.message}</Text>
        </Box>
      );
  }
}

function Header(): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={theme.pink} bold>
        video-strip-club
      </Text>
      <Text color={theme.muted}>encode for the web · powered by ffmpeg</Text>
    </Box>
  );
}

function Footer({ state }: { state: State }): JSX.Element {
  const hint = footerHint(state);
  return (
    <Box marginTop={1}>
      <Text color={theme.muted}>{hint}</Text>
    </Box>
  );
}

function footerHint(state: State): string {
  switch (state.kind) {
    case "pick-file":
    case "pick-preset":
      return "↑↓ select · ⏎ confirm · q quit";
    case "encoding":
      return "encoding… · q to abort";
    case "done":
      return "⏎ exit · q quit";
    case "error":
    case "no-files":
      return "⏎ or q to exit";
    default:
      return "q to quit";
  }
}

function PickFileScreen({
  state,
}: {
  state: Extract<State, { kind: "pick-file" }>;
}): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={theme.cyan}>Select a video</Text>
      <Box marginTop={1} flexDirection="column">
        {state.files.map((file, i) => {
          const selected = i === state.cursor;
          const colorProps = selected ? { color: theme.pink } : {};
          return (
            <Text key={file.path} {...colorProps}>
              {selected ? `${symbols.pointer} ` : "  "}
              {file.name}
              {"  "}
              <Text color={theme.muted}>{formatBytes(file.sizeBytes)}</Text>
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

function PickPresetScreen({
  state,
}: {
  state: Extract<State, { kind: "pick-preset" }>;
}): JSX.Element {
  const { probeSummary } = state;
  const dim = `${formatDuration(probeSummary.durationSec)} · ${formatBytes(probeSummary.sizeBytes)}`;
  const dims =
    probeSummary.width != null && probeSummary.height != null
      ? ` · ${probeSummary.width}×${probeSummary.height}`
      : "";
  const audio = probeSummary.hasAudio ? " · with audio" : " · no audio";
  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>
        {state.file.name} {symbols.bullet} <Text color={theme.cyan}>{dim + dims + audio}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.cyan}>Pick a preset</Text>
        <Box marginTop={1} flexDirection="column">
          {PRESETS.map((preset, i) => {
            const selected = i === state.cursor;
            const colorProps = selected ? { color: theme.pink } : {};
            return (
              <Box key={preset.id} flexDirection="column">
                <Text {...colorProps}>
                  {selected ? `${symbols.pointer} ` : "  "}
                  {preset.title}
                  {"  "}
                  <Text color={theme.muted}>{preset.id}</Text>
                </Text>
                {selected ? (
                  <Text color={theme.muted}>
                    {"    "}
                    {preset.hint}
                  </Text>
                ) : null}
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

function EncodeScreen({
  state,
}: {
  state: Extract<State, { kind: "encoding" }>;
}): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>
        {state.file.name} {symbols.bullet} <Text color={theme.cyan}>{state.preset}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        {state.phases.length === 0 ? (
          <Text color={theme.muted}>
            <Text color={theme.cyan}>
              <Spinner type="dots" />
            </Text>
            {"  starting…"}
          </Text>
        ) : (
          state.phases.map((phase) => <PhaseRow key={phase.name} phase={phase} />)
        )}
      </Box>
      {state.phases.length > 0 ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>overall </Text>
          <Bar pct={state.overallPct} width={30} color={theme.pink} />
          <Text color={theme.muted}> {`${state.overallPct}%`}</Text>
        </Box>
      ) : null}
      {state.warnings.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {state.warnings.map((w, i) => (
            <Text key={i} color={theme.amber}>
              ! {w}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function PhaseRow({ phase }: { phase: Phase }): JSX.Element {
  if (phase.doneSize !== null) {
    return (
      <Text>
        <Text color={theme.green}>{symbols.check}</Text>
        {"  "}
        {phase.name.padEnd(14)}
        <Text color={theme.muted}>
          {formatBytes(phase.doneSize)}
          {phase.cached ? " (cached)" : ""}
        </Text>
      </Text>
    );
  }
  return (
    <Text>
      <Text color={theme.cyan}>
        <Spinner type="dots" />
      </Text>
      {"  "}
      {phase.name.padEnd(14)}
      <Bar pct={phase.pct} width={20} color={theme.cyan} />
      <Text color={theme.muted}> {`${phase.pct}%`}</Text>
    </Text>
  );
}

function Bar({ pct, width, color }: { pct: number; width: number; color: string }): JSX.Element {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const empty = width - filled;
  return (
    <Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text color={theme.muted}>{"░".repeat(empty)}</Text>
    </Text>
  );
}

function DoneScreen({
  state,
}: {
  state: Extract<State, { kind: "done" }>;
}): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={theme.green} bold>
        {symbols.check} done in {formatMs(state.durationMs)}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {state.artifacts.map((a) => (
          <Text key={a.path}>
            <Text color={theme.muted}>{symbols.bullet} </Text>
            {artifactLabel(a).padEnd(14)}
            <Text color={theme.cyan}>{formatBytes(a.sizeBytes)}</Text>
            <Text color={theme.muted}>{"  "}{shortPath(a.path)}</Text>
          </Text>
        ))}
      </Box>
      {state.htmlPreviewPath ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>preview </Text>
          <Text color={theme.pink}>open {state.htmlPreviewPath}</Text>
        </Box>
      ) : null}
      {state.warnings.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {state.warnings.map((w, i) => (
            <Text key={i} color={theme.amber}>
              ! {w}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function artifactLabel(a: CompressedArtifact): string {
  if (a.kind === "video") return `${a.codec}/${a.container}`;
  if (a.kind === "poster") return `poster ${a.format}`;
  return "gif";
}

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.slice(-2).join("/");
}
