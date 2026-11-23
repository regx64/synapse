# Synapse plan

Nov 23, 2026 · @방정훈

Synapse is an IDE where several AI agents work in one workspace and a person directs that collaboration from one screen. It ships first as a fork of the VS Code open-source code (Code - OSS) and moves to a standalone IDE later. The key design choice is to keep the collaboration logic in a core that is separate from VS Code, so that going standalone means replacing only the UI.

## Decisions and assumptions

Two things are already decided, and every other choice follows from them.

| Decision | What | Why |
| --- | --- | --- |
| Now | Build Synapse as a fork of the VS Code open-source code (Code - OSS) | We get the editor, language support and extension ecosystem for free and can focus on collaboration features |
| Later | Move to a standalone IDE when the conditions are met | A fork carries ongoing upstream-sync cost and dependence on Microsoft |
| Design rule | Collaboration logic lives in a separate core (synapse-core); the VS Code fork is only the first UI | Going standalone reuses the core and replaces only the UI |

Synapse is a separate project from Interlock. Interlock is an adjacent product with coordination features: a competitor, or something to integrate with over MCP.

Assumptions:

- The team is 1–3 people, with about six months to a first public beta.
- Users run agents on their own LLM subscriptions or API keys. Synapse does not pay for model usage.
- Synapse itself is open source (MIT). That makes trust and contributions easier for a fork.

To decide before starting:

- [ ] Team size and weekly hours
- [ ] Revenue model (open source plus paid team features, a hosted core, sponsorship, etc.)
- [ ] First user group (solo developers, or teams that already use many agents)
- [ ] The first two agents to support
- [ ] Product name (“Synapse” carries a high trademark-conflict risk, risk L3)

## Product definition and MVP

Synapse cannot stand out by “running several agents”. It has to stand out by “keeping agents that work at the same time from breaking each other’s work”. VS Code 1.147 (2026-11-18) already runs Claude and Codex sessions in its Agents window.

The target user is a solo developer or small team that runs two or more agents at once. They have three problems.

1. Agents touch the same code, so merges conflict, or they merge cleanly as text and the behavior still breaks.
2. There is no single view of who owns what and how far each agent has got.
3. Each agent’s output has to be reviewed separately and combined by hand.

The MVP in one sentence: two agents work at once, each in its own worktree; the person sees on one screen which files and symbols each agent owns; conflicts are flagged before the merge; and the combined result is tested, then reviewed and merged in one pass.

MVP features:

- Agent connection: an Agent Client Protocol (ACP) client. Claude, Codex CLI, Gemini CLI and others support ACP or have adapters.
- A git worktree per agent, created and cleaned up automatically
- Collaboration board: each agent’s status, the files and symbols it owns, pending approvals
- Editor markers: code owned by another agent is shown with its color and name
- Conflict warnings: the same symbol edited at once, or a signature change to a function another agent calls
- Combined review: the diff and test results of both worktrees merged, on one screen, then merge

Competitive landscape:

| Product | What it does | How Synapse differs |
| --- | --- | --- |
| VS Code 1.147 | Manages several agent sessions in the Agents window, Claude and Codex harnesses, model comparison | Its release notes focus on session management; coordination between agents editing the same code is not visible |
| VS Code forks with AI built in (Cursor and others) | Mostly integrate one in-house agent deeply | Synapse is a neutral workspace that mixes agents from different vendors |
| ACP client editors (Zed, JetBrains, etc.) | Can connect to many agents | Same connection layer; ownership and conflict coordination between agents is Synapse’s core |
| Interlock | Coordinates conflicts through hooks, MCP and a GitHub App | A tool, not an IDE: competitor or integration target |

If upstream VS Code adds coordination between agents, the fork loses much of its value (risk S1). So the core is built so that it can also ship as a VS Code extension, as a fallback.

## Architecture

&#91;embedded content: Architecture · 2 UIs, 1 core, 3 external parts\]

