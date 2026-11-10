'use strict';
/**
 * The whole app on this machine: the staged package (kit/tools/build.py --preview-only) runs in the kit's
 * stubbed head unit, against mock_youtube.js (this folder) and the real player tool, laid out as the renderer shows it
 * where the kit runs the screen. The test presses what a finger would (the page's targets) and checks what
 * the pages then offer; --shots <folder> also saves each page as a PNG.
 *
 *   python3 kit/tools/build.py --preview-only hrybak_youtube
 *   native/ytplay/build.sh host
 *   node test/hrybak_youtube/test_app.js [--shots <folder>] [--bin <player>] [--loader <ld.so>] [--media <folder>]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const mockYouTube = require('./mock_youtube');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const STAGE = path.join(ROOT, 'dist', 'hrybak_youtube');
const BIN = path.resolve(opt('--bin', path.join(ROOT, 'native/ytplay/out/host/hrybak-ytplay')));
const LOADER = opt('--loader', '');
const MEDIA = path.resolve(opt('--media', path.join(os.tmpdir(), 'ytplay-test-media')));
const SHOTS = opt('--shots', '');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-app-'));
const M = (f) => path.join(MEDIA, f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(ok, what) { if (!ok) throw new Error('assertion failed: ' + what); }

(async () => {
    if (!fs.existsSync(path.join(STAGE, 'source', 'javascript', 'app.js'))) { console.error('no staged app: python3 kit/tools/build.py --preview-only hrybak_youtube'); process.exit(2); }
    if (!fs.existsSync(BIN)) { console.error('no player at ' + BIN + ': native/ytplay/build.sh host'); process.exit(2); }
    if (SHOTS && !fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS);
    const mock = await mockYouTube.start({ media: { video: M('video720.mp4'), audio: M('audio.m4a'), muxed: M('muxed360.mp4'), thumb: M('thumb.jpg') } });
    const sock = path.join(WORK, 'ctl.sock'), frames = '/dev/shm/mgu-video-yt-app-test-' + process.pid;
    const conf = path.join(WORK, 'asound.conf'), raw = path.join(WORK, 'audio.raw');
    // two devices as a head unit names them: one for media, one of the car's own voices (never offered)
    fs.writeFileSync(conf, 'pcm.ytnull { type null }\n'
        + 'pcm.CarMedia_48_STEREO { type file slave.pcm "ytnull" file "' + raw + '" format "raw" hint { show on description "media" } }\n'
        + 'pcm.Phone_Call_MONO { type null hint { show on description "phone" } }\n');
    const tool = spawn(LOADER || BIN, (LOADER ? [BIN] : []).concat(['--socket', sock, '--frames', frames, '--uid', '0']),
        { env: Object.assign({}, process.env, { ALSA_CONFIG_PATH: conf }), stdio: ['ignore', 'ignore', 'pipe'] });
    const toolLog = [];
    tool.stderr.on('data', (d) => toolLog.push(String(d)));
    for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(20);

    // the app's surroundings: the mock for YouTube, the tool's socket, a renderer stream nobody reads
    Object.assign(process.env, {
        HRYBAK_YT_API: mock.base + '/youtubei/v1/', HRYBAK_YT_SUGGEST: mock.base + '/complete/search', HRYBAK_YT_THUMBS: mock.base + '/vi/',
        YTPLAY_SOCKET: sock, MGU_RENDERD_FILE: path.join(WORK, 'stream.bin'),
    });
    const kit = path.join(STAGE, 'source', 'javascript', 'kit');
    const { headUnit } = require(path.join(ROOT, 'kit', 'tools', 'hu-stub'));
    const logs = [];
    const log = { info: (m) => logs.push('info ' + m), warn: (m) => logs.push('warn ' + m), error: (m) => logs.push('error ' + (m && m.stack || m)), debug() {} };
    const hu = headUnit(STAGE, { dataDir: WORK, fresh: true, sets: { demo: undefined }, image: async () => {}, log });
    const realLog = console.log;
    console.log = () => {};                 // (the stub prints every HMI call)
    hu.start();
    await sleep(300);
    // the renderer the kit runs the screen on: mgu-render/1 with touch, the controller gate and video
    const gpu = hu.display.gpu;
    gpu.touch = true;
    gpu.info = { touch: true, controller: true, frontGate: true, pixmaps: true, video: true };
    hu.display._place();
    console.log = realLog;

    const { play } = require(path.join(kit, 'record'));
    const { Canvas } = require(path.join(kit, 'canvas'));
    let shotN = 0;
    /** Draw the page as it is now; returns its targets by key. */
    const draw = async (name) => {
        console.log = () => {};
        try { await hu.loopFn(); await sleep(20); await hu.loopFn(); } finally { console.log = realLog; }
        const targets = {};
        (hu.display.pageTargets || []).forEach((t) => { targets[t.key] = t; });
        if (SHOTS && name) {
            // the page as recorded (the header the kit draws in screen pixels is left out by the software player)
            const cv = new Canvas(1600, 520 + (hu.display.place.extra || 0));
            play(hu.display.last.frame.words(), cv);
            fs.writeFileSync(path.join(SHOTS, ('0' + (++shotN)).slice(-2) + '-' + name + '.png'), cv.png());
        }
        return targets;
    };
    const tap = async (key) => {
        const t = (await draw())[key];
        assert(t, 'something to press named ' + key + ' (there: ' + Object.keys(await draw()).join(' ') + ')');
        await t.run();
        await sleep(30);
    };
    const until = async (test, ms, what) => {
        const t0 = Date.now();
        for (;;) {
            const t = await draw();
            if (test(t)) return t;
            if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what + '; there: ' + Object.keys(t).join(' ') + '\n' + logs.slice(-12).join('\n') + '\n' + toolLog.slice(-6).join(''));
            await sleep(60);
        }
    };
    const keys = (t, prefix) => Object.keys(t).filter((k) => k.indexOf(prefix) === 0);

    let failed = 0;
    try {
        assert(hu.display.own(), 'the kit runs the screen');
        assert(hu.display.place.extra > 20, 'the page reaches below 520: ' + hu.display.place.extra);

        // a first start: nothing watched, so the Search page with its keyboard
        let t = await draw('search-empty');
        assert(t.kq && t.kgo && t.kspace && t.kdel && keys(t, 'k').length === 44, 'the keyboard: ' + keys(t, 'k').length + ' keys');
        for (const ch of 'road') await tap('k' + ch);
        t = await until((x) => keys(x, 'sug').length === 4, 3000, 'suggestions');
        await draw('search-typing');
        assert(mock.requests.filter((q) => q.path === '/complete/search').pop().query.indexOf('q=road') > 0, 'suggestions asked for what was typed');
        await tap('kdel');
        await tap('kd');
        await tap('kgo');
        t = await until((x) => keys(x, 'r').length >= 8, 5000, 'results');
        assert(mock.requests.filter((q) => q.path === '/youtubei/v1/search').pop().body.query === 'road', 'searched for the text');
        assert(t.query, 'the query field can be tapped to type again');
        await until(() => mock.requests.filter((q) => /^\/vi\//.test(q.path)).length >= 8, 5000, 'thumbnails fetched');
        await sleep(400);
        await draw('search-results');
        // scrolling down brings the next page of results
        const display = hu.display;
        assert(display.pageScroll && display.pageScroll.bar, 'the results scroll');
        for (let i = 0; i < 12; i++) { display.onScroll(300); await sleep(10); }
        await until(() => mock.requests.filter((q) => q.path === '/youtubei/v1/search').length >= 2, 4000, 'the next page asked for');
        await sleep(300);
        await draw('search-results-scrolled');
        for (let i = 0; i < 40; i++) display.onScroll(-300);

        // a video: resolved, downloaded, decoded; the Playing page follows it
        const first = keys(await draw(), 'r')[1];
        await tap(first);
        t = await until((x) => x.playpause && x.picture && keys(x, 'rel').length >= 2, 6000, 'the Playing page with related videos');
        await until(() => { const b = fs.existsSync(frames) && fs.readFileSync(frames); return b && b.length > 64 && b.readUInt32LE(16) > 20; }, 8000, 'pictures in the frame file');
        await sleep(500);
        await draw('playing');
        const head = fs.readFileSync(frames);
        assert(head.readUInt32LE(8) === 1280 && head.readUInt32LE(12) === 720, 'the 720p picture: ' + head.readUInt32LE(8) + 'x' + head.readUInt32LE(12));
        assert(mock.requests.some((q) => q.path === '/videoplayback' && /itag=136/.test(q.query)), 'downloaded the 720p H.264 file');
        assert(!mock.requests.some((q) => q.path === '/videoplayback' && /f=audio/.test(q.query)), 'no sound file while sound is off');
        // pause stops the pictures, play starts them again
        await tap('playpause');
        await sleep(500);
        const seq1 = fs.readFileSync(frames).readUInt32LE(16);
        await sleep(500);
        assert(fs.readFileSync(frames).readUInt32LE(16) === seq1, 'paused');
        await draw('paused');
        await tap('playpause');
        await until(() => fs.readFileSync(frames).readUInt32LE(16) > seq1 + 5, 4000, 'playing again');
        // +10 s asks the server for bytes further on
        const before = mock.requests.length;
        await tap('fwd10');
        await until(() => mock.requests.slice(before).some((q) => q.path === '/videoplayback' && /^bytes=[1-9]\d{5,}/.test(q.range)), 5000, 'a download from further on after +10 s');

        // sound: the devices offered leave out the car's own voices; the one that takes the tone is used
        await tap('sound');
        t = await until((x) => x.dev0, 3000, 'the sound devices');
        assert(keys(t, 'dev').length === 1, 'only the media device is offered, not the phone line: ' + keys(t, 'dev').length);
        await draw('sound-setup');
        await tap('dev0');
        await until(() => mock.requests.some((q) => q.path === '/videoplayback' && /f=audio/.test(q.query)), 9000, 'the sound file downloaded once a device is picked');
        await until(() => fs.existsSync(raw) && fs.statSync(raw).size > 48000 * 4 * 3, 9000, 'the tone and the video\'s sound written to the device');
        await draw('sound-on');
        await tap('snddone');
        await sleep(300);
        await draw('playing-with-sound');

        // a related video; the first one is then in the history, with where it stopped
        const rel = keys(await draw(), 'rel')[0];
        await tap(rel);
        await until(() => mock.requests.filter((q) => q.path === '/youtubei/v1/player').length >= 3, 5000, 'the related video asked for');
        await sleep(800);
        hu.display.onTab(0);
        t = await until((x) => keys(x, 'h').length === 2 && x.recent0, 3000, 'Home with two watched videos and the search');
        await sleep(600);
        await draw('home');
        // a video YouTube will not play says why, with a way to try again
        mock.behave.botcheck = ['ANDROID_VR', 'ANDROID', 'IOS'];
        await tap(keys(t, 'h')[1]);
        await until((x) => x.retryplay, 5000, 'the refusal with Try again');
        await draw('refused');
        mock.behave.botcheck = ['ANDROID_VR'];
        await tap('retryplay');
        await until((x) => x.playpause && !x.retryplay, 5000, 'playing after Try again');
        // offline: searching says so
        hu.display.onTab(1);
        await tap('query');
        mock.behave.down = true;
        await tap('kgo');
        await until((x) => x.retry, 5000, 'the search error with Try again');
        await draw('search-failed');
        mock.behave.down = false;

        const errors = logs.filter((l) => /^error /.test(l));
        assert(!errors.length, 'no errors in the app\'s log:\n' + errors.join('\n'));
        console.log('ok   the app: search, results, play, pause, seek, sound, related, history, refusals' + (SHOTS ? ' (' + shotN + ' pictures in ' + SHOTS + ')' : ''));
    } catch (e) {
        failed = 1;
        console.log('FAIL ' + (e && e.stack || e));
        if (args.indexOf('--log') >= 0) console.log(logs.join('\n'));
    }
    tool.kill('SIGTERM');
    await mock.close();
    try { fs.readdirSync(WORK).forEach((f) => fs.unlinkSync(path.join(WORK, f))); fs.rmdirSync(WORK); } catch (e) { /* leftovers */ }
    process.exit(failed);
})();
