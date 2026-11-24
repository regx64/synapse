# Privacy and data flow

For people evaluating Synapse for company use (risk C5). Short version:
**Synapse collects nothing and sends nothing about you.** There is no
telemetry, no install id and no crash upload, and the built-in GitHub
Copilot is not shipped. Your code goes only to the agents you choose to run,
under your own accounts.

## Where data goes

| Data | Goes to | When |
| --- | --- | --- |
| Your code, prompts, files the agent reads | The agent you run (Claude, Codex, …) and that vendor's model service | Whenever you run that agent. Governed by your agreement with the vendor, not by Synapse |
| Collaboration state (agents, tasks, messages, decisions, ownership, audit) | `.synapse/` in your repository, on your machine | Always. Not sent anywhere |
| Decision log Markdown | `decisionLogPath` in your repository | When decisions change. You decide whether to commit it |
| Core log | `.synapse/core.log` | Always. Known secret formats are masked |
| Crash reports | `~/.synapse-ide/crash-reports/` | When the core crashes. Redacted (secrets masked, home directory replaced by `~`). Never sent; attach one to a bug report yourself if you want |
| Your agents' work in progress (team mode only) | Your own git remote, `refs/synapse/team/<name>/` | Only when you turn team mode on. Anyone who can read the remote can read it; `synapse team leave` removes it |
| Extensions | open-vsx.org | When you search, install or update extensions (Open VSX sees which extensions are asked for) |
| Code - OSS itself | Microsoft telemetry, experiments, crash upload, surveys, settings sync | Never. Synapse ships with `enableTelemetry: false` and none of those endpoints; `build/check-branding.mjs` fails the build if one appears |
| GitHub Copilot | GitHub | Never: it is not in the build (core patch 0002), and the editor's built-in AI features are off by default |

## No telemetry

Synapse used to have opt-in usage counts; they were removed. The core has no
telemetry API, records no usage events and keeps no install id. The only
per-user files it writes are crash reports, and only when it crashes.

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
