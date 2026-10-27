#!/usr/bin/env python3
"""Cut the page fonts for the web: WOFF2, only the glyphs the pages can show, CJK split by unicode-range.

Each Chinese weight becomes one "core" file (every character that appears in src/ + Latin + CJK punctuation,
loaded before the first paint) and a series of slices covering the rest of the font's character map; the browser
fetches a slice only when a character from it is on screen (user text: date names, places, letters).
Latin fonts become one file each (Latin ranges only).

Usage: python scripts/subset_fonts.py <source-font-dir>
  The source directory holds the static TTFs listed in FONTS (sources and licences: ASSETS.md).
Needs: fonttools, brotli.
"""
import json
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
OUT = ROOT / "assets" / "fonts"
MANIFEST = SRC / "fonts" / "manifest.json"
FILES_TS = SRC / "fonts" / "files.ts"

# key (fontFamily used by the pages) -> (source file, kind)
FONTS = {
    "NotoSerifSC-Regular-app": ("NotoSerifSC-Regular-app.ttf", "cjk"),
    "NotoSerifSC-Medium-eph": ("NotoSerifSC-Medium-eph.ttf", "cjk"),
    "NotoSerifSC-Bold-app": ("NotoSerifSC-Bold-app.ttf", "cjk"),
    "NotoSerifSC-Black-eph": ("NotoSerifSC-Black-eph.ttf", "cjk"),
    # Playfair Display has the Reserved Font Name "Playfair Display" (OFL 1.1 §3): the cut files carry another name
    "EphemeraDisplay-Regular": ("PlayfairDisplay-Regular-eph.ttf", "latin"),
    "EphemeraDisplay-Italic": ("PlayfairDisplay-Italic-eph.ttf", "latin"),
    "EphemeraDisplay-Bold": ("PlayfairDisplay-Bold.ttf", "latin"),
    "EphemeraDisplay-BoldItalic": ("PlayfairDisplay-BoldItalic.ttf", "latin"),
    "EphemeraDisplay-Black": ("PlayfairDisplay-Black.ttf", "latin"),
    "PinyonScript-Regular": ("PinyonScript-Regular.ttf", "latin"),
    "CormorantGaramond-Medium-eph": ("CormorantGaramond-Medium-eph.ttf", "latin"),
    "CormorantGaramond-SemiBold-eph": ("CormorantGaramond-SemiBold-eph.ttf", "latin"),
    "CourierPrime-Bold": ("CourierPrime-Bold.ttf", "latin"),
    "CourierPrime-Regular": ("CourierPrime-Regular.ttf", "latin"),
}
SLICE = 450

LATIN = [(0x20, 0x7E), (0xA0, 0x24F), (0x2000, 0x206F), (0x20A0, 0x20BF), (0x2100, 0x214F), (0x2190, 0x21FF), (0x2460, 0x24FF), (0x25A0, 0x25FF), (0x2600, 0x26FF)]
CJK_PUNCT = [(0x3000, 0x303F), (0xFF00, 0xFFEF)]


def rng(pairs):
    out = set()
    for a, b in pairs:
        out.update(range(a, b + 1))
    return out


def src_chars() -> set:
    out = set()
    for f in SRC.rglob("*.ts*"):
        if ".test." in f.name:
            continue
        for c in f.read_text(encoding="utf-8"):
            o = ord(c)
            if o > 0x7F and not 0xD800 <= o <= 0xDFFF and o not in (0xFE0F, 0x200D):
                out.add(o)
    return out


def neutral_names(font: TTFont, key: str) -> None:
    """Our own family name per file (the key), keep copyright/licence records, drop the old unique ID."""
    name = font["name"]
    for rec in list(name.names):
        if rec.nameID in (1, 2, 3, 4, 6, 16, 17, 21, 22, 25):
            name.removeNames(nameID=rec.nameID)
    for nid, val in ((1, key), (2, "Regular"), (3, f"{key};web-subset"), (4, key), (6, key)):
        name.setName(val, nid, 3, 1, 0x409)
        name.setName(val, nid, 1, 0, 0)
    if "STAT" in font:
        del font["STAT"]


def cut(src: Path, key: str, cps: set, out: Path, flavor: str | None = "woff2") -> bool:
    font = TTFont(src)
    have = set(font.getBestCmap())
    keep = cps & have
    if not keep:
        return False
    opts = subset.Options()
    opts.flavor = flavor
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.drop_tables += ["DSIG"]
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=sorted(keep))
    sub.subset(font)
    neutral_names(font, key)
    font.flavor = flavor
    font.save(out)
    return True


def ranges(cps) -> str:
    cps = sorted(cps)
    out, start, prev = [], None, None
    for c in cps:
        if start is None:
            start = prev = c
        elif c == prev + 1:
            prev = c
        else:
            out.append((start, prev))
            start = prev = c
    if start is not None:
        out.append((start, prev))
    return ",".join(f"U+{a:X}" if a == b else f"U+{a:X}-{b:X}" for a, b in out)


def main(src_dir: Path) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in [*OUT.glob("*.woff2"), *OUT.glob("*.skia.ttf")]:
        old.unlink()
    core = src_chars() | rng(LATIN) | rng(CJK_PUNCT)
    manifest = {}
    for key, (file, kind) in FONTS.items():
        src = src_dir / file
        have = set(TTFont(src).getBestCmap())
        parts = []
        if kind == "latin":
            cps = have & (rng(LATIN) | core)
            name = f"{key}.woff2"
            cut(src, key, cps, OUT / name)
            parts.append({"file": name, "range": ranges(cps & have), "core": True})
        else:
            first = have & core
            name = f"{key}.core.woff2"
            cut(src, key, first, OUT / name)
            parts.append({"file": name, "range": ranges(first), "core": True})
            rest = sorted(have - first)
            for i in range(0, len(rest), SLICE):
                chunk = set(rest[i:i + SLICE])
                name = f"{key}.{i // SLICE:02d}.woff2"
                cut(src, key, chunk, OUT / name)
                parts.append({"file": name, "range": ranges(chunk), "core": False})
        manifest[key] = parts
        size = sum((OUT / p["file"]).stat().st_size for p in parts)
        print(f"{key}: {len(parts)} file(s), {size / 1024:.0f} KB")
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    lines = ["// Generated by scripts/subset_fonts.py: the bundled font files (Metro needs a literal require per file).",
             "/* eslint-disable @typescript-eslint/no-require-imports */", "export const FILES: Record<string, number> = {"]
    for parts in manifest.values():
        for p in parts:
            lines.append(f'  "{p["file"]}": require("../../assets/fonts/{p["file"]}"),')
    lines.append("};")
    FILES_TS.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
