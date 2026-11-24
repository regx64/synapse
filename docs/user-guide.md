# User guide

Everything here works from the board in the Synapse IDE and from the
`synapse` CLI; both call the same core.

## Overview

The board opens on **Overview**: first **Needs you**, only the things that
wait for you or can cause damage, most urgent first, each with its action
right there:

| Alert | Action |
| --- | --- |
| an agent asks permission | the agent's own options (allow, reject…) |
| a conflict between agents (errors first) | open the file |
| an agent stopped with an error | restart, or hand its work to another agent |
| a message held for you | release or reject |
| a proposed decision | accept or reject |
| a pinned decision whose code changed | still holds |
| a task ready for review | review & merge, or mark done |
| risky commands an agent ran without asking (last day) | open the audit |

Below it, every agent at a glance: status, task, plan progress, files,
comments and waiting guidance. `synapse alerts` prints the same list.

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

## Live changes and comments

**Live diff** on an agent's card (or the agent menu) opens its changes
against its base as they happen, refreshed with every snapshot. Click a line
number to comment on it:

- **Tell the agent**: the comment, with the code it is about, goes to the
  agent as guidance after its current turn (at once if it is idle);
- **Make a task**: a task for that agent, with the comment and the code;
- **Keep as note**: stays on the diff for you.

Comments follow their code as the agent keeps editing; when the code they
quote is gone, they are marked *code changed*. Resolve a comment when it is
done.

```bash
synapse diff claude src/pricing.ts
```

```bash
synapse comment add claude src/pricing.ts:12-14 "Clamp to zero" --tell
```

```bash
synapse comments --agent claude
```

## Steering and handing off

**Guidance while an agent works.** Type in an agent's card while it is busy
and choose **After this turn** (it finishes, then continues with your
guidance) or **Interrupt now** (the turn stops and continues with it at
once). Either way it continues the same work: its task stays in progress, and
nothing it already did is undone. The card shows guidance that is waiting and
how many times a turn was steered.

```bash
synapse agent steer claude "Keep the public API unchanged"
```

```bash
synapse agent steer claude "Stop: use integer cents" --now
```

**Handing work to another agent.** When an agent is stuck, out of credit, or
simply the wrong one for the job, **Hand off…** moves its unfinished work to
another agent: the first agent is stopped where it is, its changes (committed
or not) move into the other agent's worktree, its task is reassigned, and the
new agent is told what was done (files, the old plan, the last message, and
your note) and continues from there. The agent taking over must be running,
idle and without changes of its own. The moved work is also kept at
`refs/synapse/takeovers/…`.

```bash
synapse takeover claude codex --note "The tests in cart.test.ts still fail"
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

## Team mode

Several people, each with their own Synapse and agents, on one repository.
There is no Synapse server: your existing git remote carries it. Turn it on in
`synapse.config.json` (or `.synapse/config.json` for just you):

```json
{ "team": { "enabled": true, "name": "alice", "remote": "origin", "intervalSec": 60 } }
```

Every minute, and shortly after your agents change something, Synapse pushes
your agents' work in progress (their snapshot commits) and a small summary to
`refs/synapse/team/<name>/` on the remote, and fetches your teammates'. Their
agents then take part in conflict detection: if Bob's agent calls a function
your agent is changing, you both see the signature-change warning before
anyone merges. The **Team** section of the Overview shows teammates' agents,
read-only.

```bash
synapse team sync
```

```bash
synapse team leave
```

`leave` removes everything you published. Team mode pushes unfinished code to
the remote, like pushing a branch, so it is off by default; anyone who can
read the remote can read it. `name` defaults to your git `user.name`.

## Privacy

Synapse collects no telemetry and sends nothing about you. Crash reports of
the core stay in `~/.synapse-ide/crash-reports/`. Details:
[privacy and data flow](privacy-and-data-flow.md).
