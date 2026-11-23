# Synapse Collaboration

The built-in extension of the Synapse IDE: the first UI for synapse-core.

- **Board** (activity bar → Synapse): every agent's status, plan, last
  message, the files and symbols it owns, a prompt box, pending approvals and
  conflicts.
- **Editor markers**: code another agent is changing is tinted in that agent's
  color, with its name at the end of the line.
- **Problems panel**: conflicts between agents, as diagnostics.
- **Status bar**: agents, working count, pending approvals, conflicts.
- **Combined review**: merged diff (opens VS Code's diff editor per file),
  test results on the combined code, and a merge button.

The extension holds no collaboration logic. It starts synapse-core for the
open repository (bundled in `dist/core`) and calls its API.

Settings: `synapse.autoStartCore`, `synapse.corePath`, `synapse.nodePath`,
`synapse.showInlineOwners`.
