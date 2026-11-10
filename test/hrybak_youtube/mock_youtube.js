'use strict';
/**
 * A stand-in for YouTube on this machine, for the tests and for trying the app without a car: it answers
 * the requests apps/hrybak_youtube/youtube.js makes, in the shapes YouTube's answers had when they were
 * read (November 2026), and serves local media files as a video server does (byte ranges, a redirect to
 * "another server", refusals).
 *
 *   const mock = await start({ media: { video: 'v.mp4', audio: 'a.m4a', muxed: 'm.mp4', thumb: 't.jpg' } });
 *   new YouTube({ net, api: mock.base + '/youtubei/v1/', suggestUrl: mock.base + '/complete/search', thumbBase: mock.base + '/vi/' })
 *   mock.behave = { botcheck: ['ANDROID_VR'], refuse: ['ANDROID'], ... }      (below)
 *   mock.requests: [{ path, client, range }]
 *
 * Node 8.
 */
const fs = require('fs');
const http = require('http');
const { URL } = require('url');

const WORDS = ['Road trip', 'Mountain pass', 'City at night', 'Coastal drive', 'Engine sound', 'Track day', 'Winter roads', 'Old town walk',
    'Żubry w Białowieży', 'Zażółć gęślą jaźń', 'Über die Alpen', 'Пробег по трассе', 'Garage build', 'How it works', 'Full review', 'Onboard lap'];
const CHANNELS = ['Drive & Listen', 'Alpine Roads', 'Night Cruise', 'Kanał Testowy', 'Werkstatt TV'];

/** Video n of the catalog (the same for every run). */
function video(n) {
    const id = ('mock' + ('0000000' + n).slice(-7));
    const secs = 95 + (n * 137) % 3400;
    const length = (secs >= 3600 ? Math.floor(secs / 3600) + ':' + ('0' + Math.floor(secs % 3600 / 60)).slice(-2) : String(Math.floor(secs / 60))) + ':' + ('0' + secs % 60).slice(-2);
    return {
        id, secs, length, title: WORDS[n % WORDS.length] + ' ' + (n + 1) + (n % 4 === 0 ? ' | 4K' : ''), author: CHANNELS[n % CHANNELS.length],
        views: (1 + (n * 7919) % 900) + 'K views', age: (1 + n % 11) + ' months ago', live: n % 23 === 22,
    };
}
const idNumber = (id) => (/^mock(\d{7})$/.test(id) ? Number(id.slice(4)) : -1);

