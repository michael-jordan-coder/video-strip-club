import { CommandError, run } from "./exec.ts";

export interface DepStatus {
  name: string;
  available: boolean;
  version?: string;
  path?: string;
  install: string;
  required: boolean;
  /** Which features need this tool (human-readable, shown in `vsc doctor`). */
  usedFor: string;
}

export type HasDep = (name: string) => boolean;

const DEPS: Array<Omit<DepStatus, "available" | "version" | "path">> = [
  {
    name: "ffmpeg",
    required: true,
    usedFor: "h264, h265, AV1 (libsvtav1), VP9 encoding; poster extraction",
    install: "brew install ffmpeg",
  },
  {
    name: "ffprobe",
    required: true,
    usedFor: "video analysis (duration, codec, resolution)",
    install: "brew install ffmpeg",
  },
  {
    name: "SvtAv1EncApp",
    required: false,
    usedFor: "fast standalone AV1 encoding (ffmpeg's libsvtav1 covers this too)",
    install: "brew install svt-av1",
  },
  {
    name: "HandBrakeCLI",
    required: false,
    usedFor: "alternative HEVC archival encodes",
    install: "brew install handbrake",
  },
  {
    name: "gifski",
    required: false,
    usedFor: "high-quality looping GIF previews (the `web-thumbnail-gif` preset)",
    install: "brew install gifski",
  },
];

let cache: Promise<DepStatus[]> | null = null;

/**
 * Memoized: dep state cannot change within a single CLI invocation, and the
 * batch command would otherwise re-shell `which` + `--version` per input file.
 */
export function checkDeps(): Promise<DepStatus[]> {
  if (!cache) cache = compute();
  return cache;
}

export function makeHas(deps: DepStatus[]): HasDep {
  const set = new Set(deps.filter((d) => d.available).map((d) => d.name));
  return (name) => set.has(name);
}

async function compute(): Promise<DepStatus[]> {
  return Promise.all(
    DEPS.map(async (d): Promise<DepStatus> => {
      const res = await detect(d.name);
      return res
        ? { ...d, available: true, version: res.version, path: res.path }
        : { ...d, available: false };
    }),
  );
}

async function detect(name: string): Promise<{ version: string; path: string } | null> {
  let path: string;
  try {
    const which = await run("which", [name]);
    path = which.stdout.trim();
  } catch (err) {
    if (err instanceof CommandError) {
      // `which` exits non-zero when the binary isn't on PATH — that's the
      // signal we care about. Anything else is a genuine spawn failure.
      return null;
    }
    throw err;
  }
  if (!path) return null;
  const version = await readVersion(name);
  return { version, path };
}

async function readVersion(name: string): Promise<string> {
  // Different tools disagree on the version flag, so try the common spellings.
  for (const flag of ["--version", "-version", "-v"]) {
    try {
      const r = await run(name, [flag]);
      const first = (r.stdout || r.stderr).split("\n")[0]?.trim();
      if (first) return first;
    } catch (err) {
      if (err instanceof CommandError) continue; // tool rejected this flag, try next
      throw err;
    }
  }
  return "unknown version";
}
