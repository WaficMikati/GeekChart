#!/usr/bin/env python3
"""Build static Archivo instances for the three weights the type table uses.

`font-data.ts` used to embed Archivo as a single variable font spanning
weight 400-700 (see `fetch-fonts.mjs`). A variable font's *own* default
instance is whatever its `fvar` table says, not 400 — for the file Google
Fonts serves, that default is 600 (SemiBold). A browser rendering
`font-family: Archivo` with no `font-weight` set picks 400 (the CSS initial
value) and asks the variable font for that instance specifically. Tools that
just open the file and read its outlines directly (fontkit, in
`packages/core/src/node/measure.ts`) get the file's default instance instead
unless something tells them otherwise — 600, ~6% wider per character than
400. That drift compounds over a label and was the largest source of
browser/Node text-width mismatch measured by `packages/cli/scripts/spike-node.mjs`.

The fix: stop shipping a variable font for Archivo. Ship three static
instances — 400, 500, 600, the weights `tokens.ts`'s type table and
`theme.ts`'s legacy CSS actually set — each pinned at exactly that weight, so
there is no "default instance" to get wrong. A static font's outlines *are*
its one weight.

Steps, per weight:
  1. Fetch the Latin-subset Archivo variable font from Google Fonts (same
     source `fetch-fonts.mjs` uses for the other three families).
  2. Instantiate it at the target `wght` with fontTools' `varLib.instancer`
     (this drops `fvar`/`gvar`/`avar`/`HVAR` — the file becomes a normal
     static TrueType font, default-instance ambiguity gone by construction).
  3. Subset to Basic Latin + Latin-1 Supplement + Latin Extended-A + the
     General Punctuation codepoints the fixtures and DESIGN.md's caption rule
     (3.3, the middle dot) actually use. Diagram labels outside this set
     already fall back to the system stack (see `fetch-fonts.mjs`) — same
     policy, just enumerated explicitly instead of "whatever Google's own
     latin-subset boundary happens to include".
  4. Re-encode as WOFF2 (fontTools' built-in brotli compressor).

Output: `packages/core/fonts/archivo/archivo-{weight}.woff2`, committed to
the repo so the build is reproducible without a network fetch. Re-run this
script only when the type table's weights change.

Requires: `pip install fonttools brotli` (both importable as `fontTools`/
`brotli`; this repo also has the `fonttools`/`pyftsubset` console scripts on
PATH from the same install).

Usage: python3 packages/core/scripts/fonts/build-fonts.py
"""
from __future__ import annotations

import io
import sys
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent.parent / "fonts" / "archivo"

WEIGHTS = (400, 500, 600)

CHROME_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)

# Same query fetch-fonts.mjs uses to name the weight range this file's
# @font-face rule used to cover — this only reads the file, not the CSS
# metadata, so the exact range requested doesn't matter beyond "covers
# 400-600".
CSS_QUERY = "https://fonts.googleapis.com/css2?family=Archivo:wght@400..600&display=swap"

# Basic Latin (printable) + Latin-1 Supplement + Latin Extended-A: covers the
# Roman alphabet, digits, accented Latin names (e.g. "Résumé", a real fixture
# label) and the middle dot DESIGN.md 3.3 joins captions with (U+00B7, inside
# Latin-1 Supplement). Plus the General Punctuation codepoints actually seen
# in fixtures or plausible in hand-written captions: en/em dash, curly
# quotes, ellipsis, bullet.
UNICODES = (
    set(range(0x0020, 0x007F))  # Basic Latin, printable
    | set(range(0x00A0, 0x0100))  # Latin-1 Supplement
    | set(range(0x0100, 0x0180))  # Latin Extended-A
    | {0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026}
)


def fetch_latin_variable_font() -> bytes:
    req = urllib.request.Request(CSS_QUERY, headers={"User-Agent": CHROME_UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        css = resp.read().decode("utf-8")
    # The CSS response has one @font-face block per Unicode-range subset
    # (vietnamese, latin-ext, latin, ...); only "latin" is embedded elsewhere
    # in this renderer (see fetch-fonts.mjs), so only it is fetched here.
    block_start = css.index("/* latin */")
    block = css[block_start:]
    url_start = block.index("url(") + 4
    url_end = block.index(")", url_start)
    url = block[url_start:url_end]
    with urllib.request.urlopen(url, timeout=30) as resp:
        return resp.read()


SUBFAMILY_NAMES = {400: "Regular", 500: "Medium", 600: "SemiBold"}


def rename_static_instance(font: TTFont, weight: int) -> None:
    """Overwrite the name table with plain "Archivo" names.

    The source variable font's own family name (ID 1) is "Archivo SemiBold"
    — Google names the file after its default instance (600), a legal but
    unhelpful convention for a font never shipped as a single static face
    before now. Left alone, `instantiateVariableFont`'s own name generation
    only appends to that, producing names like "Archivo SemiBold Medium" for
    the 500 instance. None of this affects CSS `@font-face` matching (this
    renderer's own generated CSS always declares `font-family:'Archivo'`
    itself, ignoring the file's internal name table), but a font that says
    what it is is worth the few extra lines.
    """
    subfamily = SUBFAMILY_NAMES[weight]
    full_name = "Archivo" if subfamily == "Regular" else f"Archivo {subfamily}"
    postscript_name = f"Archivo-{subfamily}"
    name_table = font["name"]
    for name_id, value in ((1, "Archivo"), (2, subfamily), (4, full_name), (6, postscript_name), (16, "Archivo"), (17, subfamily)):
        name_table.setName(value, name_id, 3, 1, 0x409)
        name_table.setName(value, name_id, 1, 0, 0)


def build_instance(source_bytes: bytes, weight: int) -> bytes:
    font = TTFont(io.BytesIO(source_bytes))
    instantiateVariableFont(font, {"wght": weight}, inplace=True, updateFontNames=False)
    rename_static_instance(font, weight)

    options = subset.Options()
    options.flavor = "woff2"
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.notdef_outline = True
    options.recalc_bounds = True
    options.recalc_timestamp = False
    options.desubroutinize = False
    options.layout_features = ["*"]  # keep GPOS kerning — the Node measurer shapes with it

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=UNICODES)
    subsetter.subset(font)

    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sys.stderr.write("fetching Archivo (latin subset, variable) from Google Fonts…\n")
    source_bytes = fetch_latin_variable_font()
    sys.stderr.write(f"  source: {len(source_bytes) / 1024:.1f} kB\n")

    for weight in WEIGHTS:
        data = build_instance(source_bytes, weight)
        out_path = OUT_DIR / f"archivo-{weight}.woff2"
        out_path.write_bytes(data)
        sys.stderr.write(f"  wrote {out_path.relative_to(HERE.parent.parent.parent.parent)}  {len(data) / 1024:.1f} kB\n")

    sys.stderr.write(
        "done — now run `node packages/core/scripts/fetch-fonts.mjs` to fold these into font-data.ts\n"
    )


if __name__ == "__main__":
    main()
