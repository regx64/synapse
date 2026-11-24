import type { AgentDiff, CodeComment, DiffHunk, DiffLine, FileDiff } from "@synapse/protocol";
import { ErrorCodes, RpcError } from "@synapse/protocol";
import type { AgentManager } from "./agents.js";
import type { CollabService } from "./collab.js";
import { git, showFile } from "./git.js";
import type { OwnershipService } from "./ownership.js";
import type { StateStore } from "./store.js";
import { nowIso, randomId, toPosix } from "./util.js";

/**
 * Live diffs of an agent's work and the person's comments on them.
 *
 * A comment quotes the lines it is about. As the agent keeps editing, the
 * quote is looked up again in each new snapshot, so the comment follows the
 * code; when the quoted code is gone, the comment is marked outdated.
 */

const MAX_DIFF_CHARS = 400_000;
const MAX_FILE_LINES = 3000;
const MAX_TEXT = 4000;
const MAX_QUOTE_LINES = 40;

export interface CommentDeps {
  store: StateStore;
  agents: AgentManager;
  collab: CollabService;
  ownership: OwnershipService;
}

/** Parses `git diff` output (unified, no renames) into files and hunks. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let lines = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = / b\/(.*)$/.exec(raw);
      file = { path: m ? m[1]! : raw.slice(11), status: "modified", binary: false, hunks: [] };
      files.push(file);
      hunk = undefined;
      lines = 0;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (raw.startsWith("new file mode")) file.status = "added";
      else if (raw.startsWith("deleted file mode")) file.status = "deleted";
      else if (raw.startsWith("Binary files ")) file.binary = true;
      else if (raw.startsWith("+++ b/")) file.path = raw.slice(6);
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
    if (h) {
      hunk = { header: h[5]!.trim(), oldStart: +h[1]!, oldLines: h[2] === undefined ? 1 : +h[2], newStart: +h[3]!, newLines: h[4] === undefined ? 1 : +h[4], lines: [] };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      if (lines < MAX_FILE_LINES) file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const t = raw[0];
    if (t !== "+" && t !== "-" && t !== " ") continue; // "\ No newline at end of file"
    if (++lines > MAX_FILE_LINES) {
      file.truncated = true;
      continue;
    }
    const line: DiffLine = { t, text: raw.slice(1) };
    if (t !== "+") line.oldNo = oldNo++;
    if (t !== "-") line.newNo = newNo++;
    hunk.lines.push(line);
  }
  return files;
}

/** Where `quote` (whole lines) now is in `content`, nearest to `near`. 1-based, or undefined. */
export function locateQuote(content: string, quote: string, near: number): { line: number; endLine: number } | undefined {
  const lines = content.split("\n");
  const q = quote.split("\n");
  const norm = (s: string) => s.trimEnd();
  let best: number | undefined;
  for (let i = 0; i + q.length <= lines.length; i++) {
    if (q.every((l, k) => norm(lines[i + k]!) === norm(l)) && (best === undefined || Math.abs(i + 1 - near) < Math.abs(best + 1 - near))) best = i;
  }
  return best === undefined ? undefined : { line: best + 1, endLine: best + q.length };
}

export class CommentService {
  constructor(private readonly deps: CommentDeps) {}

  private get store(): StateStore {
    return this.deps.store;
  }

  private requireAgent(id: string) {
    const a = this.store.getAgent(id);
    if (!a) throw new RpcError(ErrorCodes.NotFound, `No agent "${id}"`);
    return a;
  }

  async diff(agentId: string, filePath?: string): Promise<AgentDiff> {
    const agent = this.requireAgent(agentId);
    const own = await this.deps.ownership.refresh(agentId);
    const base = agent.worktree.baseCommit;
    const snapshot = own?.snapshot;
    if (!snapshot || snapshot === base) return { agentId, baseCommit: base, snapshot, files: [], updatedAt: nowIso() };
    const args = ["diff", "--no-color", "--no-renames", "--no-ext-diff", "-U3", base, snapshot];
    if (filePath) args.push("--", toPosix(filePath));
    let text = await git(agent.worktree.path, args);
    let truncated = false;
    if (text.length > MAX_DIFF_CHARS) {
      text = text.slice(0, text.lastIndexOf("\ndiff --git ", MAX_DIFF_CHARS) > 0 ? text.lastIndexOf("\ndiff --git ", MAX_DIFF_CHARS) : MAX_DIFF_CHARS);
      truncated = true;
    }
    const files = parseUnifiedDiff(text);
    if (truncated && files.length) files[files.length - 1]!.truncated = true;
    return { agentId, baseCommit: base, snapshot, files, updatedAt: own?.updatedAt ?? nowIso() };
  }

