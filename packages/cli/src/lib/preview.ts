import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { VIDEO_SOURCE_ORDER, videoSourceLines } from "./codec.ts";
import { formatBytes } from "./log.ts";
import type {
  CompressedArtifact,
  Codec,
  GifArtifact,
  PosterArtifact,
  Preset,
  VideoArtifact,
} from "../types.ts";

const CODEC_LABEL: Record<Codec, string> = {
  av1: "AV1",
  h265: "H.265",
  vp9: "VP9",
  h264: "H.264",
};

export interface PreviewInput {
  outDir: string;
  baseName: string;
  preset: Preset;
  artifacts: CompressedArtifact[];
  inputSizeBytes: number;
}

/**
 * Writes a self-contained `<basename>.html` preview page next to the encoded
 * artifacts and returns its absolute path. The page renders the produced video
 * (or GIF), an artifact size table, and a copy-paste `<video>` snippet.
 */
export async function writePreview(input: PreviewInput): Promise<string> {
  const outPath = join(input.outDir, `${input.baseName}.html`);
  const html = renderHtml(input);
  await writeFile(outPath, html, "utf8");
  return outPath;
}

function renderHtml(input: PreviewInput): string {
  const { baseName, preset, artifacts, inputSizeBytes } = input;
  const videos = artifacts.filter((a): a is VideoArtifact => a.kind === "video");
  const posters = artifacts.filter((a): a is PosterArtifact => a.kind === "poster");
  const gifs = artifacts.filter((a): a is GifArtifact => a.kind === "gif");

  const sortedVideos = [...videos].sort(
    (a, b) => VIDEO_SOURCE_ORDER[a.codec] - VIDEO_SOURCE_ORDER[b.codec],
  );
  const jpgPoster = posters.find((p) => p.format === "jpg");

  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width,initial-scale=1" />`,
    `<title>${esc(baseName)} · ${esc(preset.id)}</title>`,
    `<style>${STYLES}</style>`,
    `</head>`,
    `<body>`,
    `<main>`,
    renderHeader(baseName, preset, inputSizeBytes, artifacts.length),
    renderViewer(baseName, preset, sortedVideos, gifs, jpgPoster),
    renderArtifactTable(artifacts, inputSizeBytes),
    renderSnippet(baseName, preset, sortedVideos, jpgPoster),
    renderFooter(),
    `</main>`,
    `</body>`,
    `</html>`,
  ].join("\n");
}

function renderHeader(
  baseName: string,
  preset: Preset,
  inputSizeBytes: number,
  artifactCount: number,
): string {
  return `
<header>
  <div class="brand">video-strip-club</div>
  <h1>${esc(baseName)}</h1>
  <div class="meta">
    <span class="tag">${esc(preset.id)}</span>
    <span>·</span>
    <span>${artifactCount} artifact${artifactCount === 1 ? "" : "s"}</span>
    <span>·</span>
    <span>source ${esc(formatBytes(inputSizeBytes))}</span>
  </div>
  <p class="summary">${esc(preset.summary)}</p>
</header>`;
}

function renderViewer(
  baseName: string,
  preset: Preset,
  sortedVideos: VideoArtifact[],
  gifs: GifArtifact[],
  jpgPoster: PosterArtifact | undefined,
): string {
  if (sortedVideos.length === 0 && gifs.length > 0) {
    const gif = gifs[0]!;
    return `
<section class="viewer">
  <img src="${esc(basename(gif.path))}" alt="${esc(baseName)} preview" class="gif" />
  ${
    jpgPoster
      ? `<div class="aside-label">poster</div>
       <img src="${esc(basename(jpgPoster.path))}" alt="poster" class="poster" />`
      : ""
  }
</section>`;
  }

  if (sortedVideos.length === 0) {
    return `<section class="viewer empty">No video artifacts produced.</section>`;
  }

  const attrs = preset.mutedAutoplay
    ? `autoplay muted loop playsinline`
    : `controls playsinline`;
  const posterAttr = jpgPoster ? ` poster="${esc(basename(jpgPoster.path))}"` : "";

  const sources = videoSourceLines(sortedVideos, { indent: "    ", escape: esc }).join("\n");

  return `
<section class="viewer">
  <video ${attrs}${posterAttr}>
${sources}
    Your browser doesn't support any of the encoded codecs.
  </video>
</section>`;
}