The VS Code fork is a client that only calls the synapse-core API. So a later standalone IDE, or a fallback to a VS Code extension, keeps the core as it is.

## Running the fork

The largest cost of a fork is keeping up with VS Code’s monthly upstream releases. So changes to the core stay minimal, and patches are applied at build time, the way VSCodium does it.

1. Repo layout. Upstream `microsoft/vscode` is never edited wholesale. The Synapse repo holds build scripts, a patch set (`patches/`), `product.json`, built-in extensions and synapse-core.
2. Where features go. Prefer synapse-core, then a built-in extension (extension API), then a core patch. Anything the extension API can do never touches the core.
3. Patch budget. At most 20 core patches, each with an owner and a reason. If demands to exceed the budget pile up, treat that as a signal to go standalone.
4. Upstream sync. When VS Code ships a release, CI tries to apply the patches automatically and alerts on failure. The goal is to follow each release within two weeks. Electron and Chromium security fixes arrive the same way, so sync lag is a security risk.
5. Branding and `product.json`. Change the name, icons, data folder and URL protocol, and turn telemetry off. Do not use the VS Code name or logo.
6. Extension marketplace. Section 2b of the Microsoft Marketplace terms (revised September 2025) limits marketplace extensions to Microsoft’s “In-Scope Products and Services” such as Visual Studio Code, and section 3 separately bans using extensions published by Microsoft or GitHub in other products. A Code - OSS fork is not in scope. So the extension gallery is Open VSX. Plan on not having Microsoft-only extensions (for example the C/C++ extension binaries and the Remote Development extensions), and document open-source alternatives.
7. Build and distribution. macOS (arm64 and x64) signing and notarization, Windows signing, Linux packages and an auto-update server are all needed. Phase 1 makes development builds only; signing and auto-update are finished before the public beta (phase 4).
8. License notices. Code - OSS is MIT. Keep the MIT notice and the third-party notices file.

What to measure: person-hours per sync, number of core patches, and days behind the upstream release. These three numbers decide when to go standalone.

## Roadmap

&#91;embedded content: Roadmap · 5 phases, 4 gates\]

The fork foundation (phase 1) and the MVP (phase 2) overlap, and G1 is the first measurement of what the fork costs to maintain. No standalone-IDE work starts before G3.

## Phase details

Five phases, about six months, to the public beta. The standalone IDE is decided after that, at gate G3.

### Phase 0: Decide and validate (weeks 0–2)

1. Interview 10–15 developers who run agents in parallel. Ask how often conflicts happen, how they cope now, and whether they would switch IDEs.
2. Use the VS Code 1.147 Agents window and the main forks first-hand, and write down the gaps in coordination between agents.
3. Trademark search. If “Synapse” is not usable, pick three alternative names.
4. Read the Marketplace terms and the terms of the agent CLIs to be supported.
5. Technical spike (1–2 days): connect Claude and Codex CLI over ACP and check that both agents run at the same time.

Done when: the G0 decision is made.

### Phase 1: Fork foundation (week 2 to month 2)

1. Build repo: pinned upstream tag, patch-apply script, `product.json`, telemetry removal, Open VSX connection.
2. Development builds for Linux, macOS and Windows in CI.
3. Built-in extension skeleton: collaboration board panel, commands, status bar.
4. synapse-core skeleton: separate process, local JSON-RPC API, state store, event stream.
5. Rehearse one upstream sync and measure how long it takes.

Done when: development builds on all three OSes, one sync within 2 days, 5 or fewer core patches.

### Phase 2: MVP (months 1.5–4)

1. Two ACP adapters (Claude, Codex CLI) and agent start, stop and restart.
2. Per-agent worktree creation and cleanup.
3. Ownership tracking: record each agent’s edits down to the symbol, with tree-sitter.
4. Conflict detection: the same symbol edited at once, or a signature change to a function with callers in another worktree.
5. Collaboration board and editor markers (whose code this is).
6. Combined review: diff of the merged result, test run, merge.

