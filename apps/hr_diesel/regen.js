'use strict';
/**
 * regen.js - the particulate filter's regenerations as the Diesel app follows them: running or not, the regeneration
 * point, a log of each one and the soot over the last 1,000 km.
 *
 *   const rg = new Regen({ file, log });            // file: data/diesel.json (null = in memory, the demo's)
 *   rg.feed({ soot, sinceKm, tDpf, opMode, pid8b, rgnNum, loadPct, avgStart, avgEnd, avgKm, regens, engine }, t)
 *                                                   // values just read (null / undefined = not read: the last kept)
 *   rg.state() -> { phase: 'active' | 'due' | 'ok' | 'unknown', by: 'flag' | 'heat' | null, requested, asked, threshold,
 *                   thresholdBy: 'load' | 'average' | 'learned' | 'typical', load (0..1+), nextKm, run: { t0, s, km, soot0,
 *                   progress, peak, by } | null }
 *   rg.log     -> [{ t0, t1, s, km, interval, soot0, soot1, peak, by, result: 'complete' | 'stopped' }], newest first
 *                 (by 'reset': one only seen by its end, the distance since the last starting again: s, km, soot0 null)
 *   rg.samples -> [[distance km, soot g], ...] over the last HIST_KM
 *   rg.onEvent(fn) -> fn('start' | 'complete' | 'stopped', entry)
 *   rg.asked()     -> the driver asked the engine unit for one (force.js): the next one within ASK_MS of driving is
 *                     that one (entry.asked), and until then state().asked
 *
 * Time: durations add up the steps between feeds (at most MAX_STEP_MS each), never wall-clock differences: the head unit
 * sets its clock late and corrects it, by hours, both ways. t (ms, wall clock) only stamps the log.
 * Running: the engine unit's own flag together with the heat, and the flag alone once it has been seen both at 0 and
 * at 1 (a flag stuck at either is no flag). The flag: the operating mode's regeneration bit (467E bit 1, as BimmerLink
 * reads it; DDE 7 and 8), else the after-treatment status (OBD PID 8B bit 0: DDE 8 only). Requested: the engine unit's
 * request 44BB at 4..6 (BimmerLink's reading). Heat: the exhaust
 * before the filter at REGEN_C or more for HOT_MS with the soot at least half way to the regeneration point, until it
 * stays under COOL_C for HOT_MS. A pause shorter than SETTLE_MS (a stop at the lights) resumes the same regeneration.
 * Done: the distance since the last successful regeneration starts again from 0 (BMW's own marker of a successful one);
 * stopped: SETTLE_MS of engine running after its end with that distance read and not reset. One by the heat that burnt
 * no soot (towing, a long climb) is dropped. Regeneration point: the soot against the DDE's own load % (5371), else its
 * average soot at a regeneration's start (4B52), else the median of the starts seen here, else TYPICAL_G; not learnt
 * during a regeneration, and while one runs (until it is done or stopped) the point it started at.
 * Distance: the app's own, from the distance since the last regeneration (steps forward; after a reset, the new value),
 * so the soot chart has an axis without an odometer.
 */
const fs = require('fs');

const REGEN_C = 500, COOL_C = 420, HOT_MS = 30000, SETTLE_MS = 180000, MAX_STEP_MS = 120000;
const ASK_MS = 3600000;
const THR_V = 2;                       // the saved regeneration point's version
const TYPICAL_G = 24, END_G = 2, HIST_KM = 1000, SAMPLE_KM = 2, SAMPLE_G = 0.5, LOG_MAX = 30, SAVE_MS = 60000, BURNT_G = 1;
const isNum = (x) => typeof x === 'number' && isFinite(x);
// the regeneration flags, in the order they are trusted: the bit that says regenerating
const FLAGS = { opMode: (x) => (x >>> 1) & 1, pid8b: (x) => x & 1 };
const mono = () => { const h = process.hrtime(); return h[0] * 1000 + h[1] / 1e6; };

function writeWhole(file, text) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}
function median(a) { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }

class Regen {
    constructor(opts) {
        this.file = opts && opts.file;
        this.log0 = (opts && opts.log) || { info() {}, warn() {} };
        this.listeners = [];
        this.reset();
        this.load();
    }
    reset() {
        this.dist = 0;                 // km, the app's own distance axis
        this.lastSince = null;         // the last distance since the last regeneration (km)
        this.samples = [];             // [[dist, soot]]
        this.log = [];                 // newest first
        this.run = null;               // the regeneration running: { t0, ms, d0, since0, soot0, soot, peak, by }
        this.ending = null;            // ended, not yet told done or stopped: { entry, run, ran (ms of engine running since) }
        this.seen0 = { opMode: false, pid8b: false, rgnNum: false };
        this.seen1 = { opMode: false, pid8b: false };
        this.askMs = 0;                // driving time left in which a regeneration is the one the driver asked for
        this.hotMs = 0; this.coolMs = 0; this.hot = false; this.latch = false;
        this.thrLoad = null;           // the regeneration point from the load % (smoothed)
        this.last = {};                // the last value of each key fed
        this.lastT = null;
        this.dirty = false; this.savedT = 0;
    }
    onEvent(fn) { this.listeners.push(fn); }
    emit(what, e) { this.listeners.forEach((fn) => { try { fn(what, e); } catch (x) { this.log0.warn('regen event: ' + x); } }); }

