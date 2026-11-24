# Getting started

Synapse runs several AI coding agents in one repository and keeps them from
breaking each other's work. This page gets two agents working in about ten
minutes.

## 1. Install

During the beta, build from source (Node.js 22+, git 2.38+):

```bash
git clone https://github.com/regx64/synapse && cd synapse
```

```bash
npm ci && npm run build
```

```bash
npm link -w packages/cli
```

That puts `synapse` on your PATH. The Synapse IDE build (`node build/build.mjs`)
includes the same features with a board in the editor; the IDE opens a
walkthrough the first time.

## 2. Prepare a repository

Any git repository with a branch checked out works. Add a
`synapse.config.json` at its root so the combined review can test the merged
result:

```json
{
  "testCommand": "npm test",
  "decisionLogPath": "docs/decisions.md"
}
```

No repository at hand? Copy [examples/shop-js](../examples/shop-js).

## 3. Add two agents

```bash
synapse agent add claude --start
```

```bash
synapse agent add codex --start
```

Each agent gets its own git worktree (`.synapse/worktrees/<id>`) and branch
(`synapse/<id>`). They use your own credentials:

- **Claude** needs `ANTHROPIC_API_KEY` (from the Claude Console), or Amazon
  Bedrock / Google Vertex AI credentials. Anthropic's terms do not allow
  tools built on the Claude Agent SDK to use a Claude subscription login, so
  Synapse does not offer one.
- **Codex** uses `OPENAI_API_KEY`, or the sign-in you made by running `codex`
  once.

See [agent terms](agent-terms.md) for why.

No credentials? `synapse agent add mock --start` adds a scripted agent, and
`npm run demo` (in the Synapse repo) plays a full scenario.

## 4. Give them work

Directly:

```bash
synapse agent prompt claude --wait "Add input validation to the signup form"
```

Or as tasks with dependencies, so finished work is handed to the next agent:

```bash
synapse task add API endpoint --agent claude --scope "src/api/**"
```

```bash
synapse task add Client for the endpoint --agent codex --after t-1 --auto
```

```bash
synapse task start t-1
```

When Claude finishes, `t-1` waits for your review. `synapse task done t-1`
hands off to Codex (with the files and symbols Claude changed) and starts
`t-2` automatically.

## 5. Watch

```bash
synapse status
```

Shows each agent's state, pending approvals and **conflicts**: the same
symbol edited by both, a signature change one agent made while the other
calls the old signature, or changes that will not merge.

## 6. Review and merge in one pass

```bash
synapse review
```

```bash
synapse review diff <review-id>
```

```bash
synapse merge <review-id> --reset-agents
```

The review merges every agent's work in a scratch worktree, runs your
`testCommand` there, and merging is refused while tests fail or conflicts
remain.

Next: the [user guide](user-guide.md) covers permissions, messages and the
decision log.
