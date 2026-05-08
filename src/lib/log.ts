const isTty = process.stdout.isTTY === true;
const supportsColor = isTty && process.env.NO_COLOR == null;

const wrap = (open: string, close: string) => (s: string) =>
  supportsColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const c = {
  dim: wrap("2", "22"),
  bold: wrap("1", "22"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
  gray: wrap("90", "39"),
};

export function info(msg: string): void {
  process.stderr.write(`${c.cyan("›")} ${msg}\n`);
}

export function success(msg: string): void {
  process.stderr.write(`${c.green("✓")} ${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`${c.yellow("!")} ${msg}\n`);
}

export function error(msg: string): void {
  process.stderr.write(`${c.red("✗")} ${msg}\n`);
}

export function step(msg: string): void {
  process.stderr.write(`${c.dim("·")} ${c.dim(msg)}\n`);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "?";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private i = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastLine = "";

  constructor(private label: string) {}

  start(): void {
    if (this.timer) return; // idempotent — guards against accidental double-start leaks
    if (!isTty) {
      info(this.label);
      return;
    }
    this.timer = setInterval(() => this.render(), 80);
  }

  update(suffix: string): void {
    this.lastLine = suffix;
    if (!isTty) return;
    this.render();
  }

  stop(finalLine?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (isTty) {
      process.stderr.write("\r\x1b[2K");
    }
    if (finalLine != null) {
      process.stderr.write(`${finalLine}\n`);
    }
  }

  private render(): void {
    const frame = this.frames[this.i = (this.i + 1) % this.frames.length];
    const line = `${c.cyan(frame!)} ${this.label}${this.lastLine ? `  ${c.dim(this.lastLine)}` : ""}`;
    process.stderr.write(`\r\x1b[2K${line}`);
  }
}