    load() {
        if (!this.file) return;
        let s;
        try { s = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { return; }
        if (!s || s.v !== 1) return;
        this.dist = isNum(s.dist) ? s.dist : 0;
        this.lastSince = isNum(s.lastSince) ? s.lastSince : null;
        this.samples = Array.isArray(s.samples) ? s.samples.filter((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1])) : [];
        this.log = Array.isArray(s.log) ? s.log.filter((e) => e && isNum(e.t0)).slice(0, LOG_MAX) : [];
        this.run = s.run && isNum(s.run.t0) ? Object.assign({ ms: 0 }, s.run) : null;
        this.ending = s.ending && s.ending.entry && s.ending.run ? Object.assign({ ran: 0 }, s.ending) : null;
        this.seen0 = Object.assign({ opMode: false, pid8b: false, rgnNum: false }, s.seen0);
        this.seen1 = Object.assign({ opMode: false, pid8b: false }, s.seen1);
        this.askMs = isNum(s.askMs) ? s.askMs : 0;
        this.latch = s.latch === true;
        // (THR_V: a point saved before 0.10.2 may have followed the soot down during a regeneration: learnt again)
        this.thrLoad = s.thrV === THR_V && isNum(s.thrLoad) ? s.thrLoad : null;
        // a regeneration by the heat goes on as one: the heat needs no 30 s to come back
        if (this.run && this.run.by === 'heat') this.hot = true;
    }
    save(force) {
        if (!this.file || !this.dirty) return;
        const now = mono();
        if (!force && now - this.savedT < SAVE_MS) return;
        this.savedT = now; this.dirty = false;
        try {
            writeWhole(this.file, JSON.stringify({ v: 1, dist: Math.round(this.dist * 1000) / 1000, lastSince: this.lastSince, samples: this.samples,
                log: this.log, run: this.run, ending: this.ending, seen0: this.seen0, seen1: this.seen1, latch: this.latch, thrLoad: this.thrLoad, thrV: THR_V, askMs: this.askMs }));
        } catch (e) { this.log0.warn('diesel log: ' + e); }
    }

