import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";

export const nowIso = (): string => new Date().toISOString();

export function shortHash(input: string, len = 12): string {
  return createHash("sha1").update(input).digest("hex").slice(0, len);
}

export function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** True when `child` is `parent` or inside it. Both are resolved; symlinks are resolved when they exist. */
export function isInside(parent: string, child: string): boolean {
  const rp = realpathLoose(parent);
  const rc = realpathLoose(child);
  const rel = path.relative(rp, rc);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** realpath that tolerates missing leaf paths by resolving the nearest existing ancestor. */
export function realpathLoose(p: string): string {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const wrapped = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return wrapped;
}

/**
 * Runs an async task for a key with at most one execution in flight. Calls
 * that arrive while a run is in flight coalesce into exactly one follow-up run.
 */
export class KeyedSerializer {
  private readonly running = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();

  run(key: string, task: () => Promise<void>): Promise<void> {
    const inflight = this.running.get(key);
    if (inflight) {
      this.dirty.add(key);
      return inflight.then(() => this.running.get(key) ?? Promise.resolve());
    }
    const p = (async () => {
      try {
        do {
          this.dirty.delete(key);
          await task();
        } while (this.dirty.has(key));
      } finally {
        this.running.delete(key);
      }
    })();
    this.running.set(key, p);
    return p;
  }
}

export const AGENT_COLORS = ["#d97757", "#10a37f", "#4285f4", "#a855f7", "#eab308", "#ef4444", "#14b8a6", "#f472b6"];

export const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function truncateTail(text: string, max: number): string {
  return text.length <= max ? text : "…" + text.slice(text.length - max + 1);
}

export function lineCount(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n - 1 : n;
}
