# Releasing

Phase 4 scaffolding. None of it has run end to end yet: it needs signing
certificates, an update host, and the full upstream build.

## What a release produces

`.github/workflows/release.yml` runs on a `v*` tag:

| Platform | Artifacts | Signing (when secrets are set) |
| --- | --- | --- |
| macOS arm64, x64 | `Synapse-darwin-<arch>-<v>.zip` | Developer ID codesign with upstream's entitlements, notarization, stapling |
| Windows x64 | `SynapseUserSetup-x64-<v>.exe`, `SynapseSetup-x64-<v>.exe`, `Synapse-win32-x64-<v>.zip` | Authenticode (signtool, SHA-256, timestamped) |
| Linux x64 | `synapse-linux-x64-<v>.tar.gz`, `.deb`, `.rpm` | none (add repository signing when packages are hosted) |

Then it writes `SHA256SUMS` and the auto-update feed, and creates a **draft**
GitHub release.

Secrets: `MACOS_CERTIFICATE` (base64 .p12), `MACOS_CERTIFICATE_PASSWORD`,
`MACOS_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`,
`WINDOWS_CERTIFICATE` (base64 .pfx), `WINDOWS_CERTIFICATE_PASSWORD`. Without
them the builds are unsigned (macOS will refuse to open them without
right-click → Open).

## Auto-update

Code - OSS clients ask `<updateUrl>/api/update/<platform>/<quality>/<commit>`
and expect `204` when current, or JSON describing the latest build. Synapse
implements that protocol with two small scripts, so updates need **no core
patch**:

- `build/update-feed.mjs` writes `update-feed/<quality>/<platform>.json`
  (url, version, sha256) from the release assets;
- `build/update-server.mjs` serves it (no dependencies; `node
  build/update-server.mjs --feed update-feed --port 8080`).

The commit clients compare is the one `build/prepare.mjs` creates inside
the Code - OSS checkout ("Synapse <version>"), so every Synapse release is distinct even on
the same upstream tag.

To turn auto-update on:

1. Deploy `build/update-server.mjs` somewhere with HTTPS.
2. Set `"updateUrl": "https://<host>"` in `product.json` (quality is `stable`).
3. On each release, unpack the draft's `update-feed.tar.gz` into the server's
   feed directory, then publish the release.

Linux builds do not self-update (the same as upstream); they are notified.

## Checklist

1. `npm run build && npm test && npm run check`.
2. Bump `version` in the root `package.json` (it becomes `synapseVersion`).
3. Tag `vX.Y.Z` and push the tag.
4. Check the draft release; install on each OS.
5. Deploy the update feed, then publish.
