import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentOutputEvent, CoreEvent, TranscriptEntry } from "@synapse/protocol";
import { redact } from "./redact.js";
import type { StateStore } from "./store.js";
import { debounce, nowIso } from "./util.js";

/** Entries kept per agent; older ones are dropped. */
export const TRANSCRIPT_LIMIT = 400;
/** Characters kept per entry (the end of a long message, the start of a long prompt). */
export const ENTRY_TEXT_LIMIT = 8000;

/**
 * Each agent's conversation for the agent-detail view: the prompts and
 * guidance it was given, what it said, the tools it used and how its turns
 * ended. Built from the core's agent.output events, redacted before it is
 * kept, capped, and saved in `.synapse/transcripts/<agent>.json` so it
 * survives a restart. Thoughts are kept too (the view folds them away).
 */
export class TranscriptStore {
  private readonly byAgent = new Map<string, TranscriptEntry[]>();
  private readonly dirty = new Set<string>();
  private readonly saveSoon = debounce(() => this.saveNow(), 500);
  private readonly dir?: string;

  constructor(private readonly store: StateStore) {
    this.dir = store.dataDir ? path.join(store.dataDir, "transcripts") : undefined;
    store.on("event", (ev: CoreEvent) => this.onEvent(ev));
  }

  list(agentId: string, from?: number, limit = TRANSCRIPT_LIMIT): TranscriptEntry[] {
    const all = this.entries(agentId);
    const picked = from === undefined ? all : all.filter((e) => e.n >= from);
    return picked.slice(-Math.max(1, Math.min(limit, TRANSCRIPT_LIMIT))).map((e) => ({ ...e }));
  }

  /** Forgets an agent's conversation (the agent was removed). */
  remove(agentId: string): void {
    this.byAgent.delete(agentId);
    this.dirty.delete(agentId);
    const file = this.file(agentId);
    if (file) fs.rmSync(file, { force: true });
  }

  flush(): void {
    this.saveSoon.cancel();
    this.saveNow();
  }

  private onEvent(ev: CoreEvent): void {
    if (ev.type === "agent.removed") return this.remove((ev.data as { id: string }).id);
    if (ev.type !== "agent.output") return;
    const o = ev.data as AgentOutputEvent;
    const list = this.entries(o.agentId);
    const last = list[list.length - 1];
    const add = (e: Omit<TranscriptEntry, "n" | "at">) => this.push(o.agentId, { ...e, text: clip(redact(e.text), e.kind) });
    switch (o.kind) {
      case "message":
      case "thought": {
        if (last && last.kind === o.kind) {
          last.text = clip(redact(last.text + o.text), o.kind);
          this.touch(o.agentId);
        } else if (o.text.trim()) add({ kind: o.kind, text: o.text });
        return;
      }
      case "tool": {
        const t = o.tool;
        if (!t) return;
        const prev = [...list].reverse().find((e) => e.kind === "tool" && e.toolId === t.id);
        if (prev) {
          Object.assign(prev, { text: clip(redact(t.title), "tool"), status: t.status, toolKind: t.kind ?? prev.toolKind, locations: t.locations ?? prev.locations });
          this.touch(o.agentId);
        } else add({ kind: "tool", text: t.title, toolId: t.id, toolKind: t.kind, status: t.status, locations: t.locations });
        return;
      }
      case "turn": {
        if (o.phase === "prompt" || o.phase === "followup") {
          const taskId = this.store.getAgent(o.agentId)?.currentTaskId;
          add({ kind: "prompt", text: o.text.replace(/^> /, ""), taskId, followup: o.phase === "followup" || undefined });
        } else if (o.phase === "guidance") add({ kind: "guidance", text: o.guidance ?? o.text, mode: o.mode });
        else if (o.phase === "end") add({ kind: "end", text: o.stopReason ?? "", stopReason: o.stopReason, error: o.error ? redact(o.error) : undefined });
        return;
      }
      default:
        return;
    }
  }

  private push(agentId: string, e: Omit<TranscriptEntry, "n" | "at">): void {
    const list = this.entries(agentId);
    const n = (list[list.length - 1]?.n ?? 0) + 1;
    const entry = Object.fromEntries(Object.entries({ ...e, n, at: nowIso() }).filter(([, v]) => v !== undefined)) as unknown as TranscriptEntry;
    list.push(entry);
    if (list.length > TRANSCRIPT_LIMIT) list.splice(0, list.length - TRANSCRIPT_LIMIT);
    this.touch(agentId);
  }

  private touch(agentId: string): void {
    this.dirty.add(agentId);
    this.saveSoon();
  }

  private entries(agentId: string): TranscriptEntry[] {
    let list = this.byAgent.get(agentId);
    if (!list) {
      list = this.load(agentId);
      this.byAgent.set(agentId, list);
    }
    return list;
  }

  private file(agentId: string): string | undefined {
    return this.dir && /^[A-Za-z0-9_.-]+$/.test(agentId) ? path.join(this.dir, `${agentId}.json`) : undefined;
  }

  private load(agentId: string): TranscriptEntry[] {
    const file = this.file(agentId);
    if (!file || !fs.existsSync(file)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as { entries?: TranscriptEntry[] };
      return Array.isArray(data.entries) ? data.entries.slice(-TRANSCRIPT_LIMIT) : [];
    } catch {
      return [];
    }
  }

  private saveNow(): void {
    if (!this.dir) return this.dirty.clear();
    for (const id of this.dirty) {
      const file = this.file(id);
      const list = this.byAgent.get(id);
      if (!file || !list) continue;
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: list }));
      fs.renameSync(tmp, file);
    }
    this.dirty.clear();
  }
}

/** Long messages keep their end (the latest output); prompts and the rest keep their start. */
function clip(text: string, kind: TranscriptEntry["kind"]): string {
  if (text.length <= ENTRY_TEXT_LIMIT) return text;
  return kind === "message" || kind === "thought" ? `…${text.slice(-ENTRY_TEXT_LIMIT)}` : `${text.slice(0, ENTRY_TEXT_LIMIT)}…`;
}
