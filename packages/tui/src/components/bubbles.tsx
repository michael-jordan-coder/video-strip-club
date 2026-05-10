import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { theme, symbols } from "../theme.ts";
import { formatMs } from "../lib/files.ts";
import type { PickerOption, SlashTable } from "../lib/slash.ts";

/**
 * Ink-native UI primitives modeled after Charm's Bubbles package. The TUI is
 * TypeScript/Ink rather than Go/Bubble Tea, so these components provide the
 * same interaction patterns without introducing a second runtime.
 */

export interface HelpBinding {
  keys: string;
  label: string;
}

export interface ActionOption {
  id: string;
  label: string;
  detail?: string;
  disabled?: boolean;
}

export function HelpBar({
  bindings,
  expanded,
}: {
  bindings: HelpBinding[];
  expanded: boolean;
}): JSX.Element {
  if (expanded) {
    return (
      <Box flexDirection="column">
        {bindings.map((binding) => (
          <Text key={`${binding.keys}-${binding.label}`} color={theme.muted}>
            <Text color={theme.cyan}>{binding.keys.padEnd(14)}</Text>
            {binding.label}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Text color={theme.muted}>
      {bindings.map((binding) => `${binding.keys} ${binding.label}`).join(" · ")}
    </Text>
  );
}

export function ProgressBar({
  pct,
  width,
  color,
}: {
  pct: number;
  width: number;
  color: string;
}): JSX.Element {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const empty = width - filled;
  return (
    <Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text color={theme.muted}>{"░".repeat(empty)}</Text>
    </Text>
  );
}

export function DataTable({ table }: { table: SlashTable }): JSX.Element {
  const rows = table.maxRows == null ? table.rows : table.rows.slice(0, table.maxRows);
  const overflow = table.maxRows != null && table.rows.length > table.maxRows
    ? table.rows.length - table.maxRows
    : 0;

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={0}>
      <Text color={theme.muted}>
        {table.columns.map((column) => formatCell(column.label, column.width, "left")).join("  ")}
      </Text>
      <Text color={theme.muted}>
        {table.columns.map((column) => "─".repeat(column.width ?? column.label.length)).join("  ")}
      </Text>
      {rows.map((row, rowIndex) => (
        <Text key={rowIndex}>
          {table.columns.map((column) => (
            <Text key={column.key}>
              {formatCell(String(row[column.key] ?? ""), column.width, column.align)}
              {"  "}
            </Text>
          ))}
        </Text>
      ))}
      {overflow > 0 ? (
        <Text color={theme.muted}>{`… ${overflow} more rows in picker`}</Text>
      ) : null}
    </Box>
  );
}

export function filterPickerOptions(
  options: PickerOption[],
  query: string,
): PickerOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((option) => {
    const haystack = `${option.label}\n${option.payload}`.toLowerCase();
    return haystack.includes(q);
  });
}

export function PickerPanel({
  kind,
  options,
  query,
  cursor,
  visibleRows = 8,
}: {
  kind: "files" | "presets" | "commands";
  options: PickerOption[];
  query: string;
  cursor: number;
  visibleRows?: number;
}): JSX.Element {
  const windowed = useMemo(() => {
    if (options.length <= visibleRows) return options.map((option, index) => ({ option, index }));
    const half = Math.floor(visibleRows / 2);
    const start = Math.max(0, Math.min(cursor - half, options.length - visibleRows));
    return options.slice(start, start + visibleRows).map((option, offset) => ({
      option,
      index: start + offset,
    }));
  }, [cursor, options, visibleRows]);

  const title =
    kind === "files" ? "file picker" : kind === "presets" ? "preset list" : "slash commands";
  const count = options.length === 1 ? "1 match" : `${options.length} matches`;

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={0}>
      <Text color={theme.muted}>
        {title} · {count}
        {query.trim() ? ` · filter: ${query.trim()}` : ""}
      </Text>
      {options.length === 0 ? (
        <Text color={theme.amber}>no matches</Text>
      ) : (
        windowed.map(({ option, index }) => {
          const selected = index === cursor;
          return (
            <Text key={`${option.key}-${option.payload}`}>
              <Text color={selected ? theme.pink : theme.muted}>
                {selected ? symbols.pointer : " "}
                {" "}
              </Text>
              <Text color={selected ? theme.cyan : theme.muted}>{option.label}</Text>
            </Text>
          );
        })
      )}
      <Text color={theme.muted}>type to filter · ↑/↓ move · enter pick · esc dismiss</Text>
    </Box>
  );
}

export function ActionList({
  title,
  options,
  cursor,
}: {
  title: string;
  options: ActionOption[];
  cursor: number;
}): JSX.Element {
  return (
    <Box flexDirection="column" marginLeft={2} marginTop={0}>
      <Text color={theme.muted}>{title}</Text>
      {options.map((option, index) => {
        const selected = index === cursor;
        const color = option.disabled ? theme.muted : selected ? theme.cyan : undefined;
        const content = (
          <>
            <Text color={selected ? theme.pink : theme.muted}>
              {selected ? symbols.pointer : " "}
              {" "}
            </Text>
            {option.label}
            {option.detail ? <Text color={theme.muted}>{` · ${option.detail}`}</Text> : null}
          </>
        );
        return color ? (
          <Text key={option.id} color={color}>{content}</Text>
        ) : (
          <Text key={option.id}>{content}</Text>
        );
      })}
    </Box>
  );
}

export function Composer({
  mode,
  value,
  onChange,
  onSubmit,
  onCancelMultiline,
  placeholder,
  disabled,
}: {
  mode: "line" | "textarea";
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancelMultiline: () => void;
  placeholder: string;
  disabled: boolean;
}): JSX.Element {
  if (mode === "textarea") {
    return (
      <TextareaInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        onCancel={onCancelMultiline}
        placeholder={placeholder}
        disabled={disabled}
      />
    );
  }

  return (
    <Box>
      <Text color={theme.pink}>{`${symbols.pointer} `}</Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={placeholder}
      />
    </Box>
  );
}

function TextareaInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  placeholder: string;
  disabled: boolean;
}): JSX.Element {
  useInput((input, key) => {
    if (disabled) return;
    if (key.ctrl && input === "s") {
      onSubmit(value);
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onChange(`${value}\n`);
      return;
    }
    const keyWithBackspace = key as typeof key & { backspace?: boolean; delete?: boolean };
    if (keyWithBackspace.backspace || keyWithBackspace.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    if (key.ctrl || input.length === 0) return;
    onChange(value + input);
  });

  const lines = value.length > 0 ? value.split("\n") : [placeholder];
  const visible = lines.slice(-5);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.pink} paddingX={1}>
      {visible.map((line, index) =>
        value.length > 0 ? (
          <Text key={index}>{line.length > 0 ? line : " "}</Text>
        ) : (
          <Text key={index} color={theme.muted}>{line.length > 0 ? line : " "}</Text>
        ),
      )}
      <Text color={theme.muted}>enter newline · ctrl+s send · esc single line</Text>
    </Box>
  );
}

export function ElapsedTime({
  startedAt,
  finishedAt,
  now,
}: {
  startedAt: number;
  finishedAt?: number | undefined;
  now: number;
}): JSX.Element {
  const elapsed = Math.max(0, (finishedAt ?? now) - startedAt);
  return <Text color={theme.muted}>{formatMs(elapsed)}</Text>;
}

export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

function formatCell(
  value: string,
  width = value.length,
  align: "left" | "right" = "left",
): string {
  const clipped = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
  return align === "right" ? clipped.padStart(width) : clipped.padEnd(width);
}
