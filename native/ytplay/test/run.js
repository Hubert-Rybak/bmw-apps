'use strict';
/**
 * Tests of the player tool with the app's own client (apps/hrybak_youtube/player.js), on this machine:
 *
 *   native/ytplay/build.sh host
 *   node native/ytplay/test/run.js [--bin <player>] [--media <folder>] [--keep] [--only <name>]
 *
 * The media are made with the system's ffmpeg into --media (default: a folder under the system's temp
 * folder) when they are not there. Sound goes to an ALSA "file" device, so what the player played can be
 * measured. Each test starts its own player on its own socket and frame file.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { PlayerLink, fileSource } = require('../../../apps/hrybak_youtube/player');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const ROOT = path.resolve(__dirname, '..', '..', '..');
const BIN = path.resolve(opt('--bin', path.join(ROOT, 'native/ytplay/out/host/hrybak-ytplay')));
const LOADER = opt('--loader', '');
const MEDIA = path.resolve(opt('--media', path.join(os.tmpdir(), 'ytplay-test-media')));
const ONLY = opt('--only', '');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ytplay-test-'));
const quiet = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- media ---- */
function ffmpeg(a) {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y'].concat(a), { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ffmpeg failed: ' + a.join(' '));
}
function media() {
    if (!fs.existsSync(MEDIA)) fs.mkdirSync(MEDIA);      // (no { recursive } in Node 8)
    const need = (f, a) => { if (!fs.existsSync(path.join(MEDIA, f))) ffmpeg(a.concat([path.join(MEDIA, f)])); };
    const frag = ['-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof+global_sidx'];
    need('muxed360.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
        '-t', '20', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-movflags', '+faststart']);
    need('video720.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '20', '-c:v', 'libx264', '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p', '-g', '60', '-an'].concat(frag));
    need('audio.m4a', ['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100', '-t', '20', '-c:a', 'aac', '-b:a', '128k', '-ac', '2'].concat(frag));
    need('vp9opus.webm', ['-f', 'lavfi', '-i', 'testsrc2=size=854x480:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
        '-t', '12', '-c:v', 'libvpx-vp9', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-b:a', '96k']);
    need('thumb.jpg', ['-f', 'lavfi', '-i', 'testsrc2=size=480x360:rate=1', '-frames:v', '1']);
    need('thumb.webp', ['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=1', '-frames:v', '1', '-c:v', 'libwebp']);
}
const M = (f) => path.join(MEDIA, f);

/* ---- one player per test ---- */
let seq = 0;
async function withPlayer(fn, extra) {
    const id = process.pid + '-' + (++seq);
    const sock = path.join(WORK, 'ctl-' + id + '.sock');
    const frames = '/dev/shm/mgu-video-ytplay-test-' + id;
    const raw = path.join(WORK, 'audio-' + id + '.raw');
    const conf = path.join(WORK, 'asound-' + id + '.conf');
    fs.writeFileSync(conf, 'pcm.ytnull { type null }\npcm.ytfile { type file slave.pcm "ytnull" file "' + raw + '" format "raw" }\n');
    const cmd = LOADER ? LOADER : BIN;
    const argv = (LOADER ? [BIN] : []).concat(['--socket', sock, '--frames', frames, '--uid', '0']).concat((extra && extra.args) || []);
    const log = [];
    const child = spawn(cmd, argv, { env: Object.assign({}, process.env, { ALSA_CONFIG_PATH: conf }), stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => log.push(String(d)));
    let exited = null;
    child.on('exit', (code, sig) => { exited = { code, sig }; });
    for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(20);
    const link = new PlayerLink(quiet, { socket: sock });
    const states = [];
    link.on('state', (s) => states.push(s));
    const ready = new Promise((res) => link.once('ready', res));
    link.start();
    const hello = await Promise.race([ready, sleep(3000).then(() => null)]);
    const ctx = {
        link, hello, states, sock, frames, raw, log, child,
        exited: () => exited,
        last: () => states[states.length - 1] || {},
        /** The state as it is now (asked for, not the last one sent). */
        async fresh() {
            const n = states.length;
            link.poll();
            for (let i = 0; i < 80 && states.length === n; i++) await sleep(10);
            return states[states.length - 1] || {};
        },
        /** Wait until the newest state passes test (or fail after ms). */
        async until(test, ms, what) {
            const t0 = Date.now();
            while (Date.now() - t0 < ms) {
                const s = states[states.length - 1];
                if (s && test(s)) return s;
                await sleep(25);
            }
            throw new Error('timeout waiting for ' + what + '; last state ' + JSON.stringify(states[states.length - 1]) + '\n' + log.join(''));
        },
        head() {
            const b = Buffer.alloc(64);
            const fd = fs.openSync(frames, 'r');
            fs.readSync(fd, b, 0, 64, 0);
            const size = fs.fstatSync(fd).size;
            fs.closeSync(fd);
            return {
                magic: b.readUInt32LE(0), version: b.readUInt32LE(4), w: b.readUInt32LE(8), h: b.readUInt32LE(12), seq: b.readUInt32LE(16),
                slot: b.readUInt32LE(20), nslot: b.readUInt32LE(24), matrix: b.readUInt32LE(28), range: b.readUInt32LE(32), size,
            };
        },
        /** The newest frame's planes. */
        frame() {
            const h = ctx.head(), n = h.w * h.h * 3 / 2, b = Buffer.alloc(n);
            const fd = fs.openSync(frames, 'r');
            fs.readSync(fd, b, 0, n, 64 + h.slot * n);
            fs.closeSync(fd);
            return { w: h.w, h: h.h, data: b };
        },
    };
    try {
        if (!hello) throw new Error('the player did not answer: ' + log.join(''));
        await fn(ctx);
        if (exited) throw new Error('the player exited: ' + JSON.stringify(exited) + '\n' + log.join(''));
    } finally {
        link.stop();
        child.kill('SIGTERM');
        for (let i = 0; i < 100 && !exited; i++) await sleep(20);
        if (!exited) child.kill('SIGKILL');
    }
    return ctx;
}

function assert(ok, what) { if (!ok) throw new Error('assertion failed: ' + what); }
function near(a, b, tol, what) { assert(Math.abs(a - b) <= tol, what + ': ' + a + ' not within ' + tol + ' of ' + b); }
/** Mean of a plane's bytes in a rect. */
function mean(buf, stride, x, y, w, h) {
    let s = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) s += buf[(y + j) * stride + x + i];
    return s / (w * h);
}

/** A source that goes through fn(stream, off) first: slow, cut short ... */
function wrapped(file, fn) {
    const src = fileSource(file);
    return { size: src.size, open: (off) => src.open(off).then((g) => ({ stream: fn(g.stream, off), size: g.size })) };
}

const tests = {
    async hello() {
        await withPlayer(async (p) => {
            assert(p.hello.proto === 1, 'protocol 1');
            assert(/^\d+\.\d+\.\d+$/.test(p.hello.version), 'a version');
            assert(p.hello.video === p.frames, 'names its frame file');
            const h = p.head();
            assert(h.magic === 0 && h.size === 64, 'an empty frame file before anything plays');
            assert((fs.statSync(p.sock).mode & 0o777) === 0o666 || (fs.statSync(p.sock).mode & 0o777) === 0o660, 'socket mode');
        });
    },

    async thumbnails() {
        await withPlayer(async (p) => {
            for (const f of ['thumb.jpg', 'thumb.webp']) {
                const pic = await p.link.decode(fs.readFileSync(M(f)), 256, 144);
                assert(pic.w === 256 && pic.h === 144 && pic.data.length === 256 * 144 * 4, f + ': size');
                let alpha = 0, lum = 0;
                for (let i = 0; i < pic.data.length; i += 4) { alpha += pic.data[i + 3]; lum += pic.data[i] + pic.data[i + 1] + pic.data[i + 2]; }
                assert(alpha === 255 * 256 * 144, f + ': opaque');
                assert(lum / (256 * 144 * 3) > 30, f + ': not black');
                if (args.indexOf('--keep') >= 0) fs.writeFileSync(path.join(WORK, f + '.rgba'), pic.data);
            }
            // many at once come back each to its own request
            const jpg = fs.readFileSync(M('thumb.jpg'));
            const sizes = [[64, 36], [128, 72], [320, 180], [100, 100]];
            const all = await Promise.all(sizes.map((s) => p.link.decode(jpg, s[0], s[1])));
            all.forEach((pic, i) => assert(pic.w === sizes[i][0] && pic.data.length === sizes[i][0] * sizes[i][1] * 4, 'picture ' + i));
            let failed = null;
            try { await p.link.decode(Buffer.from('this is not a picture at all'), 64, 36); } catch (e) { failed = e; }
            assert(failed && /picture/.test(failed.message), 'a file that is no picture is refused: ' + (failed && failed.message));
            const again = await p.link.decode(jpg, 64, 36);
            assert(again.w === 64, 'still answers after a refusal');
        });
    },

    async plays_muxed() {
        await withPlayer(async (p) => {
            p.link.open({ video: fileSource(M('muxed360.mp4')), muxed: true }, {});
            const s = await p.until((x) => x.state === 'playing' && x.pos > 0.5, 8000, 'playing');
            assert(s.w === 640 && s.h === 360, 'size ' + s.w + 'x' + s.h);
            near(s.dur, 20, 0.2, 'duration');
            near(s.fps, 30, 0.1, 'frame rate');
            assert(s.audio === '', 'no sound device asked for, none used');
            const pos0 = (await p.fresh()).pos, h0 = p.head(), t0 = Date.now();
            assert(h0.magic === 0x4656474d && h0.version === 1 && h0.w === 640 && h0.h === 360 && h0.nslot === 3, 'frame file header ' + JSON.stringify(h0));
            assert(h0.size === 64 + 3 * 640 * 360 * 1.5, 'frame file size');
            await sleep(2000);
            const pos1 = (await p.fresh()).pos, h1 = p.head(), dt = (Date.now() - t0) / 1000;
            near((h1.seq - h0.seq) / dt, 30, 3, 'pictures a second');
            near(pos1 - pos0, dt, 0.15, 'position follows the clock');
            assert(p.last().dropped <= 2, 'no pictures left out: ' + p.last().dropped);
            const f = p.frame();
            assert(mean(f.data, f.w, 0, 0, f.w, f.h) > 40, 'the picture is not black');
        });
    },

    async pause_seek_end() {
        await withPlayer(async (p) => {
            p.link.open({ video: fileSource(M('muxed360.mp4')), muxed: true }, {});
            await p.until((x) => x.state === 'playing' && x.pos > 0.3, 8000, 'playing');
            p.link.pause(true);
            const a = await p.until((x) => x.state === 'paused', 2000, 'paused');
            const seq = p.head().seq;
            await sleep(700);
            near((await p.fresh()).pos, a.pos, 0.06, 'position stands while paused');
            assert(p.head().seq === seq, 'no new pictures while paused');
            // a seek while paused shows the picture there and stays paused
            p.link.seek(12);
            await p.until((x) => x.state === 'paused' && x.pos >= 11.9 && x.pos < 12.3, 5000, 'paused at 12 s');
            await sleep(300);
            assert(p.head().seq > seq, 'the picture at the new place is shown');
            p.link.pause(false);
            await p.until((x) => x.state === 'playing' && x.pos > 12.5, 4000, 'playing on from 12 s');
            p.link.seek(18.5);
            await p.until((x) => x.pos >= 18.4, 4000, 'at 18.5 s');
            const e = await p.until((x) => x.state === 'ended', 6000, 'ended');
            near(e.pos, 20, 0.2, 'position at the end');
            // back from the end
            p.link.seek(3);
            await p.until((x) => x.state === 'playing' && x.pos >= 3 && x.pos < 5, 5000, 'playing again after the end');
        });
    },

    async start_position() {
        await withPlayer(async (p) => {
            p.link.open({ video: fileSource(M('muxed360.mp4')), muxed: true }, { start: 9 });
            const s = await p.until((x) => x.state === 'playing', 8000, 'playing');
            assert(s.pos >= 8.9 && s.pos < 10.5, 'starts at 9 s: ' + s.pos);
        });
    },

    async adaptive_with_sound() {
        const p = await withPlayer(async (q) => {
            q.link.open({ video: fileSource(M('video720.mp4')), audio: fileSource(M('audio.m4a')), muxed: false }, { device: 'ytfile', gain: -6 });
            const s = await q.until((x) => x.state === 'playing' && x.pos > 0.5, 8000, 'playing');
            assert(s.w === 1280 && s.h === 720, 'size');
            assert(s.audio === 'ytfile', 'sound on the device asked for: ' + JSON.stringify(s));
            const h = q.head();
            assert(h.matrix === 1, 'BT.709 for 720p');
            const pos0 = (await q.fresh()).pos, t0 = Date.now();
            await sleep(3000);
            near((await q.fresh()).pos - pos0, (Date.now() - t0) / 1000, 0.2, 'position follows the sound');
            q.link.seek(15);
            await q.until((x) => x.state === 'playing' && x.pos >= 15 && x.pos < 16.5, 5000, 'playing at 15 s');
            await q.until((x) => x.state === 'ended', 9000, 'ended');
        });
        // what went to the sound device: 16-bit stereo at 48 kHz, about as long as was played (3.5 s + 5 s), the tone at the gain asked for
        const raw = fs.readFileSync(p.raw);
        const secs = raw.length / (48000 * 4);
        assert(secs > 7 && secs < 11, 'seconds of sound written: ' + secs.toFixed(2));
        let peak = 0;
        for (let i = 48000 * 4; i < 48000 * 8; i += 2) peak = Math.max(peak, Math.abs(raw.readInt16LE(i)));
        // ffmpeg's sine source is at 1/8 of full scale; -6 dB of that
        near(peak, 32768 / 8 / 2, 600, 'tone level after the gain');
    },

    async vp9_opus() {
        await withPlayer(async (p) => {
            p.link.open({ video: fileSource(M('vp9opus.webm')), muxed: true }, { device: 'ytfile', gain: 0 });
            const s = await p.until((x) => x.state === 'playing' && x.pos > 1, 8000, 'playing');
            assert(s.w === 854 && s.h === 480 && s.audio === 'ytfile', 'VP9 picture, Opus sound: ' + JSON.stringify(s));
            assert(p.head().w === 854 && p.head().h === 480, 'frame size');
        });
    },

    async no_sound_device() {
        await withPlayer(async (p) => {
            p.link.open({ video: fileSource(M('muxed360.mp4')), muxed: true }, { device: 'no-such-device-here' });
            const s = await p.until((x) => x.state === 'playing' && x.pos > 0.5, 8000, 'playing without sound');
            assert(s.audio === '' && /no-such-device-here/.test(s.err), 'says why there is no sound: ' + JSON.stringify(s));
        });
    },

    async slow_download() {
        await withPlayer(async (p) => {
            // a third of the bit rate: play has to stop and wait again and again, and must go on each time
            const { Transform } = require('stream');
            const slow = (stream) => {
                const t = new Transform({
                    highWaterMark: 4096,
                    transform(chunk, enc, cb) {
                        let i = 0;
                        const step = () => {
                            if (i >= chunk.length) { cb(); return; }
                            this.push(chunk.slice(i, i + 4096)); i += 4096;
                            setTimeout(step, 115);
                        };
                        step();
                    },
                });
                stream.on('error', (e) => t.destroy(e));
                return stream.pipe(t);
            };
            p.link.open({ video: wrapped(M('muxed360.mp4'), slow), muxed: true }, {});
            await p.until((x) => x.state === 'playing', 15000, 'playing');
            await p.until((x) => x.state === 'buffering' && x.shown > 0, 15000, 'buffering when the download falls behind');
            const at = p.last().pos;
            await p.until((x) => x.state === 'playing' && x.pos > at + 0.2, 20000, 'playing again once there is more');
        });
    },

    async download_cut() {
        await withPlayer(async (p) => {
            // every connection ends after 300 KB: the player asks again from where it is
            const { Transform } = require('stream');
            let opens = 0;
            const cut = (stream) => {
                opens++;
                let n = 0;
                const t = new Transform({ transform(chunk, enc, cb) { n += chunk.length; if (n > 300000) { this.push(null); stream.destroy(); return; } cb(null, chunk); } });
                return stream.pipe(t);
            };
            p.link.open({ video: wrapped(M('muxed360.mp4'), cut), muxed: true }, {});
            await p.until((x) => x.state === 'playing' && x.pos > 6, 15000, 'playing past the first cuts');
            assert(opens >= 3, 'asked again after each cut: ' + opens);
        });
    },

    async not_a_video() {
        await withPlayer(async (p) => {
            const junk = path.join(WORK, 'junk.bin');
            fs.writeFileSync(junk, Buffer.alloc(200000, 0x5a));
            p.link.open({ video: fileSource(junk), muxed: true }, {});
            const s = await p.until((x) => x.state === 'error', 8000, 'an error');
            assert(s.err.length > 5, 'says what is wrong: ' + s.err);
            // and plays the next thing asked for
            p.link.open({ video: fileSource(M('muxed360.mp4')), muxed: true }, {});
            await p.until((x) => x.state === 'playing' && x.pos > 0.3, 8000, 'playing after an error');
        });
    },

    async switch_videos() {
        await withPlayer(async (p) => {
            for (let i = 0; i < 6; i++) {
                p.link.open({ video: fileSource(M(i % 2 ? 'video720.mp4' : 'muxed360.mp4')), muxed: true, hasAudio: false }, { start: i });
                await sleep(i % 3 === 0 ? 30 : 400);
            }
            const s = await p.until((x) => x.state === 'playing' && x.pos > 5.2, 8000, 'the last one playing');
            assert(s.w === 1280, 'the last video opened is the one playing');
            p.link.close();
            await sleep(300);
            assert(p.head().magic === 0, 'the frame file is empty after close');
        });
    },

    async app_disconnects() {
        await withPlayer(async (p) => {
            p.link.open({ video: fileSource(M('muxed360.mp4')), muxed: true }, {});
            await p.until((x) => x.state === 'playing', 8000, 'playing');
            p.link.stop();
            await sleep(500);
            assert(p.head().magic === 0, 'play stops when the app goes');
            // a new connection is served
            const again = new PlayerLink(quiet, { socket: p.sock });
            const hello = await new Promise((res) => { again.once('ready', res); again.start(); setTimeout(() => res(null), 3000); });
            again.stop();
            assert(hello && hello.proto === 1, 'answers the next app connection');
        });
    },

    async devices_and_tone() {
        const p = await withPlayer(async (q) => {
            const d = await q.link.devices();
            assert(d.alsa === true && Array.isArray(d.list), 'device list: ' + JSON.stringify(d));
            const t = await q.link.tone('ytfile', -20, 600);
            assert(t.ok === true && t.frames >= 28000 && t.frames <= 29000, 'tone played: ' + JSON.stringify(t));
            const bad = await q.link.tone('no-such-device-here', -20, 300);
            assert(bad.ok === false && bad.err.length > 3, 'a device that is not there says so: ' + JSON.stringify(bad));
        });
        const raw = fs.readFileSync(p.raw);
        let peak = 0;
        for (let i = 0; i < raw.length; i += 2) peak = Math.max(peak, Math.abs(raw.readInt16LE(i)));
        near(peak, 3200, 120, 'tone at -20 dB');
    },

    async drops_root() {
        if (process.getuid() !== 0) { console.log('   (skipped: not root)'); return; }
        await withPlayer(async (p) => {
            const st = fs.readFileSync('/proc/' + p.child.pid + '/status', 'utf8');
            const target = LOADER ? null : p.child.pid;
            void target;
            assert(/^Uid:\s+3931\s+3931\s+3931/m.test(st), 'runs as uid 3931 once an app has connected:\n' + st.match(/^Uid:.*$/m));
            assert(/^Gid:\s+3931\s+3931\s+3931/m.test(st), 'gid 3931');
            assert(fs.statSync(p.frames).uid === 0, 'the frame file stays root\'s (the renderer takes it from root)');
            // and still plays: the frame file was opened as root
            p.link.open({ video: fileSource(M('muxed360.mp4')), muxed: true }, {});
            await p.until((x) => x.state === 'playing' && x.pos > 0.3, 8000, 'playing as uid 3931');
            assert(p.head().seq > 3, 'pictures written');
        }, { args: ['--uid', '3931'] });
    },
};

(async () => {
    media();
    if (!fs.existsSync(BIN)) { console.error('no player at ' + BIN + ': run native/ytplay/build.sh host'); process.exit(2); }
    // the unprivileged player must reach its socket folder and the media-independent files there
    fs.chmodSync(WORK, 0o755);
    let failed = 0;
    for (const name of Object.keys(tests)) {
        if (ONLY && name !== ONLY) continue;
        const t0 = Date.now();
        try {
            await tests[name]();
            console.log('ok   ' + name + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
        } catch (e) {
            failed++;
            console.log('FAIL ' + name + ': ' + (e && e.stack || e));
        }
    }
    if (args.indexOf('--keep') < 0) { try { fs.readdirSync(WORK).forEach((f) => fs.unlinkSync(path.join(WORK, f))); fs.rmdirSync(WORK); } catch (e) { /* leftovers */ } }
    else console.log('kept ' + WORK);
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
})();
