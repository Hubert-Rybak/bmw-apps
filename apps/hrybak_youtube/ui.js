'use strict';
/**
 * ui.js - the app's pages, drawn on the kit's canvas (1600 x 520 logical px, more below where the kit runs
 * the screen): Home (recent searches, watched videos), Search (keyboard and suggestions, then results) and
 * Playing (the video, its controls, related videos, the sound set-up).
 *
 * draw(cv, t, S, A, thumbs): S is the app's state and A its actions (main.js). Everything that can be
 * pressed is a kit target (cv.target): a tap runs it, and the iDrive controller walks through them.
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const fonts = require('./kit/fonts');

const X0 = 20, X1 = 1580, TOP = 54;
const TABS = ['Home', 'Search', 'Playing'];
const VIDEO_ID = 1;

/* ---- text ---- */
const UI = { font: 'ui', literal: true }, UIB = { font: 'uib', literal: true };
const opt = (bold, align) => (align ? { font: bold ? 'uib' : 'ui', literal: true, align } : bold ? UIB : UI);

const cleaned = new Map();
/** A title as the fonts can draw it: no emoji or invisible marks, one '?' for a run of letters they lack. */
function clean(s) {
    s = String(s == null ? '' : s);
    let out = cleaned.get(s);
    if (out !== undefined) return out;
    out = '';
    let gap = false;
    for (const ch of s) {
        const cp = ch.codePointAt(0);
        // emoji and pictographs, variation selectors, joiners, direction marks, tags
        if (cp > 0xffff || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2b00 && cp <= 0x2bff) || (cp >= 0xfe00 && cp <= 0xfe0f)
            || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202f) || (cp >= 0x2060 && cp <= 0x206f) || cp === 0xfeff || cp < 0x20) continue;
        if (cp === 0xa0 || cp === 0x3000) { out += ' '; gap = false; continue; }
        if (fonts.covers('ui', cp)) { out += ch; gap = false; } else if (!gap) { out += '?'; gap = true; }
    }
    out = out.replace(/\s+/g, ' ').trim();
    if (cleaned.size > 600) cleaned.clear();
    cleaned.set(s, out);
    return out;
}

function fit(cv, s, size, w, bold) {
    const o = opt(bold);
    if (cv.textWidth(s, size, o) <= w) return s;
    const chars = Array.from(s);
    while (chars.length > 1 && cv.textWidth(chars.join('') + '…', size, o) > w) chars.pop();
    return chars.join('').replace(/\s+$/, '') + '…';
}

/** s in at most `lines` lines of width w, the last one cut with an ellipsis. */
function wrap(cv, s, size, w, bold, lines) {
    const o = opt(bold), words = s.split(' '), out = [];
    let cur = '';
    for (let i = 0; i < words.length; i++) {
        const next = cur ? cur + ' ' + words[i] : words[i];
        if (cv.textWidth(next, size, o) <= w || !cur) { cur = next; continue; }
        if (out.length === lines - 1) { cur = cur + ' ' + words.slice(i).join(' '); break; }
        out.push(cur);
        cur = words[i];
    }
    out.push(fit(cv, cur, size, w, bold));
    return out;
}

function clock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + ('0' + m).slice(-2) : String(m)) + ':' + ('0' + s).slice(-2);
}

/* ---- small parts ---- */
function playIcon(cv, cx, cy, r, c) {
    cv.quad([[cx - r * 0.55, cy - r * 0.75], [cx + r * 0.85, cy - 0.6], [cx + r * 0.85, cy + 0.6], [cx - r * 0.55, cy + r * 0.75]], c);
}
function pauseIcon(cv, cx, cy, r, c) {
    cv.roundRect(cx - r * 0.62, cy - r * 0.72, r * 0.44, r * 1.44, 3, c);
    cv.roundRect(cx + r * 0.18, cy - r * 0.72, r * 0.44, r * 1.44, 3, c);
}
function searchIcon(cv, cx, cy, r, c) {
    cv.arc(cx - r * 0.15, cy - r * 0.15, r * 0.52, r * 0.72, 0, 360, c);
    cv.line(cx + r * 0.38, cy + r * 0.38, cx + r * 0.85, cy + r * 0.85, r * 0.24, c);
}
function spinner(cv, cx, cy, r, c) {
    const a = (Date.now() / 4) % 360;
    cv.arc(cx, cy, r - 5, r, 0, 360, withAlpha(c, 0.18));
    cv.arc(cx, cy, r - 5, r, a, a + 100, c, { round: true });
}

