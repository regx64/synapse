# User guide

Everything here works from the board in the Synapse IDE and from the
`synapse` CLI; both call the same core.

## Agents and worktrees

An agent is any program that speaks the [Agent Client Protocol](https://agentclientprotocol.com)
on stdio. Presets: `claude`, `codex`, `gemini` (outside the MVP), `mock`.
A custom agent:

```bash
synapse agent add --command my-agent --arg --acp --id mine --start
```

Each agent works in `.synapse/worktrees/<id>` on `synapse/<id>`. Your own
checkout is never written by agents. `synapse agent reset <id>` throws an
agent's changes away; `synapse agent remove <id>` deletes its worktree and
branch.

## Ownership and conflicts

Synapse parses changed files with tree-sitter (TypeScript, JavaScript,
Python, Go, Rust, Java) and records which functions, methods and classes each
agent changed. In the editor, code another agent is changing is tinted in
that agent's color.

| Conflict | Meaning |
| --- | --- |
| same-symbol | two agents change the same function, method or class |
| signature-change | one agent changes or removes a function; another agent's new code calls it in a way the new signature does not accept |
| text-conflict | the changes will not merge as text |
| same-file | different parts of one file (information only) |
| decision | an agent changes code that an accepted decision is pinned to (warning; see [pinning decisions](#pinning-decisions-to-code)) |

## Tasks

Tasks have a title, a description, an agent, dependencies, a scope (globs)
and an auto-start flag.

- A task is **blocked** until every dependency is **done**.
- Starting a task sends the agent a prompt with the task, its scope, the
  accepted decisions and any handoffs from its dependencies.
- When the agent's turn ends, the task goes to **review**. Files changed
  outside the scope are listed.
- You mark it **done** (or failed, or back to todo). Done hands off to the
  agents of dependent tasks and auto-starts the ones that can start.

```bash
synapse tasks
```

```bash
synapse task done t-1
```

## Messages between agents

Messages are structured: kind (handoff, question, answer, note, blocker),
subject, body, files and symbols. They reach an agent with its next prompt,
inside a block that says it is information, not instructions. Agents send
messages with the Synapse MCP tools (`synapse_send_message`), and you can too:

```bash
synapse message send codex "Prices are in cents" --body "Use integer cents everywhere"
```

**Held messages.** A message from an agent is held for you when it reads like
instructions ("ignore previous instructions", "you must run…"), contains a
dangerous command, or contains something that looks like a secret.

```bash
synapse messages
```

```bash
synapse message release <id>
```

## Decision log

Shared project memory. You add decisions (accepted right away); agents propose
them (`synapse_propose_decision`) and you accept or reject. Accepted decisions
go into every task prompt, and the whole log is written as Markdown to
`decisionLogPath`, so it can live in the repository.

```bash
synapse decision add Errors --decision "API errors use RFC 9457 problem details"
```

```bash
synapse decision accept D-3
```

### Pinning decisions to code

A decision can say which code it is about: a file, or a function, method or
class in it. Synapse fingerprints that code on the base branch (ignoring
whitespace) and then watches it:

- **An agent changes pinned code** in its worktree: a `decision` warning
  shows on the board, in the Problems panel and in the combined review, before
  anything merges. It does not block the merge.
- **The pinned code changes on the base branch** (a merge, or your own
  commits): the decision is marked *code changed* (or *gone from base*) on the
  Decisions tab and in the Markdown log, until you confirm it still holds
  (**Still holds**, `synapse decision repin`) or supersede it.

Agents see where each accepted decision applies in their task prompts, and
can pin the decisions they propose (`pins` in `synapse_propose_decision`).

In the editor, right-click a function and choose **Pin a Decision Here**. From
the CLI:

```bash
synapse decision pin D-3 src/api/errors.ts#problemDetails
```

```bash
synapse decision add Money --decision "Amounts are integer cents" --pin src/money.ts,src/cart.ts#Cart
```

```bash
synapse decision repin D-3
```

## Permissions

Each agent has a policy; `synapse.config.json` sets the default for all.

```json
{
  "policy": {
    "writable": ["**"],
    "protected": [".env", "**/.env.*", "**/*.pem", "**/secrets/**"],
    "edits": "allow",
    "commands": {
      "allow": ["npm test*", "git status*", "git diff*"],
      "deny": ["git push*", "sudo *", "* | sh"]
    },
    "network": "ask",
    "otherwise": "ask"
  }
}
```

- Protected files can never be read or written through Synapse.
- A command runs without asking only when **every part** of it (split on
  `&&`, `||`, `;`, `|`) matches an allow pattern; any part matching a deny
  pattern refuses it; command substitutions always ask.
- Network commands (curl, wget, git push/fetch, npm publish…) follow `network`.
- Everything else follows `otherwise`; "ask" puts an approval card on the board.

Per agent: `synapse policy codex --set '{"network":"deny"}'`, or in the IDE,
*Synapse: Edit Agent Permission Policy* opens the policy as JSON; saving
applies it. Test a rule: `synapse policy codex --try "npm test && git push"`.

**Audit.** Every policy decision, every decision you make, and every command
an agent reports running without asking is logged (`synapse audit`). Risky
commands run without asking raise a warning.

Policies govern what goes through Synapse. They are not an OS sandbox; see
[SECURITY.md](../SECURITY.md).

## Combined review

`synapse review` (or *Review & merge* on the board) merges every agent's work
into `.synapse/review/<id>`, runs `setupCommand` and `testCommand` there, and
shows files, owners, conflicts and test output. Merging fast-forwards your
branch; it requires a clean checkout, an unmoved base, passing tests and no
open conflicts (or `--force`).

## Privacy

Synapse collects no telemetry and sends nothing about you. Crash reports of
the core stay in `~/.synapse-ide/crash-reports/`. Details:
[privacy and data flow](privacy-and-data-flow.md).
