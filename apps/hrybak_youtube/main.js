'use strict';
/**
 * YouTube for the iDrive 7 head unit (unofficial).
 *
 * The app searches YouTube and asks it where a video's files are (youtube.js), downloads them through the
 * Store's uplink (net.js) and hands the bytes to the player tool hrybak-ytplay (player.js), which decodes
 * them: the pictures reach the screen through the renderer's video frame file, the sound (experimental,
 * off until the owner picks a device) through the unit's ALSA library. The pages are drawn by ui.js.
 *
 * The picture shows only while the car stands ("Picture only while parked", on by default).
 */
const mgu = require('./kit/mgu');
const parkedWatch = require('./kit/parked');
const { Net, NetError } = require('./net');
const { YouTube } = require('./youtube');
const { PlayerLink } = require('./player');
const { Store } = require('./store');
const { Thumbs } = require('./thumbs');
const ui = require('./ui');

// sound level settings, dB below full scale (quiet first: a device past the car's volume control may ignore the knob)
const GAIN = { quiet: -30, medium: -18, loud: -8, full: 0 };
// sound devices never offered: the car's own voices (calls, warnings, parking beeps, microphones) and their mono lines
const NOT_OURS = /phone|call|pdc|gong|warn|mic|mono|_24_|alternate|navi|tts|speech|ecall/i;
const LIKELY = /media|entertain|music|carplay|androidauto/i;

function message(e) {
    if (!e) return 'Something went wrong';
    if (e instanceof NetError) return e.code === 'offline' ? 'No internet connection' : e.message;
    return e.message || String(e);
}