/** A round button with text; returns its width. */
function chip(cv, t, x, y, h, label, run, key, o) {
    o = o || {};
    const size = o.size || 20, w = o.w || Math.round(cv.textWidth(label, size, UIB) + h * 0.9);
    const S = t.sel || t.accent;
    cv.roundRect(x, y, w, h, h / 2, o.on ? withAlpha(S, 0.85) : withAlpha('#ffffff', o.dim ? 0.04 : 0.08));
    if (!o.on) cv.strokeRoundRect(x, y, w, h, h / 2, 1.5, withAlpha('#ffffff', o.dim ? 0.12 : 0.24));
    cv.text(label, x + w / 2, y + h / 2 + size * 0.36, size, o.on ? '#ffffff' : o.dim ? t.dim : t.text, opt(true, 'center'));
    if (run) cv.target(x, y, w, h, run, key);
    return w;
}

/** A centred message with an optional button under it. */
function notice(cv, t, x, y, w, h, title, lines, button) {
    const n = (lines || []).length;
    let ty = y + h / 2 - (n * 28 + (button ? 70 : 0)) / 2;
    cv.text(title, x + w / 2, ty, 26, t.text, opt(true, 'center'));
    (lines || []).forEach((l) => { ty += 30; cv.text(l, x + w / 2, ty, 19, t.dim, opt(false, 'center')); });
    if (button) {
        const bw = Math.round(cv.textWidth(button.label, 20, UIB) + 60);
        chip(cv, t, x + w / 2 - bw / 2, ty + 26, 50, button.label, button.run, button.key || 'notice', { w: bw, on: true });
    }
}

/* ---- video cards ---- */
const CARD = { cols: 4, gap: 16, text: 86 };
function cardSize() {
    const w = Math.floor((X1 - X0 - (CARD.cols - 1) * CARD.gap) / CARD.cols), th = Math.round(w * 9 / 16);
    return { w, th, h: th + CARD.text, pitch: th + CARD.text + 14 };
}

function card(cv, t, x, y, v, A, thumbs, key, playing, view) {
    const c = cardSize(), S = t.sel || t.accent;
    const pid = thumbs.get(v);
    cv.roundRect(x, y, c.w, c.th, 10, t.panelTop);
    if (pid) cv.picture(pid, x, y, c.w, c.th, 10);
    if (playing) cv.strokeRoundRect(x - 2, y - 2, c.w + 4, c.th + 4, 12, 3, S);
    if (v.length) {
        const live = v.live, bw = Math.round(cv.textWidth(v.length, 16, UIB) + 16);
        cv.roundRect(x + c.w - bw - 8, y + c.th - 34, bw, 26, 6, live ? withAlpha(t.crit, 0.92) : withAlpha('#000000', 0.78));
        cv.text(v.length, x + c.w - 8 - bw / 2, y + c.th - 15, 16, '#ffffff', opt(true, 'center'));
    }
    // where a watched video stopped
    if (v.pos > 5 && v.seconds > 0) {
        cv.fillRect(x + 10, y + c.th - 5, c.w - 20, 3, withAlpha('#ffffff', 0.3));
        cv.fillRect(x + 10, y + c.th - 5, (c.w - 20) * Math.min(1, v.pos / v.seconds), 3, S);
    }
    const lines = wrap(cv, clean(v.title), 20, c.w - 8, false, 2);
    lines.forEach((l, i) => cv.text(l, x + 4, y + c.th + 26 + i * 25, 20, t.text, UI));
    const meta = [clean(v.author), v.views, v.age].filter(Boolean).join(' · ');
    cv.text(fit(cv, meta, 16, c.w - 8), x + 4, y + c.th + 26 + 2 * 25 + 2, 16, t.dim, UI);
    // (only what is in view can be pressed)
    const top = Math.max(y, view.top), bottom = Math.min(y + c.h, view.bottom);
    if (bottom - top > 40) cv.target(x, top, c.w, bottom - top, () => A.play(v), key, 10);
}

