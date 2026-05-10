import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import Spinner from "ink-spinner";
import { theme, symbols } from "./theme.ts";
import { formatBytes } from "./lib/files.ts";
import { createClient, openInDefaultViewer, runTurn } from "./lib/agent.ts";
import type { AgentSubscriber } from "./lib/agent.ts";
import { parseSlash, runSlash, slashCommandOptions } from "./lib/slash.ts";
import type { PickerOption, SlashTable } from "./lib/slash.ts";
import type { ProgressEvent } from "./types.ts";
import { Mascot } from "./Mascot.tsx";
import {
  Composer,
  ActionList,
  DataTable,
  ElapsedTime,
  HelpBar,
  PickerPanel,
  ProgressBar,
  filterPickerOptions,
  useNow,
  type HelpBinding,
  type ActionOption,
} from "./components/bubbles.tsx";

interface UserItem {
  kind: "user";
  id: string;
  text: string;
}

interface AssistantItem {
  kind: "assistant";
  id: string;
  text: string;
}

interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  input: unknown;
  status: "running" | "ok" | "error";
  startedAt: number;
  finishedAt?: number;
  summary?: string;
  progress?: ProgressEvent[];
}

interface SystemItem {
  kind: "system";
  id: string;
  text: string;
  tone: "info" | "error";
}

interface SlashItem {
  kind: "slash";
  id: string;
  card: string;
  status: "ok" | "error";
  summary: string;
  details?: string[];
  table?: SlashTable;
  picker?: { kind: "files" | "presets"; options: PickerOption[] };
}

type ChatItem = UserItem | AssistantItem | ToolItem | SystemItem | SlashItem;
type ReviewActionId = "open" | "keep" | "copy" | "again" | "delete";

const INPUT_PLACEHOLDER = "ask anything · e.g. compress hero.mp4 for the landing page";
const PICKER_PLACEHOLDER = "filter current picker";
const REVIEW_ACTIONS: Array<{ id: ReviewActionId; label: string }> = [
  { id: "open", label: "Open again" },
  { id: "keep", label: "Keep file" },
  { id: "copy", label: "Copy path" },
  { id: "again", label: "Compress again" },
  { id: "delete", label: "Delete output" },
];

export function App({ cwd }: { cwd: string }): JSX.Element {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey || apiKey.length === 0) {
    return <ApiKeyMissing />;
  }
  return <Chat cwd={cwd} />;
}

function ApiKeyMissing(): JSX.Element {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input === "q" || key.escape || key.return || key.ctrl) exit();
  });
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text color={theme.pink} bold>
        video-strip-club · agent
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.amber}>
          {symbols.cross} ANTHROPIC_API_KEY is not set.
        </Text>
        <Text color={theme.muted}>
          Get a key at console.anthropic.com, then export it in the shell that runs vsc-ui:
        </Text>
        <Box marginTop={1}>
          <Text color={theme.cyan}>{"  export ANTHROPIC_API_KEY=sk-ant-..."}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>any key to exit</Text>
      </Box>
    </Box>
  );
}

const INPUT_HISTORY_CAP = 100;

