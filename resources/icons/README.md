# Synapse icons

Source art for every Synapse icon. Everything in `../generated/` is produced
from these files by `node build/icons.mjs` (needs Playwright's Chromium) and
copied over upstream's icons by `build/prepare.mjs`.

- `mark.svg`: the mark. A hub: three agents (coral, mint and blue) connected
  to one white center, the place where Synapse coordinates them.
- Variants made from it (see `build/icons.mjs`): the app icon (rounded square
  with the macOS margin), the full-bleed square for Windows, Linux and the
  web, a monochrome watermark for the empty editor, and file-type icons
  (a document with the extension and a small Synapse badge, no third-party
  logos).

Colors: background black (`#1c1c1f → #000000`), center `#ffffff`, links
`#e9e9ee`, agents `#ff7a59`, `#34d399` and `#60a5fa`.

To change the design, edit `mark.svg` (or the variants in `build/icons.mjs`),
then run `node build/icons.mjs` and commit the regenerated files.