Done when: the “signature change plus new caller” scenario is flagged before merge in at least 9 of 10 runs, and the team has used it internally for two weeks.

### Phase 3: Collaboration features (months 3–5)

1. Task graph: the person splits a goal into subtasks, assigns them to agents, and sees the dependencies.
2. Handoffs and messages between agents, in a structured format rather than free text (risk C2).
3. Shared decision log: project memory that agents and people read together.
4. Permission model: per-agent command, file and network permissions, with human approval.

Done when: on the same tasks, the number of times a person has to merge or fix things by hand drops noticeably.

### Phase 4: Public beta (months 4–6)

1. macOS signing and notarization, Windows signing, auto-update.
2. Docs, onboarding, example repos.
3. Opt-in telemetry and crash reports.
4. GitHub issues, a contribution guide, a public roadmap.

Done when: 50 beta users, and four-week retention measurement has started.

## Risk register

There are 26 risks. Four are high on both likelihood and impact: S1 (upstream VS Code builds in coordination), S2 (competing with well-funded AI IDEs), T1 (upstream sync burden) and O1 (a small team doing everything at once). ID prefixes: S market, L license and legal, T technical, C security, O organization, X plan execution. Likelihood and impact are first estimates; edit them directly.

| ID | Risk | Likelihood | Impact | Response | Early warning | Phase |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Upstream VS Code builds in coordination between agents (it already has an Agents window and Claude and Codex harnesses) | High | High | Keep a fallback by making the core shippable as a VS Code extension; differentiate on depth of coordination; track every release note | Release notes add ownership or conflict features between agents | All |
| S2 | Competing with well-funded AI IDEs | High | High | Differentiate on vendor neutrality and open source; do not compete on single-agent experience | A competitor announces cross-vendor multi-agent work | 0, 2 |
| S3 | Agent vendors offer multi-agent work and coordination in their own apps | High | Medium | Focus on mixing agents from different vendors; follow the ACP standard | Major agents scale back ACP support or push their own IDEs | 2, 3 |
| S4 | Running many agents at once is not yet a mainstream way of working | Medium | High | Check first with phase 0 interviews and G0 | Most interviewees use only one agent | 0 |
| S5 | Users do not switch away from the editor they know | High | Medium | Import VS Code settings and extensions; also offer the core as an extension | Drop-off within a week of install | 4 |
| L1 | Extensions published by Microsoft or GitHub cannot be used (Marketplace terms section 3) | Occurred | Medium | Document open-source alternatives; contribute to Open VSX | Missing extensions keep coming up as a reason to leave | 1, 4 |
| L2 | Extensions missing from Open VSX, or late versions | High | Medium | Ask publishers to list key extensions; document manual VSIX install | More requests for missing extensions | 1 |
| L3 | The name “Synapse” collides with existing products and trademarks (Azure Synapse Analytics, Razer Synapse and Matrix Synapse already exist) | High | Medium | Trademark search in phase 0; rename before going public if needed | A registered mark in the same field turns up | 0 |
| L4 | Using the VS Code trademark or logo, or dropping the MIT notice | Low | Medium | Check a branding and notice checklist every release | Checklist fails | 1 |
| L5 | Agent CLI terms (automation, wrapping, conditions on subscription accounts) | Medium | High | Use only official SDK and ACP paths; review the terms | Terms-change notices | 0, 2 |
| T1 | Upstream sync burden | High | High | Patches applied at build time, a patch budget, CI that applies patches automatically | One sync takes more than 2 days, or lag exceeds 2 weeks | All |
| T2 | Extension API limits push more changes into core patches | Medium | High | Patch budget of 20; going over is a G3 signal | Patch count trending up | 2, 3 |
| T3 | Changes to ACP or agent CLIs break the adapters | High | Medium | Adapter layer, pinned versions, nightly compatibility tests | Nightly tests fail | 2 |
| T4 | Concurrent edits get out of sync (between worktrees, or ownership records go missing) | Medium | High | Agents write only to their own worktree; the main workspace is for people only; the core is the single source of truth | Ownership records disagree with the actual diff | 2 |
| T5 | Performance and memory (Electron, language servers, many agents) | Medium | Medium | Agents as separate processes, show resource use, load tests | Reports of sluggishness | 3, 4 |
| T6 | Complexity of builds, signing and auto-update on three OSes | High | Medium | Follow VSCodium’s scripts; CI in phase 1, signing in phase 4 | Release builds fail repeatedly | 1, 4 |
| T7 | The core/UI split fails, so going standalone means a rewrite | Medium | High | Extensions call only the core API; test the core on its own; validate with a CLI client | Collaboration logic accumulates in extension code | 1–3 |
| C1 | Agents run dangerous commands (delete, deploy, read secrets) | Medium | High | Permission model, human approval, worktree isolation, optional network limits | Log of risky commands run without approval | 3 |
| C2 | Prompt injection (repo content, messages between agents) | Medium | High | Structured messages, source labels, treat other agents’ output as data | Imperative instructions detected in messages | 3 |
| C3 | Malicious extensions via Open VSX | Medium | High | Install warnings, publisher verification status, a recommended list | Open VSX security notices | 4 |
| C4 | API keys or tokens leak | Medium | High | Store in the OS keychain; mask in logs and crash reports | Secrets show up in logs | 2, 4 |
| C5 | Code is sent to outside LLMs, which blocks company adoption | High | Medium | Choice of agents and models, a path to local models, a data-flow document | Company users fail security review | 4 |
| O1 | 1–3 people maintain the fork and build features at the same time | High | High | Automate syncing, shrink feature scope, recruit contributors | Sync work pushes the feature schedule back twice or more | All |
| O2 | LLM costs (team spend during development and testing) | Medium | Medium | Test by replaying recorded agent sessions; users bring their own keys | Monthly budget exceeded | 2, 3 |
| X1 | Scope grows and the schedule slips | High | Medium | Stick to “out of scope”; re-scope at every gate | Starting the next phase before meeting the done criteria | All |
| X2 | Going standalone too early or too late | Medium | High | Decide only on G3’s numeric criteria | The switch keeps being debated without criteria | 5 |

