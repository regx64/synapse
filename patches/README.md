# Core patches

Synapse never edits `microsoft/vscode` wholesale. Changes that the extension
API cannot make are kept here as small patch files and applied at build time,
the way VSCodium does it.

Rules (from the plan, "Running the fork"):

1. **Where features go.** synapse-core first, then the built-in extension
   (`extensions/synapse-collab`), and only then a core patch here.
2. **Budget.** At most 20 patches. `npm run check` fails above that. A queue
   of requests to exceed the budget is a signal for gate G3 (go standalone).
3. **Every patch is registered** in `series.json` with an owner and a reason.
   Unregistered `.patch` files fail the check.
4. **Small and focused.** One concern per patch, so upstream sync failures
   point at one thing.

Current count: **2**.

| Patch | Why |
| --- | --- |
| `0001-publisher-from-product.patch` | Upstream hard-codes "Microsoft Corporation", a Microsoft copyright and code.visualstudio.com in Windows/macOS file version info and the Windows installer. The patch reads `companyName`, `copyright` and `publisherUrl` from `product.json`. |
| `0002-remove-builtin-copilot.patch` | Upstream builds the GitHub Copilot extension, CLI runtime, SDK packages and a `copilot` shim into every app. The patch leaves them out of the desktop build and turns the editor's built-in AI features off by default. |

Names, icons and telemetry need no patch: `product.json` and the icon overlay
handle them (Code - OSS only sends telemetry when `enableTelemetry` is true).

## Adding a patch

```bash
node build/get-vscode.mjs          # fetch the pinned upstream tag into ../synapse-vscode
node build/apply-patches.mjs       # apply the existing series
cd ../synapse-vscode && <edit files> && git diff > ../synapse/patches/NN-short-name.patch
```

Then add an entry to `series.json`:

```json
{ "file": "NN-short-name.patch", "owner": "@handle", "reason": "why the extension API cannot do this", "since": "1.147.0" }
```
