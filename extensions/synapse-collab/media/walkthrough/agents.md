# Add two agents

Synapse speaks the Agent Client Protocol. The Claude and Codex presets run each vendor's own agent with **your** login or API key; Synapse never pays for or proxies model usage.

Every agent gets:

- its own git worktree in `.synapse/worktrees/<id>`, on branch `synapse/<id>`;
- a color, used on the board and in editor markers;
- a permission policy.

Your own checkout stays yours: agents never write to it.