function Chat({ cwd }: { cwd: string }): JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const client = useMemo(() => createClient(), []);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Array<{ role: "user" | "assistant"; content: string }>>(
    [],
  );
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [composerMode, setComposerMode] = useState<"line" | "textarea">("line");
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerCursor, setPickerCursor] = useState(0);
  const [slashCursor, setSlashCursor] = useState(0);
  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  const [reviewCursor, setReviewCursor] = useState(0);
  const [keptOutputs, setKeptOutputs] = useState<Set<string>>(new Set());
  const [deletedOutputs, setDeletedOutputs] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const itemIdRef = useRef(0);
  const outputsRef = useRef<Set<string>>(new Set());
  const submitRef = useRef<(text: string) => Promise<void>>(async () => undefined);

  const nextId = useCallback(() => {
    itemIdRef.current += 1;
    return `i${itemIdRef.current}`;
  }, []);

  const pushInputHistory = useCallback((text: string) => {
    setInputHistory((prev) => {
      const next = prev.length > 0 && prev[prev.length - 1] === text ? prev : [...prev, text];
      return next.length > INPUT_HISTORY_CAP ? next.slice(next.length - INPUT_HISTORY_CAP) : next;
    });
    setHistoryCursor(null);
  }, []);

  // Outputs are intentionally ephemeral — sweep them on any path that ends
  // the session. process.on('exit') covers /quit, ctrl+c (Ink translates
  // SIGINT into a graceful exit when exitOnCtrlC is set), and the natural
  // event-loop drain. Unhandled SIGKILL still leaks files, which is
  // acceptable for a temp file in cwd.
  useEffect(() => {
    const sweep = () => {
      for (const path of outputsRef.current) {
        try {
          unlinkSync(path);
        } catch {
          // File may have been moved/deleted by the user already — fine.
        }
      }
      outputsRef.current.clear();
    };
    process.on("exit", sweep);
    return () => {
      process.off("exit", sweep);
    };
  }, []);

  const activePicker = useMemo<SlashItem | null>(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it) continue;
      if (it.kind === "slash" && it.picker) return it;
      // Anything other than a slash item invalidates the picker (the user
      // moved on conversationally or another slash command landed).
      if (it.kind !== "slash") break;
    }
    return null;
  }, [items]);

  const filteredPickerOptions = useMemo(
    () => activePicker?.picker ? filterPickerOptions(activePicker.picker.options, pickerQuery) : [],
    [activePicker, pickerQuery],
  );
  const slashOptions = useMemo(() => slashCommandOptions(), []);
  const slashPaletteOpen =
    !activePicker && !busy && composerMode === "line" && input.startsWith("/") && !input.includes(" ");
  const slashQuery = slashPaletteOpen ? input.slice(1) : "";
  const filteredSlashOptions = useMemo(
    () => filterPickerOptions(slashOptions, slashQuery),
    [slashOptions, slashQuery],
  );
  const activeReview = useMemo(() => {
    const item = activeReviewId
      ? items.find((candidate) => candidate.kind === "tool" && candidate.id === activeReviewId)
      : null;
    return item?.kind === "tool" ? compressionReviewFromTool(item) : null;
  }, [activeReviewId, items]);
  const reviewActions = useMemo(
    () => activeReview ? reviewActionOptions(activeReview, keptOutputs, deletedOutputs) : [],
    [activeReview, deletedOutputs, keptOutputs],
  );

  useEffect(() => {
    setPickerQuery("");
    setPickerCursor(0);
  }, [activePicker?.id]);

  useEffect(() => {
    setPickerCursor((prev) => {
      if (filteredPickerOptions.length === 0) return 0;
      return Math.max(0, Math.min(prev, filteredPickerOptions.length - 1));
    });
  }, [filteredPickerOptions.length]);

  useEffect(() => {
    setSlashCursor((prev) => {
      if (filteredSlashOptions.length === 0) return 0;
      return Math.max(0, Math.min(prev, filteredSlashOptions.length - 1));
    });
  }, [filteredSlashOptions.length]);

  useEffect(() => {
    setReviewCursor((prev) => {
      if (reviewActions.length === 0) return 0;
      return Math.max(0, Math.min(prev, reviewActions.length - 1));
    });
  }, [reviewActions.length]);

  const submitPickerSelection = useCallback(() => {
    const choice = filteredPickerOptions[pickerCursor];
    if (!choice) return;
    setPickerQuery("");
    setPickerCursor(0);
    void submitRef.current(choice.payload);
  }, [filteredPickerOptions, pickerCursor]);

  const insertSlashCommand = useCallback((payload: string) => {
    setInput(payload.endsWith(" ") ? payload : `${payload} `);
    setSlashCursor(0);
  }, []);

  const selectSlashCommand = useCallback(() => {
    const choice = filteredSlashOptions[slashCursor];
    if (!choice) return;
    insertSlashCommand(choice.payload);
  }, [filteredSlashOptions, insertSlashCommand, slashCursor]);

  const pushSystem = useCallback((text: string, tone: "info" | "error" = "info") => {
    setItems((prev) => [
      ...prev,
      { kind: "system", id: nextId(), text, tone },
    ]);
  }, [nextId]);

  const closePicker = useCallback((text: string) => {
    pushSystem(text);
  }, [pushSystem]);

  const selectReviewAction = useCallback(async () => {
    if (!activeReview) return;
    const action = reviewActions[reviewCursor];
    if (!action || action.disabled) return;
    const actionId = action.id as ReviewActionId;
    switch (actionId) {
      case "open":
        try {
          await openInDefaultViewer(activeReview.outputPath);
          pushSystem(`opened ${activeReview.outputPath}`);
        } catch (err) {
          pushSystem(err instanceof Error ? err.message : String(err), "error");
        }
        return;
      case "keep":
        outputsRef.current.delete(activeReview.outputPath);
        setKeptOutputs((prev) => new Set(prev).add(activeReview.outputPath));
        pushSystem(`kept ${activeReview.outputPath}`);
        return;
      case "copy": {
        const copied = copyTextToClipboard(activeReview.outputPath);
        if (copied.ok) pushSystem(`copied ${activeReview.outputPath}`);
        else pushSystem(copied.message, "error");
        return;
      }
      case "again":
        setInput(retryPromptForReview(activeReview));
        setActiveReviewId(null);
        setReviewCursor(0);
        return;
      case "delete":
        try {
          unlinkSync(activeReview.outputPath);
          outputsRef.current.delete(activeReview.outputPath);
          setDeletedOutputs((prev) => new Set(prev).add(activeReview.outputPath));
          setKeptOutputs((prev) => {
            const next = new Set(prev);
            next.delete(activeReview.outputPath);
            return next;
          });
          setActiveReviewId(null);
          setReviewCursor(0);
          pushSystem(`deleted ${activeReview.outputPath}`);
        } catch (err) {
          pushSystem(err instanceof Error ? err.message : String(err), "error");
        }
        return;
    }
  }, [activeReview, pushSystem, reviewActions, reviewCursor]);

  useInput((inputChar, key) => {
    if (key.escape) {
      if (busy && abortRef.current) abortRef.current.abort();
      else if (activePicker) {
        // Push a no-op item so activePicker's "most-recent" check stops
        // matching this picker.
        closePicker("picker dismissed");
      } else if (slashPaletteOpen) {
        setInput("");
        setSlashCursor(0);
      } else if (activeReviewId) {
        setActiveReviewId(null);
      } else if (scrollOffset > 0) {
        setScrollOffset(0);
      }
      return;
    }
    if (inputChar === "?" && input.length === 0 && !busy && !activePicker && composerMode === "line") {
      setShowHelp((prev) => !prev);
      return;
    }
    if (key.pageUp) {
      const half = Math.max(2, Math.floor(viewportRows / 2));
      setScrollOffset((prev) => prev + half);
      return;
    }
    if (key.pageDown) {
      const half = Math.max(2, Math.floor(viewportRows / 2));
      setScrollOffset((prev) => Math.max(0, prev - half));
      return;
    }
    if (busy) return;
    if (composerMode === "textarea") return;
    if (activePicker) {
      if (key.upArrow) {
        setPickerCursor((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setPickerCursor((prev) => Math.min(Math.max(0, filteredPickerOptions.length - 1), prev + 1));
        return;
      }
      // Keep the old quick-pick behavior for the first nine visible options.
      if (/^[1-9]$/.test(inputChar) && pickerQuery.length === 0) {
        const choice = activePicker.picker?.options.find((o) => o.key === inputChar);
        if (choice) {
          setPickerQuery("");
          setPickerCursor(0);
          if (key.shift) {
            void submitRef.current(choice.payload);
          } else {
            setInput(choice.payload);
            closePicker("picker selected");
          }
        }
        return;
      }
      return;
    }
    if (slashPaletteOpen) {
      if (key.upArrow) {
        setSlashCursor((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSlashCursor((prev) => Math.min(Math.max(0, filteredSlashOptions.length - 1), prev + 1));
        return;
      }
      if (/^[1-9]$/.test(inputChar)) {
        const choice = filteredSlashOptions[Number(inputChar) - 1];
        if (choice) {
          insertSlashCommand(choice.payload);
        }
        return;
      }
    }
    if (activeReview && input.length === 0) {
      if (key.upArrow) {
        setReviewCursor((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setReviewCursor((prev) => Math.min(Math.max(0, reviewActions.length - 1), prev + 1));
        return;
      }
      if (key.return) {
        void selectReviewAction();
        return;
      }
    }
    if (key.ctrl && inputChar === "n") {
      setComposerMode((prev) => (prev === "line" ? "textarea" : "line"));
      return;
    }
    if (key.upArrow) {
      if (inputHistory.length === 0) return;
      const next = historyCursor == null ? inputHistory.length - 1 : Math.max(0, historyCursor - 1);
      setHistoryCursor(next);
      setInput(inputHistory[next] ?? "");
      return;
    }
    if (key.downArrow) {
      if (historyCursor == null) return;
      const next = historyCursor + 1;
      if (next >= inputHistory.length) {
        setHistoryCursor(null);
        setInput("");
      } else {
        setHistoryCursor(next);
        setInput(inputHistory[next] ?? "");
      }
      return;
    }
  });

  const subscriber = useMemo<AgentSubscriber>(
    () => ({
      onAssistantText(delta) {
        setItems((prev) => {
          const last = prev[prev.length - 1];
          if (last?.kind === "assistant") {
            const updated: AssistantItem = { ...last, text: last.text + delta };
            return [...prev.slice(0, -1), updated];
          }
          return [...prev, { kind: "assistant", id: `a${itemIdRef.current++}`, text: delta }];
        });
      },
      onToolStart(toolId, name, toolInput) {
        const base: ToolItem = {
          kind: "tool",
          id: toolId,
          name,
          input: toolInput,
          status: "running",
          startedAt: Date.now(),
        };
        const next: ToolItem =
          name === "compress_video" ? { ...base, progress: [] } : base;
        setItems((prev) => [...prev, next]);
      },
      onToolProgress(toolId, event) {
        if (event.type === "done" && event.artifacts.length > 0) {
          setActiveReviewId(toolId);
          setReviewCursor(0);
        }
        setItems((prev) =>
          prev.map((item) => {
            if (item.kind !== "tool" || item.id !== toolId) return item;
            const next: ToolItem = {
              ...item,
              progress: [...(item.progress ?? []), event],
            };
            return next;
          }),
        );
      },
      onToolEnd(toolId, summary, isError) {
        setItems((prev) =>
          prev.map((item) => {
            if (item.kind !== "tool" || item.id !== toolId) return item;
            const next: ToolItem = {
              ...item,
              status: isError ? "error" : "ok",
              finishedAt: Date.now(),
              summary,
            };
            return next;
          }),
        );
      },
      onOutputCreated(path) {
        outputsRef.current.add(path);
      },
    }),
    [],
  );

  const clearAll = useCallback(() => {
    setItems([]);
    setHistory([]);
    setScrollOffset(0);
  }, []);

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      const slash = parseSlash(trimmed);
      if (slash) {
        setInput("");
        setComposerMode("line");
        pushInputHistory(trimmed);
        setItems((prev) => [...prev, { kind: "user", id: nextId(), text: trimmed }]);
        setScrollOffset(0);
        try {
          const result = await runSlash(slash, {
            cwd,
            onClear: clearAll,
            onQuit: () => exit(),
          });
          if (result.ok) {
            const item: SlashItem = {
              kind: "slash",
              id: nextId(),
              card: result.card,
              status: "ok",
              summary: result.summary,
              ...(result.details ? { details: result.details } : {}),
              ...(result.table ? { table: result.table } : {}),
              ...(result.picker ? { picker: result.picker } : {}),
            };
            setItems((prev) => [...prev, item]);
          } else {
            setItems((prev) => [
              ...prev,
              {
                kind: "slash",
                id: nextId(),
                card: result.card,
                status: "error",
                summary: result.message,
              },
            ]);
          }
        } catch (err) {
          setItems((prev) => [
            ...prev,
            {
              kind: "system",
              id: nextId(),
              text: err instanceof Error ? err.message : String(err),
              tone: "error",
            },
          ]);
        }
        return;
      }

      setInput("");
      setComposerMode("line");
      pushInputHistory(trimmed);
      setItems((prev) => [...prev, { kind: "user", id: nextId(), text: trimmed }]);
      setScrollOffset(0);
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const result = await runTurn({
          client,
          cwd,
          history,
          userInput: trimmed,
          subscriber,
          signal: ac.signal,
        });
        setHistory((prev) => [
          ...prev,
          { role: "user", content: trimmed },
          { role: "assistant", content: result.assistantText },
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setItems((prev) => [
          ...prev,
          {
            kind: "system",
            id: nextId(),
            text: ac.signal.aborted ? "aborted" : message,
            tone: "error",
          },
        ]);
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, clearAll, client, cwd, exit, history, nextId, pushInputHistory, subscriber],
  );

  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  const totalRows = stdout?.rows ?? 24;
  const totalColumns = stdout?.columns ?? 80;
  // Reserve rows for header (~6), input box + footer (~3), spinner (~1).
  const viewportRows = Math.max(6, totalRows - 12);
  const progressWidth = Math.max(10, Math.min(32, totalColumns - 44));
  const now = useNow(items.some((item) => item.kind === "tool" && item.status === "running"));

  const viewport = useMemo(
    () => buildTranscriptViewport(items, viewportRows, scrollOffset),
    [items, scrollOffset, viewportRows],
  );

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Header />
      <Box flexDirection="column">
        {viewport.hiddenBelow > 0 ? (
          <Box>
            <Text color={theme.muted}>{`  ↓ ${viewport.hiddenBelow} transcript rows to latest · PgDn to follow`}</Text>
          </Box>
        ) : null}
        {viewport.items.map((item) => (
          <ChatItemView
            key={item.id}
            item={item}
            now={now}
            progressWidth={progressWidth}
            activePickerId={activePicker?.id ?? null}
            pickerQuery={pickerQuery}
            filteredPickerOptions={filteredPickerOptions}
            pickerCursor={pickerCursor}
            activeReviewId={input.length === 0 ? activeReviewId : null}
            reviewActions={reviewActions}
            reviewCursor={reviewCursor}
            keptOutputs={keptOutputs}
            deletedOutputs={deletedOutputs}
          />
        ))}
      </Box>
      {busy ? (
        <Box marginTop={1}>
          <Text color={theme.cyan}>
            <Spinner type="dots" />
          </Text>
          <Text color={theme.muted}>{"  thinking… (esc to abort)"}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Composer
          mode={activePicker ? "line" : composerMode}
          value={activePicker ? pickerQuery : input}
          onChange={activePicker ? setPickerQuery : setInput}
          onSubmit={activePicker ? submitPickerSelection : slashPaletteOpen ? selectSlashCommand : submit}
          onCancelMultiline={() => setComposerMode("line")}
          placeholder={activePicker ? PICKER_PLACEHOLDER : INPUT_PLACEHOLDER}
          disabled={busy}
        />
        {slashPaletteOpen ? (
          <PickerPanel
            kind="commands"
            query={slashQuery}
            options={filteredSlashOptions}
            cursor={slashCursor}
          />
        ) : null}
      </Box>
      <Footer
        busy={busy}
        items={items}
        now={now}
        showHelp={showHelp}
        activePicker={activePicker}
        slashPaletteOpen={slashPaletteOpen}
        reviewActive={activeReview != null && input.length === 0}
        composerMode={composerMode}
        hiddenBelow={viewport.hiddenBelow}
      />
    </Box>
  );
}

function Header(): JSX.Element {
  return (
    <Box flexDirection="column">
      <Mascot />
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text color={theme.pink} bold>
          video-strip-club · agent
        </Text>
        <Text color={theme.muted}>chat to encode · powered by Claude + ffmpeg</Text>
      </Box>
    </Box>
  );
}

function buildTranscriptViewport(
  items: ChatItem[],
  rows: number,
  scrollRows: number,
): { items: ChatItem[]; hiddenAbove: number; hiddenBelow: number } {
  const heights = items.map(estimateItemRows);
  const total = heights.reduce((sum, height) => sum + height, 0);
  const maxScroll = Math.max(0, total - rows);
  const effectiveScroll = Math.min(scrollRows, maxScroll);
  const bottom = total - effectiveScroll;
  const top = Math.max(0, bottom - rows);

  let cursor = 0;
  const visible: ChatItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const height = heights[i] ?? 1;
    const itemTop = cursor;
    const itemBottom = cursor + height;
    cursor = itemBottom;
    if (itemBottom > top && itemTop < bottom) visible.push(items[i]!);
  }

  return {
    items: visible,
    hiddenAbove: top,
    hiddenBelow: total - bottom,
  };
}

function estimateItemRows(item: ChatItem): number {
  switch (item.kind) {
    case "user":
    case "assistant":
      return 2 + countLines(item.text);
    case "system":
      return 1 + countLines(item.text);
    case "slash": {
      const detailRows = item.details?.length ?? 0;
      const tableRows = item.table
        ? 2 + Math.min(item.table.rows.length, item.table.maxRows ?? item.table.rows.length)
        : 0;
      const pickerRows = item.picker ? Math.min(item.picker.options.length, 8) + 2 : 0;
      return 2 + detailRows + tableRows + pickerRows;
    }
    case "tool": {
      const progressRows = item.progress ? estimateProgressRows(item.progress) : 0;
      const reviewRows = item.name === "compress_video" && item.progress?.some((event) => event.type === "done")
        ? 10
        : 0;
      return 1 + progressRows + reviewRows + (item.summary ? 1 : 0);
    }
  }
}

function estimateProgressRows(events: ProgressEvent[]): number {
  for (const event of events) {
    if (event.type === "start") return event.phases.length + 1;
  }
  return events.length > 0 ? 1 : 0;
}

function countLines(text: string): number {
  return Math.max(1, text.split("\n").length);
}

function ChatItemView({
  item,
  now,
  progressWidth,
  activePickerId,
  pickerQuery,
  filteredPickerOptions,
  pickerCursor,
  activeReviewId,
  reviewActions,
  reviewCursor,
  keptOutputs,
  deletedOutputs,
}: {
  item: ChatItem;
  now: number;
  progressWidth: number;
  activePickerId: string | null;
  pickerQuery: string;
  filteredPickerOptions: PickerOption[];
  pickerCursor: number;
  activeReviewId: string | null;
  reviewActions: ActionOption[];
  reviewCursor: number;
  keptOutputs: Set<string>;
  deletedOutputs: Set<string>;
}): JSX.Element {
  switch (item.kind) {
    case "user":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.cyan} bold>
            you
          </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.pink} bold>
            agent
          </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "tool":
      return (
        <ToolView
          item={item}
          now={now}
          progressWidth={progressWidth}
          reviewActive={item.id === activeReviewId}
          reviewActions={reviewActions}
          reviewCursor={reviewCursor}
          keptOutputs={keptOutputs}
          deletedOutputs={deletedOutputs}
        />
      );
    case "slash":
      return (
        <SlashView
          item={item}
          active={item.id === activePickerId}
          pickerQuery={pickerQuery}
          filteredPickerOptions={filteredPickerOptions}
          pickerCursor={pickerCursor}
        />
      );
    case "system":
      return (
        <Box marginTop={1}>
          <Text color={item.tone === "error" ? theme.red : theme.muted}>
            {item.tone === "error" ? `${symbols.cross} ` : `${symbols.bullet} `}
            {item.text}
          </Text>
        </Box>
      );
  }
}

function SlashView({
  item,
  active,
  pickerQuery,
  filteredPickerOptions,
  pickerCursor,
}: {
  item: SlashItem;
  active: boolean;
  pickerQuery: string;
  filteredPickerOptions: PickerOption[];
  pickerCursor: number;
}): JSX.Element {
  const glyph =
    item.status === "ok" ? (
      <Text color={theme.green}>{symbols.check}</Text>
    ) : (
      <Text color={theme.red}>{symbols.cross}</Text>
    );
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {glyph}
        <Text color={theme.muted}>{"  cmd · "}</Text>
        <Text color={theme.cyan}>{item.card}</Text>
      </Box>
      <Box>
        <Text color={theme.muted}>{"  → "}</Text>
        <Text color={item.status === "error" ? theme.red : theme.muted}>{item.summary}</Text>
      </Box>
      {item.details && item.details.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {item.details.map((line, i) => (
            <Text key={`${item.id}-d-${i}`} color={theme.muted}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      {item.table ? <DataTable table={item.table} /> : null}
      {item.picker && active ? (
        <PickerPanel
          kind={item.picker.kind}
          query={pickerQuery}
          options={filteredPickerOptions}
          cursor={pickerCursor}
        />
      ) : item.picker ? (
        <Text color={theme.muted}>{"  picker closed · run the command again to reopen"}</Text>
      ) : null}
    </Box>
  );
}

function Footer({
  busy,
  items,
  now,
  showHelp,
  activePicker,
  slashPaletteOpen,
  reviewActive,
  composerMode,
  hiddenBelow,
}: {
  busy: boolean;
  items: ChatItem[];
  now: number;
  showHelp: boolean;
  activePicker: SlashItem | null;
  slashPaletteOpen: boolean;
  reviewActive: boolean;
  composerMode: "line" | "textarea";
  hiddenBelow: number;
}): JSX.Element {
  if (busy) {
    const status = summarizeBusy(items, now);
    return (
      <Box>
        <Text color={theme.muted}>{status}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <HelpBar
        expanded={showHelp}
        bindings={helpBindings({ activePicker, slashPaletteOpen, reviewActive, composerMode, hiddenBelow })}
      />
    </Box>
  );
}

function summarizeBusy(items: ChatItem[], now: number): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it || it.kind !== "tool" || it.status !== "running") continue;
    const elapsed = ` · ${Math.round((now - it.startedAt) / 1000)}s`;
    if (it.name === "compress_video" && it.progress) {
      const phase = currentRunningPhase(it.progress);
      if (phase) {
        return `↻ ${phase.name} ${renderMiniBar(phase.pct)} ${phase.pct}%${phase.speed != null ? ` · ${phase.speed.toFixed(2)}x` : ""}${elapsed} · esc to abort`;
      }
      return `↻ encoding${elapsed} · esc to abort`;
    }
    return `↻ ${it.name}${elapsed} · esc to abort`;
  }
  return "↻ thinking · esc to abort";
}

function helpBindings({
  activePicker,
  slashPaletteOpen,
  reviewActive,
  composerMode,
  hiddenBelow,
}: {
  activePicker: SlashItem | null;
  slashPaletteOpen: boolean;
  reviewActive: boolean;
  composerMode: "line" | "textarea";
  hiddenBelow: number;
}): HelpBinding[] {
  if (slashPaletteOpen) {
    return [
      { keys: "type", label: "filter commands" },
      { keys: "↑/↓", label: "move" },
      { keys: "enter", label: "insert command" },
      { keys: "1-9", label: "quick insert" },
      { keys: "esc", label: "close" },
    ];
  }
  if (reviewActive) {
    return [
      { keys: "↑/↓", label: "move result action" },
      { keys: "enter", label: "run action" },
      { keys: "esc", label: "close result actions" },
    ];
  }
  if (activePicker) {
    return [
      { keys: "type", label: "filter picker" },
      { keys: "↑/↓", label: "move" },
      { keys: "enter", label: "pick" },
      { keys: "1-9", label: "quick insert" },
      { keys: "esc", label: "dismiss" },
    ];
  }
  if (composerMode === "textarea") {
    return [
      { keys: "enter", label: "newline" },
      { keys: "ctrl+s", label: "send" },
      { keys: "esc", label: "single line" },
      { keys: "PgUp/PgDn", label: hiddenBelow > 0 ? "scroll/follow" : "scroll" },
    ];
  }
  return [
    { keys: "enter", label: "send" },
    { keys: "/", label: "commands" },
    { keys: "ctrl+n", label: "textarea" },
    { keys: "↑/↓", label: "history" },
    { keys: "PgUp/PgDn", label: hiddenBelow > 0 ? "scroll/follow" : "scroll" },
    { keys: "esc", label: "cancel" },
    { keys: "?", label: "help" },
  ];
}

function currentRunningPhase(events: ProgressEvent[]): { name: string; pct: number; speed: number | null } | null {
  // The most recent progress or phase-start event identifies what's running.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.type === "progress") {
      return { name: e.phase, pct: e.currentPct, speed: e.speedX };
    }
    if (e.type === "phase-start") {
      return { name: e.phase, pct: 0, speed: null };
    }
  }
  return null;
}

function renderMiniBar(pct: number): string {
  const width = 10;
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

interface CompressionReviewData {
  inputPath: string;
  outputPath: string;
  preset: string;
  kind: string;
  originalBytes: number | null;
  outputBytes: number;
  savedPct: number | null;
  summary?: string;
}

function CompressionReview({
  item,
  active,
  actions,
  cursor,
  keptOutputs,
  deletedOutputs,
}: {
  item: ToolItem;
  active: boolean;
  actions: ActionOption[];
  cursor: number;
  keptOutputs: Set<string>;
  deletedOutputs: Set<string>;
}): JSX.Element | null {
  const review = compressionReviewFromTool(item);
  if (!review) return null;
  const status = reviewStatus(review, keptOutputs, deletedOutputs);
  const saved =
    review.savedPct == null
      ? "n/a"
      : `${review.savedPct >= 0 ? "" : "+"}${Math.abs(review.savedPct).toFixed(1)}%`;

  return (
    <Box flexDirection="column" marginTop={0}>
      <Box marginLeft={2}>
        <Text color={theme.pink} bold>Result review</Text>
        <Text color={theme.muted}>{` · ${status}`}</Text>
      </Box>
      <DataTable
        table={{
          columns: [
            { key: "metric", label: "metric", width: 12 },
            { key: "value", label: "value", width: 44 },
          ],
          rows: [
            { metric: "original", value: review.originalBytes == null ? "n/a" : formatBytes(review.originalBytes) },
            { metric: "optimized", value: formatBytes(review.outputBytes) },
            { metric: "saved", value: saved },
            { metric: "format", value: review.kind },
            { metric: "preset", value: review.preset },
            { metric: "output", value: shortenPath(review.outputPath) },
          ],
        }}
      />
      {active ? (
        <ActionList title="Actions" options={actions} cursor={cursor} />
      ) : (
        <Text color={theme.muted}>{"  result actions inactive · latest compression owns the action list"}</Text>
      )}
    </Box>
  );
}

function compressionReviewFromTool(item: ToolItem): CompressionReviewData | null {
  if (item.name !== "compress_video" || !item.progress) return null;
  let start: Extract<ProgressEvent, { type: "start" }> | null = null;
  let done: Extract<ProgressEvent, { type: "done" }> | null = null;
  for (const event of item.progress) {
    if (event.type === "start") start = event;
    else if (event.type === "done") done = event;
  }
  const primary = done?.artifacts[0];
  if (!primary) return null;
  const originalBytes = start?.inputSizeBytes ?? null;
  const savedPct =
    originalBytes && originalBytes > 0
      ? ((originalBytes - primary.sizeBytes) / originalBytes) * 100
      : null;
  const input = typeof item.input === "object" && item.input !== null
    ? item.input as Record<string, unknown>
    : {};
  const inputPath = typeof input["path"] === "string" ? input["path"] : start?.input ?? "";
  const preset = start?.preset ?? (typeof input["preset"] === "string" ? input["preset"] : "unknown");
  return {
    inputPath,
    outputPath: primary.path,
    preset,
    kind: formatArtifactKind(primary),
    originalBytes,
    outputBytes: primary.sizeBytes,
    savedPct,
    ...(item.summary ? { summary: item.summary } : {}),
  };
}

function reviewActionOptions(
  review: CompressionReviewData,
  keptOutputs: Set<string>,
  deletedOutputs: Set<string>,
): ActionOption[] {
  const deleted = deletedOutputs.has(review.outputPath);
  const kept = keptOutputs.has(review.outputPath);
  return REVIEW_ACTIONS.map((action) => {
    if (action.id === "open") {
      return deleted ? { ...action, disabled: true, detail: "deleted" } : action;
    }
    if (action.id === "keep") {
      return {
        ...action,
        disabled: deleted || kept,
        detail: deleted ? "deleted" : kept ? "already kept" : "prevents session cleanup",
      };
    }
    if (action.id === "delete") {
      return { ...action, disabled: deleted, detail: deleted ? "already deleted" : "remove now" };
    }
    if (action.id === "again") {
      return { ...action, detail: "insert retry prompt" };
    }
    return action;
  });
}

function reviewStatus(
  review: CompressionReviewData,
  keptOutputs: Set<string>,
  deletedOutputs: Set<string>,
): string {
  if (deletedOutputs.has(review.outputPath)) return "deleted";
  if (keptOutputs.has(review.outputPath)) return "kept";
  if (review.summary?.includes("auto-open failed")) return "auto-open failed";
  if (review.summary?.includes("· opened")) return "opened automatically";
  return "ready";
}

function formatArtifactKind(a: NonNullable<Extract<ProgressEvent, { type: "done" }>["artifacts"][number]>): string {
  if (a.kind === "video") return `${a.codec}/${a.container}`;
  if (a.kind === "poster") return `poster ${a.format}`;
  return "gif";
}

function retryPromptForReview(review: CompressionReviewData): string {
  return `compress ${review.inputPath} again with ${review.preset}`;
}

function copyTextToClipboard(text: string): { ok: true } | { ok: false; message: string } {
  const attempts =
    process.platform === "darwin"
      ? [{ command: "pbcopy", args: [] }]
      : process.platform === "win32"
        ? [{ command: "clip", args: [] }]
        : [
            { command: "wl-copy", args: [] },
            { command: "xclip", args: ["-selection", "clipboard"] },
            { command: "xsel", args: ["--clipboard", "--input"] },
          ];
  for (const attempt of attempts) {
    const result = spawnSync(attempt.command, attempt.args, { input: text });
    if (!result.error && result.status === 0) return { ok: true };
  }
  return { ok: false, message: "clipboard command not available" };
}

function ToolView({
  item,
  now,
  progressWidth,
  reviewActive,
  reviewActions,
  reviewCursor,
  keptOutputs,
  deletedOutputs,
}: {
  item: ToolItem;
  now: number;
  progressWidth: number;
  reviewActive: boolean;
  reviewActions: ActionOption[];
  reviewCursor: number;
  keptOutputs: Set<string>;
  deletedOutputs: Set<string>;
}): JSX.Element {
  const statusGlyph =
    item.status === "running" ? (
      <Text color={theme.cyan}>
        <Spinner type="dots" />
      </Text>
    ) : item.status === "ok" ? (
      <Text color={theme.green}>{symbols.check}</Text>
    ) : (
      <Text color={theme.red}>{symbols.cross}</Text>
    );

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {statusGlyph}
        <Text color={theme.muted}>{"  tool · "}</Text>
        <Text color={theme.cyan}>{item.name}</Text>
        <Text color={theme.muted}>{"  "}</Text>
        <Text color={theme.muted}>{formatToolInput(item.name, item.input)}</Text>
        <Text color={theme.muted}>{"  · "}</Text>
        <ElapsedTime startedAt={item.startedAt} finishedAt={item.finishedAt} now={now} />
      </Box>
      {item.name === "compress_video" && item.progress && item.progress.length > 0 ? (
        <CompressProgress events={item.progress} progressWidth={progressWidth} />
      ) : null}
      {item.name === "compress_video" ? (
        <CompressionReview
          item={item}
          active={reviewActive}
          actions={reviewActions}
          cursor={reviewCursor}
          keptOutputs={keptOutputs}
          deletedOutputs={deletedOutputs}
        />
      ) : null}
      {item.summary ? (
        <Box>
          <Text color={theme.muted}>{"  → "}</Text>
          <Text color={item.status === "error" ? theme.red : theme.muted}>{item.summary}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function formatToolInput(name: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const keys = Object.keys(input as Record<string, unknown>);
  if (keys.length === 0) return "";
  const obj = input as Record<string, unknown>;
  const parts = keys.map((k) => {
    const v = obj[k];
    if (k === "path" && typeof v === "string") {
      return `path: ${shortenPath(v)}`;
    }
    return `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`;
  });
  return parts.join(", ");
}

function shortenPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

function CompressProgress({
  events,
  progressWidth,
}: {
  events: ProgressEvent[];
  progressWidth: number;
}): JSX.Element {
  const phases = new Map<string, { pct: number; doneSize: number | null; cached: boolean }>();
  let overallPct = 0;
  let started = false;

  for (const event of events) {
    if (event.type === "start") {
      started = true;
      for (const phase of event.phases) {
        phases.set(phase.name, { pct: 0, doneSize: null, cached: false });
      }
    } else if (event.type === "progress") {
      const existing = phases.get(event.phase) ?? { pct: 0, doneSize: null, cached: false };
      phases.set(event.phase, { ...existing, pct: event.currentPct });
      overallPct = event.overall.pct;
    } else if (event.type === "phase-done") {
      const existing = phases.get(event.phase) ?? { pct: 100, doneSize: null, cached: false };
      phases.set(event.phase, {
        ...existing,
        pct: 100,
        doneSize: event.sizeBytes,
        cached: event.cached,
      });
    }
  }

  if (!started && phases.size === 0) {
    return (
      <Box marginLeft={2} marginTop={0}>
        <Text color={theme.muted}>{"  starting…"}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={2}>
      {Array.from(phases.entries()).map(([name, phase]) => (
        <PhaseRow
          key={name}
          name={name}
          pct={phase.pct}
          doneSize={phase.doneSize}
          cached={phase.cached}
          progressWidth={Math.max(8, progressWidth - 4)}
        />
      ))}
      {phases.size > 0 ? (
        <Box marginTop={0}>
          <Text color={theme.muted}>overall </Text>
          <ProgressBar pct={overallPct} width={progressWidth} color={theme.pink} />
          <Text color={theme.muted}>{` ${overallPct}%`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function PhaseRow({
  name,
  pct,
  doneSize,
  cached,
  progressWidth,
}: {
  name: string;
  pct: number;
  doneSize: number | null;
  cached: boolean;
  progressWidth: number;
}): JSX.Element {
  if (doneSize !== null) {
    return (
      <Text>
        <Text color={theme.green}>{symbols.check}</Text>
        {"  "}
        {name.padEnd(14)}
        <Text color={theme.muted}>
          {formatBytes(doneSize)}
          {cached ? " (cached)" : ""}
        </Text>
      </Text>
    );
  }
  return (
    <Text>
      <Text color={theme.cyan}>{symbols.bullet}</Text>
      {"  "}
      {name.padEnd(14)}
      <ProgressBar pct={pct} width={progressWidth} color={theme.cyan} />
      <Text color={theme.muted}>{` ${pct}%`}</Text>
    </Text>
  );
}
