'use strict';
/**
 * youtube.js - YouTube as the app reads it: search, search suggestions, a video's related videos, and
 * where a video's picture and sound can be downloaded.
 *
 * YouTube has no public interface for a player of its own, so this asks what YouTube's own apps ask
 * (its "youtubei" interface), as one of them. That is unofficial and YouTube changes it without notice:
 * everything here that can stop working says so in an error the app shows, and the client descriptions
 * (CLIENTS) are the part most likely to need a new number.
 *
 *   const yt = new YouTube({ net, log, hl: 'en', gl: 'PL' });
 *   yt.search('query')              -> { items: [video], more: token or null }
 *   yt.search(null, { more })       -> the next page
 *   yt.suggest('que')               -> ['query', ...]
 *   yt.related(videoId)             -> [video]
 *   yt.resolve(videoId, { maxHeight, sound, fps60 }) -> { title, author, seconds, muxed, video, audio, client }
 *
 *   video = { id, title, author, seconds, length, views, age, live, thumb }
 *   resolve's video / audio = { url, size, itag, mime, width, height, fps, headers }
 *
 * Node 8.
 */
const { NetError } = require('./net');

const API = 'https://www.youtube.com/youtubei/v1/';
const WEB_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// search results and related videos are read as the web page reads them
const WEB = { id: 1, ua: WEB_UA, client: { clientName: 'WEB', clientVersion: '2.20250312.04.00' } };
// "videos only" search filter
const FILTER_VIDEOS = 'EgIQAQ%3D%3D';

/*
 * Who to ask for a video's files, in this order. Each is one of YouTube's own apps; which of them YouTube
 * answers with files a player can download changes over time and with the connection, so each answer is
 * tried (resolve) and the first that works is kept for the next videos.
 */
const CLIENTS = [
    {
        name: 'android_vr', id: 28,
        ua: 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        client: { clientName: 'ANDROID_VR', clientVersion: '1.62.27', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' },
    },
    {
        name: 'android', id: 3,
        ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
        client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, osName: 'Android', osVersion: '11' },
    },
    {
        name: 'ios', id: 5,
        ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
        client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' },
    },
];

class YouTubeError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;       // 'unavailable', 'botcheck', 'live', 'age', 'nofiles', 'refused', 'changed'
    }
}

/* ---- reading YouTube's answers ---- */

const text = (t) => (!t ? '' : typeof t === 'string' ? t : t.simpleText != null ? t.simpleText : t.content != null ? t.content
    : Array.isArray(t.runs) ? t.runs.map((r) => r.text || '').join('') : '');

/** "1:09:25" -> 4165 */
function seconds(s) {
    if (!/^\d+(:\d{1,2}){0,2}$/.test(String(s || '').trim())) return 0;
    return String(s).trim().split(':').reduce((a, x) => a * 60 + Number(x), 0);
}

/** Every value of `key` anywhere under o, in document order. */
function findAll(o, key, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (!o || typeof o !== 'object' || depth > 24) return out;
    if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) findAll(o[i], key, out, depth + 1); return out; }
    for (const k of Object.keys(o)) {
        if (k === key) out.push(o[k]);
        else findAll(o[k], key, out, depth + 1);
    }
    return out;
}

// 320 x 180, the video's own shape
let thumbBase = 'https://i.ytimg.com/vi/';
const thumbOf = (id) => thumbBase + id + '/mqdefault.jpg';

/** A search result (the web page's videoRenderer). */
function fromVideoRenderer(v) {
    if (!v || !/^[\w-]{11}$/.test(v.videoId || '')) return null;
    const live = (v.badges || []).some((b) => /LIVE/.test((b.metadataBadgeRenderer || {}).style || '')) || (!v.lengthText && !!v.viewCountText && /watching/i.test(text(v.viewCountText)));
    const length = text(v.lengthText);
    return {
        id: v.videoId, title: text(v.title), author: text(v.ownerText) || text(v.longBylineText) || text(v.shortBylineText),
        seconds: seconds(length), length: live ? 'LIVE' : length, views: text(v.shortViewCountText) || text(v.viewCountText),
        age: text(v.publishedTimeText), live, thumb: thumbOf(v.videoId),
    };
}

