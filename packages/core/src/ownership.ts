import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentOwnership, FileChange, FileMarker, OwnedSymbol } from "@synapse/protocol";
import { diffNumstat, diffRaw, git, readBlobs, snapshotWorktree } from "./git.js";
import type { StateStore } from "./store.js";
import { parseSource, type ParsedFile } from "./symbols.js";
import { KeyedSerializer, isInside, nowIso, realpathLoose, toPosix } from "./util.js";

const MAX_PARSE_BYTES = 1024 * 1024;

export interface FileDetail {
  path: string;
  /** Blob ids of the base and worktree versions (absent when added or deleted). */
  oldOid?: string;
  newOid?: string;
  status: FileChange["status"];
  oldText: string | null;
  newText: string | null;
  oldParsed: ParsedFile | null;
  newParsed: ParsedFile | null;
  /** Names of symbols this agent added or modified in this file. */
  changedSymbols: Set<string>;
}

/**
 * Tracks what each agent is changing, down to the symbol, by diffing a
 * snapshot of the agent's worktree against the commit it started from.
 */
export class OwnershipService {
  private readonly details = new Map<string, Map<string, FileDetail>>();
  private readonly serializer = new KeyedSerializer();

  constructor(
    private readonly store: StateStore,
    private readonly repoRoot: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  detailsFor(agentId: string): Map<string, FileDetail> {
    return this.details.get(agentId) ?? new Map();
  }

  forget(agentId: string): void {
    this.details.delete(agentId);
    this.baseOf.delete(agentId);
  }

  /** Base commit the details were computed against (the agent's worktree can be reset onto a new base). */
  private readonly baseOf = new Map<string, string>();
  private readonly indexFiles = new Map<string, string>();

  /** A private, persistent index per worktree for snapshots, inside its git directory. */
  private async indexFileFor(worktree: string): Promise<string> {
    let f = this.indexFiles.get(worktree);
    if (!f) {
      f = path.join(await git(worktree, ["rev-parse", "--absolute-git-dir"]), "synapse-snapshot-index");
      this.indexFiles.set(worktree, f);
    }
    return f;
  }

  async refresh(agentId: string): Promise<AgentOwnership | undefined> {
    await this.serializer.run(agentId, () => this.refreshNow(agentId));
    return this.store.getOwnership(agentId);
  }

  private async refreshNow(agentId: string): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) return;
    const wt = agent.worktree;
    try {
      await fs.access(wt.path);
    } catch {
      return;
    }
    const snapshot = await snapshotWorktree(wt.path, `Work of ${agent.name} (snapshot by Synapse)`, await this.indexFileFor(wt.path));
    // Snapshots are deterministic: the same commit means nothing changed since the last refresh.
    const previous = this.store.getOwnership(agentId);
    if (previous?.snapshot === snapshot && this.details.has(agentId) && this.baseOf.get(agentId) === wt.baseCommit) return;
    // Keep the snapshot reachable so git gc does not collect it.
    await git(this.repoRoot, ["update-ref", `refs/synapse/snapshots/${agentId}`, snapshot]);

    const [entries, numstat] = await Promise.all([diffRaw(wt.path, wt.baseCommit, snapshot), diffNumstat(wt.path, wt.baseCommit, snapshot)]);
    const files: FileChange[] = [];
    const details = new Map<string, FileDetail>();
    // Files whose before and after blobs are the same as last time keep their analysis.
    const prevDetails = this.baseOf.get(agentId) === wt.baseCommit ? this.details.get(agentId) : undefined;
    const prevFiles = new Map((previous?.files ?? []).map((f) => [f.path, f]));
    const reusable = (e: (typeof entries)[number]) => {
      const d = prevDetails?.get(e.path);
      return d && d.oldOid === e.oldOid && d.newOid === e.newOid && prevFiles.has(e.path) ? d : undefined;
    };
    // All other contents in one git call (cached by blob id across refreshes).
    const blobs = await readBlobs(wt.path, entries.filter((e) => !reusable(e)).flatMap((e) => [e.oldOid, e.newOid]).filter((o): o is string => !!o));
    const text = (oid?: string) => {
      const t = oid ? blobs.get(oid) : undefined;
      return t === undefined || t.length > MAX_PARSE_BYTES || t.includes("\u0000") ? null : t;
    };

    for (const entry of entries) {
      const stat = numstat.get(entry.path) ?? { added: 0, removed: 0 };
      const same = reusable(entry);
      if (same) {
        files.push({ ...prevFiles.get(entry.path)!, status: entry.status, linesAdded: stat.added, linesRemoved: stat.removed });
        details.set(entry.path, same);
        continue;
      }
      const oldText = text(entry.oldOid);
      const newText = text(entry.newOid);
      const oldParsed = oldText !== null ? await parseSafe(entry.path, oldText) : null;
      const newParsed = newText !== null ? await parseSafe(entry.path, newText) : null;
      const parsed = (oldText === null || oldParsed !== null) && (newText === null || newParsed !== null);
      const symbols = parsed ? diffSymbols(oldParsed, newParsed) : [];
      files.push({ path: entry.path, status: entry.status, parsed, symbols, linesAdded: stat.added, linesRemoved: stat.removed });
      details.set(entry.path, {
        path: entry.path,
        status: entry.status,
        oldOid: entry.oldOid,
        newOid: entry.newOid,
        oldText,
        newText,
        oldParsed,
        newParsed,
        changedSymbols: new Set(symbols.filter((s) => s.change !== "removed").map((s) => s.name)),
      });
    }