/** A scrolling grid of videos from y0 to the page's bottom. sc: { y } scroll state (kept by the caller). */
function grid(cv, t, list, sc, y0, A, thumbs, keyPrefix, S, footer) {
    const c = cardSize(), bottom = G.pageBottom(cv), H = bottom - y0;
    const rows = Math.ceil(list.length / CARD.cols);
    const total = rows * c.pitch + (footer ? 60 : 0);
    sc.max = Math.max(0, total - H);
    sc.y = Math.max(0, Math.min(sc.max, sc.y || 0));
    cv.clip(0, y0, 1600, H);
    const view = { top: y0, bottom };
    for (let i = 0; i < list.length; i++) {
        const y = y0 + Math.floor(i / CARD.cols) * c.pitch - sc.y;
        if (y + c.h < y0 || y > bottom) continue;
        const x = X0 + (i % CARD.cols) * (c.w + CARD.gap);
        card(cv, t, x, y, list[i], A, thumbs, keyPrefix + list[i].id, !!(S.now && S.now.video.id === list[i].id), view);
    }
    if (footer) {
        const fy = y0 + rows * c.pitch - sc.y + 34;
        if (fy < bottom + 20) cv.text(footer, 800, fy, 19, t.dim, opt(false, 'center'));
    }
    cv.noclip();
    if (sc.max > 0) {
        const bh = Math.max(40, H * H / total), by = y0 + (H - bh) * (sc.y / sc.max);
        cv.roundRect(X1 + 6, y0, 4, H, 2, withAlpha('#ffffff', 0.08));
        cv.roundRect(X1 + 6, by, 4, bh, 2, withAlpha('#ffffff', 0.45));
        cv.scroll = { y: y0, bar: { x: X1 + 6, y: by, w: 4, h: bh } };
    }
}

/* ---- pages ---- */
function home(cv, t, S, A, thumbs) {
    let y = TOP + 6;
    if (!S.online) {
        cv.roundRect(X0, y, X1 - X0, 44, 10, withAlpha(t.warn, 0.16));
        cv.text('No internet connection. Connect the car in the Store: Settings, Wi-Fi (or plug in a phone).', X0 + 18, y + 29, 19, t.warn, UI);
        y += 56;
    }
    const chips = S.searches.length ? S.searches.slice(0, 8) : [];
    if (chips.length) {
        let x = X0;
        searchIcon(cv, x + 18, y + 24, 16, t.dim);
        x += 46;
        for (let i = 0; i < chips.length; i++) {
            const label = fit(cv, clean(chips[i]), 20, 260, true);
            const w = Math.round(cv.textWidth(label, 20, UIB) + 42);
            if (x + w > X1) break;
            chip(cv, t, x, y, 48, label, () => A.search(chips[i]), 'recent' + i, { w });
            x += w + 10;
        }
        y += 62;
    }
    if (!S.history.length) {
        notice(cv, t, X0, y, X1 - X0, G.pageBottom(cv) - y, 'Nothing watched yet', ['Find a video on the Search page.'], { label: 'Search', run: () => A.tab(1), key: 'gosearch' });
        return;
    }
    cv.text('WATCH AGAIN', X0 + 4, y + 22, 17, t.dim, opt(true));
    grid(cv, t, S.history, S.homeScroll, y + 36, A, thumbs, 'h', S);
}

