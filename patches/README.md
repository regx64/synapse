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

Current count: **0**. Branding and telemetry need no patch: `product.json`
handles both (Code - OSS only sends telemetry when `enableTelemetry` is true).

## Adding a patch

```bash
node build/get-vscode.mjs          # fetch the pinned upstream tag into ./vscode
node build/apply-patches.mjs       # apply the existing series
cd vscode && <edit files> && git diff > ../patches/NN-short-name.patch
```

Then add an entry to `series.json`:

```json
{ "file": "NN-short-name.patch", "owner": "@handle", "reason": "why the extension API cannot do this", "since": "1.147.0" }
```
