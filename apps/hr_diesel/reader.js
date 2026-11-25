'use strict';
/**
 * reader.js - reads the Diesel app's values (dde.js) from the engine unit (0x12) and the AdBlue unit (0x0B), over the
 * head unit's diagnostic link restricted to reading (kit/readonly-diag.js: nothing but 22 / 01 / 09 can leave).
 *
 *   const reader = new Reader({ signals, log, settings, canRead, engineType }).start();
 *   reader.want('ui', ['soot', 'dp', ...], 2000)     // what a source wants, and how often its live values (ms)
 *   reader.want('bg', [...], 20000)                  // (want(source, []) = nothing; the union is read)
 *   reader.value('soot') -> number or null           reader.raw('pid8b') -> the raw number (status words)
 *   reader.why('soot')   -> '' or why there's no value ('reading...', 'not on this car', 'no answer', ...)
 *   reader.status()      -> 'NO LINK' | 'PARKED' | 'NO ANSWER' | 'IDENTIFYING' | 'NOT A DIESEL' | 'LIVE' | 'STALE'
 *   reader.rows()        -> every value read so far, for the Details page
 *   reader.refresh()     -> ask everything again now (and the engine unit's type, unless it is a known petrol one)
 *
 * Pacing: one request at a time with GAP_MS between (on top of the link's own 25 ms), live values every fastMs, the
 * rest every SLOW_MS. Once an identifier's reply length is known, it goes with the others of its unit that are due or
 * nearly due (up to MAX_DIDS in one request: 62 <DID> <data> <DID> <data> ..., taken apart with kit/sgbd.js split()),
 * so they stay together. canRead() false (the car locked and left) = no request at all, so the car can sleep; a unit
 * that stops answering (ignition off) is asked again every WAKE_MS. All timing is on a steady clock: the head unit sets
 * its wall clock late and corrects it, by hours, both ways.
 *
 * A refusal (7F 22 nn) names no identifier, and every app on the head unit gets every reply, so one refusal may be
 * another app's: an identifier counts as "not on this car" only after ABSENT_AFTER refusals of its own single reads.
 *
 * The engine unit's type: its SGBD index (22 F1 50) in dde.js FAMILY (a diesel) or PETROL (not one, nothing more read).
 * An index in neither: a diesel when the car's engine type says so, or when soot and the distance since the last
 * regeneration both answer plausibly; not one when both are refused as unknown (NRC 31 / 11 / 12); otherwise asked again.
 */
const { ReadOnlyDiag, MAX_DIDS } = require('./kit/readonly-diag');
const { hex, NRC } = require('./kit/diag');
const { split } = require('./kit/sgbd');
const D = require('./dde');

const GAP_MS = 120, SLOW_MS = 30000, ASK_MS = 1500, WAKE_MS = 30000, STALE_MS = 15000, IDENT_MS = 3000, IDENT_SLOW_MS = 30000, SCR_RETRY_MS = 300000;
const ABSENT = [0x11, 0x12, 0x31], ABSENT_AFTER = 3, ABSENT_RETRY_MS = 60000, IDENT_TRIES = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** ms on a steady clock (never jumps with the wall clock) */
const mono = () => { const h = process.hrtime(); return h[0] * 1000 + h[1] / 1e6; };

class Reader {
    /**
     * opts: { signals, log, settings, canRead: () => bool (default: always), engineType: () => 'diesel' | 'petrol' | null,
     * link (a ReadOnlyDiag to share; made here if none) }
     */
    constructor(opts) {
        this.log = opts.log;
        this.settings = opts.settings;
        this.canRead = opts.canRead || (() => true);
        this.engineType = opts.engineType || (() => null);
        this.link = opts.link || new ReadOnlyDiag(opts.signals, opts.log);
        this.ownLink = !opts.link;
        this.wants = {};               // source -> { keys, fastMs }
        this.vals = {};                // key -> { v, raw, at, why }   (at: steady clock)
        this.dids = {};                // 'ecu:DID' -> { ecu, did, len, single, asked, absentN, absentUntil, bytes, why, at }
        this.family = null;            // dde.js family: d83 / d7x / d94 / unknown, or 'other' (not a diesel)
        this.index = null;             // the engine unit's SGBD index
        this.scr = undefined;          // the AdBlue unit's family (scr04 / scr03), null = none / unknown, undefined = not asked
        this.scrIndex = null; this.scrAsked = 0; this.scrWokenT = 0;
        this.replied = false; this.lastGood = 0; this.wokenT = 0; this.identT = 0; this.identN = 0;
        this.quiet = false;            // the engine unit went quiet: until it answers again
        this.running = false;
        this.logged = {};
    }

