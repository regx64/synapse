import type { AgentReviewedEvent, AgentState, CodeComment } from "@synapse/protocol";
import { ErrorCodes, RpcError } from "@synapse/protocol";
import type { AgentManager } from "./agents.js";
import type { CommentService } from "./comments.js";
import type { StateStore } from "./store.js";

/** Diff text given to the reviewer. */
const DIFF_LIMIT = 40_000;
/** Comments kept from one review. */
export const MAX_REVIEW_COMMENTS = 30;

/**
 * One agent reviews another's changes: it gets the changes with line
 * numbers, is told not to change files, and replies with comments as JSON.
 * The reply is data; each comment is placed on the reviewed agent's lines as
 * a note marked with the reviewer, for the person to resolve or pass on.
 */
export class AgentReviewService {
  /** reviewer id → whom it is reviewing */
  private readonly pending = new Map<string, string>();

  constructor(
    private readonly store: StateStore,
    private readonly agents: AgentManager,
    private readonly comments: CommentService,
  ) {}

  async start(reviewerId: string, targetId: string): Promise<AgentState> {
    if (reviewerId === targetId) throw new RpcError(ErrorCodes.InvalidParams, "An agent cannot review its own work");
    const reviewer = this.store.getAgent(reviewerId);
    const target = this.store.getAgent(targetId);
    if (!reviewer) throw new RpcError(ErrorCodes.NotFound, `No agent "${reviewerId}"`);
    if (!target) throw new RpcError(ErrorCodes.NotFound, `No agent "${targetId}"`);
    if (this.pending.has(reviewerId)) throw new RpcError(ErrorCodes.Conflict, `${reviewer.name} is already reviewing`);
    const diff = await this.comments.diff(targetId);
    if (!diff.files.length) throw new RpcError(ErrorCodes.Conflict, `${target.name} has no changes to review`);
    const task = target.currentTaskId ? this.store.getTask(target.currentTaskId) : this.store.listTasks().find((t) => t.agentId === targetId && t.status === "review");
    let text = "";
    for (const f of diff.files) {
      text += `\n=== ${f.path} (${f.status})\n`;
      for (const h of f.hunks) {
        text += `@@ ${h.header}\n`;
        for (const l of h.lines) text += l.t === "-" ? `     - ${l.text}\n` : `${String(l.newNo ?? "").padStart(5)}${l.t === "+" ? "+" : " "} ${l.text}\n`;
      }
      if (text.length > DIFF_LIMIT) {
        text = `${text.slice(0, DIFF_LIMIT)}\n… (the rest of the changes are not shown)\n`;
        break;
      }
    }
    const prompt = [
      `Review the changes ${target.name} made${task ? ` for task ${task.id} "${task.title}"` : ""}. Do not change any files.`,
      task?.description ? `\nThe task:\n${task.description}` : "",
      "",
      "The changes, with line numbers in the new version on the left (+ marks added lines, - removed ones):",
      "```",
      text.trim(),
      "```",
      "",
      "Look for bugs, missing cases, broken callers and anything that would fail review. Skip style nits.",
      `Reply with only a JSON code block, at most ${MAX_REVIEW_COMMENTS} comments; "line" is the number on the left:`,
      "```json",
      '{"summary": "one or two sentences", "comments": [{"path": "src/…", "line": 12, "severity": "blocker", "text": "…"}]}',
      "```",
      'Use "blocker" for what must change and "suggestion" for the rest.',
    ].join("\n");
    this.agents.prompt(reviewerId, prompt); // throws if not running or busy
    this.pending.set(reviewerId, targetId);
    return this.store.getAgent(reviewerId)!;
  }

  /** At the end of a reviewer's turn: place its comments. */
  async onTurnEnd(reviewerId: string, stopReason: string, error?: string): Promise<void> {
    const targetId = this.pending.get(reviewerId);
    if (!targetId) return;
    this.pending.delete(reviewerId);
    const event: AgentReviewedEvent = { reviewerId, targetId, summary: "", comments: 0, skipped: 0 };
    if (error || stopReason !== "end_turn") {
      this.store.emitEvent("agent.reviewed", { ...event, error: error ?? `the review turn ended: ${stopReason}` });
      return;
    }
    const parsed = parseReview(this.store.getAgent(reviewerId)?.lastMessage ?? "");
    if (!parsed) {
      this.store.emitEvent("agent.reviewed", { ...event, error: "The reviewer's reply had no comments in JSON" });
      return;
    }
    event.summary = parsed.summary;
    for (const c of parsed.comments) {
      try {
        await this.comments.add({ agentId: targetId, path: c.path, line: c.line, text: c.text, action: "note" }, { author: reviewerId, severity: c.severity });
        event.comments++;
      } catch {
        event.skipped++;
      }
    }
    this.store.emitEvent("agent.reviewed", event);
  }
}

/** A reviewer's reply: its summary and comments, validated. Undefined when there is no usable JSON. */
export function parseReview(reply: string): { summary: string; comments: { path: string; line: number; text: string; severity: CodeComment["severity"] }[] } | undefined {
  const candidates = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const brace = reply.indexOf("{");
  if (brace >= 0) candidates.push(reply.slice(brace, reply.lastIndexOf("}") + 1));
  for (const c of candidates.reverse()) {
    let data: { summary?: unknown; comments?: unknown };
    try {
      data = JSON.parse(c) as typeof data;
    } catch {
      continue;
    }
    if (!data || typeof data !== "object" || !Array.isArray(data.comments)) continue;
    const comments = data.comments
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        path: typeof x.path === "string" ? x.path.trim().replace(/^\.\//, "") : "",
        line: Math.floor(Number(x.line)),
        text: typeof x.text === "string" ? x.text.trim().slice(0, 2000) : "",
        severity: (x.severity === "blocker" ? "blocker" : "suggestion") as CodeComment["severity"],
      }))
      .filter((x) => x.path && x.line >= 1 && x.text)
      .slice(0, MAX_REVIEW_COMMENTS);
    return { summary: typeof data.summary === "string" ? data.summary.trim().slice(0, 1000) : "", comments };
  }
  return undefined;
}
