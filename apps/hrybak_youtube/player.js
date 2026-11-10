'use strict';
/**
 * player.js - the app's side of hrybak-ytplay, the player tool (native/ytplay).
 *
 * The tool decodes; it has no network. This module tells it what to play and hands it the bytes: for every
 * 'need' the tool sends (stream, byte offset), one more connection to its socket carries that file from
 * there on, read from a source the caller gives:
 *
 *   source = { size: bytes or -1, open(offset) -> Promise<{ stream, size }> }     stream: a Readable
 *
 *   const link = new PlayerLink(log);
 *   link.on('ready', (hello) => ...);  link.on('gone', () => ...);
 *   link.on('state', (st) => ...);     // { sid, state, pos, dur, w, h, fps, audio, err, shown, dropped }
 *   link.start();
 *   link.open({ video, audio, muxed }, { start, device, gain });
 *
 * Node 8 (the head unit's): no syntax or API newer than that.
 */
const net = require('net');
const EventEmitter = require('events');

const SOCKET = process.env.YTPLAY_SOCKET || '/run/hrybak-ytplay/ctl.sock';
const RETRY_MS = 3000;

class PlayerLink extends EventEmitter {
    constructor(log, opts) {
        super();
        this.log = log || console;
        this.path = (opts && opts.socket) || SOCKET;
        this.sock = null;
        this.ready = false;
        this.hello = null;
        this.stopped = false;
        this.buf = Buffer.alloc(0);
        this.binary = null;          // { head, want }: a picture's bytes follow its line
        this.sid = 0;
        this.media = null;           // what plays: { video, audio, muxed }
        this.feeds = {};             // stream -> the connection carrying it
        this.pictures = new Map();   // id -> { resolve, reject }
        this.picSeq = 0;
        this.waiters = { devices: [], tone: [] };
        this.state = null;
    }

    start() {
        this.stopped = false;
        this._connect();
        return this;
    }

    stop() {
        this.stopped = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this._dropFeeds();
        if (this.sock) this.sock.destroy();
    }

    _connect() {
        if (this.stopped || this.sock) return;
        const s = net.createConnection(this.path);
        this.sock = s;
        s.on('connect', () => { s.write(JSON.stringify({ op: 'hello', app: 'hrybak_youtube', proto: 1 }) + '\n'); });
        s.on('data', (d) => this._data(d));
        s.on('error', (e) => {
            if (!this.errLogged) { this.errLogged = true; this.log.warn('player: ' + e.message); }
        });
        s.on('close', () => {
            const was = this.ready;
            this.sock = null; this.ready = false; this.hello = null; this.buf = Buffer.alloc(0); this.binary = null;
            this._dropFeeds();
            this.media = null; this.state = null;
            this.pictures.forEach((p) => p.reject(new Error('player gone')));
            this.pictures.clear();
            ['devices', 'tone'].forEach((k) => { this.waiters[k].forEach((w) => w.reject(new Error('player gone'))); this.waiters[k] = []; });
            if (was) { this.log.warn('player: connection closed'); this.emit('gone'); }
            if (!this.stopped) this.timer = setTimeout(() => { this.timer = null; this._connect(); }, RETRY_MS);
        });
    }

    _send(obj) {
        if (!this.sock || !this.ready) return false;
        this.sock.write(JSON.stringify(obj) + '\n');
        return true;
    }