## Gates and when to go standalone

There are four gates. The move to a standalone IDE is decided by G3’s numbers, not by feel. All numbers below are drafts.

| Gate | When | Pass criteria | If not met |
| --- | --- | --- | --- |
| G0 Demand and feasibility | Week 2 | At least 5 of 10 interviewees run 2+ agents at once and hit conflicts. ACP spike works. Name settled | If demand is weak, shrink to a VS Code extension with no fork, or stop |
| G1 Fork cost | Month 2 | One sync within 2 days, 5 or fewer core patches, development builds on 3 OSes | Redesign around extensions to cut patches, or review G3 early |
| G2 MVP validation | Month 4 | Phase 2 done criteria met; half of 10 outside testers keep using it for 2+ weeks | Postpone phase 3 and polish the MVP |
| G3 Start the standalone IDE | After month 6 | At least 3 of the 4 conditions below | Keep the fork and revisit in 6 months |

G3 conditions:

1. Core patches exceed the budget (20), or 3 or more core UX needs have piled up that the extension API cannot meet.
2. Upstream sync takes 4 or more days a month.
3. At least 500 weekly active users and at least 2 dedicated people.
4. The synapse-core API has been stable, with no major changes, for 3+ months.

Standalone options:

| Option | Pros | Cons |
| --- | --- | --- |
| Own shell on Electron + Monaco | Same editor experience as VS Code; reuses web tech | Workbench and extension system must be rebuilt; memory-heavy |
| Tauri + Monaco or CodeMirror | Lightweight; uses the system webview | Webview differences across OSes; no extension ecosystem |
| Built on Eclipse Theia | VS Code extension compatible; a framework designed for building your own IDE | Depends on another framework; smaller community than VS Code |
| Native (for example a Rust GUI) | Performance, full control | Highest cost; language support and extensions from scratch |

