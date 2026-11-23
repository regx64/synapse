# Security policy

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability
reporting for this repository (Security tab → "Report a vulnerability").
We aim to acknowledge reports within 3 working days.

Especially relevant:

- an agent escaping its worktree or policy through Synapse (ACP file access,
  permission requests, the Synapse MCP server);
- one agent's output reaching another agent or the person as instructions
  (prompt injection through messages, handoffs, decisions);
- secrets leaking into logs, crash reports or `.synapse/`;
- the local core API being reachable by other users or without the token.

## What Synapse protects, and what it does not

Synapse confines what agents do **through Synapse**: file access over ACP is
limited to the agent's worktree and its policy, permission requests are
decided by policy or by you, and agent-to-agent messages are screened and
delivered as data.

Synapse is **not an OS sandbox**. Agents run as your user. An agent's own
shell tools can read and write anything your user can, including other
worktrees and `.synapse/core.json`. Synapse logs commands agents report and
warns about risky ones they ran without asking, but cannot prevent them. Run
agents you do not trust in a container or VM.

The core API listens on a local socket (mode 0600 on Unix; a named pipe on
Windows) and requires the token in `.synapse/core.json` (mode 0600).
Agents' MCP servers get a separate per-agent token that opens only the
restricted agent API.

## Supported versions

Only the latest release receives fixes during the beta.