    _data(d) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
        for (;;) {
            if (this.binary) {
                if (this.buf.length < this.binary.want) return;
                const px = Buffer.from(this.buf.slice(0, this.binary.want));
                this.buf = this.buf.slice(this.binary.want);
                const head = this.binary.head;
                this.binary = null;
                const p = this.pictures.get(head.id);
                if (p) { this.pictures.delete(head.id); p.resolve({ w: head.w, h: head.h, data: px }); }
                continue;
            }
            const nl = this.buf.indexOf(10);
            if (nl < 0) {
                if (this.buf.length > 65536) { this.log.warn('player: a line without end'); this.sock.destroy(); }
                return;
            }
            const line = this.buf.slice(0, nl).toString('utf8');
            this.buf = this.buf.slice(nl + 1);
            let m = null;
            try { m = JSON.parse(line); } catch (e) { this.log.warn('player: not JSON: ' + line.slice(0, 80)); continue; }
            this._event(m);
        }
    }

    _event(m) {
        if (m.ev === 'hello') {
            this.ready = true; this.errLogged = false; this.hello = m;
            this.log.info('player: connected, version ' + m.version + ', frames ' + m.video + (m.alsa ? '' : ', no ALSA library'));
            this.emit('ready', m);
        } else if (m.ev === 'need') {
            this._feed(m);
        } else if (m.ev === 'state') {
            if (m.sid !== this.sid) return;
            this.state = m;
            this.emit('state', m);
        } else if (m.ev === 'picture') {
            if (m.ok) { this.binary = { head: m, want: m.len }; return; }
            const p = this.pictures.get(m.id);
            if (p) { this.pictures.delete(m.id); p.reject(new Error(m.err || 'picture not decoded')); }
        } else if (m.ev === 'devices' || m.ev === 'tone') {
            const w = this.waiters[m.ev].shift();
            if (w) w.resolve(m);
        }
    }

    /* ---- playback ---- */

    /** Start playing media ({ video, audio, muxed }: sources); o: { start, device, gain }. Returns the session id. */
    open(media, o) {
        o = o || {};
        this._dropFeeds();
        this.sid = (this.sid % 1000000) + 1;
        this.media = media;
        this.state = null;
        const hasAudio = !!(media.muxed ? media.hasAudio !== false : media.audio);
        this._send({
            op: 'open', sid: this.sid, muxed: media.muxed ? 1 : 0, audio: hasAudio ? 1 : 0,
            vsize: media.video.size > 0 ? media.video.size : -1, asize: media.audio && media.audio.size > 0 ? media.audio.size : -1,
            start: o.start || 0, device: o.device || '', gain: typeof o.gain === 'number' ? o.gain : -30,
        });
        return this.sid;
    }

    close() {
        this._dropFeeds();
        if (this.media) this._send({ op: 'close', sid: this.sid });
        this.media = null;
        this.state = null;
    }

    pause(paused) { this._send({ op: 'pause', paused: paused ? 1 : 0 }); }
    seek(t) { this._send({ op: 'seek', t: Math.max(0, Number(t) || 0) }); }
    gain(db) { this._send({ op: 'gain', db }); }
    /** Ask for the state now (it comes as 'state'; the tool sends one twice a second by itself while playing). */
    poll() { this._send({ op: 'status' }); }

    /** The sound devices the unit offers: { alsa, list }. */
    devices() { return this._ask('devices', { op: 'devices' }); }
    /** A test tone on a device: { ok, frames, err }. */
    tone(device, db, ms) { return this._ask('tone', { op: 'tone', device, db, ms }); }

    _ask(kind, msg) {
        return new Promise((resolve, reject) => {
            if (!this._send(msg)) { reject(new Error('player not connected')); return; }
            this.waiters[kind].push({ resolve, reject });
        });
    }

    /** A JPEG or WebP file as w x h pixels (RGBA, cropped to fill): { w, h, data }. */
    decode(file, w, h) {
        return new Promise((resolve, reject) => {
            if (!this.sock || !this.ready) { reject(new Error('player not connected')); return; }
            const id = ++this.picSeq;
            this.pictures.set(id, { resolve, reject });
            this.sock.write(JSON.stringify({ op: 'decode', id, w, h, len: file.length }) + '\n');
            this.sock.write(file);
        });
    }

    /* ---- the media's bytes ---- */

    _dropFeeds() {
        Object.keys(this.feeds).forEach((k) => this._dropFeed(k));
    }

    _dropFeed(stream) {
        const f = this.feeds[stream];
        if (!f) return;
        delete this.feeds[stream];
        f.dead = true;
        if (f.src) { try { f.src.destroy(); } catch (e) { /* gone already */ } }
        if (f.conn) f.conn.destroy();
    }

    /** The tool needs `stream` from byte `off`: a new connection carries it, the one before ends. */
    _feed(m) {
        if (m.sid !== this.sid || !this.media) return;
        const source = m.stream === 'audio' ? this.media.audio : this.media.video;
        if (!source) return;
        this._dropFeed(m.stream);
        const f = { dead: false, conn: null, src: null };
        this.feeds[m.stream] = f;
        const sid = this.sid;
        Promise.resolve().then(() => source.open(m.off)).then((got) => {
            if (f.dead || sid !== this.sid) { try { got.stream.destroy(); } catch (e) { /* gone */ } return; }
            f.src = got.stream;
            const conn = f.conn = net.createConnection(this.path);
            const size = got.size > 0 ? got.size : source.size > 0 ? source.size : -1;
            conn.on('connect', () => {
                conn.write(JSON.stringify({ op: 'data', sid, stream: m.stream, req: m.req, off: m.off, size }) + '\n');
                got.stream.pipe(conn);
            });
            // the tool closed it (a seek, a stop): the download ends with it
            conn.on('close', () => { if (!f.dead) this._dropFeed(m.stream); });
            conn.on('error', () => { /* 'close' follows */ });
            got.stream.on('error', (e) => {
                // the tool sees the connection end early and asks again from where it is
                this.log.warn('player: ' + m.stream + ' download: ' + (e && e.message || e));
                conn.end();
            });
        }).catch((e) => {
            if (f.dead || sid !== this.sid) return;
            delete this.feeds[m.stream];
            // a connection that hiccuped is tried again for a while (the tool waits 30 s for its bytes); a server
            // that answers "no" (the address ran out) is the caller's to deal with
            const refused = e && e.status >= 400 && e.status < 500;
            m.tries = (m.tries || 0) + 1;
            if (!refused && m.tries <= 6) {
                const again = { dead: false, conn: null, src: null };
                this.feeds[m.stream] = again;
                setTimeout(() => { if (!again.dead && this.feeds[m.stream] === again && sid === this.sid) this._feed(m); }, 2500);
                return;
            }
            this.log.warn('player: ' + m.stream + ' at byte ' + m.off + ': ' + (e && e.message || e));
            this.emit('feederror', { stream: m.stream, off: m.off, error: e });
        });
    }
}

/** A local file as a source (tests, and anything already on disk). */
function fileSource(file) {
    const fs = require('fs');
    const size = fs.statSync(file).size;
    return { size, open: (off) => Promise.resolve({ stream: fs.createReadStream(file, { start: off }), size }) };
}

module.exports = { PlayerLink, fileSource, SOCKET };