With synapse-core kept separate, any option means rebuilding only the UI. At G3, “shrink to a VS Code extension” may turn out better than “go standalone”, so that option is always compared too.

## Out of scope and the first two weeks

Out of scope:

- Our own LLM or our own coding agent. Synapse coordinates other people’s agents.
- Competing on single-agent features such as autocomplete or inline chat.
- UI changes that go beyond the core patch budget (20).
- Mobile or web versions, or running agents in the cloud.
- Supporting a third agent or more (until after G2).
- Work on the standalone IDE (until G3).

First two weeks:

- [ ] Settle team size and weekly hours
- [ ] Run a trademark search on “Synapse” and pick three alternative names (L3)
- [ ] Interview 10 developers who run agents in parallel (S4)
- [ ] Use the VS Code 1.147 Agents window and write down the gaps (S1)
- [ ] Build the spike that connects Claude and Codex CLI over ACP
- [ ] Read VSCodium’s build scripts and settle the Synapse build repo layout (T1)
- [ ] Read the agent CLI terms (L5)
- [ ] Draft the API between synapse-core and the built-in extension (T7)
- [ ] Record the G0 decision

## Limits of this plan and sources

Schedules, numeric criteria and risk ratings are all drafts. They should be reset after the team size and the phase 0 interviews are known.

Checked against the source pages:

- Code - OSS is under the MIT license, and Microsoft’s Visual Studio Code product ships under a separate Microsoft product license. Brand assets such as logos and product names are Microsoft trademarks and are outside the MIT grant.
- Marketplace terms (revised September 2025), original text: section 2b “Marketplace Offerings are intended for use only with In-Scope Products and Services”, section 3 “You may not import, install, or use Offerings published by Microsoft or GitHub, or Microsoft affiliates in any products or services except for the In-Scope Products and Services.”
- The binary license of the C/C++ extension (cpptools) restricts use to Microsoft products such as Visual Studio and Visual Studio Code. The source is MIT.
- The Remote Development extensions are not open source, and their server component is not licensed for use by other clients.
- Open VSX is a vendor-neutral open-source alternative to the Visual Studio Marketplace (EPL-2.0); the public instance is open-vsx.org.
- Products named “Synapse” already exist: Microsoft Azure Synapse Analytics, Razer Synapse 4, and the Matrix homeserver Synapse (Element).
- VS Code 1.147 (2026-11-18) has an Agents window and Claude and Codex harnesses.
- ACP is a standard between editors and coding agents; its list includes Claude (via Zed’s adapter), Codex CLI (via an adapter), Gemini CLI and others.
- VSCodium is not a fork but a set of scripts that build the vscode source; it is MIT and uses Open VSX as its extension gallery.

Still to check before starting:

- [ ] The Pylance license text (the terms were not found on the public pages)
- [ ] Who operates Open VSX and how it is governed (it looks like an Eclipse project, but no explicit statement was found)
- [ ] The registered trademark scope of “Synapse” (the products exist; the registered classes are unchecked)
- [ ] How far the VS Code name may be used, for example in a “compatible with” label (Microsoft trademark guidelines)

Sources:

- [microsoft/vscode repo](https://github.com/microsoft/vscode)
- [Differences between the repository and Visual Studio Code](https://github.com/microsoft/vscode/wiki/Differences-between-the-repository-and-Visual-Studio-Code)
- [Visual Studio Marketplace Terms of Use](https://aka.ms/vsmarketplace-ToU)
- [vscode-cpptools runtime licenses](https://github.com/microsoft/vscode-cpptools/tree/main/RuntimeLicenses)
- [Remote Development FAQ](https://code.visualstudio.com/docs/remote/faq)
- [VS Code release notes](https://code.visualstudio.com/updates)
- [Agent Client Protocol](https://agentclientprotocol.com)
- [VSCodium](https://github.com/VSCodium/vscodium)
- [Open VSX](https://github.com/eclipse-openvsx/openvsx)
