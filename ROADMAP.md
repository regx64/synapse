# Roadmap

Public version of [the plan](docs/plan.md). Dates are drafts; gates decide
what happens next, not the calendar. Current state in detail:
[docs/status.md](docs/status.md).

| Phase | What | State |
| --- | --- | --- |
| 0 | Decide and validate: interviews, ACP spike, vendor terms | Spike done; vendor terms read ([agent-terms](docs/agent-terms.md)); trademark search not needed (non-profit); interviews and G0 decision open |
| 1 | Fork foundation: build repo, CI, extension and core skeletons, one upstream sync | Built; 3-OS IDE dev builds pass |
| 2 | MVP: two agents in worktrees, symbol ownership, pre-merge conflicts, board, combined review | Built and tested with scripted agents |
| 3 | Collaboration: task graph, structured handoffs, decision log, permission model | Built and tested with scripted agents |
| 4 | Public beta: signing, auto-update, docs, onboarding, community | Scaffolding built; needs certificates and an update host. No telemetry, by decision |
| G3 | Decide on a standalone IDE | After month 6, on the numbers in the plan |

## Gates

| Gate | Pass criteria (drafts) |
| --- | --- |
| G0 | 5 of 10 interviewees run 2+ agents and hit conflicts; ACP spike works; name settled |
| G1 | One upstream sync within 2 days; 5 or fewer core patches; dev builds on 3 OSes |
| G2 | Signature-change-plus-new-caller flagged in 9 of 10 runs with real agents; half of 10 outside testers keep using it for 2+ weeks |
| G3 | 3 of 4: patch budget exceeded, sync takes 4+ days a month, 500+ weekly users and 2+ dedicated people, core API stable for 3+ months |

## Next up

- Measure the phase 2 criterion with real Claude and Codex sessions.
- First full IDE build on Linux, macOS and Windows; first upstream sync.
- Type-aware call matching for member calls (`obj.method()`) and Go, Rust, Java (imports are already resolved for JS/TS and Python).
- OS-level sandboxing for agents' own shell tools (policies today cover what goes through Synapse).
- A decision on the built-in Copilot.

## Not planned

Our own model or coding agent, single-agent features (autocomplete, inline
chat), mobile or web versions, cloud-hosted agents, a third agent before G2,
standalone-IDE work before G3.
