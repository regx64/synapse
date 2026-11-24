import type { GoalSplit, ProposedTask, Task } from "@synapse/protocol";
import { ErrorCodes, RpcError } from "@synapse/protocol";
import type { AgentManager } from "./agents.js";
import type { CollabService } from "./collab.js";
import type { StateStore } from "./store.js";
import { nowIso, randomId } from "./util.js";

export const MAX_PROPOSED_TASKS = 20;
const TITLE_LIMIT = 200;
const DESCRIPTION_LIMIT = 4000;

export interface GoalDeps {
  store: StateStore;
  agents: AgentManager;
  collab: CollabService;
}

/**
 * Splitting a goal into tasks with an agent: the agent proposes tasks,
 * dependencies, scopes and assignees as JSON (it changes no files); the
 * person edits and accepts, and the tasks are created. The agent's reply is
 * data: parsed, validated and capped, never followed.
 */
export class GoalService {
  constructor(private readonly deps: GoalDeps) {}

  split(goal: string, agentId: string): GoalSplit {
    const text = String(goal ?? "").trim();
    if (!text) throw new RpcError(ErrorCodes.InvalidParams, "Describe the goal");
    if (text.length > DESCRIPTION_LIMIT) throw new RpcError(ErrorCodes.InvalidParams, `A goal is limited to ${DESCRIPTION_LIMIT} characters`);
    const agent = this.deps.store.getAgent(agentId);
    if (!agent) throw new RpcError(ErrorCodes.NotFound, `No agent "${agentId}"`);
    const busy = this.deps.store.listGoals().find((g) => g.agentId === agentId && g.status === "splitting");
    if (busy) throw new RpcError(ErrorCodes.Conflict, `${agent.name} is already splitting a goal`);
    const now = nowIso();
    const g: GoalSplit = { id: randomId("g"), goal: text, agentId, status: "splitting", tasks: [], createdAt: now, updatedAt: now };
    this.deps.agents.prompt(agentId, this.prompt(g)); // throws if not running or busy
    return this.deps.store.putGoal(g);
  }

  /** At the end of the splitting agent's turn: read its proposal. */
  onTurnEnd(agentId: string, stopReason: string, error?: string): void {
    const g = this.deps.store.listGoals().find((x) => x.agentId === agentId && x.status === "splitting");
    if (!g) return;
    if (error || stopReason !== "end_turn") {
      this.deps.store.putGoal({ ...g, status: "failed", error: error ?? `the agent's turn ended: ${stopReason}` });
      return;
    }
    try {
      const tasks = parseProposal(this.deps.store.getAgent(agentId)?.lastMessage ?? "", new Set(this.deps.store.listAgents().map((a) => a.id)));
      this.deps.store.putGoal({ ...g, status: "proposed", tasks });
    } catch (err) {
      this.deps.store.putGoal({ ...g, status: "failed", error: (err as Error).message });
    }
  }

