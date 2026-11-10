#!/usr/bin/env python3
"""Bake the wide text atlases kit/runtime/fonts/ui.json and uib.json: Inter (SIL OFL 1.1) with the letters
of Latin-script languages (accents included), Greek and Cyrillic, for text that comes from outside the app
(video titles, channel names). Same file format as bake_fonts.py's, plus "wide": true, which tells
fonts.js not to send such text to a per-script atlas.

  python3 kit/tools/bake_wide.py            needs Pillow and the Inter fonts
  FONTDIR=/path/to/inter python3 ...        where Inter-Regular.otf and Inter-SemiBold.otf are
"""
import base64, hashlib, json, os, zlib
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'runtime', 'fonts')
FONTDIR = os.environ.get('FONTDIR', '/usr/share/fonts/opentype/inter')


def span(a, b):
    return ''.join(chr(c) for c in range(a, b + 1))


CHARS = (span(0x20, 0x7e) + span(0xa1, 0xff) + span(0x100, 0x17f)          # Latin, Latin-1, Latin Extended-A
         + 'ȘșȚț'                                      # Romanian
         + span(0x384, 0x3ce)                                                # Greek
         + span(0x400, 0x45f) + 'Ґґ'                             # Cyrillic
         + '–—‘’‚“”„†•…‰‹›'
         + '€₺₽№™←↑→↓−≈≠≤≥')

FAMILIES = {
    'ui': ('Inter-Regular.otf', [22, 28, 36]),
    'uib': ('Inter-SemiBold.otf', [24, 30, 40]),
}


def bake(path, size):
    font = ImageFont.truetype(path, size)
    ascent, descent = font.getmetrics()
    notdef = font.getmask('￿').getbbox()
    glyphs, imgs = {}, []
    for ch in dict.fromkeys(CHARS):
        if ch != ' ' and not font.getmask(ch).getbbox():
            continue                                                         # nothing drawn: not in the font
        bbox = font.getbbox(ch, anchor='ls')
        adv = font.getlength(ch)
        w, h = max(0, bbox[2] - bbox[0]), max(0, bbox[3] - bbox[1])
        im = None
        if w and h:
            im = Image.new('L', (w, h), 0)
            ImageDraw.Draw(im).text((-bbox[0], -bbox[1]), ch, font=font, fill=255, anchor='ls')
        imgs.append((ch, im, bbox, adv))
    W = 1024
    x = y = rowh = 0
    place = {}
    for ch, im, bbox, adv in imgs:
        if im is None:
            place[ch] = (0, 0, 0, 0)
            continue
        if x + im.width > W:
            x, y, rowh = 0, y + rowh + 1, 0
        place[ch] = (x, y, im.width, im.height)
        x += im.width + 1
        rowh = max(rowh, im.height)
    H = y + rowh + 1
    atlas = Image.new('L', (W, H), 0)
    for ch, im, bbox, adv in imgs:
        px, py, pw, ph = place[ch]
        if im is not None:
            atlas.paste(im, (px, py))
        glyphs[ord(ch)] = [px, py, pw, ph, bbox[0], bbox[1], round(adv, 2)]
    void = notdef
    return {'size': size, 'ascent': ascent, 'descent': descent, 'atlasW': W, 'atlasH': H,
            'alpha': base64.b64encode(zlib.compress(atlas.tobytes(), 9)).decode(), 'glyphs': glyphs}, void


def main():
    for fam, (fname, sizes) in FAMILIES.items():
        path = os.path.join(FONTDIR, fname)
        # the atlas id the renderer shares between apps comes from family, size and this key
        key = hashlib.sha256((fname + CHARS + open(path, 'rb').read().hex()[:4096]).encode()).hexdigest()[:16]
        data = {'family': fam, 'source': fname, 'wide': True, 'cacheKey': key, 'sizes': [bake(path, s)[0] for s in sizes]}
        p = os.path.join(OUT, fam + '.json')
        json.dump(data, open(p, 'w', encoding='utf-8', newline='\n'), separators=(',', ':'))
        print('%s: %s, %d glyphs, atlas heights %s -> %d KiB' % (fam, sizes, len(data['sizes'][0]['glyphs']),
                                                                  [s['atlasH'] for s in data['sizes']], os.path.getsize(p) // 1024))


if __name__ == '__main__':
    main()
