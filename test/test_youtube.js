'use strict';
/**
 * Tests of the app's YouTube and network modules against test/mock_youtube.js, and of the whole chain
 * (YouTube -> ranged download -> player tool -> frame file) with the player built by
 * native/ytplay/build.sh host:
 *
 *   node test/test_youtube.js [--bin <player>] [--loader <ld.so>] [--media <folder>] [--only <name>]
 *
 * The media come from native/ytplay/test/run.js's folder (made by it when missing). Node 8 and newer.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const { Net } = require(path.join(ROOT, 'apps/hrybak_youtube/net'));
const { YouTube, seconds, pickFormats } = require(path.join(ROOT, 'apps/hrybak_youtube/youtube'));
const { PlayerLink } = require(path.join(ROOT, 'apps/hrybak_youtube/player'));
const mockYouTube = require('./mock_youtube');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const BIN = path.resolve(opt('--bin', path.join(ROOT, 'native/ytplay/out/host/hrybak-ytplay')));
const LOADER = opt('--loader', '');
const MEDIA = path.resolve(opt('--media', path.join(os.tmpdir(), 'ytplay-test-media')));
const ONLY = opt('--only', '');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-test-'));
const M = (f) => path.join(MEDIA, f);
const quiet = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(ok, what) { if (!ok) throw new Error('assertion failed: ' + what); }
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
async function fails(p) { try { await p; } catch (e) { return e; } throw new Error('expected a failure'); }

function mockMedia() { return { video: M('video720.mp4'), audio: M('audio.m4a'), muxed: M('muxed360.mp4'), thumb: M('thumb.jpg') }; }
async function withMock(behave, fn) {
    const mock = await mockYouTube.start({ media: mockMedia(), behave });
    const net = new Net({ log: quiet, uplink: false });
    const yt = new YouTube({ net, log: quiet, hl: 'pl', gl: 'PL', api: mock.base + '/youtubei/v1/', suggestUrl: mock.base + '/complete/search', thumbBase: mock.base + '/vi/' });
    try { await fn({ mock, net, yt }); } finally { await mock.close(); }
}
function readAll(stream) {
    return new Promise((resolve, reject) => { const c = []; stream.on('data', (d) => c.push(d)); stream.on('end', () => resolve(Buffer.concat(c))); stream.on('error', reject); });
}

/** A DNS server that knows one name: enough to show names go to the lease's server. */
function dnsServer(name, ip) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        const asked = [];
        sock.on('message', (msg, from) => {
            let i = 12;
            const labels = [];
            while (msg[i]) { labels.push(msg.slice(i + 1, i + 1 + msg[i]).toString()); i += msg[i] + 1; }
            const q = labels.join('.'), qend = i + 5;
            asked.push(q);
            const head = Buffer.from(msg.slice(0, 12));
            head[2] = 0x81; head[3] = q === name ? 0x80 : 0x83;       // an answer; NXDOMAIN for any other name
            head.writeUInt16BE(q === name ? 1 : 0, 6);
            head.writeUInt16BE(0, 8); head.writeUInt16BE(0, 10);
            const parts = [head, msg.slice(12, qend)];
            if (q === name) parts.push(Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4].concat(ip.split('.').map(Number))));
            sock.send(Buffer.concat(parts), from.port, from.address);
        });
        sock.bind(0, '127.0.0.1', () => resolve({ port: sock.address().port, asked, close: () => sock.close() }));
    });
}

