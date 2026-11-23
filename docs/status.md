# Status against the plan

As of 2026-11-23. "Done" means implemented and covered by tests or a run
recorded here; "not verified" means written but not yet run end to end.

## Phase 1: Fork foundation

| Item | State |
| --- | --- |
| Build repo: pinned upstream tag, patch-apply script, `product.json`, telemetry off, Open VSX | Done. Steps fetch → patch → prepare → branding check ran against Code - OSS 1.147.0 |
| Development builds for Linux, macOS, Windows in CI | Written (`dev-build.yml`); **not verified**: the full upstream compile has not run yet |
| Built-in extension skeleton: board panel, commands, status bar | Done (beyond skeleton: markers, diagnostics, review panel). Smoke-tested in VS Code 1.147.0 (`npm run test:smoke -w extensions/synapse-collab`): activates, starts the core with the editor's runtime, shows a two-agent conflict in the Problems panel, registers its commands. The webviews (board, review panel) have not been checked by eye |
| synapse-core skeleton: separate process, local JSON-RPC API, state store, event stream | Done |
| Rehearse one upstream sync and measure it | Automated in `upstream-sync.yml`; no newer upstream release exists yet to rehearse against |

G1 numbers so far: **0 core patches**; sync time and 3-OS builds not yet measured.

## Phase 2: MVP

| Item | State |
| --- | --- |
| Two ACP adapters (Claude, Codex CLI); start, stop, restart | Done for the ACP client and lifecycle; presets pinned. Tested end to end with the scripted ACP agent; real adapters checked by `scripts/acp-compat.mjs` (handshake only, no prompts) |
| Per-agent worktree creation and cleanup | Done |
| Ownership tracking down to the symbol with tree-sitter | Done for TypeScript/TSX, JavaScript, Python, Go, Rust, Java |
| Conflict detection: same symbol; signature change with callers in another worktree | Done, plus textual-conflict prediction and same-file info. Arity-aware: a new call that already fits the new signature is not flagged |
| Collaboration board and editor markers | Done (extension) |
| Combined review: diff of the merged result, test run, merge | Done (core, CLI, extension panel with per-file diff editor) |

ACP compatibility run on 2026-11-23 (`node scripts/acp-compat.mjs claude codex mock`):

| Adapter | initialize | session/new |
| --- | --- | --- |
| `@agentclientprotocol/claude-agent-acp@0.109.1` | ok, protocol v1 | ok |
| `@zed-industries/codex-acp@0.16.0` | ok, protocol v1 | auth required (no credentials on the test machine), as expected |
| scripted mock agent | ok | ok |

No prompts were sent to real agents: a full turn with Claude or Codex inside
Synapse is still to be run with credentials.

The phase 2 criterion, "signature change plus new caller flagged before merge
in at least 9 of 10 runs", is met deterministically with scripted agents
(`packages/core/test/conflicts.test.ts`, `packages/cli/test/e2e.test.ts`,
`npm run demo`). It still has to be measured with real agents, whose edits
vary from run to run, and with two weeks of internal use.

## Phase 3 and 4

Not started, by design (the plan starts them after G2): task graph, structured
handoffs between agents, shared decision log, the full permission model,
signing and notarization, auto-update, docs site and onboarding, opt-in
telemetry and crash reports.

Partial groundwork: approvals route every ACP permission request to the
person; agents are confined to their worktree for file access through ACP
(not for their own shell tools, which run as the user; sandboxing is phase 3).

## Known limits

- **Call matching is by name.** Two unrelated functions with the same short
  name in one language family can raise a false signature-change warning.
  Import resolution would fix it.
- **Agents' own tools.** Agents such as Claude Code edit files and run
  commands with their own tools. Synapse sees those edits (file watching and
  snapshots) but cannot stop a shell command from writing outside the
  worktree. That needs the phase 3 permission model and OS sandboxing.
- **Windows** is not yet verified (CI runs it as non-blocking).
- **Product icons** are still upstream's Code - OSS defaults.
- **The built-in Copilot** in Code - OSS 1.147 is an open decision; see
  [fork maintenance](fork-maintenance.md#open-question-the-built-in-copilot).
- Ownership uses a fixed debounce (750 ms) and file watching; very large
  worktrees may need tuning (risk T5).

## First two weeks checklist

| Item | State |
| --- | --- |
| Settle team size and weekly hours | Open: a decision for the team |
| Trademark search on "Synapse", three alternative names (L3) | Open. Identity is centralized in `product.json` and package names to make a rename cheap |
| Interview 10 developers (S4) | Open |
| Use the VS Code 1.147 Agents window, write down gaps (S1) | Open |
| Spike: Claude and Codex CLI over ACP | Done in code; `scripts/acp-compat.mjs` checks both adapters; running both at once is covered by the e2e test with scripted agents |
| Read VSCodium's build scripts, settle the build repo layout (T1) | Done (`build/`, `patches/`, `product.json`) |
| Read the agent CLI terms (L5) | Open. Synapse uses only the official ACP adapters with the user's own login |
| Draft the core ↔ extension API (T7) | Done: [core-api.md](core-api.md) |
| Record the G0 decision | Open |
