'use strict';
/**
 * thumbs.js - video thumbnails as renderer pictures. A thumbnail is downloaded (JPEG), decoded and scaled by
 * the player tool, and kept as picture `pid` (ctx.media) while it is among the newest MAX; older ones are
 * dropped. get(video) answers at once: the picture's id when it is there, 0 while it is on its way.
 */
const W = 384, H = 216, MAX = 44, PARALLEL = 3;

class Thumbs {
    constructor(o) {
        this.net = o.net; this.link = o.link; this.media = o.media; this.log = o.log;
        this.onChange = o.onChange || (() => {});
        this.byId = new Map();      // video id -> { pid, state: 'wait' | 'busy' | 'ok' | 'bad', used, url, at }
        this.free = [];
        for (let i = MAX; i >= 1; i--) this.free.push(i);
        this.queue = [];
        this.running = 0;
        this.tick = 0;
    }

    /** The picture id of a video's thumbnail, 0 when it is not there (yet). Asking keeps it and fetches it. */
    get(video) {
        if (!video || !video.thumb) return 0;
        let e = this.byId.get(video.id);
        if (!e) {
            e = { pid: 0, state: 'wait', used: 0, url: video.thumb, at: 0 };
            this.byId.set(video.id, e);
            this.queue.push(video.id);
        } else if (e.state === 'bad' && Date.now() - e.at > 30000 && this.queue.indexOf(video.id) < 0) {
            // (no connection then, or the tool was not up yet: tried again after a while)
            e.state = 'wait';
            this.queue.push(video.id);
        }
        e.used = ++this.tick;
        this._pump();
        return e.state === 'ok' ? e.pid : 0;
    }

    _pump() {
        while (this.running < PARALLEL && this.queue.length) {
            // newest asked first: what is on screen now
            const id = this.queue.pop(), e = this.byId.get(id);
            if (!e || e.state !== 'wait') continue;
            if (!this.link.ready) { e.state = 'bad'; e.at = Date.now(); continue; }
            e.state = 'busy';
            this.running++;
            this.net.request(e.url, { timeout: 10000, maxBytes: 2 * 1024 * 1024 })
                .then((r) => { if (r.status !== 200) throw new Error('HTTP ' + r.status); return this.link.decode(r.body, W, H); })
                .then((pic) => {
                    if (this.byId.get(id) !== e) return;
                    e.pid = this._slot();
                    if (!e.pid) { e.state = 'bad'; e.at = Date.now(); return; }
                    this.media.picture(e.pid, pic.w, pic.h, pic.data);
                    e.state = 'ok';
                    this.onChange();
                })
                .catch(() => { e.state = 'bad'; e.at = Date.now(); })
                .then(() => { this.running--; this._pump(); });
        }
    }

    /** A free picture id; the least recently asked-for thumbnail gives its up when none is free. */
    _slot() {
        if (this.free.length) return this.free.pop();
        let oldest = null, key = null;
        this.byId.forEach((e, id) => { if (e.state === 'ok' && (!oldest || e.used < oldest.used)) { oldest = e; key = id; } });
        if (!oldest) return 0;
        const pid = oldest.pid;
        this.byId.delete(key);
        this.media.dropPicture(pid);
        return pid;
    }

    /** The player tool came back: thumbnails that failed meanwhile are tried again when next asked for. */
    retry() { this.byId.forEach((e) => { if (e.state === 'bad') e.at = 0; }); }
}

module.exports = { Thumbs, W, H };
