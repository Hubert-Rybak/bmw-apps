'use strict';
/**
 * fonts.js - loads the pre-baked glyph atlases (kit/runtime/fonts/*.json,
 * made by kit/tools/bake_fonts.py) and picks the best size for a request.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, 'fonts');
const families = Object.create(null);

function family(name) {
    if (families[name] !== undefined) return families[name];
    let fam = null;
    try {
        const j = JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));
        fam = j.sizes.map((s) => ({
            size: s.size, ascent: s.ascent, descent: s.descent, atlasW: s.atlasW, atlasH: s.atlasH,
            glyphs: s.glyphs, _alpha: s.alpha, alpha: null, family: name, cacheKey: j.cacheKey || '',
        }));
        // "wide": the family has the letters of many scripts itself (Latin with accents, Greek, Cyrillic)
        fam.wide = !!j.wide;
    } catch (e) { fam = null; }
    families[name] = fam;
    return fam;
}

/** Smallest baked size >= requested (downscaling looks better), else largest. */
function get(name, size, text) {
    // Shared supplemental atlases avoid duplicating glyphs in every numeric size.
    const asked = family(name);
    if (asked && asked.wide) text = null;
    if (text && /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff]/.test(text)) name = 'korean';
    else if (text && /[\u3000-\u9fff\uff00-\uffef]/.test(text)) name = 'cjk';
    else if (text && /[\u0400-\u04ff]/.test(text)) name = 'cyrillic';
    const fam = family(name) || family('label');
    if (!fam) return null;
    let best = null;
    for (const f of fam) if (f.size >= size && (!best || f.size < best.size)) best = f;
    if (!best) best = fam[fam.length - 1];
    if (!best.alpha) best.alpha = zlib.inflateSync(Buffer.from(best._alpha, 'base64'));
    return best;
}

/** Whether a family's atlas is there (get() falls back to 'label' for one that isn't). */
function has(name) { return !!family(name); }
/** Whether a family draws code point cp itself (else '?'). */
function covers(name, cp) { const fam = family(name); return !!(fam && fam.length && fam[0].glyphs[cp]); }

function measure(f, s) {
    let w = 0;
    for (const ch of s) { const g = f.glyphs[ch.codePointAt(0)] || f.glyphs[63]; if (g) w += g[6]; }
    return w;
}

module.exports = { get, has, covers, measure };