    /** Values just read (null / undefined = not read this time), at wall-clock time t (ms). */
    feed(v, t) {
        t = isNum(t) ? t : Date.now();
        const step = this.lastT === null ? 0 : t - this.lastT;
        const dt = step > 0 && step <= MAX_STEP_MS ? step : 0;          // a jump of the clock (or a long gap) counts as no time
        this.lastT = t;
        const L = this.last;
        Object.keys(v).forEach((k) => { if (v[k] !== null && v[k] !== undefined) L[k] = v[k]; });
        const engineOn = L.engine !== false;
        // ---- the app's distance, from the distance since the last regeneration
        if (isNum(v.sinceKm)) {
            const reset = this.lastSince !== null && v.sinceKm < this.lastSince - 0.5;
            if (this.lastSince !== null) {
                const d = reset ? v.sinceKm : v.sinceKm - this.lastSince;
                if (d > 0 && d < 50) { this.dist += d; this.dirty = true; }
            }
            const before = this.lastSince;
            this.lastSince = v.sinceKm;
            if (reset && before >= 1) this.done(t, before);
        }
        // ---- soot samples over the last HIST_KM
        if (isNum(v.soot)) {
            const p = this.samples[this.samples.length - 1];
            if (!p || this.dist - p[0] >= SAMPLE_KM || Math.abs(v.soot - p[1]) >= SAMPLE_G) {
                this.samples.push([Math.round(this.dist * 10) / 10, Math.round(v.soot * 100) / 100]);
                while (this.samples.length && this.samples[0][0] < this.dist - HIST_KM) this.samples.shift();
                if (this.samples.length > 800) this.samples.splice(0, this.samples.length - 800);
                this.dirty = true;
            }
        }
        // ---- the regeneration point from the load % (not during a regeneration: the load % stays up while the soot
        // burns, so soot / load would follow the soot down)
        if (!this.run && !this.ending && isNum(v.loadPct) && isNum(v.soot) && v.loadPct >= 15 && v.soot >= 2) {
            const thr = v.soot * 100 / v.loadPct;
            if (thr >= 5 && thr <= 80) { this.thrLoad = this.thrLoad === null ? thr : this.thrLoad * 0.8 + thr * 0.2; this.dirty = true; }
        }
        // ---- flags: seen at 0 (a request / regeneration flag that ever reads 0) and, for the regeneration flags, at 1
        Object.keys(FLAGS).forEach((k) => {
            if (!isNum(v[k])) return;
            const b = FLAGS[k](v[k]);
            if (b === 0 && !this.seen0[k]) { this.seen0[k] = true; this.dirty = true; }
            if (b === 1 && this.seen0[k] && !this.seen1[k]) { this.seen1[k] = true; this.dirty = true; }
        });
        if (this.askMs > 0) { this.askMs = Math.max(0, this.askMs - dt); this.dirty = true; }
        if (isNum(v.rgnNum) && v.rgnNum === 0 && !this.seen0.rgnNum) { this.seen0.rgnNum = true; this.dirty = true; }
        // ---- heat before the filter (only with the engine running)
        const temp = isNum(v.tDpf) ? v.tDpf : null;
        if (!engineOn) { this.hotMs = 0; this.coolMs = 0; this.hot = false; }
        else if (temp !== null) {
            if (temp >= REGEN_C) { this.coolMs = 0; this.hotMs += dt; if (this.hotMs >= HOT_MS && this.near()) this.hot = true; }
            else if (temp < COOL_C) { this.hotMs = 0; this.coolMs += dt; if (this.coolMs >= HOT_MS) this.hot = false; }
            else { if (!this.hot) this.hotMs = 0; this.coolMs = 0; }       // in between: keeps what it was
        }
        // ---- running?
        const fk = isNum(L.opMode) && this.seen0.opMode ? 'opMode' : 'pid8b';
        const flagKnown = isNum(L[fk]) && this.seen0[fk], bit = flagKnown && FLAGS[fk](L[fk]) === 1;
        let on;
        if (!engineOn) on = false;
        else if (this.seen0[fk] && this.seen1[fk]) on = isNum(v[fk]) ? bit : this.run ? true : bit;   // the flag decides (not read now: as it was)
        else on = bit || this.hot;
        const by = bit ? 'flag' : 'heat';
        // (after a regeneration was done, a new one only once it has read as not running: the heat lingers)
        if (!on) this.latch = false;
        if (this.run) { this.run.ms += dt; if (temp !== null && (!isNum(this.run.peak) || temp > this.run.peak)) this.run.peak = Math.round(temp); if (isNum(v.soot)) this.run.soot = v.soot; }
        if (on && !this.run && !this.latch) this.begin(t, by);
        else if (!on && this.run) this.end(t);
        // ---- an ended one not told done: stopped once the engine has run SETTLE_MS since, with the distance read and not reset
        if (this.ending) {
            if (engineOn) this.ending.ran += dt;
            if (this.ending && this.ending.ran >= SETTLE_MS && isNum(v.sinceKm)) this.finish('stopped');
        }
        this.save(false);
    }

    /** The soot near enough to the regeneration point for a regeneration by heat (or not known). */
    near() { return !isNum(this.last.soot) || this.last.soot >= 0.5 * this.threshold().g; }

