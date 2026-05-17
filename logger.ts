import type { App } from "obsidian";

// Lightweight file logger. Writes to a path inside the vault so it's reachable
// via the normal vault adapter (no Node fs needed, works on mobile too).
// Use this only for development diagnostics — remove the hookups in main.ts
// before shipping.
export class Logger {
  private buffer: string[] = [];
  private flushScheduled = false;

  constructor(private app: App, private logPath: string) {
    this.app.vault.adapter
      .write(
        this.logPath,
        `=== session start ${new Date().toISOString()} ===\n`
      )
      .catch((e) => console.error("[Cornell] log init failed:", e));
  }

  log(...args: unknown[]): void {
    const ts = new Date().toISOString().slice(11, 23);
    const parts = args.map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    });
    const line = `[${ts}] ${parts.join(" ")}`;
    console.log("[Cornell]", ...args);
    this.buffer.push(line);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flush();
      this.flushScheduled = false;
    }, 100);
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const data = this.buffer.join("\n") + "\n";
    this.buffer = [];
    try {
      await this.app.vault.adapter.append(this.logPath, data);
    } catch (e) {
      console.error("[Cornell] log write failed:", e);
    }
  }
}

export function describeElement(el: Element | null): string {
  if (!el) return "<null>";
  const cls = (el.className || "").toString().split(/\s+/).filter(Boolean);
  return `${el.tagName}${cls.length ? "." + cls.join(".") : ""}`;
}

export function ancestorChain(start: Element | null, max = 12): string[] {
  const out: string[] = [];
  let el: Element | null = start;
  while (el && out.length < max) {
    out.push(describeElement(el));
    el = el.parentElement;
  }
  return out;
}
