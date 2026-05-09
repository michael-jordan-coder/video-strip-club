import { unlinkSync } from "node:fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { theme, symbols } from "./theme.ts";
import { formatBytes } from "./lib/files.ts";
import { createClient, runTurn } from "./lib/agent.ts";
import type { AgentSubscriber } from "./lib/agent.ts";
import { parseSlash, runSlash } from "./lib/slash.ts";
import type { PickerOption } from "./lib/slash.ts";
import type { ProgressEvent } from "./types.ts";
import { Mascot } from "./Mascot.tsx";

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
  picker?: { kind: "files" | "presets"; options: PickerOption[] };
}

type ChatItem = UserItem | AssistantItem | ToolItem | SystemItem | SlashItem;

const INPUT_PLACEHOLDER = "ask anything · e.g. compress hero.mp4 for the landing page";

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
  const abortRef = useRef<AbortController | null>(null);
  const itemIdRef = useRef(0);
  const outputsRef = useRef<Set<string>>(new Set());

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

  useInput((inputChar, key) => {
    if (key.escape) {
      if (busy && abortRef.current) abortRef.current.abort();
      else if (activePicker) {
        // Dismiss the picker by pushing a no-op system note so it stops
        // matching activePicker's "most-recent" check.
        setItems((prev) => [
          ...prev,
          { kind: "system", id: nextId(), text: "picker dismissed", tone: "info" },
        ]);
      } else if (scrollOffset > 0) {
        setScrollOffset(0);
      }
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
    // Picker selection (1-9): only when input is empty so digit-typing in the
    // text box still works for normal input.
    if (activePicker && /^[1-9]$/.test(inputChar) && input.length === 0) {
      const choice = activePicker.picker?.options.find((o) => o.key === inputChar);
      if (choice) {
        if (key.shift) {
          // Shift+digit: auto-submit
          void submitRef.current(choice.payload);
        } else {
          setInput(choice.payload);
        }
      }
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
        };
        const next: ToolItem =
          name === "compress_video" ? { ...base, progress: [] } : base;
        setItems((prev) => [...prev, next]);
      },
      onToolProgress(toolId, event) {
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

  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  const totalRows = stdout?.rows ?? 24;
  // Reserve rows for header (~6), input box + footer (~3), spinner (~1).
  const viewportRows = Math.max(6, totalRows - 12);

  const visibleItems = useMemo(() => {
    if (scrollOffset === 0) return items;
    const cut = Math.min(items.length, scrollOffset);
    return items.slice(0, items.length - cut);
  }, [items, scrollOffset]);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Header />
      <Box flexDirection="column">
        {scrollOffset > 0 ? (
          <Box>
            <Text color={theme.muted}>{`  ↑ ${scrollOffset} more · PgDn to follow latest`}</Text>
          </Box>
        ) : null}
        {visibleItems.map((item) => (
          <ChatItemView key={item.id} item={item} />
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
      <Box marginTop={1}>
        <Text color={theme.pink}>{`${symbols.pointer} `}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={submit}
          placeholder={INPUT_PLACEHOLDER}
        />
      </Box>
      <Footer busy={busy} items={items} />
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

function ChatItemView({ item }: { item: ChatItem }): JSX.Element {
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
      return <ToolView item={item} />;
    case "slash":
      return <SlashView item={item} />;
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

function SlashView({ item }: { item: SlashItem }): JSX.Element {
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
      {item.picker ? <PickerView picker={item.picker} /> : null}
    </Box>
  );
}

function PickerView({
  picker,
}: {
  picker: { kind: "files" | "presets"; options: PickerOption[] };
}): JSX.Element {
  return (
    <Box flexDirection="column" marginLeft={2} marginTop={0}>
      {picker.options.map((opt) => (
        <Text key={opt.key}>
          <Text color={theme.pink} bold>{`${opt.key} `}</Text>
          <Text color={theme.muted}>{opt.label}</Text>
        </Text>
      ))}
      <Text color={theme.muted}>{"  press 1-9 (shift = submit) · esc to dismiss"}</Text>
    </Box>
  );
}

function Footer({ busy, items }: { busy: boolean; items: ChatItem[] }): JSX.Element {
  if (busy) {
    const status = summarizeBusy(items);
    return (
      <Box>
        <Text color={theme.muted}>{status}</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text color={theme.muted}>
        ⏎ send · / commands · ↑↓ history · PgUp/PgDn scroll · esc cancel · /quit
      </Text>
    </Box>
  );
}

function summarizeBusy(items: ChatItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it || it.kind !== "tool" || it.status !== "running") continue;
    if (it.name === "compress_video" && it.progress) {
      const phase = currentRunningPhase(it.progress);
      if (phase) {
        return `↻ ${phase.name} ${renderMiniBar(phase.pct)} ${phase.pct}%${phase.speed != null ? ` · ${phase.speed.toFixed(2)}x` : ""} · esc to abort`;
      }
      return `↻ encoding · esc to abort`;
    }
    return `↻ ${it.name} · esc to abort`;
  }
  return "↻ thinking · esc to abort";
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

function ToolView({ item }: { item: ToolItem }): JSX.Element {
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
      </Box>
      {item.name === "compress_video" && item.progress && item.progress.length > 0 ? (
        <CompressProgress events={item.progress} />
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

function CompressProgress({ events }: { events: ProgressEvent[] }): JSX.Element {
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
        <PhaseRow key={name} name={name} pct={phase.pct} doneSize={phase.doneSize} cached={phase.cached} />
      ))}
      {phases.size > 0 ? (
        <Box marginTop={0}>
          <Text color={theme.muted}>overall </Text>
          <Bar pct={overallPct} width={20} color={theme.pink} />
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
}: {
  name: string;
  pct: number;
  doneSize: number | null;
  cached: boolean;
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
      <Bar pct={pct} width={16} color={theme.cyan} />
      <Text color={theme.muted}>{` ${pct}%`}</Text>
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
