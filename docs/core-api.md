# synapse-core API

Version `0.1.0`. The TypeScript source of truth is
[`packages/protocol/src/api.ts`](../packages/protocol/src/api.ts); use
[`@synapse/client`](../packages/client/src/index.ts) rather than speaking the
wire protocol directly.

## Transport

- JSON-RPC 2.0, one JSON message per line.
- A Unix domain socket (`$TMPDIR/synapse-<hash>.sock`, mode 0600), or a named
  pipe on Windows (`\\.\pipe\synapse-<hash>`).
- Discovery: `<repo>/.synapse/core.json` (mode 0600) holds `pid`, `socket`,
  `token`, `version`, `startedAt`.
- The first call on a connection must be `session.hello` with that token.
  Anything else fails with code `-32001` (Unauthorized).

Error codes: `-32602` invalid params, `-32601` unknown method, `-32001`
unauthorized, `-32002` conflicts with current state (busy agent, stale review,
failing tests), `-32004` not found.

## Methods

| Method | Params | Result |
| --- | --- | --- |
| `session.hello` | `{ token, client? }` | `{ version, repoRoot, baseRef, pid }` |
| `state.get` | – | `CoreState`: agents, ownership, conflicts, approvals, reviews, seq |
| `events.subscribe` | `{ sinceSeq? }` | `{ seq, backlog }`; then `event` notifications |
| `events.unsubscribe` | – | `null` |
| `agents.presets` | – | `PresetInfo[]` |
| `agents.list` | – | `AgentState[]` |
| `agents.add` | `{ preset?, id?, name?, color?, command?, args?, env?, start? }` | `AgentState` (worktree created) |
| `agents.remove` | `{ id, keepWorktree? }` | `null` (worktree and branch deleted unless kept) |
| `agents.start` / `stop` / `restart` | `{ id }` | `AgentState` |
| `agents.prompt` | `{ id, text }` | `{ accepted: true }`; progress arrives as events |
| `agents.cancel` | `{ id }` | `null` |
| `agents.reset` | `{ id, ref? }` | `AgentState` (worktree reset to the base, changes discarded) |
| `ownership.get` | `{ agentId? }` | `AgentOwnership[]` |
| `ownership.refresh` | `{ agentId? }` | `AgentOwnership[]` (also rechecks conflicts) |
| `ownership.forFile` | `{ path, content? }` | `FileMarker[]` for a file in the person's checkout or a worktree |
| `conflicts.list` | – | `Conflict[]` |
| `conflicts.check` | – | `Conflict[]` (recomputed now) |
| `approvals.list` | `{ all? }` | `Approval[]` |
| `approvals.resolve` | `{ id, optionId?, reject? }` | `Approval` |
| `review.prepare` | `{ agents?, runTests? }` | `Review` |
| `review.get` / `review.list` | `{ id }` / – | `Review` / `Review[]` |
| `review.diff` | `{ id, path? }` | `{ diff }` (unified diff, base → combined) |
| `review.fileContent` | `{ id, path, side: "base" \| "merged" }` | `{ content \| null }` |
| `review.merge` | `{ id, resetAgents?, force? }` | `Review` |
| `review.discard` | `{ id }` | `Review` |
| `agents.setPolicy` | `{ id, policy: Partial<AgentPolicy> }` | `AgentState` |
| `policy.evaluate` | `{ agentId, query: { toolKind?, command?, path?, url? } }` | `{ decision: "allow" \| "ask" \| "deny", rule }` |
| `audit.list` | `{ agentId?, limit? }` | `AuditEntry[]` |
| `tasks.list` | – | `Task[]` |
| `tasks.create` | `{ title, description?, agentId?, dependsOn?, scope?, autoStart? }` | `Task` |
| `tasks.update` | `{ id, title?, description?, agentId?, dependsOn?, scope?, autoStart? }` | `Task` |
| `tasks.remove` | `{ id }` | `null` |
| `tasks.start` | `{ id }` | `Task` (prompt sent with context) |
| `tasks.setStatus` | `{ id, status }` | `Task` ("done" hands off and may auto-start dependents) |
| `messages.list` | `{ agentId? }` | `AgentMessage[]` |
| `messages.send` | `{ to, subject, body?, kind?, taskId?, files?, symbols? }` | `AgentMessage` (from the person) |
| `messages.release` / `messages.reject` | `{ id }` | `AgentMessage` (held messages) |
| `decisions.list` | – | `Decision[]` |
| `decisions.add` | `{ title, decision, rationale?, tags?, supersedes?, status? }` | `Decision` (accepted by default) |
| `decisions.resolve` | `{ id, status: "accepted" \| "rejected" \| "superseded" }` | `Decision` |
| `telemetry.status` | – | `TelemetryStatus` |
| `telemetry.setEnabled` | `{ enabled, endpoint? }` | `TelemetryStatus` |
| `telemetry.preview` | – | `TelemetryEvent[]` (exactly what would be sent) |
| `core.shutdown` | – | `null` (stops agents, then the process) |

## Events

Each `event` notification is `{ seq, ts, type, data }`.

| Type | Data |
| --- | --- |
| `agent.added` / `agent.updated` | `AgentState` |
| `agent.removed` | `{ id }` |
| `agent.output` | `{ agentId, kind: "message" \| "thought" \| "tool" \| "plan" \| "stderr" \| "turn", text }` |
| `ownership.updated` | `AgentOwnership` |
| `conflicts.updated` | `Conflict[]` (the full current list) |
| `approval.requested` / `approval.resolved` | `Approval` |
| `review.updated` | `Review` |
| `task.updated` / `task.removed` | `Task` / `{ id }` |
| `message.updated` | `AgentMessage` |
| `decision.updated` | `Decision` |
| `audit.added` | `AuditEntry` |
| `core.log` | `{ level, message }` (e.g. a risky command an agent ran without asking) |

The core keeps the last 2000 events for `sinceSeq` replay.

## The agent API

Agents' Synapse MCP servers connect with `agent.hello { agentToken }` instead
of `session.hello`. Such a connection can call only these, always as that
agent:

| Method | Does |
| --- | --- |
| `agent.tasks` | the task graph |
| `agent.inbox` | messages to this agent (marks pending ones delivered) |
| `agent.send` | send a message (screened; may be held) |
| `agent.decisions` | accepted decisions |
| `agent.proposeDecision` | propose a decision (status "proposed") |
| `agent.completeTask` | move its own in-progress task to review |

MCP tools exposed to the agent: `synapse_tasks`, `synapse_inbox`,
`synapse_send_message`, `synapse_decisions`, `synapse_propose_decision`,
`synapse_complete_task`.

## Agent status

`stopped → starting → idle ⇄ working ⇄ awaiting-approval`, and `error` when
the agent fails to start or exits unexpectedly.

## Example

```ts
import { SynapseClient } from "@synapse/client";

const c = await SynapseClient.connectOrStart({ workspace: process.cwd(), coreMain: require.resolve("@synapse/core/main") });
c.on("event", (ev) => console.log(ev.type));
await c.subscribe();
await c.call("agents.add", { preset: "claude", start: true });
await c.call("agents.prompt", { id: "claude", text: "Add input validation to the signup form" });
const conflicts = await c.call("conflicts.list");
```
