'use strict';
/**
 * demo.js - a simulated engine unit for the Diesel app (setting "demo", the preview and the emulator): the same
 * interface as reader.js, values in the same units, cycling through loading and a regeneration every CYCLE_S seconds
 * (sped up: a regeneration every ~440 km). Its regeneration history is made by feeding regen.js 2,200 km of the same
 * model, so the demo exercises the real tracking code.
 *
 *   const demo = new DemoReader();          // DIESEL_MOCK=regen / due: start in that phase (previews)
 *   demo.value('soot'), demo.why(k), demo.status() ('DEMO'), demo.rows()
 *   demo.seed(regen)                        // fill a Regen with 2,200 km of history (the chart keeps the last 1,000)
 */
const D = require('./dde');

const CYCLE_S = 240, LOAD_S = 180;             // loading 0..LOAD_S, regenerating LOAD_S..CYCLE_S
const THR = 24, CLEAN = 2.5, KM_LOAD = 425, KM_REGEN = 15;
const START = { regen: 205, due: 179 };

/** The demo's raw model at s seconds into a cycle (0..CYCLE_S): soot, distance, heat, flags. */
function model(s, n) {
    s = ((s % CYCLE_S) + CYCLE_S) % CYCLE_S;
    const w = (a, p) => Math.sin(s / p + (n || 0)) * a;
    if (s < LOAD_S) {
        const f = s / LOAD_S;
        return { soot: CLEAN + (THR - CLEAN) * f + w(0.08, 1.3), sinceKm: KM_LOAD * f, tDpf: 300 + w(30, 9), opMode: 1, pid8b: 0, rgnNum: f > 0.985 ? 5 : 0, regen: false };
    }
    const g = (s - LOAD_S) / (CYCLE_S - LOAD_S);
    return { soot: THR - (THR - CLEAN) * Math.min(1, g * 1.15), sinceKm: KM_LOAD + KM_REGEN * g, tDpf: 300 + 320 * Math.min(1, g * 5) + w(8, 3), opMode: 3, pid8b: 3, rgnNum: 5, regen: true };
}

class DemoReader {
    constructor() {
        this.t0 = Date.now() - ((START[process.env.DIESEL_MOCK] || 100) * 1000);
        this.family = 'd83'; this.index = '0F2670'; this.scr = 'scr04'; this.scrIndex = '0F2940';
        this.diesel = true; this.verified = true; this.replied = true;
        this.cycles = 0;
    }
    want() {}
    refresh() {}
    start() { return this; }
    stop() {}
    status() { return 'DEMO'; }
    age() { return 0; }
    why(key) { return this.value(key) === null ? (D.VALUES[key] ? 'not on this car' : '') : ''; }
    raw(key) { const v = this.value(key); return v === null ? null : Math.round(v); }

    value(key) {
        const s = (Date.now() - this.t0) / 1000, m = model(s), k = Math.floor(s / CYCLE_S), w = (a, p) => Math.sin(s / p) * a;
        const regens = 287 + k, odo1 = 152340 + k * (KM_LOAD + KM_REGEN);
        const load = m.soot / THR * 100;
        const v = {
            soot: m.soot, sootMeas: m.soot * 1.04 + w(0.3, 2.1), sootSim: m.soot * 0.97, ash: 38.2, dp: 6 + m.soot * 0.55 + (m.regen ? 4 : 0) + w(1.2, 1.7),
            tDpf: m.tDpf, tDpfSens: m.tDpf + 4, tDoc: m.tDpf + (m.regen ? -40 : 25), sinceKm: m.regen && (s % CYCLE_S) > CYCLE_S - 1 ? 0 : m.sinceKm,
            sinceS: m.sinceKm * 75, sinceL: m.sinceKm * 0.062, regens, avgKm: 441, odo1, odo2: odo1 - 436, odo3: odo1 - 436 - 452, odo4: odo1 - 888 - 211,
            odo5: odo1 - 1099 - 447, lifeKm: 146240, rgnNum: m.rgnNum, rgnLock: 0, rgnIntr: 0, opMode: m.opMode, pid8b: m.pid8b, loadPct: load, avgStart: 24.3, avgEnd: 1.9,
            adRange: 5900 - (s % 600), adQual: 32.5, adMass: 12860, noxIn: 260 + w(90, 4), noxOut: 11 + w(4, 3), scrT: m.regen ? 420 : 285 + w(15, 11), tScr: m.regen ? 440 : 300 + w(15, 11),
            scrEff: 96.4, adLevel: 11.8 - (s % 600) / 600 * 0.1,
            egrHp: m.regen ? 0 : 34 + w(6, 2.3), egrHpSet: m.regen ? 0 : 35 + w(5, 2.3), egrLp: m.regen ? 0 : 12 + w(4, 3.1), egrLpSet: m.regen ? 0 : 12 + w(4, 3.1),
            egrRate: m.regen ? 0 : 18 + w(4, 2.3), air: m.regen ? 520 : 412 + w(20, 2.3), airSet: m.regen ? 520 : 430 + w(15, 2.3),
            rail: 1180 + w(180, 1.9), railSet: 1200 + w(170, 1.9), boostAbs: 2450 + w(250, 2.7), boostSetAbs: 2480 + w(240, 2.7), ambient: 1013,
            inj1: 0.4, inj2: -0.3, inj3: 1.2, inj4: -0.6, inj5: null, inj6: null,
        };
        const x = v[key];
        return typeof x === 'number' && isFinite(x) ? x : null;
    }

    rows() {
        return Object.keys(D.VALUES).map((k) => {
            const spec = D.specOf(k, D.ON_SCR[k] ? this.scr : this.family) || {};
            return { key: k, ecu: D.ON_SCR[k] ? D.SCR : D.DDE, did: spec.did || '', value: this.value(k), raw: this.raw(k), unit: D.VALUES[k].unit,
                why: this.why(k), bytes: '', at: Date.now() };
        });
    }

    /** KM km of the model into a Regen, driven at 60 km/h and ending at the demo's now (the chart keeps 1,000 km). */
    seed(regen, km) {
        const now = Date.now(), s0 = (now - this.t0) / 1000, kmPerCycle = KM_LOAD + KM_REGEN, span = (km || 2200) / kmPerCycle * CYCLE_S;
        // the distance driven up to model second s, and its time at 60 km/h (1 km a minute) before now
        const dist = (s) => Math.floor(s / CYCLE_S) * kmPerCycle + model(s).sinceKm, end = dist(s0);
        for (let s = s0 - span; s <= s0; s += 0.25) {
            const m = model(s), t = now - (end - dist(s)) * 60000;
            regen.feed({ soot: m.soot, sinceKm: m.sinceKm, tDpf: m.tDpf, opMode: m.opMode, pid8b: m.pid8b, rgnNum: m.rgnNum, loadPct: m.soot / THR * 100, avgKm: 441, engine: true }, t);
        }
        // one stopped early, as a real log would have now and then
        if (regen.log.length > 1) Object.assign(regen.log[1], { result: 'stopped', s: 380, km: 4.2, soot1: 17.9 });
    }
}

DemoReader.model = model; DemoReader.CYCLE_S = CYCLE_S; DemoReader.LOAD_S = LOAD_S;
module.exports = { DemoReader };