    start() {
        if (this.running) return this;
        this.running = true;
        if (this.ownLink) this.link.init().catch((e) => this.log.warn('diagnostic link: ' + (e && e.message || e)));
        this.pump().catch((e) => this.log.error('diesel reader: ' + (e && e.stack || e)));
        return this;
    }
    stop() { this.running = false; this.link.cancel(); }

    /** What a source wants read: keys (dde.js VALUES) and how often the live ones (ms). */
    want(source, keys, fastMs) {
        this.wants[source] = { keys: (keys || []).filter((k) => !!D.VALUES[k]), fastMs: fastMs || 2000 };
    }
    wanted() {
        const out = {};
        Object.keys(this.wants).forEach((s) => this.wants[s].keys.forEach((k) => {
            const ms = D.VALUES[k].live ? this.wants[s].fastMs : Math.max(SLOW_MS, this.wants[s].fastMs);
            out[k] = out[k] ? Math.min(out[k], ms) : ms;
        }));
        return out;
    }

    /** Ask everything again now: values, refusals (still counted), a unit that went quiet, an engine unit taken for a petrol one. */
    refresh() {
        Object.keys(this.dids).forEach((k) => { const r = this.dids[k]; r.asked = 0; r.absentUntil = 0; });
        this.scrAsked = 0;
        if (this.family === 'other' && !D.petrol(this.index)) { this.family = null; this.identN = 0; }
        if (!this.family) this.identT = 0;
        this.link.wake();
    }

    get diesel() { return !!this.family && this.family !== 'other'; }
    get verified() { return D.verified(this.family); }

    value(key) { const r = this.vals[key]; return r && r.v !== null && r.v !== undefined ? r.v : null; }
    raw(key) { const r = this.vals[key]; return r && r.raw !== undefined ? r.raw : null; }
    age(key) { const r = this.vals[key]; return r && r.at ? mono() - r.at : null; }

    /** Why a key has no value ('' when it has one). */
    why(key) {
        if (this.value(key) !== null) return '';
        if (!this.link.ready) return 'no diagnostic link';
        if (!this.canRead()) return 'car parked';
        if (this.family === 'other') return 'not a diesel engine unit';
        if (D.ON_SCR[key]) {
            if (this.scr === undefined) return 'reading...';
            if (this.scr === null) return this.scrIndex ? 'AdBlue unit not known' : 'no AdBlue unit';
        }
        const spec = this.specOf(key);
        if (this.family && !spec) return 'not on this car';
        const r = spec && this.dids[this.didKey(key, spec)];
        if (r && r.absentN >= ABSENT_AFTER) return 'not on this car';
        if (r && r.why) return r.why;
        const v = this.vals[key];
        if (v && v.why) return v.why;
        return 'reading...';
    }

    status() {
        if (!this.link.ready) return 'NO LINK';
        if (!this.canRead()) return 'PARKED';
        if (this.quiet || this.link.silent(D.DDE)) return 'NO ANSWER';
        if (!this.family) return 'IDENTIFYING';
        if (this.family === 'other') return 'NOT A DIESEL';
        return mono() - this.lastGood > STALE_MS ? 'STALE' : 'LIVE';
    }

    /** Every identifier asked so far, for the Details page: { key, ecu, did, value, unit, why, bytes, at }. */
    rows() {
        return Object.keys(D.VALUES).filter((k) => this.vals[k] || this.dids[this.didKey(k, this.specOf(k) || {})]).map((k) => {
            const spec = this.specOf(k) || {}, r = this.dids[this.didKey(k, spec)] || {}, v = this.vals[k] || {};
            return { key: k, ecu: D.ON_SCR[k] ? D.SCR : D.DDE, did: spec.did || '', value: this.value(k), raw: this.raw(k), unit: D.VALUES[k].unit,
                why: this.why(k), bytes: r.bytes || '', at: v.at || 0 };
        });
    }

    specOf(key) {
        if (D.ON_SCR[key]) return this.scr ? D.specOf(key, this.scr) : null;
        return this.family && this.family !== 'other' ? D.specOf(key, this.family) : null;
    }
    didKey(key, spec) { return (D.ON_SCR[key] ? D.SCR : D.DDE) + ':' + (spec && spec.did); }

    once(key, msg) { if (!this.logged[key]) { this.logged[key] = true; this.log.info(msg); } }
    heard(ecu) { if (ecu === D.DDE) { this.quiet = false; this.replied = true; } }

    /* ---------- identification ---------- */

