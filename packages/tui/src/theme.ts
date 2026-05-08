/**
 * Charm-flavored palette. Hex codes are passed directly to Ink's <Text color>
 * which forwards them to chalk's truecolor mode.
 */
export const theme = {
  pink: "#FF5FAF",
  cyan: "#06B6D4",
  green: "#10B981",
  amber: "#F59E0B",
  red: "#EF4444",
  muted: "#6B7280",
  bg: "#1F1F1F",
} as const;

export const symbols = {
  arrow: "›",
  check: "✔",
  cross: "✘",
  bullet: "•",
  pointer: "❯",
  spinner: "⣷",
} as const;
