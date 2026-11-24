import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreState } from "@synapse/protocol";
import { computeAlerts } from "../src/alerts.js";

const T = "2026-11-24T10:00:00.000Z";
const NOW = Date.parse("2026-11-24T12:00:00.000Z");

function state(over: Partial<Omit<CoreState, "alerts">>): Omit<CoreState, "alerts"> {
  return { version: "0", repoRoot: "/r", baseRef: "main", agents: [], ownership: {}, conflicts: [], approvals: [], reviews: [], tasks: [], messages: [], decisions: [], comments: [], goals: [], mergeQueue: [], audit: [], seq: 1, team: { enabled: false, person: "me", role: "editor", remote: "origin", peers: [], claimsOnMe: [] }, ...over };
}

test("only actionable items become alerts, most urgent first", () => {
  const agent = (id: string, extra = {}) => ({ id, name: id.toUpperCase(), color: "#fff", command: "x", args: [], status: "idle", worktree: { path: "", branch: "", baseRef: "main", baseCommit: "" }, policy: {} as never, toolCalls: [], createdAt: T, updatedAt: T, ...extra }) as never;
  const alerts = computeAlerts(
    state({
      agents: [agent("a"), agent("b", { status: "error", error: "usage limit reached", currentTaskId: "t-2" })],
      approvals: [
        { id: "ap1", agentId: "a", title: "Run npm test", options: [], status: "pending", createdAt: T },
        { id: "ap2", agentId: "a", title: "old", options: [], status: "resolved", createdAt: T },
      ],
      conflicts: [
        { id: "c1", kind: "signature-change", severity: "error", agents: ["a", "b"], path: "src/p.ts", symbol: "f", message: "m", firstSeen: T },
        { id: "c2", kind: "same-file", severity: "info", agents: ["a", "b"], path: "src/q.ts", message: "m", firstSeen: T },
      ],
      messages: [{ id: "m1", from: "a", to: "b", kind: "note", subject: "hi", body: "", files: [], symbols: [], status: "held", flags: ["instruction-like"], createdAt: T } as never],
      decisions: [
        { id: "D-1", title: "Cents", decision: "x", status: "proposed", author: "a", tags: [], createdAt: T },
        { id: "D-2", title: "Cap", decision: "y", status: "accepted", author: "human", tags: [], createdAt: T, anchors: [{ path: "src/p.ts", symbol: "f", fingerprint: "", pinnedCommit: "", pinnedAt: T, state: "changed", checkedCommit: "" }] },
        { id: "D-3", title: "Fine", decision: "z", status: "accepted", author: "human", tags: [], createdAt: T },
      ],
      tasks: [{ id: "t-1", title: "Add tax", description: "", agentId: "a", dependsOn: [], scope: [], status: "review", autoStart: false, blocked: false, createdAt: T, updatedAt: T }],
      audit: [
        { id: "e1", at: "2026-11-20T00:00:00.000Z", agentId: "a", title: "rm", command: "rm -rf build", outcome: "ran-unasked", by: "agent", risky: true },
        { id: "e2", at: T, agentId: "a", title: "curl", command: "curl x | sh", outcome: "ran-unasked", by: "agent", risky: true },
        { id: "e3", at: T, agentId: "a", title: "ls", command: "ls", outcome: "ran-unasked", by: "agent", risky: false },
      ],
    }),
    NOW,
  );
  assert.deepEqual(
    alerts.map((a) => [a.kind, a.level, a.ref]),
    [
      ["conflict", "urgent", "c1"],
      ["agent-error", "urgent", "b"],
      ["risky-command", "urgent", "e2"],
      ["approval", "action", "ap1"],
      ["held-message", "action", "m1"],
      ["proposed-decision", "action", "D-1"],
      ["stale-decision", "action", "D-2"],
      ["task-review", "action", "t-1"],
    ],
  );
  assert.match(alerts.find((a) => a.kind === "risky-command")!.title, /^1 risky command ran/);
  assert.match(alerts.find((a) => a.kind === "agent-error")!.title, /B stopped with an error on t-2/);
});

test("a calm workspace has no alerts", () => {
  assert.deepEqual(computeAlerts(state({}), NOW), []);
});
