# Privacy and data flow

For people evaluating Synapse for company use (risk C5). Short version:
**Synapse itself sends nothing anywhere by default.** Your code goes only to
the agents you choose to run, under your own accounts.

## Where data goes

| Data | Goes to | When |
| --- | --- | --- |
| Your code, prompts, files the agent reads | The agent you run (Claude, Codex, …) and that vendor's model service | Whenever you run that agent. Governed by your agreement with the vendor, not by Synapse |
| Collaboration state (agents, tasks, messages, decisions, ownership, audit) | `.synapse/` in your repository, on your machine | Always. Not sent anywhere |
| Decision log Markdown | `decisionLogPath` in your repository | When decisions change. You decide whether to commit it |
| Core log | `.synapse/core.log` | Always. Known secret formats are masked |
| Crash reports | `~/.synapse-ide/crash-reports/` | When the core crashes. Redacted (secrets masked, home directory replaced by `~`). Stay local unless telemetry is on |
| Telemetry events | The configured endpoint | Only after you opt in **and** an endpoint is set |
| Extensions | Downloaded from open-vsx.org | When you install or update extensions |
| Code - OSS itself | Microsoft telemetry endpoints | Never: Synapse ships with `enableTelemetry: false` and no telemetry keys |

## Telemetry, when you opt in

Recorded: counts and enums only, for example `agent.added {preset: "claude"}`,
`conflicts {signature-change: 1}`, `review.merged {agents: 2, files: 5,
testsPassed: true}`, `policy.decision {outcome: "denied"}`. Plus a random
install id, the Synapse version, OS and architecture.

Never recorded: code, file paths, prompts, messages, agent output, commands,
repository names, user names.

```bash
synapse telemetry preview
```

shows the exact queue that would be sent. `synapse telemetry disable` drops
it. There is no Synapse telemetry server yet: until one exists and you set its
endpoint, enabling telemetry only collects locally.

## Choosing where code goes

- Use agents whose data terms your company accepts; Synapse treats every ACP
  agent the same.
- An ACP agent backed by a local model keeps code on your machine. Any agent
  that speaks ACP can be added with `--command`.
- Policies can deny network access for commands that go through Synapse
  (`"network": "deny"`). They do not restrict the agent's own connection to
  its model service.

## Secrets

- Agent environment variables (`agents.add` with `env`) are kept in memory
  only, never written to `.synapse/state.json`, never returned by the API,
  and masked in logs.
- Protected paths (`.env`, keys, `secrets/`) cannot be read or written by
  agents through Synapse; agent messages containing secret-like strings are
  held.
- Agents' own shell tools are outside Synapse's control; see
  [SECURITY.md](../SECURITY.md).