    /** The unit's SGBD index (22 F1 50), positive replies only (a refusal may be another app's): '0F2670', or null. */
    async index0(ecu) {
        let u = null;
        try { u = await this.link.physical(ecu, 0x22, [0xF1, 0x50], ASK_MS, (x) => x[0] === 0x62 && x[1] === 0xF1 && x[2] === 0x50); } catch (e) { return null; }
        if (!u || u.length < 6) return null;
        this.heard(ecu);
        return [u[3], u[4], u[5]].map((b) => hex(b)).join('');
    }

    async identify() {
        this.identT = mono();
        this.identN++;
        const index = await this.index0(D.DDE);
        if (!index) return;
        this.index = index;
        let fam = D.familyOf(index);
        if (!fam && D.petrol(index)) fam = 'other';
        if (!fam && this.engineType() === 'diesel') fam = 'unknown';
        if (!fam) {
            // an index we don't know: a DDE answers soot and the distance since the last regeneration plausibly
            const a = await this.probe(D.specOf('soot', 'd83')), b = await this.probe(D.specOf('sinceKm', 'd83'));
            if (a.v !== null && b.v !== null) fam = 'unknown';
            else if (a.absent && b.absent) fam = 'other';
            else { this.once('ident?' + index, 'engine unit: SGBD index ' + index + ' not known, its answers not conclusive yet: asked again'); return; }
        }
        this.family = fam;
        this.log.info('engine unit: SGBD index ' + index + ' -> ' + (fam === 'other' ? 'not a diesel engine unit, nothing read' : D.NAMES[fam] + (D.verified(fam) ? '' : ' (read as DDE 8.3, unverified)')));
    }

    /** One identifier read for the type: { v (plausible value or null), absent (refused as unknown) }. */
    async probe(spec) {
        let u = null;
        try { u = await this.link.read(D.DDE, parseInt(spec.did, 16), ASK_MS); } catch (e) { return { v: null, absent: false }; }
        if (!u) return { v: null, absent: false };
        this.heard(D.DDE);
        if (u[0] === 0x7F) return { v: null, absent: u.length > 2 && ABSENT.indexOf(u[2]) >= 0 };
        return { v: u[0] === 0x62 ? D.decode(spec, Array.prototype.slice.call(u, 3)) : null, absent: false };
    }

    async identifyScr() {
        this.scrAsked = mono();
        const index = await this.index0(D.SCR);
        this.scrIndex = index;
        this.scr = index ? D.scrFamilyOf(index) : null;
        this.once('scr' + index, index ? 'AdBlue unit: SGBD index ' + index + (this.scr ? ' -> ' + this.scr.toUpperCase() : ' (no known layout, its tank level not read)') : 'AdBlue unit: no answer at 0x0B');
    }

    /* ---------- reading ---------- */

    /**
     * The identifiers due or nearly due now: [{ k, r, keys, late, want }], the most overdue first. late >= 0: due;
     * up to half an interval early: may join a request that goes anyway.
     */
    due(now) {
        const want = this.wanted(), by = {};
        Object.keys(want).forEach((key) => {
            const spec = this.specOf(key);
            if (!spec) return;
            const k = this.didKey(key, spec);
            const r = this.dids[k] || (this.dids[k] = { ecu: D.ON_SCR[key] ? D.SCR : D.DDE, did: spec.did, len: null, single: true, asked: 0, absentN: 0, absentUntil: 0, bytes: '', why: '' });
            if (r.absentUntil > now || this.link.silent(r.ecu)) return;
            const late = r.asked ? now - r.asked - want[key] : Infinity;
            if (late < -want[key] / 2) return;
            const e = by[k] || (by[k] = { k, r, keys: [], late, want: want[key] });
            e.keys.push(key);
            e.late = Math.max(e.late, late);
        });
        return Object.keys(by).map((k) => by[k]).sort((a, b) => b.late - a.late);
    }

