# Architecture

Two UIs, one core, three external parts.

```
            ┌──────────────────────────────┐     ┌──────────────────────┐
  UIs       │ Synapse IDE (Code - OSS fork) │     │ synapse CLI          │   (later: standalone IDE,
            │  built-in extension           │     │                      │    or a plain VS Code extension)
            │  synapse-collab               │     │                      │
            └──────────────┬───────────────┘     └──────────┬───────────┘
                           │  JSON-RPC 2.0 over a local socket (token-authenticated)
                           ▼                                 ▼
            ┌──────────────────────────────────────────────────────────────┐
  Core      │ synapse-core (separate Node process, one per repository)     │
            │  StateStore ─ single source of truth, event stream           │
            │  AgentManager ─ lifecycle, ACP client handlers, approvals    │
            │  WorktreeManager ─ one git worktree per agent                │
            │  OwnershipService ─ snapshots + tree-sitter symbol diffs     │
            │  Conflict detection ─ same symbol, signature change, text    │
            │  ReviewService ─ integration worktree, tests, merge          │
            │  CollabService ─ task graph, messages, decision log          │
            │  Policy ─ per-agent permissions, audit; Telemetry (opt-in)   │
            └───────┬─────────────────────────┬──────────────────────┬─────┘
                    │ ACP over stdio           │ git                  │ (IDE only)
                    ▼                          ▼                      ▼
  External   Agents: Claude, Codex,      The repository:        Open VSX: the
             Gemini, any ACP agent       worktrees, refs,       extension gallery
             (user's own keys)           merge-tree
```

Each agent also starts a **Synapse MCP server** (given to it in ACP
`session/new`). It connects back to the core with a per-agent token and can
use only the restricted agent API: read tasks and its inbox, send messages,
read accepted decisions, propose decisions, report a task finished.

## Rules

1. **Collaboration logic lives only in synapse-core** (risk T7). UIs render
   core state and call core methods. The CLI exists partly to prove this: every
   feature the extension has, the CLI can drive.
2. **The core is the single source of truth** (risk T4). Every change goes
   through `StateStore`, gets a sequence number and is pushed as an event.
   Clients that reconnect replay missed events with `events.subscribe({sinceSeq})`.
3. **Agents write only to their own worktree** (T4, C1). The ACP file handlers
   refuse paths outside it and `.git`. The person's checkout is never touched
   by agents; only an approved `review.merge` changes it.
4. **Agent output is data, not instructions** (C2). Approval details and
   messages are displayed, never executed or fed to another agent as commands.
5. **Policies decide first, the person decides the rest** (C1). Every
   permission request is evaluated against the agent's policy (allow, deny, or
   ask the person), and every decision is audited.
6. **No secrets on disk** (C4). Agent environment variables stay in memory and
   are not written to `.synapse/state.json` or returned by the API.

## How ownership works

On every change signal (an ACP file write, a completed edit tool call, a file
system event in the worktree, the end of a turn) the core, debounced:

1. writes a **snapshot commit** of the agent's worktree with a temporary index
   (uncommitted and untracked files included, nothing in the worktree touched)
   and keeps it reachable under `refs/synapse/snapshots/<agent>`;
2. diffs the snapshot against the commit the agent started from;
3. parses both versions of each changed file with tree-sitter and compares
   symbols by qualified name. A symbol counts as modified when its *own* text
   changes: a class is not modified because one of its methods changed.
   Signatures (parameters and return type) are compared separately, and the
   accepted argument counts are recorded.

## How conflicts are found

After ownership changes, across all agents:

| Kind | Rule | Severity |
| --- | --- | --- |
| `same-symbol` | the same qualified symbol in the same file is changed by 2+ agents | error |
| `signature-change` | agent A changes the signature of (or removes) a function or method; agent B's added or modified code calls that name with an argument count that does not fit the new signature | error |
| `text-conflict` | `git merge-tree --write-tree` of the two snapshots reports conflicts | error |
| `same-file` | two agents change different symbols of one file | info |

Conflict ids are stable while a conflict persists, so UIs can track them.
Name-based call matching can produce false positives across unrelated
functions with the same name; import resolution is future work.

## Task graph and handoffs

Tasks have dependencies (cycles are rejected), an assignee, a scope and an
auto-start flag. `tasks.start` composes the prompt: the task, its scope, then
a `<synapse-context>` block holding accepted decisions and pending messages,
labeled as data. When the agent's turn ends the task goes to review; the
person's "done" creates handoff messages to the agents of dependent tasks
(files and symbols from ownership, not from agent text) and auto-starts what
can start.

Messages from agents are screened before delivery: text that reads like
instructions, dangerous commands or secret-looking strings hold the message
for the person; tags that would open or close the context block are removed.

## Permission model

`policy.ts` is a pure function of a policy and a request. File access over
ACP is checked against `protected` and `writable` globs; permission requests
are evaluated by tool kind (edits, reads, commands, fetches). A command is
auto-allowed only if every part of it (split on `&&`, `||`, `;`, `|`) matches
an allow pattern; any denied part refuses it; substitutions always ask.
Commands an agent reports running without having asked are audited as
`ran-unasked`, and risky ones raise a warning event.

## Combined review

`review.prepare` refreshes all snapshots, creates `.synapse/review/<id>` as a
detached worktree at the tip of the base branch, merges each agent's snapshot
with `--no-ff`, runs `setupCommand` and `testCommand` there, and records the
files, their owners and the test output. `review.merge` fast-forwards the base
branch to the integration commit (or updates the ref when it is not checked
out), only if the base has not moved, your checkout is clean, tests passed and
no error-level conflicts remain (`force` overrides the last two). With
`resetAgents`, agents whose work did not change since the review restart from
the new base.

## Process model

The UI starts the core detached (`SynapseClient.connectOrStart`) and finds it
through `<repo>/.synapse/core.json` (socket path and token, mode 0600). The
socket is a Unix domain socket in the temp dir (mode 0600), or a named pipe on
Windows. The core keeps running across window reloads so agents survive; it
stops on `core.shutdown`. Inside the IDE, the extension runs the bundled core
with the editor's own runtime (`ELECTRON_RUN_AS_NODE=1`).
