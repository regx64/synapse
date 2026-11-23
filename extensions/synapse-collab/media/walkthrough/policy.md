# Decide what agents may do

Each agent has a policy. The default:

- **Edits** inside the agent's own worktree: allowed.
- **Protected files** (`.env`, keys, `secrets/`): never read or written.
- **Commands** on the allow list (tests, builds, `git status`): run without asking. Every part of a chained command must be on the list.
- **Denied commands** (`git push`, `sudo`, piping into a shell…): refused.
- **Network** commands: you are asked.
- Anything else: you are asked.

Every decision lands in the **Audit** tab. Commands an agent ran without asking are logged too, and risky ones raise a warning.

Policies limit what Synapse allows. They are not an OS sandbox: an agent's own shell tools run as you.
