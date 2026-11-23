# Running the fork

The largest cost of a fork is keeping up with VS Code's upstream releases.
Synapse keeps changes to the upstream code minimal and applies them at build
time, the way VSCodium does.

## Layout

`microsoft/vscode` is never committed here. A build fetches the tag pinned in
[`build/upstream.json`](../build/upstream.json) into `../synapse-vscode`, a
folder next to this repository (or `SYNAPSE_VSCODE_DIR`), and turns it into
Synapse. It must stay outside this repository: inside it, TypeScript would
pick up this repository's `node_modules/@types` while compiling VS Code. The
app is written next to that folder (`../VSCode-<platform>-<arch>`).

| Step | Script | What |
| --- | --- | --- |
| 1 | `build/get-vscode.mjs` | shallow clone of the pinned tag; verifies the pinned commit |
| 2 | `build/apply-patches.mjs` | applies `patches/series.json` in order; names the first patch that fails |
| 3 | `build/prepare.mjs` | merges [`product.json`](../product.json), adds the built-in extension with its bundled core, checks upstream license notices |
| 4 | `build/build.mjs` | runs 1–3, then `pnpm install` and `gulp vscode-<platform>-<arch>-min` |

Pinned upstream: **Code - OSS 1.147.0** (2026-11-18), which builds with Node
24.22.1 and pnpm 12.16.0. Code - OSS packages every `extensions/*` folder;
because `synapse-collab` ships prebuilt and declares no production
dependencies, upstream copies it as-is (`fromLocalNormal` in
`build/lib/extensions.ts`).

Steps 1–3 have been run against 1.147.0. A full step 4 has not run yet: it
needs a machine or CI runner with the upstream toolchain (see
[status](status.md)).

## Where features go

1. synapse-core;
2. the built-in extension, through the extension API;
3. only then a core patch in `patches/`, registered in `patches/series.json`
   with an owner and a reason.

**Budget: 20 core patches** (`build/check-patches.mjs`, part of `npm run check`).
Current count: **1**: `0001-publisher-from-product.patch` makes the Windows
and macOS file version info and the Windows installer take the publisher,
copyright and URL from `product.json` instead of Microsoft's. The rest of
the branding is `product.json` and the icon overlay; telemetry needs no patch
because Code - OSS sends telemetry only when `product.json` sets
`enableTelemetry` (see `src/vs/platform/telemetry/common/telemetryUtils.ts`),
and Synapse sets it to `false`.

## Upstream sync

- `.github/workflows/upstream-sync.yml` runs daily. When a newer Code - OSS
  tag exists, it fetches it, applies the patches, prepares, runs the branding
  check, and opens an `upstream-sync` issue if anything fails or the pin is
  more than two weeks behind.
- To move the pin: update `tag`, `commit`, `releasedAt`, `node` and
  `packageManager` in `build/upstream.json` (from the new tag's `.nvmrc` and
  `package.json`), fix patches that no longer apply, run a dev build.
- Electron and Chromium security fixes arrive through these releases, so sync
  lag is a security risk, not only a feature gap.

### The three numbers

Record these at every sync; together they decide gate G3:

| Metric | Source | G1 target | G3 signal |
| --- | --- | --- | --- |
| Person-hours per sync | the sync issue | one sync within 2 days | 4+ days a month |
| Core patches | `node build/check-patches.mjs` | ≤ 5 | > 20, or 3+ UX needs the extension API cannot meet |
| Days behind upstream | `node build/check-upstream.mjs` | — | > 14 |

## Branding

`product.json` changes the name, icons' names, data folders (`~/.synapse-ide`),
URL protocol (`synapse://`), Windows and macOS ids, and turns telemetry off.
`build/check-branding.mjs` fails on Microsoft names in identity fields, on any
Visual Studio Marketplace reference, when telemetry is on, when upstream's
`LICENSE.txt` or `ThirdPartyNotices.txt` would not ship, and when any upstream
icon was not replaced.

## Icons

All Synapse icons come from one source, `resources/icons/mark.svg`.
`node build/icons.mjs` (needs Playwright's Chromium) renders the app icon,
Windows/Linux/web icons, file-type icons, installer images, the empty-editor
watermark and the extension's activity bar icon into `resources/generated/`,
with `overlay.json` mapping each file to the upstream file it replaces.
`build/prepare.mjs` copies them over upstream's (assets, not code, so they do
not count against the patch budget) and sets the Windows Start tile name and
color. If an upstream release renames or drops an icon, prepare fails and
names it.

## Extensions: Open VSX, not the Visual Studio Marketplace

Marketplace terms (revised September 2025) limit marketplace extensions to
Microsoft's in-scope products (section 2b) and forbid using extensions
published by Microsoft or GitHub in other products (section 3). Synapse uses
[Open VSX](https://open-vsx.org) as its gallery.

Extensions Synapse users should plan to do without, and open alternatives:

| Microsoft extension | Why it is unavailable | Open alternative on Open VSX |
| --- | --- | --- |
| C/C++ (`ms-vscode.cpptools`) | binary license restricts use to Microsoft products | clangd (`llvm-vs-code-extensions.vscode-clangd`) |
| Remote - SSH / Containers / WSL | closed source; server not licensed for other clients | Open Remote - SSH (`jeanp413.open-remote-ssh`); Dev Containers CLI |
| Pylance (`ms-python.vscode-pylance`) | proprietary (license text still to check) | basedpyright (`detachhead.basedpyright`), Pyright |
| C# Dev Kit | Microsoft product license | C# via free OmniSharp builds (`muhammad-sammy.csharp`) |
| Live Share | proprietary service | none equivalent |

Extensions published by Microsoft on Open VSX under open-source licenses
(for example Python, Jupyter) need a case-by-case license read before
Synapse recommends them. Missing extensions: ask publishers to list on Open
VSX, or install a `.vsix` manually (risk L2).

## Open question: the built-in Copilot

Code - OSS 1.147 contains the GitHub Copilot extension and runtime as built-in
parts of the build (`extensions/copilot`, `build/lib/copilot.ts`), and
`product.json` names `GitHub.copilot` as the default chat agent. Removing it
would take core patches. Synapse currently leaves it in place and only clears
`builtInExtensionsEnabledWithAutoUpdates`. Whether to ship, disable or patch
it out is a product and licensing decision to make before the public beta.

## Build and distribution

Phase 1: unsigned development builds on Linux x64, macOS arm64 and Windows x64
(`.github/workflows/dev-build.yml`). Before the public beta (phase 4): macOS
signing and notarization (arm64 and x64), Windows signing, Linux packages, an
update server.
