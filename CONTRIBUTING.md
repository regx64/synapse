# Contributing to Synapse

Thanks for helping. Synapse is small and moves fast, so a short conversation
before a large change saves everyone time: open an issue or a draft PR first.

## Ground rules

These come from the [plan](docs/plan.md) and keep the project maintainable:

1. **Collaboration logic lives in synapse-core** (`packages/core`). The
   extension and the CLI only call the core API. If a feature needs logic in a
   UI, the API is missing something; add it to `packages/protocol/src/api.ts`.
2. **Prefer core, then the extension, then a core patch.** Patches to
   upstream VS Code (`patches/`) are capped at 20, and each needs an owner and
   a reason in `patches/series.json`. `npm run check` enforces it.
3. **No Microsoft branding.** Never use the Visual Studio Code name or logo;
   extensions come from Open VSX.
4. **Agent output is data.** Never feed one agent's text to another as
   instructions; route it through `CollabService` so it is screened and
   labeled.
5. **No secrets on disk or in logs.** Pass anything that might leak through
   `redact()`.
6. **Stay in scope.** See "Out of scope" in the plan: no in-house LLM or
   agent, no single-agent features like autocomplete.

## Setup

Node.js 22+ and git 2.38+.

```bash
npm ci
```

```bash
npm run build
```

```bash
npm test
```

```bash
npm run check
```

The extension smoke test downloads VS Code and needs a display (on Linux,
put `xvfb-run -a` in front):

```bash
npm run test:smoke -w extensions/synapse-collab
```

A full IDE build needs the toolchain in `build/upstream.json` (Node 24, pnpm
12) and plenty of disk and memory:

```bash
node build/build.mjs
```

## Tests

- Core behavior gets a test that drives real git repositories and, where
  agents are involved, the scripted mock agent (`packages/mock-agent`). It
  never calls a model, so tests cost nothing.
- Prefer tests through the public API (`SynapseClient`) over internals.
- A bug fix comes with a test that fails without it.

## Pull requests

- One change per PR; describe what and why.
- `npm run build && npm test && npm run check` must pass.
- UI changes: include a screenshot.
- New core patch: explain why the extension API cannot do it.

## License

By contributing you agree that your contributions are licensed under the MIT
license of this repository.