  list(agentId?: string): CodeComment[] {
    return this.store.listComments(agentId);
  }

  async add(p: { agentId: string; path: string; line: number; endLine?: number; text: string; action?: CodeComment["action"] }): Promise<CodeComment> {
    const agent = this.requireAgent(p?.agentId);
    const text = String(p.text ?? "").trim();
    if (!text) throw new RpcError(ErrorCodes.InvalidParams, "A comment needs some text");
    if (text.length > MAX_TEXT) throw new RpcError(ErrorCodes.InvalidParams, `Comments are limited to ${MAX_TEXT} characters`);
    const action = p.action ?? "note";
    if (!["note", "guidance", "task"].includes(action)) throw new RpcError(ErrorCodes.InvalidParams, `Unknown action "${action}"`);
    const rel = toPosix(String(p.path ?? "")).replace(/^\.\//, "");
    if (!rel || rel.split("/").includes("..")) throw new RpcError(ErrorCodes.InvalidParams, `Invalid path "${p.path}"`);
    const line = Math.floor(Number(p.line));
    const endLine = Math.floor(Number(p.endLine ?? p.line));
    if (!(line >= 1) || !(endLine >= line) || endLine - line >= MAX_QUOTE_LINES) throw new RpcError(ErrorCodes.InvalidParams, `Comment on 1 to ${MAX_QUOTE_LINES} lines (line ≥ 1, endLine ≥ line)`);

    const own = await this.deps.ownership.refresh(agent.id);
    const content = await showFile(agent.worktree.path, own?.snapshot ?? "HEAD", rel);
    if (content === null) throw new RpcError(ErrorCodes.NotFound, `${rel} is not in ${agent.name}'s version`);
    const lines = content.split("\n");
    if (endLine > lines.length) throw new RpcError(ErrorCodes.InvalidParams, `${rel} has ${lines.length} lines`);
    const quote = lines.slice(line - 1, endLine).join("\n");

    const now = nowIso();
    let c: CodeComment = { id: randomId("c"), agentId: agent.id, path: rel, line, endLine, quote, text, action, status: "open", createdAt: now, updatedAt: now };
    const where = `${rel}:${line}${endLine > line ? `-${endLine}` : ""}`;
    const block = `${text}\n\nThe code in question (${where}):\n\`\`\`\n${quote}\n\`\`\``;
    if (action === "guidance") {
      // Given after the agent's turn, like agents.steer; an idle agent gets it now.
      this.deps.agents.steer(agent.id, `About ${where}: ${block}`, "next");
    } else if (action === "task") {
      const t = this.deps.collab.createTask({ title: text.split("\n")[0]!.slice(0, 120), description: block, agentId: agent.id });
      c = { ...c, taskId: t.id };
    }
    return this.store.putComment(c);
  }

  resolve(id: string, status: CodeComment["status"] = "resolved"): CodeComment {
    const c = this.store.getComment(id);
    if (!c) throw new RpcError(ErrorCodes.NotFound, `No comment "${id}"`);
    if (status !== "open" && status !== "resolved") throw new RpcError(ErrorCodes.InvalidParams, `Invalid status "${status}"`);
    return this.store.putComment({ ...c, status });
  }

  /** After an agent's snapshot changes: follow its open comments to where their code is now. */
  async relocate(agentId: string): Promise<void> {
    const agent = this.store.getAgent(agentId);
    const open = this.store.listComments(agentId).filter((c) => c.status === "open");
    if (!agent || !open.length) return;
    const rev = this.store.getOwnership(agentId)?.snapshot ?? agent.worktree.baseCommit;
    const contents = new Map<string, string | null>();
    for (const c of open) {
      if (!contents.has(c.path)) contents.set(c.path, await showFile(agent.worktree.path, rev, c.path).catch(() => null));
      const content = contents.get(c.path);
      const at = content == null ? undefined : locateQuote(content, c.quote, c.line);
      const next = at ? { ...c, ...at, outdated: undefined } : { ...c, outdated: true };
      if (next.line !== c.line || next.endLine !== c.endLine || !!next.outdated !== !!c.outdated) this.store.putComment(next);
    }
  }
}

