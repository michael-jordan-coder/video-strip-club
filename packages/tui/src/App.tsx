import { unlinkSync } from "node:fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { theme, symbols } from "./theme.ts";
import { formatBytes } from "./lib/files.ts";
import { createClient, runTurn } from "./lib/agent.ts";
import type { AgentSubscriber } from "./lib/agent.ts";
import type { ProgressEvent } from "./types.ts";

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

type ChatItem = UserItem | AssistantItem | ToolItem | SystemItem;

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

function Chat({ cwd }: { cwd: string }): JSX.Element {
  const { exit } = useApp();
  const client = useMemo(() => createClient(), []);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Array<{ role: "user" | "assistant"; content: string }>>(
    [],
  );
  const abortRef = useRef<AbortController | null>(null);
  const itemIdRef = useRef(0);
  const outputsRef = useRef<Set<string>>(new Set());

  const nextId = useCallback(() => {
    itemIdRef.current += 1;
    return `i${itemIdRef.current}`;
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

  useInput((inputChar, key) => {
    if (key.escape && busy && abortRef.current) {
      abortRef.current.abort();
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

  const submit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      if (trimmed === "/quit" || trimmed === "/exit") {
        exit();
        return;
      }
      setInput("");
      setItems((prev) => [...prev, { kind: "user", id: nextId(), text: trimmed }]);
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
    [busy, client, cwd, exit, history, nextId, subscriber],
  );

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Header />
      <Box flexDirection="column">
        {items.map((item) => (
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
      <Box>
        <Text color={theme.muted}>⏎ send · esc abort · /quit</Text>
      </Box>
    </Box>
  );
}

function Header(): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color={theme.pink} bold>
        video-strip-club · agent
      </Text>
      <Text color={theme.muted}>chat to encode · powered by Claude + ffmpeg</Text>
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