    /** One request: the most overdue identifier, with others of the same unit whose length is known (up to MAX_DIDS). */
    async step(now) {
        const due = this.due(now);
        if (!due.length || due[0].late < 0) return false;
        const first = due[0], ecu = first.r.ecu;
        const batch = [first];
        if (!first.r.single && first.r.len !== null) {
            for (let i = 1; i < due.length && batch.length < MAX_DIDS; i++) {
                const e = due[i];
                if (e.r.ecu === ecu && !e.r.single && e.r.len !== null) batch.push(e);
            }
        }
        batch.forEach((e) => { e.r.asked = now; });
        const ids = batch.map((e) => parseInt(e.r.did, 16));
        let u;
        try { u = await this.link.readMany(ecu, ids, ASK_MS); } catch (e) {
            batch.forEach((b) => { b.r.why = String(e && e.message || e).indexOf('transport refused') >= 0 ? 'link busy' : 'no diagnostic link'; });
            return true;
        }
        if (u === undefined) { batch.forEach((b) => { b.r.asked = 0; }); return true; }     // cancelled before it went
        if (!u) { batch.forEach((b) => { b.r.why = 'no answer'; }); return true; }
        this.heard(ecu);
        if (u[0] === 0x7F) {
            if (batch.length > 1) { batch.forEach((b) => { b.r.single = true; b.r.asked = 0; }); return true; }   // ask them one by one
            this.refused(first.r, u.length > 2 ? u[2] : 0, now);
            return true;
        }
        if (batch.length === 1) {
            const data = Array.prototype.slice.call(u, 3);
            this.got(first, data, now);
            first.r.len = data.length;
            first.r.single = false;
            return true;
        }
        const lens = {};
        batch.forEach((b) => { lens[parseInt(b.r.did, 16)] = b.r.len; });
        const parts = split(Array.prototype.slice.call(u), lens);
        if (!parts) { batch.forEach((b) => { b.r.single = true; b.r.asked = 0; }); this.once('split' + first.r.did, 'reply to ' + batch.map((b) => b.r.did).join(' ') + ' did not add up: read one by one'); return true; }
        batch.forEach((b) => {
            const p = parts[parseInt(b.r.did, 16)];
            if (p) this.got(b, p.slice(3), now);
            else { b.r.single = true; b.r.asked = 0; }          // left out of the reply: its own request tells why
        });
        return true;
    }

    got(e, data, now) {
        const r = e.r;
        r.absentN = 0; r.absentUntil = 0; r.why = '';
        r.bytes = data.map((b) => hex(b)).join(' ');
        r.at = now;
        this.lastGood = now;
        this.once('ok' + r.ecu + r.did, 'unit ' + hex(r.ecu) + ' ' + r.did + ': ' + r.bytes);
        e.keys.forEach((key) => {
            const spec = this.specOf(key), v = D.decode(spec, data);
            this.vals[key] = { v, raw: D.rawOf(spec, data), at: now, why: v === null ? (data.length < (spec.at || 0) + (spec.bytes || 1) ? 'reply too short' : 'value out of range') : '' };
        });
    }

    refused(r, nrc, now) {
        r.why = 'refused (NRC ' + hex(nrc) + (NRC[nrc] ? ' ' + NRC[nrc] : '') + ')';
        if (ABSENT.indexOf(nrc) >= 0) {
            r.absentN++;
            r.absentUntil = now + ABSENT_RETRY_MS * Math.min(r.absentN, 10);
            if (r.absentN === ABSENT_AFTER) this.log.info('unit ' + hex(r.ecu) + ' ' + r.did + ': not on this car (' + r.why + ')');
        } else if (nrc === 0x22) r.why = 'refused now (conditions)';
    }

    async pump() {
        while (this.running) {
            let wait = 300;
            try { wait = await this.turn(mono()); } catch (e) { this.log.error('diesel reader: ' + (e && e.stack || e)); wait = 1000; }
            await sleep(wait);
        }
    }

    /** One turn of the reader: what it did; returns how long to wait before the next. */
    async turn(now) {
        if (!this.link.ready || !this.canRead() || !Object.keys(this.wanted()).length || (this.settings && this.settings.get('demo') === 'on')) return 300;
        if (this.link.silent(D.DDE)) {
            this.quiet = true;
            if (now - this.wokenT < WAKE_MS) return 500;
            this.wokenT = now; this.link.wake();               // every unit: the ignition is back for all of them
        }
        if (!this.family) {
            if (now - this.identT < (this.identN >= IDENT_TRIES ? IDENT_SLOW_MS : IDENT_MS)) return 300;
            await this.identify();
            return GAP_MS;
        }
        if (this.family === 'other') return 1000;
        const ad = Object.keys(this.wanted()).some((k) => D.ON_SCR[k]);
        if (ad && (this.scr === undefined || (this.scr === null && now - this.scrAsked > SCR_RETRY_MS))) { await this.identifyScr(); return GAP_MS; }
        if (ad && this.scr && this.link.silent(D.SCR) && now - this.scrWokenT >= WAKE_MS) { this.scrWokenT = now; this.link.wake(D.SCR); }
        return (await this.step(now)) ? GAP_MS : 200;
    }
}

Reader.GAP_MS = GAP_MS; Reader.SLOW_MS = SLOW_MS; Reader.ABSENT_AFTER = ABSENT_AFTER; Reader.STALE_MS = STALE_MS;
Reader.mono = mono;
module.exports = { Reader };