const tests = {
    async parses_search() {
        await withMock({}, async ({ mock, yt }) => {
            const r = await yt.search('  road trip ');
            assert(r.items.length === 20, '20 results: ' + r.items.length);
            const v = r.items[0];
            assert(v.id === 'mock0000000' && v.title === 'Road trip 1 | 4K' && v.author === 'Drive & Listen', 'first result: ' + JSON.stringify(v));
            assert(v.seconds === 95 && v.length === '1:35' && v.views === '1K views' && v.age === '1 months ago' && v.live === false, 'its numbers: ' + JSON.stringify(v));
            assert(v.thumb === mock.base + '/vi/mock0000000/mqdefault.jpg', 'thumbnail address');
            assert(r.items[8].title.indexOf('Żubry w Białowieży') === 0 && r.items[11].title.indexOf('Пробег') === 0, 'titles keep their letters');
            assert(r.items.filter((x) => x.live).length === 0, 'no live in the first 20');
            const q = mock.requests[0];
            assert(q.body.query === 'road trip' && q.body.params === 'EgIQAQ%3D%3D' && q.client === 'WEB', 'asks for videos only, as the web page: ' + JSON.stringify(q.body).slice(0, 200));
            assert(q.body.context.client.hl === 'pl' && q.body.context.client.gl === 'PL', 'in the app\'s language and region');
            // the next page, and the visitor id YouTube gave goes back with it
            const r2 = await yt.search(null, { more: r.more });
            assert(r2.items.length === 20 && r2.items[0].id === 'mock0000020', 'second page');
            assert(r2.items[2].live === true && r2.items[2].length === 'LIVE' && r2.items[2].seconds === 0, 'a live result is marked: ' + JSON.stringify(r2.items[2]));
            assert(mock.requests[1].visitor === 'MOCKVISITOR%3D%3D' && mock.requests[1].body.context.client.visitorData === 'MOCKVISITOR%3D%3D', 'visitor id sent back');
            const none = await yt.search('nothing like this');
            assert(none.items.length === 0 && none.more === null, 'a search without results is empty, not an error');
            const empty = await yt.search('   ');
            assert(empty.items.length === 0 && mock.requests.length === 3, 'an empty query asks nothing');
        });
    },

    async suggestions_and_related() {
        await withMock({}, async ({ mock, yt }) => {
            const s = await yt.suggest('żubr');
            assert(s.length === 4 && s[0] === 'żubr review' && s[3] === 'żubr żółw', 'suggestions: ' + JSON.stringify(s));
            assert(/q=%C5%BCubr/.test(mock.requests[0].query) && /hl=pl/.test(mock.requests[0].query), 'query encoded as UTF-8');
            assert((await yt.suggest('')).length === 0, 'nothing for nothing');
            const rel = await yt.related('mock0000005');
            assert(rel.length === 20 && rel[0].id === 'mock0000006', 'related: ' + rel.length);
            assert(rel[0].title === 'Winter roads 7' && rel[0].author === 'Alpine Roads' && rel[0].length === '15:17' && rel[0].seconds === 917, 'a related video: ' + JSON.stringify(rel[0]));
            assert(rel[0].views === '715K' && rel[0].age === '7 months ago', 'its views and age: ' + JSON.stringify(rel[0]));
            assert(seconds('1:09:25') === 4165 && seconds('0:07') === 7 && seconds('LIVE') === 0 && seconds('') === 0, 'lengths');
        });
    },

    async picks_formats() {
        await withMock({}, async ({ mock, yt }) => {
            const sd = (await yt.net.json(mock.base + '/youtubei/v1/player', { method: 'POST', body: { context: { client: { clientName: 'ANDROID' } }, videoId: 'mock0000001' } })).streamingData;
            const p = (o) => { const x = pickFormats(sd, o); return [x.muxed, x.video.itag, x.audio ? x.audio.itag : null]; };
            assert(String(p({ maxHeight: 720, sound: true })) === 'false,136,140', '720p H.264 with AAC: ' + p({ maxHeight: 720, sound: true }));
            assert(pickFormats(sd, { maxHeight: 720, sound: true }).audio.url.indexOf('drc') < 0, 'not the "stable volume" sound');
            assert(String(p({ maxHeight: 720 })) === 'false,136,', 'no sound wanted: picture only');
            assert(String(p({ maxHeight: 1080 })) === 'false,136,', '1080p is 60 fps only here: 720p unless 60 fps is allowed');
            assert(String(p({ maxHeight: 1080, fps60: true })) === 'false,299,', '1080p60 when allowed');
            assert(String(p({ maxHeight: 480, sound: true })) === 'false,135,140', '480p');
            assert(String(p({ maxHeight: 240, sound: true })) === 'true,18,', 'nothing as small as 240p: the 360p file with both');
            assert(pickFormats({ adaptiveFormats: sd.adaptiveFormats.filter((f) => /^video/.test(f.mimeType)), formats: sd.formats }, { maxHeight: 720, sound: true }).muxed === true,
                'no separate sound: the file with both, when sound is wanted');
            assert(pickFormats({ adaptiveFormats: [sd.adaptiveFormats[7]] }, {}) === null, 'only protected files: nothing');
        });
    },

    async resolves_with_fallback() {
        await withMock({ botcheck: ['ANDROID_VR'], refuse: [] }, async ({ mock, yt }) => {
            const r = await yt.resolve('mock0000003', { maxHeight: 720, sound: true });
            assert(r.client === 'android' && !r.muxed && r.video.itag === 136 && r.audio.itag === 140, 'the first client that works: ' + r.client);
            assert(r.title === 'Coastal drive 4' && r.seconds === 506, 'the video\'s title and length');
            assert(r.video.size === fs.statSync(M('video720.mp4')).size, 'size from the server');
            assert(/redirect_counter=1/.test(r.video.url) && !/hop=1/.test(r.video.url), 'keeps the server it was redirected to');
            assert(/^com\.google\.android\.youtube\//.test(r.video.headers['User-Agent']) && r.audio.headers === r.video.headers, 'downloads as the client that asked');
            const players = mock.requests.filter((q) => q.path === '/youtubei/v1/player');
            assert(players.map((q) => q.client).join() === 'ANDROID_VR,ANDROID', 'asked in order: ' + players.map((q) => q.client).join());
            assert(players[0].body.context.client.hl === 'en', 'player answers are asked for in English');
            assert(/^com\.google\.android\.apps\.youtube\.vr/.test(players[0].ua), 'each as itself');
            // the client that worked is asked first next time
            mock.requests.length = 0;
            await yt.resolve('mock0000004', { maxHeight: 720 });
            assert(mock.requests.filter((q) => q.path === '/youtubei/v1/player').map((q) => q.client).join() === 'ANDROID', 'the working client first');
            // its files stop downloading: on to the next, and that one is remembered
            mock.behave.refuse = ['ANDROID'];
            mock.requests.length = 0;
            const r3 = await yt.resolve('mock0000004', { maxHeight: 720 });
            assert(r3.client === 'ios', 'falls through to the next client: ' + r3.client);
            assert(yt.good === 'ios', 'remembers it');
        });
    },

    async says_why_not() {
        await withMock({ botcheck: ['ANDROID_VR', 'ANDROID', 'IOS'] }, async ({ yt }) => {
            const e = await fails(yt.resolve('mock0000001', {}));
            assert(e.code === 'botcheck', 'every client asked to sign in: ' + e.code + ' ' + e.message);
        });
        await withMock({ botcheck: ['ANDROID_VR'], refuse: ['ANDROID', 'IOS'] }, async ({ yt }) => {
            const e = await fails(yt.resolve('mock0000001', {}));
            assert(e.code === 'refused', 'files that will not download tell more than the bot check: ' + e.code);
        });
        await withMock({}, async ({ yt, mock }) => {
            let e = await fails(yt.resolve('not-a-video', {}));
            assert(e.code === 'unavailable' && /unavailable/.test(e.message), 'a video that does not exist: ' + e.message);
            e = await fails(yt.resolve('mock0000022', {}));
            assert(e.code === 'live', 'a live stream: ' + e.code + ' ' + e.message);
            mock.behave.down = true;
            e = await fails(yt.search('x'));
            assert(e.code === 'http' && e.status === 500, 'a server error: ' + e.code + ' ' + e.status);
        });
        // nothing listening at all
        const net = new Net({ log: quiet, uplink: false });
        const yt = new YouTube({ net, log: quiet, api: 'http://127.0.0.1:9/youtubei/v1/' });
        const e = await fails(yt.search('x'));
        assert(e.code === 'io', 'no server: ' + e.code + ' ' + e.message);
    },

    async ranged_download() {
        await withMock({ redirect: true }, async ({ mock, net }) => {
            const file = fs.readFileSync(M('video720.mp4'));
            const url = mock.base + '/videoplayback?f=video&c=T&hop=1';
            // the size unknown: learnt from the first range
            const src = net.rangeSource(url, { chunk: 700000, headers: { 'User-Agent': 'test-agent' } });
            const a = await src.open(0);
            const got = await readAll(a.stream);
            assert(got.length === file.length && md5(got) === md5(file), 'the whole file, in order');
            assert(src.size === file.length, 'the size is known after the first range');
            const ranges = mock.requests.filter((q) => q.range).map((q) => q.range);
            assert(ranges[0] === 'bytes=0-699999' && ranges[2] === 'bytes=700000-1399999', 'in ranges: ' + ranges.slice(0, 4).join(' '));
            assert(mock.requests.filter((q) => /hop=1/.test(q.query)).length === 1, 'the redirect is followed once, later ranges go to the server it named');
            assert(mock.requests.every((q) => q.ua === 'test-agent'), 'with the headers given');
            // from the middle
            const b = await src.open(5000001);
            const tail = await readAll(b.stream);
            assert(md5(tail) === md5(file.slice(5000001)), 'from an offset');
            // a reader that stops early stops the download
            mock.requests.length = 0;
            const c = await src.open(0);
            await new Promise((r) => c.stream.once('data', r));
            c.stream.destroy();
            await sleep(300);
            assert(mock.requests.length <= 2, 'no more ranges after the reader left: ' + mock.requests.length);
            // the server starts refusing: the stream ends in an error with the HTTP status
            const d = await src.open(0);
            mock.behave.expired = true;
            const e = await fails(readAll(d.stream));
            assert(e.code === 'http' && e.status === 403, 'a refusal mid-file: ' + e.code + ' ' + e.status);
            const e2 = await fails(src.open(0));
            assert(e2.status === 403, 'and at the start');
        });
    },

    async names_through_the_uplink() {
        await withMock({}, async ({ mock }) => {
            const dns = await dnsServer('youtube.test', '127.0.0.1');
            const lease = path.join(WORK, 'uplink.json');
            // offline: the uplink is installed and has no lease
            const net = new Net({ log: quiet, uplink: true, leaseFiles: [lease] });
            assert(net.online() === false, 'offline without a lease');
            let e = await fails(net.json('http://youtube.test:' + mock.port + '/complete/search?q=a'));
            assert(e.code === 'offline', 'says offline: ' + e.code + ' ' + e.message);
            // online: names are asked of the lease's DNS server
            fs.writeFileSync(lease, JSON.stringify({ interface: 'vethuplink', ip: '10.0.0.2', dns: ['127.0.0.1:' + dns.port], leaseSeconds: 3600 }));
            await sleep(600);
            assert(net.online() === true, 'online with a lease');
            const j = await net.json('http://youtube.test:' + mock.port + '/complete/search?q=a');
            assert(Array.isArray(j) && j[0] === 'a', 'answered through the lease\'s DNS');
            assert(dns.asked.join() === 'youtube.test', 'asked once: ' + dns.asked.join());
            await net.json('http://youtube.test:' + mock.port + '/complete/search?q=b');
            assert(dns.asked.length === 1, 'the address is kept for the next request');
            e = await fails(net.json('http://other.test:' + mock.port + '/'));
            assert(e.code === 'dns', 'a name the server does not know: ' + e.code + ' ' + e.message);
            // the lease goes: offline again
            fs.unlinkSync(lease);
            await sleep(600);
            e = await fails(net.json('http://youtube.test:' + mock.port + '/complete/search?q=c'));
            assert(e.code === 'offline', 'offline again once the lease is gone');
            dns.close();
        });
    },

    async plays_from_youtube() {
        if (!fs.existsSync(BIN)) { console.log('   (skipped: no player at ' + BIN + ')'); return; }
        await withMock({ botcheck: ['ANDROID_VR'] }, async ({ mock, net, yt }) => {
            const sock = path.join(WORK, 'ctl.sock'), frames = '/dev/shm/mgu-video-yt-test-' + process.pid;
            const raw = path.join(WORK, 'audio.raw'), conf = path.join(WORK, 'asound.conf');
            fs.writeFileSync(conf, 'pcm.ytnull { type null }\npcm.ytfile { type file slave.pcm "ytnull" file "' + raw + '" format "raw" }\n');
            const child = spawn(LOADER || BIN, (LOADER ? [BIN] : []).concat(['--socket', sock, '--frames', frames, '--uid', '0']),
                { env: Object.assign({}, process.env, { ALSA_CONFIG_PATH: conf }), stdio: ['ignore', 'ignore', 'pipe'] });
            const log = [];
            child.stderr.on('data', (d) => log.push(String(d)));
            const link = new PlayerLink(quiet, { socket: sock });
            try {
                for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(20);
                await new Promise((res, rej) => { link.once('ready', res); link.start(); setTimeout(() => rej(new Error('no player: ' + log.join(''))), 3000); });
                const until = async (test, ms, what) => {
                    const t0 = Date.now();
                    while (Date.now() - t0 < ms) { if (link.state && test(link.state)) return link.state; await sleep(25); }
                    throw new Error('timeout waiting for ' + what + ': ' + JSON.stringify(link.state) + '\n' + log.join(''));
                };
                // a thumbnail as the app gets one: downloaded, decoded by the tool
                const found = (await yt.search('road')).items[1];
                const jpg = await net.request(found.thumb);
                const pic = await link.decode(jpg.body, 256, 144);
                assert(jpg.status === 200 && pic.data.length === 256 * 144 * 4, 'thumbnail fetched and decoded');
                // the video: resolved, downloaded in ranges, picture and sound from separate files
                const r = await yt.resolve(found.id, { maxHeight: 720, sound: true });
                const media = { video: net.rangeSource(r.video.url, { size: r.video.size, headers: r.video.headers }),
                    audio: net.rangeSource(r.audio.url, { size: r.audio.size, headers: r.audio.headers }), muxed: false };
                link.open(media, { device: 'ytfile', gain: -6 });
                const s = await until((x) => x.state === 'playing' && x.pos > 1, 10000, 'playing');
                assert(s.w === 1280 && s.h === 720 && s.audio === 'ytfile', 'picture and sound: ' + JSON.stringify(s));
                link.seek(14);
                await until((x) => x.state === 'playing' && x.pos > 14.5 && x.pos < 17, 8000, 'playing after a seek');
                const ranges = mock.requests.filter((q) => q.path === '/videoplayback' && q.range && /f=video/.test(q.query)).map((q) => q.range);
                assert(ranges.some((x) => /^bytes=[1-9]\d{5,}-/.test(x)), 'the seek asked for a range further on: ' + ranges.join(' '));
                // the address expires while playing: the app is told, resolves again and goes on from where it was
                mock.behave.expired = true;
                const feedError = new Promise((res) => link.once('feederror', res));
                link.seek(3);
                const fe = await Promise.race([feedError, sleep(8000).then(() => null)]);
                assert(fe && fe.error && fe.error.status === 403, 'told that the download is refused: ' + JSON.stringify(fe && String(fe.error)));
                mock.behave.expired = false;
                const again = await yt.resolve(found.id, { maxHeight: 720, sound: true });
                link.open({ video: net.rangeSource(again.video.url, { size: again.video.size, headers: again.video.headers }), muxed: false }, { start: 3 });
                await until((x) => x.state === 'playing' && x.pos > 3.3 && x.pos < 6, 8000, 'playing again after resolving');
                // one 360p file with both, for a client that gets nothing else
                mock.behave.muxedOnly = ['ANDROID'];
                const m = await yt.resolve(found.id, { maxHeight: 720, sound: true });
                assert(m.muxed && m.video.itag === 18 && m.video.size > 0, 'the file with both: ' + JSON.stringify(m.video));
                link.open({ video: net.rangeSource(m.video.url, { size: m.video.size, headers: m.video.headers }), muxed: true }, { device: 'ytfile' });
                const s2 = await until((x) => x.state === 'playing' && x.pos > 0.5 && x.w === 640, 8000, 'the 360p file playing');
                assert(s2.audio === 'ytfile', 'with its sound');
            } finally {
                link.stop();
                child.kill('SIGTERM');
            }
        });
    },
};

(async () => {
    if (!fs.existsSync(M('video720.mp4'))) {
        const r = spawnSync(process.execPath, [path.join(ROOT, 'native/ytplay/test/run.js'), '--media', MEDIA, '--only', 'none'], { stdio: 'ignore' });
        if (!fs.existsSync(M('video720.mp4'))) { console.error('no test media in ' + MEDIA + ' (ffmpeg needed): ' + r.status); process.exit(2); }
    }
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
    try { fs.readdirSync(WORK).forEach((f) => fs.unlinkSync(path.join(WORK, f))); fs.rmdirSync(WORK); } catch (e) { /* leftovers */ }
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
})();