    this.details.set(agentId, details);
    this.baseOf.set(agentId, wt.baseCommit);
    // The agent may have been removed while we were computing.
    if (!this.store.getAgent(agentId)) return;
    this.store.setOwnership({ agentId, files, snapshot, updatedAt: nowIso() });
  }

  /**
   * Markers for a file the person has open: which agents are changing which
   * symbols in it. `filePath` may be absolute (main checkout or an agent
   * worktree) or repo-relative.
   */
  async markersFor(filePath: string, content?: string): Promise<FileMarker[]> {
    const { rel, viewerAgent } = this.resolveViewPath(filePath);
    if (!rel) return [];
    let text = content;
    if (text === undefined) {
      const abs = viewerAgent ? path.join(this.store.getAgent(viewerAgent)!.worktree.path, rel) : path.join(this.repoRoot, rel);
      text = await fs.readFile(abs, "utf8").catch(() => undefined);
    }
    const viewed = text !== undefined ? await parseSafe(rel, text) : null;
    const markers: FileMarker[] = [];
    for (const own of this.store.allOwnership()) {
      if (own.agentId === viewerAgent) continue;
      const agent = this.store.getAgent(own.agentId);
      if (!agent) continue;
      const file = own.files.find((f) => f.path === rel);
      if (!file) continue;
      const base = { agentId: agent.id, agentName: agent.name, color: agent.color };
      if (!file.parsed || file.symbols.length === 0) {
        markers.push({ ...base, symbol: "(file)", kind: "module", change: file.status === "added" ? "added" : file.status === "deleted" ? "removed" : "modified", signatureChanged: false });
        continue;
      }
      for (const sym of file.symbols) {
        const match = viewed?.symbols.find((s) => s.name === sym.name);
        markers.push({ ...base, symbol: sym.name, kind: sym.kind, change: sym.change, signatureChanged: sym.signatureChanged, range: match?.range });
      }
    }
    return markers;
  }

  private resolveViewPath(filePath: string): { rel?: string; viewerAgent?: string } {
    if (!path.isAbsolute(filePath)) return { rel: toPosix(path.normalize(filePath)) };
    // Compare canonical paths: symlinks, and 8.3 short names on Windows, would otherwise give a wrong relative path.
    const real = realpathLoose(filePath);
    for (const agent of this.store.listAgents()) {
      const wt = realpathLoose(agent.worktree.path);
      if (isInside(wt, real)) {
        return { rel: toPosix(path.relative(wt, real)), viewerAgent: agent.id };
      }
    }
    const root = realpathLoose(this.repoRoot);
    if (isInside(root, real)) {
      const rel = toPosix(path.relative(root, real));
      if (rel.startsWith(".synapse/")) return {};
      return { rel };
    }
    return {};
  }
}

/** Symbol-level difference between two versions of a file. */
export function diffSymbols(oldFile: ParsedFile | null, newFile: ParsedFile | null): OwnedSymbol[] {
  const oldMap = new Map((oldFile?.symbols ?? []).map((s) => [s.name, s]));
  const newMap = new Map((newFile?.symbols ?? []).map((s) => [s.name, s]));
  const out: OwnedSymbol[] = [];
  for (const [name, n] of newMap) {
    const o = oldMap.get(name);
    if (!o) {
      out.push({ name, kind: n.kind, change: "added", signatureChanged: false, newSignature: n.signature, range: n.range });
    } else if (o.textHash !== n.textHash || o.signature !== n.signature) {
      const signatureChanged = (o.signature ?? "") !== (n.signature ?? "") && isCallable(n.kind);
      out.push({
        name,
        kind: n.kind,
        change: "modified",
        signatureChanged,
        oldSignature: o.signature,
        newSignature: n.signature,
        range: n.range,
      });
    }
  }
  for (const [name, o] of oldMap) {
    if (!newMap.has(name)) out.push({ name, kind: o.kind, change: "removed", signatureChanged: false, oldSignature: o.signature });
  }
  return out;
}

export const isCallable = (kind: string) => kind === "function" || kind === "method" || kind === "class";

async function parseSafe(filePath: string, text: string): Promise<ParsedFile | null> {
  if (text.length > MAX_PARSE_BYTES) return null;
  try {
    return await parseSource(filePath, text);
  } catch {
    return null;
  }
}
