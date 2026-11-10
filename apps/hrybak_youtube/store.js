'use strict';
/**
 * store.js - what the app keeps between starts, in its data folder (state.json): watched videos with where
 * each stopped, recent searches, the sound device the owner picked. Written whole (a temp file renamed over
 * it), at most once every few seconds.
 */
const fs = require('fs');
const path = require('path');

const MAX_HISTORY = 40, MAX_SEARCHES = 12;

class Store {
    constructor(dataDir, log) {
        this.file = path.join(dataDir, 'state.json');
        this.log = log;
        this.data = { history: [], searches: [], audioDevice: '', soundOn: false };
        try {
            const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (j && typeof j === 'object') {
                if (Array.isArray(j.history)) this.data.history = j.history.filter((v) => v && typeof v.id === 'string').slice(0, MAX_HISTORY);
                if (Array.isArray(j.searches)) this.data.searches = j.searches.filter((s) => typeof s === 'string').slice(0, MAX_SEARCHES);
                if (typeof j.audioDevice === 'string') this.data.audioDevice = j.audioDevice;
                this.data.soundOn = j.soundOn === true;
            }
        } catch (e) { /* first start, or a damaged file: start empty */ }
        this.timer = null;
    }

    get history() { return this.data.history; }
    get searches() { return this.data.searches; }

    /** A video was opened: first in the history (pos: where it was last watched to, seconds). */
    watched(video, pos) {
        const old = this.data.history.find((v) => v.id === video.id);
        const entry = {
            id: video.id, title: video.title, author: video.author, seconds: video.seconds, length: video.length, thumb: video.thumb,
            pos: pos != null ? pos : (old ? old.pos : 0), t: Date.now(),
        };
        this.data.history = [entry].concat(this.data.history.filter((v) => v.id !== video.id)).slice(0, MAX_HISTORY);
        this.save();
    }
    /** Where a video in the history stopped. */
    position(id, pos) {
        const v = this.data.history.find((x) => x.id === id);
        if (!v || Math.abs((v.pos || 0) - pos) < 3) return;
        v.pos = Math.round(pos);
        this.save();
    }
    resumeAt(id) { const v = this.data.history.find((x) => x.id === id); return v ? v.pos || 0 : 0; }
    searched(q) {
        q = String(q).trim();
        if (!q) return;
        this.data.searches = [q].concat(this.data.searches.filter((s) => s.toLowerCase() !== q.toLowerCase())).slice(0, MAX_SEARCHES);
        this.save();
    }
    set(key, value) { this.data[key] = value; this.save(); }
    forget() { this.data.history = []; this.data.searches = []; this.save(); }

    save() {
        if (this.timer) return;
        this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 3000);
        if (this.timer.unref) this.timer.unref();
    }
    flush() {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        try {
            const tmp = this.file + '.' + process.pid + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.data));
            fs.renameSync(tmp, this.file);
        } catch (e) { if (this.log) this.log.warn('state not saved: ' + e.message); }
    }
}

module.exports = { Store };
