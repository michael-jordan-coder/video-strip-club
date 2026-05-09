import { Box, Text } from "ink";
import { theme } from "./theme.ts";

/**
 * Pink mascot — pixel-art trace of the welcome logo. Lounging pose with
 * arms extended forward (left) and both legs bent up forming an M-shape.
 * The single black eye sits near the front of the head.
 *
 * Two color layers (body / eye) are applied at the segment level by
 * walking each line and grouping runs of same-colored characters, so the
 * silhouette reads cleanly without per-character Text nodes.
 */
const FRAME: readonly string[] = [
  "                ▄▄▄▄▄▄▄▄                            ",
  "             ▄██████████████▄                       ",
  "            ████████████████                        ",
  "           ████████████ ●███                        ",
  "           ██████████████████                       ",
  "          ████████████████                          ",
  "         ███████████████                            ",
  "       ▄████████████████                            ",
  "     ▄██████████████████                            ",
  "   ▄████████████████████                            ",
  "  ████████████████████                              ",
  "  ████   ████      ████                             ",
  "  ███     █                                         ",
  "                                                    ",
  "                  ▄▄▄                ▄▄             ",
  "               ▄███████           ▄██████▄          ",
  "              █████████          ████████████       ",
  "            █████   █████       ████      ████      ",
  "          █████      ██████    ████        █████    ",
  "        █████          █████   ████          █████  ",
  "      █████              █████████             █████",
  "   ████████              ████████              █████",
  "█████████████          ████                    █████",
];

const EYE_CHARS = new Set(["●"]);

export function Mascot(): JSX.Element {
  return (
    <Box flexDirection="column" alignItems="center">
      {FRAME.map((line, i) => (
        <Line key={i} text={line} />
      ))}
    </Box>
  );
}

function Line({ text }: { text: string }): JSX.Element {
  const segments: Array<{ chars: string; color: string }> = [];
  let buf = "";
  let currentColor = "";
  for (const ch of text) {
    const color = EYE_CHARS.has(ch)
      ? theme.muted
      : ch === " "
        ? "transparent"
        : theme.pink;
    if (color !== currentColor) {
      if (buf) segments.push({ chars: buf, color: currentColor });
      buf = ch;
      currentColor = color;
    } else {
      buf += ch;
    }
  }
  if (buf) segments.push({ chars: buf, color: currentColor });

  return (
    <Text>
      {segments.map((seg, i) =>
        seg.color === "transparent" ? (
          <Text key={i}>{seg.chars}</Text>
        ) : (
          <Text key={i} color={seg.color}>
            {seg.chars}
          </Text>
        ),
      )}
    </Text>
  );
}
