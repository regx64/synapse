import type { Alert, CoreState } from "@synapse/protocol";

/** Risky commands an agent ran without asking stay an alert this long. */
const RISKY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * What needs the person, derived from state: only items they can act on,
 * most urgent first. Nothing here is stored; an alert disappears when its
 * item is resolved.
 */
export function computeAlerts(s: Omit<CoreState, "alerts">, now = Date.now()): Alert[] {
  const name = (id?: string) => (id ? (s.agents.find((a) => a.id === id)?.name ?? id) : "");
  const out: Alert[] = [];

  for (const ap of s.approvals) {
    if (ap.status !== "pending") continue;
    out.push({ id: `approval:${ap.id}`, kind: "approval", level: "action", title: `${name(ap.agentId)} asks: ${ap.title}`, detail: ap.toolKind, agentId: ap.agentId, ref: ap.id, at: ap.createdAt });
  }
  for (const c of s.conflicts) {
    if (c.severity === "info") continue;
    out.push({
      id: `conflict:${c.id}`,
      kind: "conflict",
      level: c.severity === "error" ? "urgent" : "action",
      title: c.kind === "decision" ? `Pinned decision ${c.decisionId}: code being changed` : `${c.kind.replace("-", " ")} in ${c.path}${c.symbol ? ` › ${c.symbol}` : ""}`,
      detail: c.message,
      agentId: c.agents[0],
      ref: c.id,
      at: c.firstSeen,
    });
  }
  for (const a of s.agents) {
    if (a.status !== "error" && !(a.error && a.status !== "working")) continue;
    out.push({
      id: `agent-error:${a.id}`,
      kind: "agent-error",
      level: "urgent",
      title: `${a.name} stopped with an error${a.currentTaskId ? ` on ${a.currentTaskId}` : ""}`,
      detail: a.error,
      agentId: a.id,
      ref: a.id,
      at: a.updatedAt,
    });
  }
  for (const m of s.messages) {
    if (m.status !== "held") continue;
    out.push({ id: `held-message:${m.id}`, kind: "held-message", level: "action", title: `Message from ${name(m.from)} held for you: ${m.subject}`, detail: m.flags.join(", "), agentId: m.from, ref: m.id, at: m.createdAt });
  }
  for (const d of s.decisions) {
    if (d.status === "proposed") {
      const by = d.author === "human" ? "Proposed decision" : `${name(d.author)} proposes`;
      out.push({ id: `proposed-decision:${d.id}`, kind: "proposed-decision", level: "action", title: `${by} ${d.id}: ${d.title}`, detail: d.decision, agentId: d.author === "human" ? undefined : d.author, ref: d.id, at: d.createdAt });
    } else if (d.status === "accepted" && d.anchors?.some((x) => x.state !== "current")) {
      const changed = d.anchors.filter((x) => x.state !== "current").map((x) => (x.symbol ? `${x.path} › ${x.symbol}` : x.path));
      out.push({ id: `stale-decision:${d.id}`, kind: "stale-decision", level: "action", title: `Does ${d.id} still hold? Its code changed`, detail: `${d.title}: ${changed.join(", ")}`, ref: d.id, at: d.decidedAt ?? d.createdAt });
    }
  }
  for (const t of s.tasks) {
    if (t.status !== "review") continue;
    if (t.plan?.state === "proposed") {
      out.push({
        id: `plan-review:${t.id}`,
        kind: "plan-review",
        level: "action",
        title: `${t.id} plan to approve: ${t.title}`,
        detail: t.plan.changedFiles ? "the agent changed files while planning" : undefined,
        agentId: t.agentId,
        ref: t.id,
        at: t.endedAt ?? t.updatedAt,
      });
      continue;
    }
    out.push({
      id: `task-review:${t.id}`,
      kind: "task-review",
      level: "action",
      title: `${t.id} is ready for review: ${t.title}`,
      detail: t.outOfScope?.length ? `changed files outside its scope: ${t.outOfScope.join(", ")}` : undefined,
      agentId: t.agentId,
      ref: t.id,
      at: t.endedAt ?? t.updatedAt,
    });
  }
  const risky = s.audit.filter((e) => e.risky && e.outcome === "ran-unasked" && now - Date.parse(e.at) < RISKY_WINDOW_MS);
  if (risky.length) {
    const last = risky[risky.length - 1]!;
    out.push({
      id: "risky-command",
      kind: "risky-command",
      level: "urgent",
      title: `${risky.length} risky command${risky.length === 1 ? "" : "s"} ran without asking in the last day`,
      detail: `latest: ${name(last.agentId)} ran ${last.command ?? last.title}`,
      agentId: last.agentId,
      ref: last.id,
      at: last.at,
    });
  }
  for (const e of s.mergeQueue ?? []) {
    if (e.status !== "failed") continue;
    out.push({ id: `queue-failed:${e.id}`, kind: "queue-failed", level: "action", title: `${name(e.agentId)}'s work was not merged`, detail: e.error, agentId: e.agentId, ref: e.id, at: e.updatedAt });
  }
  for (const g of s.goals ?? []) {
    if (g.status !== "proposed" && g.status !== "failed") continue;
    out.push({
      id: `goal-split:${g.id}`,
      kind: "goal-split",
      level: "action",
      title: g.status === "proposed" ? `${name(g.agentId)} split a goal into ${g.tasks.length} tasks` : `${name(g.agentId)} could not split a goal`,
      detail: g.status === "failed" ? g.error : g.goal.slice(0, 200),
      agentId: g.agentId,
      ref: g.id,
      at: g.updatedAt,
    });
  }
  for (const a of s.agents) {
    if (a.tests?.status !== "failed") continue;
    out.push({
      id: `tests-failed:${a.id}`,
      kind: "tests-failed",
      level: "action",
      title: `${a.name}'s tests failed`,
      detail: (a.tests.output ?? "").trimEnd().split("\n").slice(-3).join("\n"),
      agentId: a.id,
      ref: a.id,
      at: a.tests.startedAt,
    });
  }
  for (const c of s.team?.claimsOnMe ?? []) {
    const own = c.agent.slice(c.agent.indexOf("/") + 1);
    out.push({
      id: `team-claim:${c.id}`,
      kind: "team-claim",
      level: "action",
      title: `${c.by} continued ${name(own)}'s work${c.task ? ` on "${c.task}"` : ""}`,
      detail: `in ${c.by}'s ${c.byAgent}. Reset ${name(own)} so you two don't work on the same changes, or dismiss.`,
      agentId: own,
      ref: c.id,
      at: c.at,
    });
  }
  const rank = (a: Alert) => (a.level === "urgent" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at));
}
