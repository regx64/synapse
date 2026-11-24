import type { QueueEntry, Review } from "@synapse/protocol";
import { ErrorCodes, RpcError } from "@synapse/protocol";
import type { CollabService } from "./collab.js";
import type { ReviewService } from "./review.js";
import type { StateStore } from "./store.js";
import { nowIso, randomId } from "./util.js";

export interface MergeQueueDeps {
  store: StateStore;
  reviews: ReviewService;
  collab: CollabService;
  log: (msg: string) => void;
}

/**
 * Agents' work merged one at a time: each entry is prepared on the current
 * base (so it includes what merged before it), tested, and merged only when
 * the tests pass and no conflict blocks it. A failing entry stops there with
 * its reason; the queue moves on to the next. An agent still in a turn
 * waits its turn in the queue.
 */
export class MergeQueue {
  private working = false;
  private again = false;

  constructor(private readonly deps: MergeQueueDeps) {}

  add(agentId: string, taskId?: string): QueueEntry {
    if (!this.deps.store.getAgent(agentId)) throw new RpcError(ErrorCodes.NotFound, `No agent "${agentId}"`);
    if (taskId && !this.deps.store.getTask(taskId)) throw new RpcError(ErrorCodes.NotFound, `No task "${taskId}"`);
    const open = this.deps.store.listQueue().find((e) => e.agentId === agentId && (e.status === "queued" || e.status === "merging"));
    if (open) throw new RpcError(ErrorCodes.Conflict, `${agentId}'s work is already in the queue`);
    const now = nowIso();
    const e = this.deps.store.putQueueEntry({ id: randomId("q"), agentId, taskId, status: "queued", createdAt: now, updatedAt: now });
    this.kick();
    return e;
  }

  remove(id: string): QueueEntry {
    const e = this.require(id);
    if (e.status === "merging") throw new RpcError(ErrorCodes.Conflict, "It is being merged right now");
    return this.deps.store.putQueueEntry({ ...e, status: "removed" });
  }

  retry(id: string): QueueEntry {
    const e = this.require(id);
    if (e.status !== "failed") throw new RpcError(ErrorCodes.Conflict, `Only a failed entry can be retried (this one is ${e.status})`);
    const next = this.deps.store.putQueueEntry({ ...e, status: "queued", error: undefined, reviewId: undefined, createdAt: nowIso() });
    this.kick();
    return next;
  }

  /** Works through the queue in order. Called after changes and when an agent becomes idle. */
  kick(): void {
    if (this.working) {
      this.again = true;
      return;
    }
    this.working = true;
    void this.drain()
      .catch((err: Error) => this.deps.log(`merge queue: ${err.message}`))
      .finally(() => {
        this.working = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  /** A promise that settles when the queue is idle (tests). */
  async idle(): Promise<void> {
    while (this.working) await new Promise((r) => setTimeout(r, 50));
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = this.deps.store
        .listQueue()
        .filter((e) => e.status === "queued")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .find((e) => {
          const a = this.deps.store.getAgent(e.agentId);
          return a && a.status !== "working" && a.status !== "awaiting-approval" && a.status !== "starting";
        });
      if (!next) return;
      await this.mergeOne(next);
    }
  }

  private async mergeOne(e: QueueEntry): Promise<void> {
    if (!this.deps.store.getAgent(e.agentId)) {
      this.deps.store.putQueueEntry({ ...e, status: "failed", error: "The agent was removed" });
      return;
    }
    let entry = this.deps.store.putQueueEntry({ ...e, status: "merging" });
    let review: Review | undefined;
    try {
      review = await this.deps.reviews.prepare([e.agentId], true);
      entry = this.deps.store.putQueueEntry({ ...entry, reviewId: review.id });
      const why = blocked(review);
      if (why) {
        await this.deps.reviews.discard(review.id).catch(() => {});
        this.deps.store.putQueueEntry({ ...entry, status: "failed", error: why });
        return;
      }
      await this.deps.reviews.merge(review.id, { resetAgents: true });
      if (e.taskId) {
        const t = this.deps.store.getTask(e.taskId);
        if (t && t.status !== "done") this.deps.collab.setStatus(e.taskId, "done");
      }
      this.deps.store.putQueueEntry({ ...entry, status: "merged" });
      this.deps.log(`merge queue: merged ${e.agentId}'s work`);
    } catch (err) {
      if (review && review.status !== "merged") await this.deps.reviews.discard(review.id).catch(() => {});
      this.deps.store.putQueueEntry({ ...entry, status: "failed", error: (err as Error).message });
    }
  }

  private require(id: string): QueueEntry {
    const e = this.deps.store.getQueueEntry(id);
    if (!e) throw new RpcError(ErrorCodes.NotFound, `No queue entry "${id}"`);
    return e;
  }
}

/** Why a prepared review must not be merged, if it must not. */
function blocked(r: Review): string | undefined {
  if (r.status === "conflicted") return r.error ?? `Does not merge cleanly: ${r.mergeConflicts.join(", ")}`;
  if (r.status !== "ready") return r.error ?? `The review is ${r.status}`;
  if (!r.files.length) return "No changes to merge";
  if (r.tests && !r.tests.passed) return r.tests.timedOut ? "The tests timed out" : `The tests failed:\n${r.tests.output.trimEnd().split("\n").slice(-15).join("\n")}`;
  const conflicts = r.conflicts.filter((c) => c.severity === "error");
  if (conflicts.length) return `${conflicts.length} conflict(s) with other agents: ${conflicts.map((c) => c.message).join(" ")}`;
  return undefined;
}
