import type { AgentState, AgentTests } from "@synapse/protocol";
import { ErrorCodes, RpcError } from "@synapse/protocol";
import type { AgentManager } from "./agents.js";
import type { SynapseConfig } from "./config.js";
import { redact } from "./redact.js";
import { runShell } from "./review.js";
import type { StateStore } from "./store.js";
import { nowIso } from "./util.js";

/** Output kept on the agent (the end of it). */
const OUTPUT_TAIL = 8 * 1024;
/** Failing runs given back to the agent in a row before Synapse stops and leaves it to the person. */
export const MAX_FEEDBACK = 3;

export interface AgentTestDeps {
  store: StateStore;
  agents: AgentManager;
  config: () => SynapseConfig;
  /** Brings the agent's ownership (and its snapshot) up to date. */
  refreshOwnership: (agentId: string) => Promise<unknown>;
  log: (msg: string) => void;
}

/**
 * Runs the workspace's testCommand in each agent's own worktree after a turn
 * that changed something, so a failure shows on that agent while it still
 * has the context, not at review time. setupCommand runs first, once per
 * worktree base. Optionally gives the failure back to the agent.
 */
export class AgentTestService {
  private readonly running = new Set<string>();
  private readonly setUp = new Map<string, string>();

  constructor(private readonly deps: AgentTestDeps) {}

  /** After a turn: run when tests after turns are on and the worktree changed since the last run. */
  async onTurnEnd(agentId: string, stopReason: string): Promise<void> {
    const cfg = this.deps.config();
    if (!cfg.testCommand || cfg.testsAfterTurn === false || stopReason === "cancelled" || stopReason === "refusal") return;
    await this.deps.refreshOwnership(agentId);
    const a = this.deps.store.getAgent(agentId);
    const snapshot = this.deps.store.getOwnership(agentId)?.snapshot;
    if (!a || !snapshot || a.tests?.snapshot === snapshot) return;
    if (!(this.deps.store.getOwnership(agentId)?.files.length)) return;
    await this.run(agentId, true);
  }

  /** Runs the tests now (the person asked). */
  async runNow(agentId: string): Promise<AgentState> {
    if (!this.deps.config().testCommand) throw new RpcError(ErrorCodes.InvalidParams, 'No test command: set "testCommand" in synapse.config.json');
    if (!this.deps.store.getAgent(agentId)) throw new RpcError(ErrorCodes.NotFound, `No agent "${agentId}"`);
    if (this.running.has(agentId)) return this.deps.store.getAgent(agentId)!;
    await this.deps.refreshOwnership(agentId);
    void this.run(agentId, false).catch((e: Error) => this.deps.log(`tests for ${agentId} failed to run: ${e.message}`));
    return this.deps.store.getAgent(agentId)!;
  }

  private async run(agentId: string, afterTurn: boolean): Promise<void> {
    if (this.running.has(agentId)) return;
    const cfg = this.deps.config();
    const a = this.deps.store.getAgent(agentId);
    if (!a || !cfg.testCommand) return;
    this.running.add(agentId);
    const snapshot = this.deps.store.getOwnership(agentId)?.snapshot;
    const previous = a.tests;
    const startedAt = nowIso();
    this.set(agentId, { status: "running", command: cfg.testCommand, startedAt, snapshot, feedbackCount: previous?.feedbackCount });
    try {
      const timeout = cfg.testTimeoutMs ?? 600_000;
      if (cfg.setupCommand && this.setUp.get(agentId) !== a.worktree.baseCommit) {
        const setup = await runShell(cfg.setupCommand, a.worktree.path, timeout);
        if (!setup.passed) {
          this.set(agentId, { status: "failed", command: cfg.setupCommand, startedAt, durationMs: setup.durationMs, timedOut: setup.timedOut, output: tail(setup.output), snapshot });
          return;
        }
        this.setUp.set(agentId, a.worktree.baseCommit);
      }
      const r = await runShell(cfg.testCommand, a.worktree.path, timeout);
      const failedInARow = r.passed ? 0 : (previous?.status === "failed" ? (previous.feedbackCount ?? 0) : 0);
      const result: AgentTests = { status: r.passed ? "passed" : "failed", command: cfg.testCommand, startedAt, durationMs: r.durationMs, timedOut: r.timedOut || undefined, output: tail(r.output), snapshot, feedbackCount: failedInARow };
      this.set(agentId, result);
      if (!r.passed && afterTurn && cfg.testsFeedback && failedInARow < MAX_FEEDBACK) {
        const now = this.deps.store.getAgent(agentId);
        if (now && now.status === "idle") {
          this.set(agentId, { ...result, feedbackCount: failedInARow + 1 });
          this.deps.agents.steer(agentId, feedback(result), "next");
        }
      }
    } finally {
      this.running.delete(agentId);
    }
  }

  private set(agentId: string, tests: AgentTests): void {
    this.deps.store.updateAgent(agentId, { tests: Object.fromEntries(Object.entries(tests).filter(([, v]) => v !== undefined)) as unknown as AgentTests });
  }
}

function tail(output: string): string {
  const r = redact(output);
  return r.length > OUTPUT_TAIL ? `…${r.slice(-OUTPUT_TAIL)}` : r;
}

/** What the agent is told when its tests fail. */
export function feedback(t: AgentTests): string {
  const lines = (t.output ?? "").trimEnd().split("\n").slice(-60).join("\n");
  return [
    `Synapse ran \`${t.command}\` in your worktree after your turn and it ${t.timedOut ? "timed out" : "failed"}. The end of the output:`,
    "```",
    lines,
    "```",
    "Fix the failure, then finish. If the failure is not caused by your changes, say so instead of changing unrelated code.",
  ].join("\n");
}