function renderArtifactTable(artifacts: CompressedArtifact[], inputSizeBytes: number): string {
  const rows = artifacts
    .map((a) => {
      const ratio = inputSizeBytes > 0 ? `${((a.sizeBytes / inputSizeBytes) * 100).toFixed(1)}%` : "—";
      const file = basename(a.path);
      const label = artifactLabel(a);
      return `
    <tr>
      <td class="label">${esc(label)}</td>
      <td class="size">${esc(formatBytes(a.sizeBytes))}</td>
      <td class="ratio">${esc(ratio)}</td>
      <td class="file"><a href="${esc(file)}" download>${esc(file)}</a></td>
    </tr>`;
    })
    .join("");

  return `
<section>
  <h2>Artifacts</h2>
  <table>
    <thead><tr><th>format</th><th>size</th><th>vs input</th><th>file</th></tr></thead>
    <tbody>${rows}
    </tbody>
  </table>
</section>`;
}

function renderSnippet(
  baseName: string,
  preset: Preset,
  sortedVideos: VideoArtifact[],
  jpgPoster: PosterArtifact | undefined,
): string {
  if (sortedVideos.length === 0) return "";
  const attrs = preset.mutedAutoplay
    ? `autoplay muted loop playsinline`
    : `controls playsinline`;
  const posterAttr = jpgPoster ? ` poster="${baseName}.poster.jpg"` : "";

  const lines = [
    `<video ${attrs}${posterAttr}>`,
    ...videoSourceLines(sortedVideos, { indent: "  " }),
    `</video>`,
  ];
  const snippet = lines.join("\n");

  return `
<section>
  <h2>Embed snippet</h2>
  <p class="hint">Paste into your page. Source order is AV1 → H.265 → VP9 → H.264; browsers pick the first they can decode.</p>
  <pre><code>${esc(snippet)}</code></pre>
  <button class="copy" data-target="#snippet-text" type="button">Copy</button>
  <textarea id="snippet-text" hidden>${esc(snippet)}</textarea>
</section>
<script>
  document.querySelector('.copy')?.addEventListener('click', async (e) => {
    const ta = document.getElementById('snippet-text');
    if (!ta) return;
    await navigator.clipboard.writeText(ta.value);
    const btn = e.currentTarget;
    const prev = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = prev), 1500);
  });
</script>`;
}

function renderFooter(): string {
  return `
<footer>
  Generated by <code>vsc compress</code>. Re-run with <code>--force</code> to regenerate.
</footer>`;
}

function artifactLabel(a: CompressedArtifact): string {
  switch (a.kind) {
    case "video":
      return `${CODEC_LABEL[a.codec]} · ${a.container}`;
    case "poster":
      return `poster · ${a.format}`;
    case "gif":
      return "preview · gif";
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLES = `
:root {
  --bg: #0b0b0c;
  --panel: #131316;
  --line: #232328;
  --text: #e6e6e8;
  --dim: #8a8a92;
  --accent: #7dd3fc;
  --accent-dim: #38bdf8;
}
* { box-sizing: border-box; }
html, body { background: var(--bg); color: var(--text); margin: 0; }
body {
  font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  padding: 32px 24px 64px;
}
main { max-width: 880px; margin: 0 auto; }
header { margin-bottom: 32px; }
.brand { color: var(--dim); font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
h1 { font-size: 22px; margin: 4px 0 8px; font-weight: 600; }
.meta { display: flex; gap: 8px; align-items: center; color: var(--dim); font-size: 12px; }
.tag { background: var(--panel); border: 1px solid var(--line); padding: 2px 8px; border-radius: 4px; color: var(--accent); }
.summary { color: var(--dim); margin: 12px 0 0; max-width: 60ch; }
section { margin-bottom: 32px; }
h2 { font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dim); margin: 0 0 12px; font-weight: 500; }
.viewer { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
.viewer.empty { color: var(--dim); padding: 48px; text-align: center; }
video, .gif { max-width: 100%; max-height: 540px; border-radius: 4px; background: #000; }
.poster { max-width: 100%; max-height: 240px; border-radius: 4px; opacity: 0.6; }
.aside-label { color: var(--dim); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); }
th { color: var(--dim); font-weight: 500; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; }
td.size, td.ratio { color: var(--dim); }
td.file a { color: var(--accent); text-decoration: none; border-bottom: 1px dashed transparent; }
td.file a:hover { border-bottom-color: var(--accent-dim); }
.hint { color: var(--dim); font-size: 12px; margin: -4px 0 12px; }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 14px 16px; overflow-x: auto; font-size: 12.5px; line-height: 1.6; }
code { color: var(--text); }
.copy { background: transparent; color: var(--accent); border: 1px solid var(--line); padding: 6px 12px; border-radius: 4px; cursor: pointer; font: inherit; font-size: 12px; margin-top: 8px; }
.copy:hover { border-color: var(--accent-dim); }
footer { color: var(--dim); font-size: 11px; border-top: 1px solid var(--line); padding-top: 16px; }
footer code { color: var(--accent); }
`;
