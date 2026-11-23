# Configure the workspace

`synapse.config.json` at the repository root (commit it):

```json
{
  "testCommand": "npm test",
  "setupCommand": "npm ci",
  "decisionLogPath": "docs/decisions.md",
  "policy": { "network": "ask" }
}
```

- **testCommand** runs on the combined work of all agents before you merge.
- **decisionLogPath** is where the shared decision log is written, so people can read it in the repo.
- **policy** is the default permission policy for every agent.
