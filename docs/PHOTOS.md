# The photographs in the app

Fifteen food photographs are embedded in `ai4food-app.html` as WebP data URIs,
plus the logo and an app icon. They are graded as one set by
`tools/grade-photos.py` so they read as a single body of work rather than
fifteen stock frames.

**None of them is cleared for production.** Their provenance was not recorded
when they were added, so we cannot name the photographer or the licence for any
of them, which means we cannot answer the only question that matters if someone
asks. They are demo assets until that changes.

## What has to happen before launch

For every image that ships, this file needs a row:

| Key | Source | Author | Licence | Attribution required |
| --- | --- | --- | --- | --- |
| `accara` | *unrecorded* | — | — | — |
| `epicerie` | *unrecorded* | — | — | — |
| `mafe` | *unrecorded* | — | — | — |
| `yassa` | *unrecorded* | — | — | — |
| `pain`, `pastels`, `thiebou`, … | *unrecorded* | — | — | — |

Two ways to fill it in:

1. **Trace them.** If they came from a stock library with a known licence,
   record the licence and the attribution it requires, and add the attribution
   to the app where the licence says it must appear.
2. **Replace them.** Photograph the partner shops. This is the better answer
   anyway: a real photo of the bakery someone is walking to beats a stock frame
   of bread, and it is a reason for a shop to say yes.

## Adding a photo

```bash
python3 tools/grade-photos.py photos/ > blob.js
```

Paste the `const P = {…}` block over the one in `ai4food-app.html`. It applies
the same crop, white balance, contrast curve and sharpening as the rest, so a
new photo joins the set instead of standing out from it. Needs Pillow.

## Shops without a photo

A shop with no photograph gets a house tile with its initials, in the AI4Food
palette. It does not borrow another shop's picture — a photo of food you are
not getting is a small lie, and the tile is honest about being a tile.
