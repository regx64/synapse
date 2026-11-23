# Status against the plan

As of 2026-11-23 (phases 3 and 4 added the same day). "Done" means implemented and covered by tests or a run
recorded here; "not verified" means written but not yet run end to end.

## Phase 1: Fork foundation

| Item | State |
| --- | --- |
| Build repo: pinned upstream tag, patch-apply script, `product.json`, telemetry off, Open VSX | Done. Steps fetch → patch → prepare → branding check ran against Code - OSS 1.147.0 |
| Development builds for Linux, macOS, Windows in CI | Written (`dev-build.yml`); **not verified**: the full upstream compile has not run yet |
| Built-in extension skeleton: board panel, commands, status bar | Done (beyond skeleton: markers, diagnostics, review panel). Smoke-tested in VS Code 1.147.0 (`npm run test:smoke -w extensions/synapse-collab`): activates, starts the core with the editor's runtime, shows a two-agent conflict in the Problems panel, registers its commands, and applies an agent policy edited as JSON. The board (all five tabs) and the review panel (blocked, clean and merged reviews) were rendered in Chromium from real core state and checked by eye. |
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

## Phase 3: Collaboration features

| Item | State |
| --- | --- |
| Task graph: split a goal into subtasks, assign, dependencies | Done: tasks with assignee, dependencies (cycles rejected), scope, auto-start; board tab and CLI |
| Handoffs and messages in a structured format (C2) | Done: typed messages with files and symbols; automatic handoffs on "done" use ownership facts; delivered as labeled data; flagged messages held for the person |
| Shared decision log | Done: propose / accept / supersede; accepted decisions in every task prompt; Markdown file |
| Permission model with human approval | Done for everything that goes through Synapse: per-agent file, command and network rules, approvals, audit log, warnings for risky commands run unasked. Not an OS sandbox (see Known limits) |
| Agent-side tools | Synapse MCP server per agent session, with a restricted per-agent-token API |

Tested with scripted agents (`packages/cli/test/phase3.test.ts`, `packages/core/test/policy.test.ts`). The plan's done criterion (fewer manual merges and fixes on the same tasks) needs real agents and a before/after comparison.

## Phase 4: Public beta

| Item | State |
| --- | --- |
| macOS signing and notarization, Windows signing, auto-update | Scaffolding: `release.yml` (signing steps run when secrets exist), update feed generator and a no-dependency update server implementing the Code - OSS update protocol (tested). Not run: needs certificates, a host and the full build |
| Docs, onboarding, example repos | Done: getting started, user guide, privacy and data flow, release guide; in-editor walkthrough; `examples/shop-js`, `examples/inventory-py` (their tests pass) |
| Opt-in telemetry and crash reports | Done: off by default; counts and enums only; preview of exactly what would be sent; redacted local crash reports. No telemetry server exists yet, so nothing is sent until an endpoint is configured |
| GitHub issues, contribution guide, public roadmap | Done: issue and PR templates, CONTRIBUTING, ROADMAP, SECURITY, CODE_OF_CONDUCT |

Done criteria (50 beta users, retention measurement) are outside what code can do.

## Known limits

- **Call matching.** JavaScript/TypeScript and Python calls are resolved
  through imports. Member calls (`obj.method()`), Go, Rust and Java still
  match by name, so methods or functions with the same name can raise a
  false signature-change warning there. Workspace-package imports are matched
  by package folder name, not by `package.json` resolution.
- **Agents' own tools.** Agents such as Claude Code edit files and run
  commands with their own tools. Synapse sees those edits (file watching and
  snapshots) but cannot stop a shell command from writing outside the
  worktree. That needs the phase 3 permission model and OS sandboxing.
- **Windows** is not yet verified (CI runs it as non-blocking).
- **The built-in Copilot** in Code - OSS 1.147 is an open decision; see
  [fork maintenance](fork-maintenance.md#open-question-the-built-in-copilot).
- **Same-user processes.** An agent's shell can read `.synapse/core.json`
  and talk to the core as the person. Only OS-level isolation (containers,
  separate users) closes that.
- **Instruction screening is heuristic.** It catches common injection
  phrasing, not every attack; agent text is always labeled as data as the
  main defense.
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
