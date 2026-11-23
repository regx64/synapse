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

The core keeps the last 2000 events for `sinceSeq` replay.

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