/** A related video (the web page's lockupViewModel). */
function fromLockup(l) {
    if (!l || !/^[\w-]{11}$/.test(l.contentId || '') || (l.contentType && l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO')) return null;
    const meta = (l.metadata || {}).lockupMetadataViewModel || {};
    const rows = ((meta.metadata || {}).contentMetadataViewModel || {}).metadataRows || [];
    const parts = (row) => ((row || {}).metadataParts || []).map((p) => text(p.text)).filter(Boolean);
    const badges = findAll(l.contentImage, 'thumbnailBadgeViewModel').map((b) => b.text || '');
    const length = badges.find((b) => /^\d+(:\d{2}){1,2}$/.test(b)) || '';
    const live = badges.some((b) => /^live$/i.test(b));
    const second = parts(rows[1]);
    return {
        id: l.contentId, title: text(meta.title), author: parts(rows[0])[0] || '',
        seconds: seconds(length), length: live ? 'LIVE' : length, views: second[0] || '', age: second[1] || '', live, thumb: thumbOf(l.contentId),
    };
}

/** What can be played of a format list: H.264 picture (the unit decodes it in software) and AAC or Opus sound. */
function pickFormats(sd, o) {
    o = o || {};
    const maxH = o.maxHeight || 720;
    const usable = (f) => f && typeof f.url === 'string' && /^https?:\/\//.test(f.url) && !f.signatureCipher && !f.cipher;
    const adaptive = (sd.adaptiveFormats || []).filter(usable);
    const isH264 = (f) => /^video\/mp4/.test(f.mimeType || '') && /avc1/.test(f.mimeType || '');
    const videos = adaptive.filter((f) => isH264(f) && f.height && f.height <= maxH && (o.fps60 || !(f.fps > 32)));
    // the largest picture within the limit; of two alike, the lower bit rate
    videos.sort((a, b) => (b.height - a.height) || ((a.bitrate || 0) - (b.bitrate || 0)));
    // sound: the original language, not the "stable volume" variant, AAC at about 128 kbit/s first
    const sounds = adaptive.filter((f) => /^audio\/(mp4|webm)/.test(f.mimeType || '') && /mp4a|opus/.test(f.mimeType || '') && !f.isDrc
        && (!f.audioTrack || f.audioTrack.audioIsDefault));
    const rank = (f) => (f.itag === 140 ? 0 : f.itag === 251 ? 1 : /mp4a/.test(f.mimeType) ? 2 : 3);
    sounds.sort((a, b) => (rank(a) - rank(b)) || ((b.bitrate || 0) - (a.bitrate || 0)));
    const muxed = (sd.formats || []).filter((f) => usable(f) && /^video\/mp4/.test(f.mimeType || '') && /avc1/.test(f.mimeType || ''))
        .sort((a, b) => (b.height || 0) - (a.height || 0)).filter((f) => !f.height || f.height <= Math.max(maxH, 360));
    const shape = (f) => ({
        url: f.url, size: Number(f.contentLength) || -1, itag: f.itag, mime: f.mimeType || '', width: f.width || 0, height: f.height || 0,
        fps: f.fps || 0, bitrate: f.bitrate || 0,
    });
    if (videos.length && (!o.sound || sounds.length)) {
        return { muxed: false, video: shape(videos[0]), audio: o.sound ? shape(sounds[0]) : null };
    }
    // one file with both (360p): when no separate H.264 picture fits, or sound is wanted and there is no separate sound
    if (muxed.length) return { muxed: true, video: shape(muxed[0]), audio: null };
    if (videos.length) return { muxed: false, video: shape(videos[0]), audio: null };
    return null;
}

/** Why YouTube will not play a video, in the app's words. */
function refusal(ps) {
    const status = (ps && ps.status) || 'none';
    const reason = (ps && (ps.reason || text((ps.errorScreen || {}).playerErrorMessageRenderer && ps.errorScreen.playerErrorMessageRenderer.reason))) || '';
    if (/not a bot|confirm you.re not/i.test(reason)) return new YouTubeError('botcheck', 'YouTube asks this connection to sign in to prove it is not a bot');
    if (status === 'LOGIN_REQUIRED' && /age/i.test(reason)) return new YouTubeError('age', 'Age-restricted: YouTube wants a signed-in account');
    if (status === 'LOGIN_REQUIRED') return new YouTubeError('age', reason || 'YouTube wants a signed-in account for this video');
    if (status === 'LIVE_STREAM_OFFLINE') return new YouTubeError('live', reason || 'This live stream has not started');
    return new YouTubeError('unavailable', reason || 'YouTube does not play this video (' + status + ')');
}

class YouTube {
    constructor(o) {
        this.net = o.net;
        this.log = o.log || { info() {}, warn() {} };
        this.hl = o.hl || 'en';
        this.gl = o.gl || 'US';
        this.visitor = o.visitor || '';
        this.good = null;           // the client that last gave working files
        this.clients = o.clients || CLIENTS;
        // (the HRYBAK_YT_* variables point the app at test/hrybak_youtube/mock_youtube.js on a PC)
        this.api = o.api || process.env.HRYBAK_YT_API || API;
        this.suggestUrl = o.suggestUrl || process.env.HRYBAK_YT_SUGGEST || 'https://suggestqueries.google.com/complete/search';
        if (o.thumbBase || process.env.HRYBAK_YT_THUMBS) thumbBase = o.thumbBase || process.env.HRYBAK_YT_THUMBS;
    }

    setRegion(hl, gl) { this.hl = hl || this.hl; this.gl = gl || this.gl; }

    /** hl: the language of YouTube's own texts in the answer (default: the app's). */
    _call(endpoint, who, body, hl) {
        const client = Object.assign({ hl: hl || this.hl, gl: this.gl, utcOffsetMinutes: 0 }, who.client);
        if (this.visitor) client.visitorData = this.visitor;
        const headers = {
            'User-Agent': who.ua, 'X-YouTube-Client-Name': String(who.id), 'X-YouTube-Client-Version': who.client.clientVersion,
            Origin: 'https://www.youtube.com',
        };
        if (this.visitor) headers['X-Goog-Visitor-Id'] = this.visitor;
        return this.net.json(this.api + endpoint + '?prettyPrint=false', {
            method: 'POST', headers, body: Object.assign({ context: { client } }, body), timeout: 15000, maxBytes: 6 * 1024 * 1024,
        }).then((j) => {
            // the id YouTube gives a visitor: sent back with later requests, as its own apps do
            const v = j && j.responseContext && j.responseContext.visitorData;
            if (v && !this.visitor) this.visitor = v;
            return j;
        });
    }

    /** Search for videos; `more` continues an earlier search. */
    search(query, o) {
        const more = o && o.more;
        const body = more ? { continuation: more } : { query: String(query || '').trim(), params: FILTER_VIDEOS };
        if (!more && !body.query) return Promise.resolve({ items: [], more: null });
        return this._call('search', WEB, body).then((j) => {
            const seen = new Set();
            const items = findAll(j, 'videoRenderer').map(fromVideoRenderer).filter((v) => v && !seen.has(v.id) && seen.add(v.id));
            const next = findAll(j, 'continuationCommand').map((c) => c && c.token).filter(Boolean)[0] || null;
            if (!items.length && !more && !findAll(j, 'itemSectionRenderer').length) throw new YouTubeError('changed', 'YouTube\'s search answer has changed: the app needs an update');
            return { items, more: next };
        });
    }

    /** What YouTube would complete `q` to. */
    suggest(q) {
        q = String(q || '').trim();
        if (!q) return Promise.resolve([]);
        const url = this.suggestUrl + '?client=firefox&ds=yt&ie=utf-8&oe=utf-8&hl=' + encodeURIComponent(this.hl) + '&gl=' + encodeURIComponent(this.gl) + '&q=' + encodeURIComponent(q);
        return this.net.json(url, { headers: { 'User-Agent': WEB_UA }, timeout: 6000, maxBytes: 65536 })
            .then((j) => (Array.isArray(j) && Array.isArray(j[1]) ? j[1].filter((s) => typeof s === 'string').slice(0, 8) : []));
    }

    /** The videos YouTube shows beside a video. */
    related(videoId) {
        return this._call('next', WEB, { videoId }).then((j) => {
            const seen = new Set([videoId]);
            const out = findAll(j, 'lockupViewModel').map(fromLockup).concat(findAll(j, 'compactVideoRenderer').map(fromVideoRenderer))
                .filter((v) => v && !seen.has(v.id) && seen.add(v.id));
            return out.slice(0, 20);
        });
    }

    /** One client's answer for a video: { title, author, seconds, live, muxed, video, audio } or an error. */
    _player(who, videoId, o) {
        // in English: why YouTube refuses a video is told apart by its words (refusal)
        return this._call('player', who, { videoId, contentCheckOk: true, racyCheckOk: true }, 'en').then((j) => {
            const ps = j.playabilityStatus;
            if (!ps || ps.status !== 'OK') throw refusal(ps);
            const d = j.videoDetails || {};
            if (d.videoId && d.videoId !== videoId) throw new YouTubeError('unavailable', 'YouTube answered with another video');
            const sd = j.streamingData || {};
            if (d.isLive || (d.isLiveContent && !(sd.adaptiveFormats || []).some((f) => f.contentLength))) throw new YouTubeError('live', 'Live streams are not supported yet');
            const pick = pickFormats(sd, o);
            if (!pick) {
                const ciphered = (sd.formats || []).concat(sd.adaptiveFormats || []).some((f) => f.signatureCipher || f.cipher);
                throw new YouTubeError('nofiles', ciphered ? 'YouTube gave this client only protected files' : 'YouTube gave no file this player can decode');
            }
            const headers = { 'User-Agent': who.ua };
            pick.video.headers = headers;
            if (pick.audio) pick.audio.headers = headers;
            return Object.assign(pick, {
                title: d.title || '', author: d.author || '', seconds: Number(d.lengthSeconds) || 0, live: false, client: who.name,
                expires: Date.now() + (Number(sd.expiresInSeconds) || 3600) * 1000,
            });
        });
    }

    /** Whether a file's address really serves bytes (YouTube answers some clients with addresses that do not). */
    _serves(file) {
        return this.net.open(file.url, { headers: Object.assign({}, file.headers, { Range: 'bytes=0-1' }), timeout: 12000 }).then((r) => {
            r.stream.resume();
            if (r.status !== 206 && r.status !== 200) return false;
            const total = /\/(\d+)\s*$/.exec(r.headers['content-range'] || '');
            if (total) file.size = Number(total[1]);
            file.url = r.url;           // the server it redirected to
            return true;
        });
    }

    /**
     * Where to download a video: the first client whose answer has playable files that really download.
     * o: { maxHeight (720), sound (false: picture only), fps60 }.
     */
    resolve(videoId, o) {
        o = o || {};
        const order = this.clients.slice().sort((a, b) => (a.name === this.good ? -1 : 0) - (b.name === this.good ? -1 : 0));
        const errors = [];
        const attempt = (i) => {
            if (i >= order.length) {
                // what every client says is the video's own state (removed, private, live); otherwise the one that
                // got furthest tells most: files that would not download, then no usable files, then the bot check
                const same = errors.length && errors.every((e) => e.code === errors[0].code);
                const by = (code) => errors.find((e) => e.code === code);
                const pickErr = same ? errors[0] : by('live') || by('refused') || by('nofiles') || by('botcheck') || by('age') || errors[0];
                return Promise.reject(pickErr || new YouTubeError('nofiles', 'No way to play this video was found'));
            }
            const who = order[i];
            return this._player(who, videoId, o).then((got) => this._serves(got.video).then((ok) => {
                if (!ok) throw new YouTubeError('refused', 'YouTube\'s video server refused the download');
                this.good = who.name;
                return got;
            })).catch((e) => {
                this.log.info('youtube: ' + who.name + ' for ' + videoId + ': ' + (e && e.message));
                // no connection at all: the other clients would fail the same way
                if (e instanceof NetError && (e.code === 'offline' || e.code === 'dns' || e.code === 'tls')) throw e;
                errors.push(e);
                if (this.good === who.name) this.good = null;
                return attempt(i + 1);
            });
        };
        return attempt(0);
    }
}

module.exports = { YouTube, YouTubeError, CLIENTS, pickFormats, fromVideoRenderer, fromLockup, seconds, findAll };
