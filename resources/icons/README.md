# Synapse icons

Source art for every Synapse icon. Everything in `../generated/` is produced
from these files by `node build/icons.mjs` (needs Playwright's Chromium) and
copied over upstream's icons by `build/prepare.mjs`.

- `mark.svg`: the mark. An "S" split in the middle: two agents (coral and
  mint ends) with signals crossing the gap between them. That gap is what
  Synapse coordinates.
- Variants made from it (see `build/icons.mjs`): the app icon (rounded square
  with the macOS margin), the full-bleed square for Windows, Linux and the
  web, a monochrome watermark for the empty editor, and file-type icons
  (a document with the extension and a small Synapse badge, no third-party
  logos).

Colors: background `#2e2a7a → #5b3fd1`, strokes `#efeaff`, signals
`#ffb020`/`#ffd27a`, agents `#ff7a59` and `#34d399`.

To change the design, edit `mark.svg` (or the variants in `build/icons.mjs`),
then run `node build/icons.mjs` and commit the regenerated files.