const KEYS = ['1234567890', 'qwertyuiop', 'asdfghjkl\'', 'zxcvbnm,.-'];
function keyboard(cv, t, S, A, x0, y0, w, bottom) {
    const gap = 8, kw = Math.floor((w - 9 * gap) / 10), rows = KEYS.length + 1;
    const kh = Math.min(74, Math.floor((bottom - y0 - (rows - 1) * gap) / rows));
    const key = (x, y, kwid, label, run, id, o) => {
        o = o || {};
        const Sc = t.sel || t.accent;
        cv.roundRect(x, y, kwid, kh, 10, o.primary ? withAlpha(Sc, 0.85) : withAlpha('#ffffff', o.wide ? 0.06 : 0.09));
        cv.text(label, x + kwid / 2, y + kh / 2 + (o.small ? 7 : 9), o.small ? 19 : 25, o.primary ? '#ffffff' : t.text, opt(true, 'center'));
        cv.target(x, y, kwid, kh, run, id, 10);
    };
    KEYS.forEach((row, r) => {
        for (let i = 0; i < row.length; i++) {
            const ch = row[i];
            key(x0 + i * (kw + gap), y0 + r * (kh + gap), kw, ch, () => A.type(ch), 'k' + ch);
        }
    });
    const y = y0 + KEYS.length * (kh + gap), span = (n) => n * kw + (n - 1) * gap;
    key(x0, y, span(2), 'CLEAR', () => A.clear(), 'kclear', { small: true, wide: true });
    key(x0 + span(2) + gap, y, span(4), 'SPACE', () => A.type(' '), 'kspace', { small: true, wide: true });
    key(x0 + span(6) + 2 * gap, y, span(2), 'DELETE', () => A.backspace(), 'kdel', { small: true, wide: true });
    key(x0 + span(8) + 3 * gap, y, span(2), 'SEARCH', () => A.search(S.query), 'kgo', { small: true, primary: true });
}

function queryField(cv, t, S, A, x, y, w, editable) {
    cv.roundRect(x, y, w, 60, 12, withAlpha('#ffffff', 0.07));
    cv.strokeRoundRect(x, y, w, 60, 12, 1.5, withAlpha('#ffffff', S.typing ? 0.4 : 0.18));
    searchIcon(cv, x + 34, y + 30, 18, t.dim);
    const shown = clean(S.query);
    const text = shown ? fit(cv, shown, 26, w - 110, true) : 'Search YouTube';
    const tw = cv.text(text, x + 66, y + 39, 26, shown ? t.text : t.dim, UIB);
    if (S.typing && Math.floor(Date.now() / 500) % 2 === 0) cv.fillRect(x + 68 + (shown ? tw : 0), y + 14, 2, 32, t.text);
    if (editable) cv.target(x, y, w, 60, () => A.edit(), 'query', 12);
}

function search(cv, t, S, A, thumbs) {
    const bottom = G.pageBottom(cv);
    if (S.typing) {
        const kbW = 1010;
        queryField(cv, t, S, A, X0, TOP + 4, kbW, false);
        keyboard(cv, t, S, A, X0, TOP + 78, kbW, bottom - 6);
        // beside it: what YouTube would complete the text to, or the last searches
        const sx = X0 + kbW + 26, sw = X1 - sx;
        const list = S.query.trim() ? S.suggestions : S.searches;
        cv.text(S.query.trim() ? 'SUGGESTIONS' : 'RECENT SEARCHES', sx + 4, TOP + 28, 17, t.dim, opt(true));
        const rowH = 56, n = Math.min(list.length, Math.floor((bottom - TOP - 44) / rowH));
        for (let i = 0; i < n; i++) {
            const y = TOP + 42 + i * rowH;
            cv.roundRect(sx, y, sw, rowH - 8, 10, withAlpha('#ffffff', 0.05));
            searchIcon(cv, sx + 26, y + 24, 12, t.dim);
            cv.text(fit(cv, clean(list[i]), 21, sw - 66), sx + 50, y + 31, 21, t.text, UI);
            cv.target(sx, y, sw, rowH - 8, () => A.search(list[i]), 'sug' + i, 10);
        }
        if (!list.length && !S.online) cv.text('No internet connection', sx + 4, TOP + 70, 19, t.warn, UI);
        return;
    }
    queryField(cv, t, S, A, X0, TOP + 4, 1000, true);
    const y0 = TOP + 80;
    if (S.loading) { spinner(cv, 800, (y0 + bottom) / 2, 34, t.text); return; }
    if (S.error) {
        notice(cv, t, X0, y0, X1 - X0, bottom - y0, 'Search failed', [S.error], { label: 'Try again', run: () => A.search(S.query), key: 'retry' });
        return;
    }
    if (!S.results.length) {
        notice(cv, t, X0, y0, X1 - X0, bottom - y0, S.searched ? 'No videos found' : 'Search YouTube', [S.searched ? 'Try other words.' : 'Tap the field above to type.']);
        return;
    }
    cv.text(S.results.length + ' videos', X0 + 1024, TOP + 42, 19, t.dim, UI);
    grid(cv, t, S.results, S.resultScroll, y0, A, thumbs, 'r', S, S.loadingMore ? 'Loading more…' : S.more ? '' : 'End of results');
}

