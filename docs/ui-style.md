# Synapse UI style

The redesign decided in November 2026. Mockups:
the "Synapse UI 시안" canvas (Main, Narrow and Style boards).

## Layout

Agent first, three columns:

| Where | What | Built with |
| --- | --- | --- |
| Title bar | working / needs you / to review / conflict counts; click: home | patch 0003 (`contrib/synapse`), fed by the extension through `_synapse.titleStatus` |
| Left (primary side bar) | agents (color, status, task, plan); Agents/Files switch; teammates | webview view `synapse.agents` |
| Middle (editor) | home tab pinned first; files open beside it | webview panel `synapse.home` |
| Right (secondary side bar) | selected agent: conversation, plan, changes, guidance box | webview view `synapse.detail` |
| Bottom panel | closed by default | — |

Hidden by default (each can be turned back on in Settings): activity bar,
status bar, layout controls, minimap, welcome page. Below 1280 px the right
column hides itself (`synapse.autoHideAgentColumn`).

## Colors

Dark, neutral accent; color is only for agents and status. Every Synapse
webview reads theme variables, so other themes work too. Synapse Dark
(`extensions/synapse-collab/themes`) sets:

| Token | Value |
| --- | --- |
| app, title bar | `#0B0B0C` |
| side columns | `#0E0E10` |
| editor, home | `#111113` |
| cards (`synapse.cardBackground`) | `#141417` |
| selected (`synapse.raisedBackground`) | `#1C1C20` |
| lines | `#1E1E22`, `#26262B` |
| text | `#EDEDEF`, `#D4D4D8`, `#A1A1AA`, `#8B8B94`, `#80808A` (lowest, 4.8:1) |
| primary button | `#FAFAFA` on `#0B0B0C` |

Status: working `#E4E4E7` (pulsing dot), needs you `#F2B84B`, ready for
review `#6EE7A0`, conflict/error `#F87171`, idle `#A1A1AA`. Status always
has a word next to its color.

Agents: coral `#FF7A66`, mint `#3DDBB4`, blue `#5B9DFF` (the icon's), then
violet `#B08CFF`, pink `#F59EBB` and four more (`AGENT_COLORS` in core).

## Type

Pretendard for the UI, JetBrains Mono for code (both OFL, in
`extensions/synapse-collab/media/fonts`). Home title 20/650, panel title
14/650, body 13, secondary 12, labels 11, code 12. Compact density: list
rows 26–28 px, buttons 28 px, tabs 36 px, title bar 38 px.

## Language

English and Korean, following the editor's language. Korean terms:

| English | 한국어 |
| --- | --- |
| Agent | 에이전트 |
| Task | 작업 |
| Decision | 결정 |
| Handoff | 인계 |
| Guidance | 지시 추가 |
| Takeover | 이어받기 |
| Review & merge | 검토 후 병합 |
| Conflict | 충돌 |
| Needs you | 확인 필요 |
| Live diff | 실시간 변경 |

Strings live in `media/ui/strings.js` (webviews), `package.nls(.ko).json`
(commands, settings) and `l10n/bundle.l10n.ko.json` (messages).

## Motion and accessibility

Motion only for status changes, panels and streaming; off when the OS or
the editor asks for reduced motion. Text meets WCAG AA (4.5:1). Every
action is a real button reachable by keyboard; icon buttons have labels;
progress bars are `role="progressbar"`.
