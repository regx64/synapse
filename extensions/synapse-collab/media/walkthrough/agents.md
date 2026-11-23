# Add two agents

Synapse speaks the Agent Client Protocol. The Claude and Codex presets run each vendor's own agent with **your** credentials; Synapse never pays for, proxies or sees them.

- **Claude** needs `ANTHROPIC_API_KEY` (or Bedrock / Vertex AI credentials). Anthropic's terms do not let tools built on its Agent SDK offer a Claude subscription login.
- **Codex** uses `OPENAI_API_KEY`, or the sign-in you made with the `codex` CLI.

Every agent gets:

- its own git worktree in `.synapse/worktrees/<id>`, on branch `synapse/<id>`;
- a color, used on the board and in editor markers;
- a permission policy.

Your own checkout stays yours: agents never write to it.