    begin(t, by) {
        const L = this.last;
        if (this.ending) {
            // paused, not done: the same regeneration goes on
            this.run = this.ending.run;
            this.ending = null;
            this.dirty = true;
            this.log0.info('regeneration goes on');
            return;
        }
        this.run = { t0: t, ms: 0, d0: this.dist, since0: isNum(L.sinceKm) ? L.sinceKm : null, soot0: isNum(L.soot) ? L.soot : null, soot: L.soot, peak: null, by,
            asked: this.askMs > 0, thr: this.threshold() };    // (the regeneration point as it was: shown until it is done)
        this.askMs = 0;
        this.dirty = true;
        this.log0.info('regeneration started (' + by + '), soot ' + (isNum(L.soot) ? L.soot.toFixed(1) + ' g' : '?') + ', ' + (isNum(L.sinceKm) ? L.sinceKm.toFixed(0) + ' km' : '?') + ' since the last');
        this.emit('start', this.run);
        this.save(true);
    }
    end(t) {
        const r = this.run, L = this.last;
        this.run = null;
        const entry = { t0: r.t0, t1: t, s: Math.round(r.ms / 1000), km: Math.round((this.dist - r.d0) * 10) / 10, interval: r.since0,
            soot0: r.soot0, soot1: isNum(L.soot) ? L.soot : null, peak: r.peak, by: r.by, asked: r.asked === true, result: null };
        this.ending = { entry, run: r, ran: 0 };
        this.dirty = true;
    }
    /** The distance since the last regeneration started again from 0 (it was `before` km): a regeneration was done. */
    done(t, before) {
        if (this.run) { this.end(t); this.latch = true; }
        if (this.ending) { this.finish('complete'); return; }
        // not seen running (the app wasn't, or it was too short to tell): logged by its end alone
        const L = this.last;
        this.log.unshift({ t0: t, t1: t, s: null, km: null, interval: before, soot0: null, soot1: isNum(L.soot) ? L.soot : null, peak: null, by: 'reset', result: 'complete' });
        if (this.log.length > LOG_MAX) this.log.length = LOG_MAX;
        this.dirty = true;
        this.log0.info('regeneration done (seen by its end), after ' + Math.round(before) + ' km');
        this.save(true);
    }
    finish(result) {
        const e = this.ending.entry, r = this.ending.run;
        this.ending = null;
        e.result = result;
        if (result === 'complete' && isNum(this.last.soot)) e.soot1 = this.last.soot;
        this.dirty = true;
        if (result === 'stopped' && r.by === 'heat' && isNum(e.soot0) && isNum(e.soot1) && e.soot1 > e.soot0 - BURNT_G) {
            // hot, but no soot burnt: towing or a long climb, not a regeneration
            this.log0.info('heat without a regeneration (' + e.s + ' s, soot ' + e.soot0.toFixed(1) + ' -> ' + e.soot1.toFixed(1) + ' g): not logged');
            this.save(true);
            return;
        }
        this.log.unshift(e);
        if (this.log.length > LOG_MAX) this.log.length = LOG_MAX;
        this.log0.info('regeneration ' + result + ': ' + e.s + ' s, ' + e.km + ' km, soot ' + (isNum(e.soot0) ? e.soot0.toFixed(1) : '?') + ' -> ' + (isNum(e.soot1) ? e.soot1.toFixed(1) : '?') + ' g, peak ' + (e.peak || '?') + ' °C');
        this.emit(result, e);
        this.save(true);
    }

    /** The driver asked the engine unit for a regeneration (force.js accepted): the next one is that one. */
    asked() {
        this.askMs = ASK_MS;
        this.dirty = true;
        this.log0.info('regeneration asked for by the driver');
        this.save(true);
    }

    /** The regeneration point (g) and where it came from. */
    threshold() {
        // a regeneration running (or ended, not yet told done): the point it started at
        const r = this.run || (this.ending && this.ending.run);
        if (r && r.thr && isNum(r.thr.g)) return r.thr;
        if (isNum(this.thrLoad)) return { g: this.thrLoad, by: 'load' };
        const a = this.last.avgStart;
        if (isNum(a) && a >= 5 && a <= 80) return { g: a, by: 'average' };
        const starts = this.log.filter((e) => e.result === 'complete' && isNum(e.soot0) && e.soot0 >= 5).slice(0, 5).map((e) => e.soot0);
        if (starts.length) return { g: median(starts), by: 'learned' };
        return { g: TYPICAL_G, by: 'typical' };
    }

    state() {
        const L = this.last, thr = this.threshold();
        const load = isNum(L.loadPct) ? L.loadPct / 100 : isNum(L.soot) ? L.soot / thr.g : null;
        const requested = isNum(L.rgnNum) && L.rgnNum >= 4 && L.rgnNum <= 6;
        const nextKm = isNum(L.avgKm) && isNum(L.sinceKm) ? Math.max(0, L.avgKm - L.sinceKm) : null;
        let phase = 'unknown', run = null;
        if (this.run) {
            phase = 'active';
            const r = this.run, end = isNum(L.avgEnd) && L.avgEnd >= 0 && L.avgEnd < 15 ? L.avgEnd : END_G;
            const progress = isNum(r.soot0) && isNum(L.soot) ? Math.max(0, Math.min(1, (r.soot0 - L.soot) / Math.max(1, r.soot0 - end))) : null;
            run = { t0: r.t0, s: Math.round(r.ms / 1000), km: Math.round((this.dist - r.d0) * 10) / 10, soot0: r.soot0, progress, peak: r.peak, by: r.by };
        } else if (load !== null || requested || this.askMs > 0) phase = (load !== null && load >= 1) || requested || this.askMs > 0 ? 'due' : 'ok';
        return { phase, by: this.run ? this.run.by : null, requested, asked: this.askMs > 0, threshold: thr.g, thresholdBy: thr.by, load, nextKm, run };
    }
}

Regen.REGEN_C = REGEN_C; Regen.COOL_C = COOL_C; Regen.HOT_MS = HOT_MS; Regen.SETTLE_MS = SETTLE_MS; Regen.TYPICAL_G = TYPICAL_G;
Regen.HIST_KM = HIST_KM; Regen.MAX_STEP_MS = MAX_STEP_MS; Regen.ASK_MS = ASK_MS;
module.exports = { Regen };