function videoRenderer(v) {
    const r = {
        videoId: v.id, thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/' + v.id + '/hq720.jpg', width: 360, height: 202 }] },
        title: { runs: [{ text: v.title }] }, longBylineText: { runs: [{ text: v.author }] }, ownerText: { runs: [{ text: v.author }] },
        shortBylineText: { runs: [{ text: v.author }] }, trackingParams: 'x', showActionMenu: false,
    };
    if (v.live) {
        r.badges = [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW', label: 'LIVE' } }];
        r.viewCountText = { runs: [{ text: '312' }, { text: ' watching' }] };
        r.shortViewCountText = { runs: [{ text: '312' }, { text: ' watching' }] };
    } else {
        r.publishedTimeText = { simpleText: v.age };
        r.lengthText = { simpleText: v.length };
        r.viewCountText = { simpleText: v.views };
        r.shortViewCountText = { simpleText: v.views };
    }
    return { videoRenderer: r };
}

function lockup(v) {
    return {
        lockupViewModel: {
            contentImage: { thumbnailViewModel: {
                image: { sources: [{ url: 'https://i.ytimg.com/vi/' + v.id + '/hqdefault.jpg', width: 168, height: 94 }] },
                overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: v.live ? 'LIVE' : v.length, badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT' } }] } }],
            } },
            metadata: { lockupMetadataViewModel: {
                title: { content: v.title },
                metadata: { contentMetadataViewModel: { metadataRows: [
                    { metadataParts: [{ text: { content: v.author } }] },
                    { metadataParts: [{ text: { content: v.views.replace(' views', '') } }, { text: { content: v.age } }] },
                ] } },
            } },
            contentId: v.id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
        },
    };
}

function start(o) {
    o = o || {};
    const media = o.media || {};
    const size = (k) => (media[k] ? fs.statSync(media[k]).size : 0);
    const mock = {
        requests: [],
        /*
         * botcheck: clients YouTube asks to sign in; refuse: clients whose files the video server will not
         * serve (403); muxedOnly: clients that get the one 360p file only; redirect: the video server sends
         * every first request on to "another server"; expired: every file request is refused;
         * slow: ms between 16 KiB pieces of a file; down: every API request fails (500).
         */
        behave: Object.assign({ botcheck: ['ANDROID_VR'], refuse: [], muxedOnly: [], redirect: true, expired: false, slow: 0, down: false }, o.behave || {}),
    };

    function playerAnswer(body) {
        const client = (((body.context || {}).client || {}).clientName) || '';
        const n = idNumber(body.videoId);
        if (n < 0) return { playabilityStatus: { status: 'ERROR', reason: 'This video is unavailable' } };
        const v = video(n);
        if (mock.behave.botcheck.indexOf(client) >= 0) return { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } };
        const details = { videoId: v.id, title: v.title, lengthSeconds: String(v.secs), author: v.author, isLiveContent: v.live, isLive: v.live || undefined };
        if (v.live) return { playabilityStatus: { status: 'OK' }, videoDetails: details, streamingData: { expiresInSeconds: '21540', hlsManifestUrl: mock.base + '/hls' } };
        const url = (f, itag) => mock.base + '/videoplayback?f=' + f + '&itag=' + itag + '&c=' + client + '&id=' + v.id + (mock.behave.redirect ? '&hop=1' : '');
        const formats = media.muxed ? [{ itag: 18, url: url('muxed', 18), mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', bitrate: 359607, width: 640, height: 360, fps: 30, qualityLabel: '360p' }] : [];
        const adaptive = mock.behave.muxedOnly.indexOf(client) >= 0 ? [] : [
            // as YouTube lists them: every picture size in three codecs, sound in several, some only "protected"
            { itag: 399, url: url('video', 399), mimeType: 'video/mp4; codecs="av01.0.09M.08"', bitrate: 4492945, width: 1920, height: 1080, fps: 60, contentLength: '124386876' },
            { itag: 299, url: url('video', 299), mimeType: 'video/mp4; codecs="avc1.64002A"', bitrate: 6933529, width: 1920, height: 1080, fps: 60, contentLength: String(size('video')) },
            { itag: 303, url: url('video', 303), mimeType: 'video/webm; codecs="vp9"', bitrate: 4652291, width: 1920, height: 1080, fps: 60, contentLength: '168736189' },
            { itag: 136, url: url('video', 136), mimeType: 'video/mp4; codecs="avc1.4D401F"', bitrate: 2206005, width: 1280, height: 720, fps: 30, contentLength: String(size('video')) },
            { itag: 247, url: url('video', 247), mimeType: 'video/webm; codecs="vp9"', bitrate: 1766749, width: 1280, height: 720, fps: 30, contentLength: '112676322' },
            { itag: 135, url: url('video', 135), mimeType: 'video/mp4; codecs="avc1.4D401F"', bitrate: 1098569, width: 854, height: 480, fps: 30, contentLength: String(size('video')) },
            { itag: 134, url: url('video', 134), mimeType: 'video/mp4; codecs="avc1.4D401E"', bitrate: 643723, width: 640, height: 360, fps: 30, contentLength: String(size('video')) },
            { itag: 137, signatureCipher: 's=abc&sp=sig&url=https%3A%2F%2Fexample.invalid', mimeType: 'video/mp4; codecs="avc1.640028"', bitrate: 4000000, width: 1920, height: 1080, fps: 30, contentLength: '1' },
            { itag: 139, url: url('audio', 139), mimeType: 'audio/mp4; codecs="mp4a.40.5"', bitrate: 50452, contentLength: String(size('audio')), audioQuality: 'AUDIO_QUALITY_LOW' },
            { itag: 140, url: url('audio', 140) + '&drc=1', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 131003, contentLength: String(size('audio')), isDrc: true },
            { itag: 140, url: url('audio', 140), mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130992, contentLength: String(size('audio')), audioQuality: 'AUDIO_QUALITY_MEDIUM' },
            { itag: 251, url: url('audio', 251), mimeType: 'audio/webm; codecs="opus"', bitrate: 143452, contentLength: '10202210' },
            { itag: 328, url: url('audio', 328), mimeType: 'audio/mp4; codecs="ec-3"', bitrate: 385274, contentLength: '30468811' },
        ];
        return { responseContext: { visitorData: 'MOCKVISITOR%3D%3D' }, playabilityStatus: { status: 'OK' }, videoDetails: details, streamingData: { expiresInSeconds: '21540', formats, adaptiveFormats: adaptive } };
    }

    function api(path, body, res) {
        const send = (j) => { const b = Buffer.from(JSON.stringify(j)); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': b.length }); res.end(b); };
        if (mock.behave.down) { res.writeHead(500); res.end('down'); return; }
        if (path === '/youtubei/v1/search') {
            const from = body.continuation ? Number(String(body.continuation).replace('PAGE', '')) || 0 : 0;
            if (!body.continuation && /^nothing/.test(body.query || '')) { send({ responseContext: { visitorData: 'MOCKVISITOR%3D%3D' }, contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ backgroundPromoRenderer: { title: { runs: [{ text: 'No results found' }] } } }] } }] } } } } }); return; }
            const items = [];
            for (let i = from; i < from + 20; i++) items.push(videoRenderer(video(i)));
            const cont = { continuationItemRenderer: { trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN', continuationEndpoint: { continuationCommand: { token: 'PAGE' + (from + 20), request: 'CONTINUATION_REQUEST_TYPE_SEARCH' } } } };
            if (body.continuation) send({ responseContext: { visitorData: 'MOCKVISITOR%3D%3D' }, onResponseReceivedCommands: [{ appendContinuationItemsAction: { continuationItems: [{ itemSectionRenderer: { contents: items } }, cont] } }] });
            else send({ responseContext: { visitorData: 'MOCKVISITOR%3D%3D' }, estimatedResults: '1035', contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }, cont] } } } } });
        } else if (path === '/youtubei/v1/next') {
            const n = Math.max(0, idNumber(body.videoId));
            const list = [];
            for (let i = 1; i <= 20; i++) list.push(lockup(video(n + i)));
            send({ contents: { twoColumnWatchNextResults: { secondaryResults: { secondaryResults: { results: list } } } } });
        } else if (path === '/youtubei/v1/player') send(playerAnswer(body));
        else { res.writeHead(404); res.end(); }
    }

    function file(u, req, res) {
        const f = u.searchParams.get('f'), client = u.searchParams.get('c');
        const p = media[f];
        if (!p || mock.behave.expired || mock.behave.refuse.indexOf(client) >= 0) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
        if (u.searchParams.get('hop')) {
            u.searchParams.delete('hop');
            u.searchParams.set('redirect_counter', '1');
            res.writeHead(302, { Location: mock.base + u.pathname + '?' + u.searchParams.toString() });
            res.end();
            return;
        }
        const total = fs.statSync(p).size;
        const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        let a = 0, b = total - 1, status = 200;
        if (m) {
            a = Number(m[1]);
            b = m[2] === '' ? total - 1 : Math.min(total - 1, Number(m[2]));
            status = 206;
            if (a >= total) { res.writeHead(416, { 'Content-Range': 'bytes */' + total }); res.end(); return; }
        }
        const head = { 'Content-Type': f === 'audio' ? 'audio/mp4' : 'video/mp4', 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' };
        if (status === 206) head['Content-Range'] = 'bytes ' + a + '-' + b + '/' + total;
        res.writeHead(status, head);
        if (!mock.behave.slow) { fs.createReadStream(p, { start: a, end: b }).pipe(res); return; }
        const fd = fs.openSync(p, 'r');
        let at = a;
        const step = () => {
            if (res.destroyed || at > b) { fs.closeSync(fd); if (!res.destroyed) res.end(); return; }
            const n = Math.min(16384, b - at + 1), buf = Buffer.alloc(n);
            fs.readSync(fd, buf, 0, n, at);
            at += n;
            res.write(buf);
            setTimeout(step, mock.behave.slow);
        };
        step();
    }

    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const chunks = [];
        req.on('data', (d) => chunks.push(d));
        req.on('end', () => {
            let body = {};
            try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch (e) { /* not JSON */ }
            mock.requests.push({
                path: u.pathname, method: req.method, client: ((body.context || {}).client || {}).clientName || u.searchParams.get('c') || '', range: req.headers.range || '',
                ua: req.headers['user-agent'] || '', visitor: req.headers['x-goog-visitor-id'] || '', body, query: u.search,
            });
            if (req.method === 'POST') api(u.pathname, body, res);
            else if (u.pathname === '/videoplayback') file(u, req, res);
            else if (u.pathname === '/complete/search') {
                const q = u.searchParams.get('q') || '';
                const b = Buffer.from(JSON.stringify([q, [q + ' review', q + ' sound', q + ' 4k', q + ' żółw'], [], {}]));
                res.writeHead(200, { 'Content-Type': 'text/javascript; charset=UTF-8', 'Content-Length': b.length });
                res.end(b);
            } else if (/^\/vi\/[\w-]{11}\/mqdefault\.jpg$/.test(u.pathname) && media.thumb) {
                res.writeHead(200, { 'Content-Type': 'image/jpeg' });
                fs.createReadStream(media.thumb).pipe(res);
            } else { res.writeHead(404); res.end(); }
        });
    });
    // (Node 8's server.close() waits for kept-alive connections: they are ended here)
    const sockets = new Set();
    server.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)); });
    return new Promise((resolve) => {
        server.listen(o.port || 0, '127.0.0.1', () => {
            mock.port = server.address().port;
            mock.base = 'http://127.0.0.1:' + mock.port;
            mock.close = () => new Promise((r) => { server.close(r); sockets.forEach((c) => c.destroy()); });
            resolve(mock);
        });
    });
}

module.exports = { start, video };

if (require.main === module) {
    const dir = process.argv[2] || '.';
    const p = require('path');
    start({ port: Number(process.env.PORT) || 8787, media: { video: p.join(dir, 'video720.mp4'), audio: p.join(dir, 'audio.m4a'), muxed: p.join(dir, 'muxed360.mp4'), thumb: p.join(dir, 'thumb.jpg') } })
        .then((m) => console.log('mock YouTube at ' + m.base));
}