mgu.run({
    async start(ctx) {
        const { log, settings } = ctx;
        const store = new Store(ctx.dataDir, log);
        const net = new Net({ dataDir: ctx.dataDir, log });
        const region = () => String(settings.get('region') || 'en-US').split('-');
        const yt = new YouTube({ net, log, hl: region()[0], gl: region()[1] });
        const link = new PlayerLink(log);
        let loop = null, dirty = true, lastDraw = 0;
        const changed = () => { dirty = true; if (loop) loop.kick(); };
        const thumbs = new Thumbs({ net, link, media: ctx.media, log, onChange: changed });
        const parked = parkedWatch.watch(ctx, log);

        const S = {
            tab: store.history.length ? 0 : 1, online: net.online(), tool: false, moving: false,
            get history() { return settings.get('keepHistory') === false ? [] : store.history; },
            get searches() { return settings.get('keepHistory') === false ? [] : store.searches; },
            homeScroll: { y: 0 }, resultScroll: { y: 0 },
            query: '', typing: true, suggestions: [], results: [], more: null, loading: false, loadingMore: false, error: '', searched: false,
            now: null, pos: 0, seekBar: null,
            soundOn: store.data.soundOn, audioDevice: store.data.audioDevice,
            sound: { open: false, devices: [], alsa: true, loading: false, testing: '', result: {}, note: '' },
        };
        const keep = () => settings.get('keepHistory') !== false;
        const wantSound = () => S.soundOn && !!S.audioDevice;
        const gain = () => (GAIN[settings.get('volume')] != null ? GAIN[settings.get('volume')] : GAIN.quiet);

        /* ---- where the video is (the tool reports twice a second; in between the clock runs on) ---- */
        let posAt = { pos: 0, t: Date.now(), running: false };
        const currentPos = () => {
            const dur = (S.now && S.now.st && S.now.st.dur) || 0;
            const p = posAt.running ? posAt.pos + (Date.now() - posAt.t) / 1000 : posAt.pos;
            return Math.max(0, dur ? Math.min(dur, p) : p);
        };

        /* ---- search ---- */
        let searchSeq = 0, suggestSeq = 0, suggestTimer = null;
        const suggestSoon = () => {
            if (suggestTimer) clearTimeout(suggestTimer);
            const q = S.query.trim(), seq = ++suggestSeq;
            if (!q) { S.suggestions = []; return; }
            suggestTimer = setTimeout(() => {
                suggestTimer = null;
                yt.suggest(q).then((list) => { if (seq === suggestSeq) { S.suggestions = list; changed(); } }).catch(() => { /* no suggestions: the keyboard still works */ });
            }, 350);
        };
        const loadMore = () => {
            if (!S.more || S.loadingMore || S.loading) return;
            const seq = searchSeq;
            S.loadingMore = true;
            yt.search(null, { more: S.more }).then((r) => {
                if (seq !== searchSeq) return;
                const have = new Set(S.results.map((v) => v.id));
                const fresh = r.items.filter((v) => !have.has(v.id));
                S.results = S.results.concat(fresh);
                S.more = fresh.length && S.results.length < 200 ? r.more : null;
            }).catch(() => { if (seq === searchSeq) S.more = null; }).then(() => { if (seq === searchSeq) { S.loadingMore = false; changed(); } });
            changed();
        };

        /* ---- playing ---- */
        let playSeq = 0, pausedByUs = '', reopens = [];
        const openFiles = (start) => {
            const now = S.now, r = now && now.files;
            if (!r || !link.ready) return;          // (opened when the tool connects)
            const src = (f) => net.rangeSource(f.url, { size: f.size, headers: f.headers });
            ctx.media.video(ui.VIDEO_ID, link.hello.video);
            now.status = 'opening';
            now.st = null;
            posAt = { pos: start || 0, t: Date.now(), running: false };
            link.open({ video: src(r.video), audio: r.audio ? src(r.audio) : null, muxed: r.muxed, hasAudio: r.muxed },
                { start: start > 3 ? start : 0, device: wantSound() ? S.audioDevice : '', gain: gain() });
            pausedByUs = '';
            changed();
        };
        const resolve = (seq, start) => yt.resolve(S.now.video.id, { maxHeight: Number(settings.get('quality')) || 720, sound: wantSound(), fps60: !!settings.get('fps60') })
            .then((r) => {
                if (seq !== playSeq || !S.now) return;
                S.now.files = r;
                if (!S.now.video.seconds && r.seconds) S.now.video.seconds = r.seconds;
                if (!S.now.video.title && r.title) { S.now.video.title = r.title; S.now.video.author = r.author; }
                log.info('playing ' + S.now.video.id + ' as ' + r.client + ': ' + (r.muxed ? 'one file' : 'picture ' + r.video.height + 'p' + (r.audio ? ' + sound' : '')));
                openFiles(start);
            })
            .catch((e) => {
                if (seq !== playSeq || !S.now) return;
                log.warn('cannot play ' + S.now.video.id + ': ' + message(e));
                S.now.error = message(e);
                S.now.status = 'error';
                changed();
            });

        const A = {
            tab(i) {
                if (S.tab === i) return;
                S.tab = i;
                if (i !== 2) S.sound.open = false;
                changed();
            },
            type(ch) {
                if (Array.from(S.query).length >= 80) return;
                S.query += ch; S.typing = true;
                suggestSoon(); changed();
            },
            backspace() { S.query = Array.from(S.query).slice(0, -1).join(''); suggestSoon(); changed(); },
            clear() { S.query = ''; S.suggestions = []; suggestSeq++; changed(); },
            edit() { S.typing = true; suggestSoon(); changed(); },
            search(q) {
                q = String(q || '').trim();
                if (!q) return;
                const seq = ++searchSeq;
                Object.assign(S, { query: q, typing: false, tab: 1, loading: true, loadingMore: false, error: '', results: [], more: null, searched: true });
                S.resultScroll.y = 0;
                if (keep()) store.searched(q);
                changed();
                yt.search(q).then((r) => { if (seq !== searchSeq) return; S.results = r.items; S.more = r.more; S.loading = false; changed(); })
                    .catch((e) => { if (seq !== searchSeq) return; log.warn('search: ' + message(e)); S.loading = false; S.error = message(e); changed(); });
            },
            /** Play a video; `at`: seconds to start from (default: where it stopped the last time). */
            play(video, at) {
                const seq = ++playSeq;
                link.close();
                const start = at != null ? at : (() => { const p = store.resumeAt(video.id); return p > 10 && (!video.seconds || p < video.seconds - 15) ? p : 0; })();
                S.now = { video: Object.assign({}, video), status: 'resolving', st: null, error: '', related: [], audio: false, files: null };
                S.pos = start;
                posAt = { pos: start, t: Date.now(), running: false };
                S.tab = 2;
                S.sound.open = false;
                reopens = [];
                if (keep()) store.watched(video, start);
                changed();
                resolve(seq, start);
                yt.related(video.id).then((list) => { if (seq === playSeq && S.now) { S.now.related = list.slice(0, 8); changed(); } }).catch(() => { /* none shown */ });
            },
            toggle() {
                const st = S.now && S.now.st;
                if (!st) return;
                if (st.state === 'ended') { A.seekTo(0); return; }
                if (st.state === 'paused') { pausedByUs = ''; link.pause(false); } else if (st.state === 'playing' || st.state === 'buffering') { pausedByUs = ''; link.pause(true); }
            },
            seekBy(d) { if (S.now && S.now.st) A.seekTo(currentPos() + d); },
            seekTo(t) {
                const st = S.now && S.now.st;
                if (!st || st.state === 'error') return;
                t = Math.max(0, st.dur ? Math.min(st.dur - 1, t) : t);
                link.seek(t);
                posAt = { pos: t, t: Date.now(), running: false };
                S.pos = t;
                changed();
            },
            soundSetup(open) {
                S.sound.open = !!open;
                S.sound.note = '';
                if (open && link.ready) {
                    S.sound.loading = true;
                    link.devices().then((d) => {
                        S.sound.alsa = !!d.alsa;
                        const list = (d.list || []).filter((n) => !NOT_OURS.test(n));
                        S.sound.devices = list.filter((n) => LIKELY.test(n)).concat(list.filter((n) => !LIKELY.test(n))).slice(0, 8);
                    }).catch(() => { /* the tool went away: the page says so */ }).then(() => { S.sound.loading = false; changed(); });
                }
                changed();
            },
            /** A quiet tone on a device; when the device takes it, it becomes the app's sound device. */
            pickDevice(d) {
                const sd = S.sound;
                if (sd.testing) return;
                if (parked.moving()) { sd.note = 'Sound devices are tried only while the car stands.'; changed(); return; }
                if (S.now && S.now.st && S.now.st.audio === d) { sd.note = 'This device is playing the video\'s sound now.'; changed(); return; }
                sd.testing = d; sd.note = '';
                changed();
                link.tone(d, gain(), 2500).then((r) => {
                    sd.testing = '';
                    if (r.ok) {
                        sd.result[d] = 'took the tone';
                        S.audioDevice = d; S.soundOn = true;
                        store.set('audioDevice', d); store.set('soundOn', true);
                        sd.note = 'If you heard the tone, keep this device. If not, try another, or Sound off.';
                        // the video starts again from where it is, now with its sound; this page stays for the next try
                        if (S.now && !S.now.error) { A.play(S.now.video, currentPos()); sd.open = true; }
                    } else {
                        sd.result[d] = 'failed';
                        sd.note = r.err || 'The device did not take the tone.';
                    }
                    changed();
                }).catch((e) => { sd.testing = ''; sd.note = message(e); changed(); });
            },
            soundOff() {
                const was = S.soundOn;
                S.soundOn = false;
                store.set('soundOn', false);
                S.sound.note = '';
                if (was && S.now && !S.now.error) { A.play(S.now.video, currentPos()); S.sound.open = true; }
                changed();
            },
        };

        /* ---- the player tool ---- */
        link.on('ready', () => {
            S.tool = true;
            thumbs.retry();
            if (S.now && S.now.files && !S.now.error) openFiles(S.pos);
            changed();
        });
        link.on('gone', () => {
            S.tool = false;
            if (S.now) { S.now.st = null; posAt = { pos: S.pos, t: Date.now(), running: false }; }
            changed();
        });
        link.on('state', (st) => {
            const now = S.now;
            if (!now) return;
            now.st = st;
            now.audio = !!st.audio;
            posAt = { pos: st.pos || 0, t: Date.now(), running: st.state === 'playing' };
            if (st.state === 'error') now.error = st.err || 'The player could not play this video';
            else if (st.state !== 'opening') now.status = st.state;
            if (st.state === 'ended' && keep()) store.position(now.video.id, 0);
            changed();
        });
        // the video server refused a download (the address ran out, or the car's connection changed): YouTube is
        // asked again and the video goes on from where it was; three times a minute at most
        link.on('feederror', (f) => {
            const now = S.now;
            if (!now || now.error) return;
            const t = Date.now();
            reopens = reopens.filter((x) => t - x < 60000);
            if (reopens.length >= 3) { now.error = message(f.error); link.close(); changed(); return; }
            reopens.push(t);
            log.warn('download refused (' + message(f.error) + '): asking YouTube again');
            resolve(playSeq, currentPos());
        });
        link.start();

        /* ---- the kit's screen ---- */
        ctx.ui.onClick('BTN_PLAY', () => A.toggle());
        ctx.hideButton('BTN_PLAY');
        ctx.onTab((i) => A.tab(i));
        ctx.onLayout(changed);
        // a tap on the position bar goes there
        ctx.onTap((x, y) => {
            const b = S.seekBar;
            if (S.tab === 2 && b && !S.sound.open && x >= b.x - 10 && x <= b.x + b.w + 10 && y >= b.y && y <= b.y + b.h) A.seekTo(Math.max(0, Math.min(1, (x - b.x) / b.w)) * b.dur);
        });
        ctx.onScroll((dy) => {
            const sc = S.tab === 0 ? S.homeScroll : S.tab === 1 && !S.typing ? S.resultScroll : null;
            if (!sc) return false;
            const y = Math.max(0, Math.min(sc.max || 0, (sc.y || 0) + dy));
            if (y === sc.y) return false;
            sc.y = y;
            if (S.tab === 1 && (sc.max || 0) - y < 500) loadMore();
            dirty = true;
            return true;
        });
        settings.onChange((key) => {
            if (key === 'region') yt.setRegion(region()[0], region()[1]);
            else if (key === 'volume') link.gain(gain());
            else if ((key === 'quality' || key === 'fps60') && S.now && !S.now.error) A.play(S.now.video, currentPos());
            else if (key === 'keepHistory' && !keep()) store.forget();
            changed();
        });

        // left the app's screen, or driving with the picture off: a video without sound waits
        const hold = (why, on) => {
            const st = S.now && S.now.st;
            if (on && st && (st.state === 'playing' || st.state === 'buffering') && !st.audio) { pausedByUs = why; link.pause(true); } else if (!on && pausedByUs === why) {
                pausedByUs = '';
                if (st && st.state === 'paused') link.pause(false);
            }
        };
        ctx.ui.onVisible((name, v) => { if (name === 'MAIN') { hold('hidden', !v); changed(); } });
        const watch = setInterval(() => {
            const online = net.online(), moving = settings.get('parkedOnly') !== false && parked.moving();
            if (moving !== S.moving) { S.moving = moving; hold('driving', moving); changed(); }
            if (online !== S.online) { S.online = online; changed(); }
            const st = S.now && S.now.st;
            if (st && st.state === 'playing' && keep()) store.position(S.now.video.id, currentPos());
        }, 1000);
        if (watch.unref) watch.unref();
        if (ctx.app && ctx.app.on) ctx.app.on('shutdown', () => { store.flush(); link.stop(); });

        loop = ctx.loop('MAIN', 4, () => {
            const t = Date.now(), st = S.now && S.now.st;
            const moving = S.loading || (S.tab === 1 && S.typing) || (S.tab === 2 && S.now && !S.now.error && (!st || st.state === 'buffering' || st.state === 'opening' || !st.shown));
            const playing = S.tab === 2 && st && st.state === 'playing';
            // drawn on changes; while something moves 30 times a second, the position four times
            if (!dirty && !(moving && t - lastDraw >= 33) && !(playing && t - lastDraw >= 250) && t - lastDraw < 1000) return null;
            dirty = false;
            lastDraw = t;
            S.pos = S.now ? currentPos() : 0;
            const cv = ctx.canvas(1600, 520);
            ui.draw(cv, ctx.theme(), S, A, thumbs);
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