/** Why there is no picture, in the picture's place. */
function pictureNote(cv, S, now) {
    const st = now.st || {};
    if (now.error) return { title: 'Cannot play this video', lines: wrap(cv, now.error, 19, 700, false, 3), retry: true };
    if (!S.tool) return { title: 'The YouTube player is not running', lines: ['Install "YouTube player" in the Store,', 'then restart the head unit.'] };
    if (S.moving) return { title: 'Picture off while driving', lines: [now.audio ? 'The sound plays on.' : 'Paused. It goes on when the car stands.'] };
    if (!cv.media.video) return { title: 'This renderer cannot show video', lines: ['Update "Renderer" in the Store,', 'then restart the head unit.'] };
    if (st.state === 'ended') return { title: 'Finished', lines: [], replay: true };
    if (!st.shown) return { busy: true, title: now.status === 'resolving' ? 'Asking YouTube…' : 'Loading…', lines: [] };
    return null;
}

function soundSetup(cv, t, S, A, x, y, w, bottom) {
    const sd = S.sound;
    cv.text('Sound (experimental)', x, y + 26, 24, t.text, UIB);
    const lines = ['Nobody has shown yet which of the head unit\'s sound devices reaches',
        'the speakers. Tap one to hear a short quiet tone on it; the one you',
        'hear is the one to keep. Parked only: the head unit may restart.'];
    lines.forEach((l, i) => cv.text(l, x, y + 56 + i * 24, 17, t.dim, UI));
    let ry = y + 56 + lines.length * 24 + 8;
    const row = (label, note, on, run, key) => {
        if (ry + 50 > bottom - 62) return;
        cv.roundRect(x, ry, w, 46, 10, on ? withAlpha(t.sel || t.accent, 0.3) : withAlpha('#ffffff', 0.06));
        cv.text(fit(cv, label, 19, w - 190, true), x + 14, ry + 30, 19, t.text, UIB);
        if (note) cv.text(note, x + w - 14, ry + 30, 16, on ? t.text : t.dim, opt(false, 'right'));
        cv.target(x, ry, w, 46, run, key, 10);
        ry += 52;
    };
    if (!S.tool) cv.text('The YouTube player tool is not running.', x, ry + 24, 19, t.warn, UI);
    else if (!sd.alsa) cv.text('This head unit has no ALSA sound library.', x, ry + 24, 19, t.warn, UI);
    else if (!sd.devices.length) cv.text(sd.loading ? 'Looking for sound devices…' : 'No sound device found.', x, ry + 24, 19, t.dim, UI);
    else sd.devices.forEach((d, i) => row(d, sd.testing === d ? 'tone…' : S.audioDevice === d && S.soundOn ? 'in use' : sd.result[d] || 'tap: test and use', S.audioDevice === d && S.soundOn, () => A.pickDevice(d), 'dev' + i));
    if (sd.note) wrap(cv, sd.note, 17, w, false, 2).forEach((l, i) => cv.text(l, x, bottom - 84 + i * 22, 17, t.warn, UI));
    let bx = x;
    bx += chip(cv, t, bx, bottom - 50, 46, 'Sound off', () => A.soundOff(), 'sndoff', { on: !S.soundOn }) + 12;
    chip(cv, t, bx, bottom - 50, 46, 'Done', () => A.soundSetup(false), 'snddone');
}