  /** Creates the tasks, dependencies first, mapping the agent's keys to task ids. */
  accept(id: string, edited?: ProposedTask[], opts: { autoStart?: boolean; planFirst?: boolean } = {}): Task[] {
    const g = this.deps.store.getGoal(id);
    if (!g) throw new RpcError(ErrorCodes.NotFound, `No goal "${id}"`);
    if (g.status !== "proposed") throw new RpcError(ErrorCodes.Conflict, `Goal ${id} is ${g.status}, not waiting for you`);
    const agents = new Set(this.deps.store.listAgents().map((a) => a.id));
    const tasks = edited ? sanitize(edited, agents) : g.tasks;
    if (!tasks.length) throw new RpcError(ErrorCodes.InvalidParams, "No tasks to create");
    const keys = new Set(tasks.map((t) => t.key));
    const order = topoOrder(tasks.map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => keys.has(d)) })));
    const idOf = new Map<string, string>();
    const created: Task[] = [];
    for (const t of order) {
      const task = this.deps.collab.createTask({
        title: t.title,
        description: [t.description, `Part of the goal: ${g.goal}`].filter(Boolean).join("\n\n"),
        agentId: t.agentId,
        dependsOn: t.dependsOn.map((d) => idOf.get(d)!).filter(Boolean),
        scope: t.scope,
        autoStart: opts.autoStart,
        planFirst: opts.planFirst,
      });
      idOf.set(t.key, task.id);
      created.push(task);
    }
    this.deps.store.putGoal({ ...g, status: "accepted", tasks, createdTasks: created.map((t) => t.id) });
    return created.map((t) => this.deps.store.getTask(t.id)!);
  }

  discard(id: string): GoalSplit {
    const g = this.deps.store.getGoal(id);
    if (!g) throw new RpcError(ErrorCodes.NotFound, `No goal "${id}"`);
    if (g.status === "splitting") this.deps.agents.cancel(g.agentId);
    return this.deps.store.putGoal({ ...g, status: "discarded" });
  }

  private prompt(g: GoalSplit): string {
    const agents = this.deps.store.listAgents().map((a) => `- ${a.id}: ${a.name}${a.agentInfo?.name ? ` (${a.agentInfo.name})` : a.preset ? ` (${a.preset})` : ""}`);
    return [
      "Split this goal into tasks for several AI agents working in parallel, each in its own git worktree of this repository:",
      "",
      g.goal,
      "",
      "Look at the code as much as you need, but do not change any files.",
      "Make tasks that can run in parallel touch different files where you can; give a task dependsOn when it needs another task's result.",
      "Suggest an agent for each task from these (or leave agent empty):",
      ...agents,
      "",
      `Reply with only a JSON code block, at most ${MAX_PROPOSED_TASKS} tasks:`,
      "```json",
      '{"tasks": [{"key": "a", "title": "…", "description": "…", "dependsOn": [], "scope": ["src/…/**"], "agent": "…"}]}',
      "```",
    ].join("\n");
  }
}

/** Reads the tasks from an agent's reply: the last JSON block (or object) with a "tasks" array. */
export function parseProposal(reply: string, agentIds: Set<string>): ProposedTask[] {
  const candidates = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const brace = reply.indexOf("{");
  if (brace >= 0) candidates.push(reply.slice(brace, reply.lastIndexOf("}") + 1));
  for (const c of candidates.reverse()) {
    let data: unknown;
    try {
      data = JSON.parse(c);
    } catch {
      continue;
    }
    const list = Array.isArray(data) ? data : (data as { tasks?: unknown })?.tasks;
    if (!Array.isArray(list)) continue;
    const tasks = sanitize(list, agentIds);
    if (tasks.length) return tasks;
  }
  throw new Error("The agent's reply had no task list in JSON");
}

/** Validates and caps proposed tasks; unknown agents become unassigned, unknown or circular dependencies are dropped. */
function sanitize(list: unknown[], agentIds: Set<string>): ProposedTask[] {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim().slice(0, 200)).filter(Boolean).slice(0, 20) : []);
  const out: ProposedTask[] = [];
  const keys = new Set<string>();
  for (const [i, raw] of list.slice(0, MAX_PROPOSED_TASKS).entries()) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = str(r.title, TITLE_LIMIT);
    if (!title) continue;
    let key = str(r.key, 40) || `t${i + 1}`;
    while (keys.has(key)) key = `${key}'`;
    keys.add(key);
    const agent = str(r.agent ?? r.agentId, 64);
    out.push({ key, title, description: str(r.description, DESCRIPTION_LIMIT), dependsOn: strs(r.dependsOn), scope: strs(r.scope), agentId: agentIds.has(agent) ? agent : undefined });
  }
  for (const t of out) t.dependsOn = [...new Set(t.dependsOn.filter((d) => keys.has(d) && d !== t.key))];
  return topoOrder(out).length === out.length ? out : out.map((t) => ({ ...t, dependsOn: [] }));
}

/** Dependencies first. Tasks in a cycle are left out (the caller checks the count). */
function topoOrder(tasks: ProposedTask[]): ProposedTask[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const order: ProposedTask[] = [];
  const visit = (t: ProposedTask): boolean => {
    if (done.has(t.key)) return true;
    if (visiting.has(t.key)) return false;
    visiting.add(t.key);
    for (const d of t.dependsOn) {
      const dep = byKey.get(d);
      if (dep && !visit(dep)) return false;
    }
    visiting.delete(t.key);
    done.add(t.key);
    order.push(t);
    return true;
  };
  for (const t of tasks) if (!visit(t)) return order;
  return order;
}