function playing(cv, t, S, A, thumbs) {
    const bottom = G.pageBottom(cv), now = S.now;
    if (!now) {
        notice(cv, t, X0, TOP, X1 - X0, bottom - TOP, 'Nothing is playing', ['Pick a video on the Home or Search page.'], { label: 'Search', run: () => A.tab(1), key: 'gosearch2' });
        return;
    }
    const st = now.st || {}, Sc = t.sel || t.accent;
    const vy = TOP + 4, vh = bottom - vy - 6, vw = Math.min(950, Math.round(vh * 16 / 9));
    // the picture, or why there is none over the video's thumbnail
    cv.roundRect(X0, vy, vw, vh, 12, '#000000');
    const note = pictureNote(cv, S, now);
    if (!note) cv.video(VIDEO_ID, X0, vy, vw, vh, 12);
    if (note) {
        // (darkened with a layer over it: the same on every renderer)
        const pid = thumbs.get(now.video);
        if (pid) { cv.picture(pid, X0, vy, vw, vh, 12); cv.roundRect(X0, vy, vw, vh, 12, withAlpha('#000000', 0.74)); }
        const cx = X0 + vw / 2, cy = vy + vh / 2;
        if (note.busy) { spinner(cv, cx, cy - 26, 30, '#ffffff'); cv.text(note.title, cx, cy + 40, 21, '#ffffff', opt(true, 'center')); } else {
            notice(cv, t, X0, vy, vw, vh, note.title, note.lines,
                note.retry ? { label: 'Try again', run: () => A.play(now.video), key: 'retryplay' } : note.replay ? { label: 'Play again', run: () => A.seekTo(0), key: 'replay' } : null);
        }
    } else if (st.state === 'paused') {
        cv.circle(X0 + vw / 2, vy + vh / 2, 46, withAlpha('#000000', 0.55));
        pauseIcon(cv, X0 + vw / 2, vy + vh / 2, 26, '#ffffff');
    } else if (st.state === 'buffering') spinner(cv, X0 + vw / 2, vy + vh / 2, 30, '#ffffff');
    if (!note || (!note.retry && !note.replay)) cv.target(X0, vy, vw, vh, () => A.toggle(), 'picture', 12);

    const x = X0 + vw + 26, w = X1 - x;
    if (S.sound.open) { soundSetup(cv, t, S, A, x, vy, w, bottom); return; }
    let y = vy + 28;
    wrap(cv, clean(now.video.title), 24, w, true, 3).forEach((l) => { cv.text(l, x, y, 24, t.text, UIB); y += 31; });
    cv.text(fit(cv, [clean(now.video.author), now.video.views].filter(Boolean).join(' · '), 18, w), x, y, 18, t.dim, UI);
    y += 22;
    // where it is: a bar that can be tapped to go there
    const dur = st.dur || now.video.seconds || 0, pos = Math.min(dur || 1e9, S.pos || 0);
    const by = y + 20;
    S.seekBar = dur > 0 ? { x, y: by - 16, w, h: 44, dur } : null;
    cv.roundRect(x, by, w, 8, 4, withAlpha('#ffffff', 0.16));
    if (dur > 0) {
        cv.roundRect(x, by, Math.max(8, w * pos / dur), 8, 4, Sc);
        cv.circle(x + w * pos / dur, by + 4, 9, '#ffffff');
    }
    cv.text(clock(pos), x, by + 36, 18, t.text, UI);
    cv.text(dur > 0 ? clock(dur) : '', x + w, by + 36, 18, t.dim, opt(false, 'right'));
    const info = st.state === 'buffering' ? 'Buffering…' : st.h ? st.h + 'p' + (st.fps > 32 ? Math.round(st.fps) : '') + (st.dropped > 30 ? ' · the unit cannot keep up' : '') : '';
    cv.text(info, x + w / 2, by + 36, 16, st.dropped > 30 ? t.warn : t.dim, opt(false, 'center'));
    y = by + 58;
    // back 10 s, play / pause, on 10 s
    const r = 36, mid = x + w / 2, cy = y + r;
    const round = (cx, key, run, drawIt, primary) => {
        cv.circle(cx, cy, r, primary ? withAlpha(Sc, 0.9) : withAlpha('#ffffff', 0.09));
        drawIt(cx);
        cv.target(cx - r, cy - r, r * 2, r * 2, run, key, r);
    };
    const can = !!st.state && st.state !== 'error' && !now.error;
    round(mid - 110, 'back10', () => A.seekBy(-10), (cx) => cv.text('-10', cx, cy + 8, 22, can ? t.text : t.dim, opt(true, 'center')));
    round(mid, 'playpause', () => A.toggle(), (cx) => (st.state === 'playing' || st.state === 'buffering' ? pauseIcon(cv, cx, cy, 22, '#ffffff') : playIcon(cv, cx, cy, 22, '#ffffff')), true);
    round(mid + 110, 'fwd10', () => A.seekBy(10), (cx) => cv.text('+10', cx, cy + 8, 22, can ? t.text : t.dim, opt(true, 'center')));
    y = cy + r + 16;
    // sound is wanted and the video is running without it: the player says why beside the button
    const wanted = S.soundOn && !!S.audioDevice, silent = wanted && !!st.shown && !st.audio && st.state !== 'error';
    const sw = chip(cv, t, x, y, 42, !wanted ? 'Sound off' : silent ? 'Sound: not working' : 'Sound on', () => A.soundSetup(true), 'sound', { size: 17, dim: !wanted || silent });
    if (silent && st.err) cv.text(fit(cv, st.err, 15, w - sw - 16), x + sw + 14, y + 27, 15, t.warn, UI);
    y += 58;
    // what YouTube shows beside the video
    const rowH = 84;
    if (now.related.length && y + rowH <= bottom) {
        cv.text('RELATED', x + 2, y + 6, 15, t.dim, opt(true));
        y += 16;
        for (let i = 0; i < now.related.length && y + rowH <= bottom + 4; i++, y += rowH) {
            const v = now.related[i], pid = thumbs.get(v);
            cv.roundRect(x, y, 128, 72, 8, t.panelTop);
            if (pid) cv.picture(pid, x, y, 128, 72, 8);
            wrap(cv, clean(v.title), 17, w - 142, false, 2).forEach((l, k) => cv.text(l, x + 140, y + 22 + k * 21, 17, t.text, UI));
            cv.text(fit(cv, [clean(v.author), v.length].filter(Boolean).join(' · '), 15, w - 142), x + 140, y + 22 + 2 * 21, 15, t.dim, UI);
            cv.target(x, y, w, 76, () => A.play(v), 'rel' + v.id, 8);
        }
    }
}

/** The page for a renderer the kit cannot run the screen on (no touch): what is needed, and what plays. */
function limited(cv, t, S) {
    const lines = ['YouTube needs the Store\'s "Renderer" (mgu-render) with touch: install it in the Store',
        'and restart the head unit. The pages then work by touch and with the iDrive controller.'];
    cv.clear(t.bg);
    cv.text('YouTube', 800, 190, 44, t.text, opt(true, 'center'));
    lines.forEach((l, i) => cv.text(l, 800, 250 + i * 30, 20, t.dim, opt(false, 'center')));
    if (S.now) cv.text(fit(cv, 'Playing: ' + clean(S.now.video.title), 20, 1400), 800, 350, 20, t.text, opt(false, 'center'));
}

function draw(cv, t, S, A, thumbs) {
    cv.clear(t.bg);
    cv.scroll = false;
    if (!cv.own) { G.frame(cv, t, [], -1, []); limited(cv, t, S); return; }
    G.frame(cv, t, TABS, S.tab, [!S.online && { text: 'OFFLINE', color: 'warn' }]);
    if (S.tab === 0) home(cv, t, S, A, thumbs);
    else if (S.tab === 1) search(cv, t, S, A, thumbs);
    else playing(cv, t, S, A, thumbs);
}

module.exports = { draw, clean, clock, wrap, fit, cardSize, VIDEO_ID, TABS };
