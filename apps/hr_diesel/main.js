'use strict';
/**
 * Diesel - the diesel particulate filter (DPF) and the rest of a B47 / B57's exhaust after-treatment, read from the
 * engine unit (DDE) over the head unit's diagnostic link: reading (reader.js, kit/readonly-diag.js), but for the
 * regeneration request the driver confirms (force.js).
 *
 *   DPF            one glance: FILTER OK / REGENERATION DUE / REGENERATING (keep driving, don't switch the engine off),
 *                  the soot against the regeneration point, since the last one and the next; the heat into the filter,
 *                  the pressure drop, ash; the EGR valves OPEN / CLOSED in short
 *   Regenerations  each one the app saw (when, the distance before it, how long, soot before / after, peak, done or
 *                  stopped; the one running first), else the engine unit's own last five (odometer, intervals); the
 *                  totals and the soot over the last 1,000 km (the app's own log)
 *   AdBlue         ADBLUE OK / REFILL SOON / REFILL NOW with the range; the level, NOx before / after the SCR catalyst,
 *                  how much of it goes, the catalyst's heat
 *   Engine         each EGR valve OPEN / CLOSED (how far, the target), EGR rate, air mass; rail pressure and boost against
 *                  their targets, the injectors' quantity corrections
 *   Details        every value with its identifier, the reply's bytes and why one has none: what the car really sends
 *
 * Request regeneration (the bar's button: a sheet on the DPF page): after the driver confirms, the one write the app sends (force.js,
 * as BimmerLink does it): the engine unit then counts a regeneration as due and runs it once the driving allows.
 *
 * In the background (app.json autostart; regen.js): while the engine runs, the filter's values every 20 s (5 s during a
 * regeneration and until it is told done or stopped), so each regeneration is logged even with the app closed; nothing
 * once the car is locked and left.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha, rgba } = require('./kit/canvas');
const G = require('./kit/gauges');
const { fitText } = require('./kit/text-layout');
// (a word between numbers: translated before they are added, the drawn line's own translation leaves numbers alone)
const { t: tr } = require('./kit/i18n');
const Car = require('./kit/car');
const Engine = require('./kit/engine');
const { Reader } = require('./reader');
const { Regen } = require('./regen');
const { DemoReader } = require('./demo');
const { Force } = require('./force');
const D = require('./dde');

const W = 1600, H = 520;
const GO = '#2fd27a', BLUE = '#81c4ff';
const TABS = ['DPF', 'Regenerations', 'AdBlue', 'Engine', 'Details'];
const DPF_KEYS = ['soot', 'sootMeas', 'sootSim', 'ash', 'dp', 'tDpf', 'tDpfSens', 'tDoc', 'sinceKm', 'sinceS', 'sinceL', 'regens', 'avgKm', 'lifeKm',
    'opMode', 'pid8b', 'rgnNum', 'rgnLock', 'loadPct', 'avgStart', 'avgEnd'];
const PAGE_KEYS = [
    DPF_KEYS.concat(['egrHp', 'egrLp']),          // (the EGR valves' state in short, on the DPF page too)
    ['soot', 'tDpf', 'tDpfSens', 'sinceKm', 'regens', 'avgKm', 'opMode', 'pid8b', 'rgnNum', 'loadPct', 'avgStart', 'avgEnd'].concat(D.ODO),
    ['adLevel', 'adRange', 'adQual', 'adMass', 'noxIn', 'noxOut', 'scrT', 'tScr', 'scrEff'],
    ['egrHp', 'egrHpSet', 'egrLp', 'egrLpSet', 'egrRate', 'air', 'airSet', 'rail', 'railSet', 'boostAbs', 'boostSetAbs', 'ambient'].concat(D.INJ),
    Object.keys(D.VALUES),
];
const PAGE_MS = [2000, 5000, 2000, 1000, 2000];
// what the background follows while the engine runs: enough to see a regeneration start and end
const BG_KEYS = ['soot', 'tDpf', 'tDpfSens', 'sinceKm', 'opMode', 'pid8b', 'rgnNum', 'loadPct', 'avgKm', 'avgStart', 'avgEnd', 'regens'];
const BG_MS = 20000, BG_REGEN_MS = 5000, RUN_RPM = 400, TICK_MS = 1000;
const KM_MI = 0.621371;
const AD_DENSITY = 1090;              // g per litre of AdBlue (32.5 % urea)
const SCR_WARM_C = 180;               // deg C: the SCR catalyst converts from about here
const AD_SOON_KM = 2400, AD_NOW_KM = 1000;    // AdBlue range: BMW's own reserve warning, and its urgent one
const EGR_OPEN = 3;                   // % opening from which an EGR valve counts as open
const INJ_WARN = 1, INJ_FULL = 1.5;   // mg/stroke: a correction past INJ_WARN is marked; its bar is full at INJ_FULL
// the tiles' traces: the last 2 minutes, of readings no older than FRESH_MS, drawn from TRACE_MIN points on; a pause
// longer than TRACE_GAP_MS (the background reads every 20 s) is a gap in the line
const TRACE_S = 120, FRESH_MS = 6000, TRACE_MIN = 5, TRACE_GAP_MS = 25000;
// the page grid (as Warm-Up): a wide left column, the state card right; PAD inside a card
const LX = 24, LW = 880, RX = 928, RW = 648, PAD = 24;

// the Details page's names
const LABELS = {
    soot: 'Soot', sootMeas: 'Soot, measured', sootSim: 'Soot, model', ash: 'Ash', dp: 'Pressure drop', tDpf: 'Before the filter',
    tDpfSens: 'Before the filter, sensor', tDoc: 'Before the oxidation cat', sinceKm: 'Since the last regeneration', sinceS: 'Engine time since it',
    sinceL: 'Fuel since it', regens: 'Regenerations', avgKm: 'Average interval', odo1: 'Last regeneration at', odo2: 'The one before at',
    odo3: 'Third last at', odo4: 'Fourth last at', odo5: 'Fifth last at', lifeKm: 'Filter life left', rgnNum: 'Regeneration request',
    rgnLock: 'Regeneration lock', rgnIntr: 'Regeneration interrupted', opMode: 'Operating mode', pid8b: 'After-treatment status', loadPct: 'Load, regeneration point',
    avgStart: 'Average soot at a start', avgEnd: 'Average soot at an end', adRange: 'AdBlue range', adQual: 'AdBlue quality',
    adMass: 'AdBlue, engine unit', noxIn: 'NOx before the SCR', noxOut: 'NOx after the SCR', scrT: 'SCR catalyst', tScr: 'Before the SCR',
    scrEff: 'SCR conversion, average', adLevel: 'AdBlue level', egrHp: 'EGR, high pressure', egrHpSet: 'EGR high, target',
    egrLp: 'EGR, low pressure', egrLpSet: 'EGR low, target', egrRate: 'EGR rate', air: 'Air mass', airSet: 'Air mass, target', rail: 'Rail pressure',
    railSet: 'Rail pressure, target', boostAbs: 'Boost, absolute', boostSetAbs: 'Boost target, absolute', ambient: 'Ambient pressure',
    inj1: 'Injector 1', inj2: 'Injector 2', inj3: 'Injector 3', inj4: 'Injector 4', inj5: 'Injector 5', inj6: 'Injector 6',
};

const two = (n) => (n < 10 ? '0' : '') + n;
/**
 * v as shown: held while it stays within band of the value shown (the regeneration point from the load % moves a
 * little with every reading, and the soot bar's amber zone, its mark and label would jump with it). hold: { key: v }.
 */
function steady(hold, key, v, band) {
    if (typeof v !== 'number' || !isFinite(v)) { hold[key] = null; return v; }
    if (typeof hold[key] !== 'number' || Math.abs(v - hold[key]) >= band) hold[key] = v;
    return hold[key];
}
const POINT_BAND = 1;                 // g: the regeneration point shown moves once the real one is this far from it
/** 146240 -> '146,240' */
const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/* With or without the screen (autostart): the regenerations followed while the engine runs. */
async function background(bg) {
    const { settings, signals, log } = bg;
    const st = { rpm: null, left: false };
    const engine = new Engine({ settings, dataDir: bg.dataDir, log });
    const w = (iface, h) => (signals && signals.watch ? Promise.resolve(signals.watch(iface, '1', h, log)).catch((e) => log.warn('diesel: ' + iface + ': ' + (e && e.message || e))) : null);
    w('de.bmw.infotainment.vehicle.CDS', {
        statusEngineSpeed2: (v) => { const r = v && v.actualValueRPMEngineCrankshaft; if (typeof r === 'number' && r !== 65535) st.rpm = r * 0.25; },
    });
    w(Engine.SIGNAL[0], engine.handlers());
    // the car locked and left (BMW's vehicle state 1..3): nothing read, so it can sleep
    w('de.bmw.infrastructure.VehicleCondition', {
        VehicleCondition: (v) => {
            const n = Car.conditionOf(v && v.statusConditionVehicle);
            if (n === undefined || st.left === (n <= 3)) return;
            st.left = n <= 3;
            log.info(st.left ? 'the car is locked and left: nothing read' : 'the car is in use again');
        },
    });
    const reader = new Reader({ signals, log, settings, canRead: () => !st.left, engineType: () => engine.detected() }).start();
    const regen = new Regen({ file: path.join(bg.dataDir, 'diesel.json'), log });
    let fedAt = 0, ran = false;
    setInterval(() => {
        const running = typeof st.rpm === 'number' && st.rpm >= RUN_RPM;
        reader.want('bg', running && settings.get('demo') !== 'on' ? BG_KEYS : [], regen.run || regen.ending ? BG_REGEN_MS : BG_MS);
        if (!reader.diesel) return;
        if (ran && !running) regen.feed({ engine: false });
        ran = running;
        if (reader.lastGood <= fedAt) return;
        fedAt = reader.lastGood;
        const v = {};
        ['soot', 'sinceKm', 'pid8b', 'rgnNum', 'loadPct', 'avgStart', 'avgEnd', 'avgKm', 'regens'].forEach((k) => { v[k] = reader.value(k); });
        v.opMode = reader.raw('opMode'); v.pid8b = reader.raw('pid8b'); v.rgnNum = reader.raw('rgnNum');
        v.tDpf = reader.value('tDpf') !== null ? reader.value('tDpf') : reader.value('tDpfSens');
        v.engine = typeof st.rpm === 'number' ? running : undefined;
        regen.feed(v);
    }, TICK_MS);
    process.on('exit', () => regen.save(true));
    return { reader, regen, engine, st };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings } = ctx;
        const bgs = ctx.background || await background(ctx);
        const reader = bgs.reader, regen = bgs.regen;
        let page = 0, detail = 0, detailT = Date.now(), lastDemo = null;
        // the regeneration request: its sheet (null: closed; { state: 'ask' | 'sending' | 'failed', why })
        const force = new Force({ signals: ctx.signals, log: ctx.log });
        let sheet = null;

        // ---- demo: Always, or Auto while the link isn't there and nothing has answered
        let demoReader = null, demoRegen = null;
        const demo = () => settings.get('demo') === 'on' || (settings.get('demo') !== 'off' && !reader.replied && !reader.link.available);
        const src = () => {
            if (!demo()) return reader;
            if (!demoReader) { demoReader = new DemoReader(); demoRegen = new Regen({}); demoReader.seed(demoRegen); }
            return demoReader;
        };
        const rg = () => (demo() ? (src(), demoRegen) : regen);
        const d0 = () => (demo() ? 'demo' : 'car');
        const six = { demo: false, car: false };
        const point = {};                // the regeneration point shown, per source (steady())

        // ---- units
        const F = () => settings.get('tempUnit') === 'f', MI = () => settings.get('distUnit') === 'mi';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null), tU = () => (F() ? '°F' : '°C');
        const Dk = (km) => (G.isNum(km) ? (MI() ? km * KM_MI : km) : null), dU = () => (MI() ? 'mi' : 'km');

        // ---- what to read: the page's values while it is shown
        let visible = ui.isVisible ? ui.isVisible('MAIN') : true;
        const wanted = () => reader.want('ui', visible && !demo() ? PAGE_KEYS[page] : [], PAGE_MS[page]);
        const turn = (i) => { page = i; detail = 0; detailT = Date.now(); if (sheet && sheet.state !== 'sending') sheet = null; wanted(); return render(); };
        ui.onClick('BTN_PAGE', () => turn((page + 1) % TABS.length));
        // the bar's button (Standard layout): opens the sheet, and pressed again on it sends the request
        ui.onClick('BTN_REGEN', () => {
            if (!sheet) { const why = canForce(data()); sheet = why ? { state: 'failed', why } : { state: 'ask' }; return page !== 0 ? turn(0) : render(); }
            return askRegen();
        });
        ui.onClick('BTN_PREV', () => turn((page + TABS.length - 1) % TABS.length));
        // the current tab tapped again: read its page again now (unless the tap closed Settings)
        if (ctx.onTab) ctx.onTab((i, closedSheet) => { if (i !== page) return turn(i); if (!closedSheet) reader.refresh(); return render(); });
        if (ui.onVisible) ui.onVisible((name, on) => { if (name === 'MAIN') { visible = on; wanted(); } });
        settings.onChange(() => wanted());
        wanted();

        // ---- short traces (the last TRACE_S) for the tiles: [time, value], looked at once a second, a point for each
        // new reading (a page's values stand still while another page is shown: no points then). On a steady clock: the
        // head unit sets its own after start-up, and wall-clock times can jump by hours.
        const mono = () => { const h = process.hrtime(); return h[0] * 1000 + h[1] / 1e6; };
        const trace = { dp: [], tIn: [], nox: [], scr: [] };
        let traceT = 0, traceDemo = null;
        function sample(d) {
            // the demo's traces are not the car's (and back): a switch starts them again
            if (d.demo !== traceDemo) { traceDemo = d.demo; Object.keys(trace).forEach((k) => { trace[k].length = 0; }); }
            const now = mono(), since = traceT ? now - traceT : FRESH_MS;
            if (since < 1000) return;
            traceT = now;
            const put = (name, value, key) => {
                const a = trace[name], age = d.age(key);
                // (read since the last look, and not long ago)
                if (G.isNum(value) && age !== null && age < Math.min(FRESH_MS, since)) a.push([now, value]);
                while (a.length && now - a[0][0] > TRACE_S * 1000) a.shift();
            };
            put('dp', d.dp, 'dp'); put('tIn', d.tIn, d.v('tDpf') !== null ? 'tDpf' : 'tDpfSens'); put('nox', d.noxIn, 'noxIn'); put('scr', d.scrT, 'scrT');
            if (demo()) {
                // the demo's tracker is fed here (the background feeds the real one)
                const s = src(), v = {};
                ['soot', 'sinceKm', 'loadPct', 'avgStart', 'avgEnd', 'avgKm', 'regens', 'tDpf'].forEach((k) => { v[k] = s.value(k); });
                v.opMode = s.raw('opMode'); v.pid8b = s.raw('pid8b'); v.rgnNum = s.raw('rgnNum'); v.engine = true;
                demoRegen.feed(v);
            }
        }

        /** Everything the pages draw, from the engine unit (or the demo) and the regeneration tracker. */
        function data() {
            const s = src(), r = rg(), st = r.state(), v = (k) => s.value(k), why = (k) => s.why(k);
            const tIn = v('tDpf') !== null ? v('tDpf') : v('tDpfSens');
            const amb = v('ambient') !== null ? v('ambient') : 1013;
            const boost = v('boostAbs') !== null ? (v('boostAbs') - amb) / 1000 : null;
            const boostT = v('boostSetAbs') !== null ? (v('boostSetAbs') - amb) / 1000 : null;
            // injectors: six once the fifth or sixth has answered with something (B57), else four (B47)
            if ([v('inj5'), v('inj6')].some((x) => G.isNum(x) && Math.abs(x) > 0.005)) six[d0()] = true;
            const inj = D.INJ.slice(0, six[d0()] ? 6 : 4).map((k) => v(k));
            // the cylinder each of them belongs to (dde.js FIRING: they come in firing order), else as numbered
            const firing = D.FIRING && D.FIRING[inj.length];
            const injCyl = inj.map((q, i) => (firing && firing.length === inj.length ? firing[i] : i + 1));
            const noxIn = v('noxIn'), noxOut = v('noxOut'), scrT = v('scrT');
            const conv = G.isNum(noxIn) && G.isNum(noxOut) && noxIn >= 20 && G.isNum(scrT) && scrT >= SCR_WARM_C ? G.clamp((1 - noxOut / noxIn) * 100, 0, 100) : null;
            const adLevel = v('adLevel') !== null ? v('adLevel') : v('adMass') !== null ? v('adMass') / AD_DENSITY : null;
            return {
                demo: demo(), status: s.status(), diesel: s.diesel, family: s.family, verified: s.verified, index: s.index, scr: s.scr, scrIndex: s.scrIndex,
                v, why, age: (k) => (typeof s.age === 'function' ? s.age(k) : null),
                soot: v('soot'), sootMeas: v('sootMeas'), sootSim: v('sootSim'), sootMax: steady(point, d0(), st.threshold, POINT_BAND), thrBy: st.thresholdBy, load: st.load,
                ash: v('ash'), lifeKm: v('lifeKm'), dp: v('dp'), tIn, tDoc: v('tDoc'),
                phase: st.phase, by: st.by, requested: st.requested, run: st.run, nextKm: st.nextKm,
                sinceKm: v('sinceKm'), sinceS: v('sinceS'), sinceL: v('sinceL'), regens: v('regens'), avgKm: v('avgKm'),
                hist: r.samples.map((p) => [p[0] - r.dist, p[1]]), log: r.log, odo: D.ODO.map((k) => v(k)),
                adLevel, adLevelEst: v('adLevel') === null && v('adMass') !== null, adRange: v('adRange'), adQual: v('adQual'), noxIn, noxOut, scrT,
                tScr: v('tScr'), scrEff: v('scrEff'), conv, asked: st.asked, locked: s.raw('rgnLock') === 1, interrupted: s.raw('rgnIntr') === 1,
                egrHp: { pos: v('egrHp'), target: v('egrHpSet'), why: why('egrHp') }, egrLp: { pos: v('egrLp'), target: v('egrLpSet'), why: why('egrLp') },
                egrRate: v('egrRate'), air: v('air'), airTarget: v('airSet'), rail: v('rail'), railTarget: v('railSet'), boost, boostTarget: boostT, inj, injCyl,
            };
        }

        /* ---------- drawing ---------- */

        const has = G.isNum;
        const num = (x, dec) => (has(x) ? x.toFixed(dec || 0) : '--');
        const big = (x) => (has(x) ? thousands(x) : '--');
        const hm = (sec) => (has(sec) ? Math.floor(sec / 3600) + ' h ' + two(Math.floor(sec % 3600 / 60)) + ' min' : '');
        const flow = (t) => t.accent2 || t.accent;          // an open valve, the gas through it
        /** Text on a solid fill of col: dark on the light fills (amber, green, light blue), white on red. */
        const inkOn = (t, col) => { const c = rgba(col); return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > 130 ? t.bg : '#ffffff'; };
        /** Tops of blocks of the heights hs between top and bottom, the same gap before, between and after them. */
        function spread(top, bottom, hs) {
            const gap = Math.max(0, (bottom - top - hs.reduce((a, b) => a + b, 0)) / (hs.length + 1)), out = [];
            let y = top;
            hs.forEach((h) => { y += gap; out.push(Math.round(y)); y += h; });
            return out;
        }

        /** A card's row (x, w: the card's inside): label left, value + unit right, a dim note under the label. 48 high from 16 over y. */
        function row(cv, t, x, w, y, label, value, unit, note, color) {
            const uw = unit ? cv.textWidth(' ' + unit, 24) : 0;
            const vw = cv.text(value, x + w - uw, y + 20, 44, value === '--' ? t.dim : color || t.text, { align: 'right', font: 'num' });
            if (unit) cv.text(' ' + unit, x + w, y + 20, 24, t.dim, { align: 'right' });
            cv.text(label, x, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
            if (note) cv.text(fitText(cv, note, 20, w - vw - uw - 24), x, y + 26, 20, t.dim);
        }

        /**
         * A state in one word on its colour (Warm-Up's banner): 'tint' = the word in col on a tint of it (all is well),
         * 'ring' = that with an outline (look here), 'fill' = filled (it is on), 'pulse' = filled and breathing (it is
         * running: nothing else on the screen looks like it), 'plain' = white on grey (off, closed), 'off' = no state.
         */
        function banner(cv, t, x, y, w, h, word, col, how, now) {
            const r = Math.min(10, h / 2), o = { align: 'center', font: 'bold', spacing: h >= 56 ? 3 : 2 };
            let size = h >= 56 ? 38 : 28, ink = col;
            if (cv.textWidth(word, size, o) > w - 32) size = Math.round(size * 0.8);
            if (how === 'pulse') cv.roundRect(x - 6, y - 6, w + 12, h + 12, r + 6, withAlpha(col, 0.2 + 0.16 * Math.sin((now || 0) / 380)));
            if (how === 'pulse' || how === 'fill') { cv.roundRect(x, y, w, h, r, col); ink = inkOn(t, col); }
            else if (how === 'plain') { cv.roundRect(x, y, w, h, r, withAlpha('#ffffff', 0.1)); ink = t.text; }
            else if (how === 'off') { cv.roundRect(x, y, w, h, r, withAlpha(t.dim, 0.16)); ink = t.dim; }
            else {
                cv.roundRect(x, y, w, h, r, withAlpha(col, 0.22));
                if (how === 'ring') cv.strokeRoundRect(x, y, w, h, r, 2, col);
            }
            cv.text(word, x + w / 2, y + h / 2 + size * 0.36, size, ink, o);
        }

        /** A slim bar (Warm-Up's cool-down): f = 0..1 of it filled in col, a colour or a ramp's stops along the whole bar. */
        function meter(cv, t, x, y, w, h, f, col) {
            cv.roundRect(x, y, w, h, h / 2, t.track);
            if (!has(f) || f <= 0) return;
            const fw = Math.max(h, w * G.clamp(f, 0, 1));
            if (Array.isArray(col) && typeof col[0] === 'string') cv.rampRect(x, y, fw, h, h / 2, col, x, w);
            else cv.roundRect(x, y, fw, h, h / 2, col);
        }

        /**
         * A trace over the last TRACE_S, now at the right edge: pts = [[time, value]] (sample), base y = yb, h high. It
         * shows at least minSpan of the value's unit, so a steady value is a level line and not its noise blown up;
         * a long pause in the readings (another page was shown) is a gap. conv: to the shown unit.
         */
        function spark(cv, t, x, yb, w, h, pts, col, conv, minSpan) {
            const now = mono(), v = pts.map((p) => [p[0], conv ? conv(p[1]) : p[1]]).filter((p) => has(p[1]) && now - p[0] <= TRACE_S * 1000);
            if (v.length < TRACE_MIN || h < 16) return;
            let lo = Math.min.apply(null, v.map((p) => p[1])), hi = Math.max.apply(null, v.map((p) => p[1]));
            if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
            const P = (p) => [x + w - (now - p[0]) / (TRACE_S * 1000) * w, yb - 3 - (p[1] - lo) / (hi - lo) * (h - 3)];
            cv.fillRect(x, yb, w, 1, withAlpha(t.tick, 0.5));
            let run = [];
            const draw = () => { if (run.length > 1) { cv.fillUnder(run, yb, withAlpha(col, 0.16)); cv.polyline(run, 2.5, withAlpha(col, 0.85)); } run = []; };
            v.forEach((p, i) => { if (i && p[0] - v[i - 1][0] > TRACE_GAP_MS) draw(); run.push(P(p)); });
            draw();
        }

        /**
         * A tile as G.stat draws them (title, the value big with its unit, a trace, a last line), and with them: a second,
         * smaller value top right under its label (as M Vitals' target), a bar in place of the trace, or a labelled value
         * at the bottom. g = { label, value, unit, decimals, color, side: { label, value }, trace, conv, minSpan,
         * meter: { f, color }, foot: { label, text }, sub }.
         */
        function tile(cv, t, x, y, w, h, g) {
            const p = G.panel(cv, t, x, y, w, h, g.label), yb = p.y + p.h, r = x + w - 18, v = g.value, vy = y + 102;
            const vw = cv.text(has(v) ? G.fmt(v, g.decimals) : '--', x + 18, vy, 64, has(v) ? g.color || t.text : t.dim, { font: 'num' });
            let end = x + 26 + vw;
            if (g.unit) end += cv.text(g.unit, end, vy, 28, t.dim);
            if (g.side && has(g.side.value)) {
                // (left out where the big value leaves it no room)
                const ss = G.fmt(g.side.value, g.decimals), size = cv.textWidth(ss, 36, { font: 'num' }) <= r - end - 14 ? 36 : 28;
                const lw = cv.textWidth(g.side.label, 18, { font: 'bold', spacing: 1.5 });
                if (cv.textWidth(ss, size, { font: 'num' }) <= r - end - 10 && r - lw >= x + 18 + vw + 6) {
                    cv.text(g.side.label, r, y + 68, 18, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
                    cv.text(ss, r, vy, size, t.text, { align: 'right', font: 'num' });
                }
            }
            const base = yb - 50;                 // of the trace / the bar, over the last line
            if (g.trace) spark(cv, t, x + 18, base, w - 36, Math.min(84, base - vy - 14), g.trace, g.color || t.accent, g.conv, g.minSpan);
            if (g.meter) meter(cv, t, x + 18, base - 14, w - 36, 14, g.meter.f, g.meter.color);
            if (g.foot) {
                cv.text(g.foot.label, x + 18, yb - 58, 18, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text(g.foot.text, x + 18, yb - G.MARGIN, 28, t.text, { font: 'bold' });
            } else if (g.sub) cv.text(fitText(cv, g.sub, 22, w - 36, { spacing: 0.5 }), x + 18, yb - G.MARGIN, 22, t.dim, { spacing: 0.5 });
        }
        const traced = (pts) => pts.length >= TRACE_MIN;      // a trace is drawn (sample() keeps the last TRACE_S of it)
        /** A value that has none yet is still on its way (not refused, missing or silent). */
        const waiting = (d, key) => d.status === 'IDENTIFYING' || d.why(key) === 'reading...';

        /** The whole page as one message (not a diesel, no link...); col: the headline's colour (a warning's without). */
        function message(cv, t, head, line1, line2, col) {
            const p = G.panel(cv, t, LX, G.TOP, W - 2 * LX, 468, null), dy = Math.round((p.h - 468) / 2);
            cv.text(head, W / 2, 250 + dy, 34, col || t.warn, { align: 'center', font: 'bold' });
            if (line1) cv.text(line1, W / 2, 304 + dy, 24, t.dim, { align: 'center' });
            if (line2) cv.text(line2, W / 2, 344 + dy, 22, t.dim, { align: 'center' });
        }

        /* ---------- DPF ---------- */

        /** The filter's state: its word, colour and banner (banner()). */
        function dpfState(t, d) {
            if (d.phase === 'active') return { key: 'active', word: 'REGENERATING', col: t.warn, how: 'pulse' };
            if (d.phase === 'due') return { key: 'due', word: 'REGENERATION DUE', col: t.warn, how: 'ring' };
            if (d.phase === 'ok') return { key: 'ok', word: 'FILTER OK', col: GO, how: 'tint' };
            return { key: 'none', word: waiting(d, 'soot') ? 'NO DATA YET' : 'NO SOOT VALUE', col: t.dim, how: 'off' };
        }

        /**
         * The soot bar's scale: the regeneration point at about 4/5 of it, further for a filter loaded past that. It keeps
         * the scale it has while that still fits (the regeneration point worked out from the load % moves a little with
         * every reading: a scale that followed it would jump between 30 and 35).
         */
        let sootTop = 0;
        function sootScale(lim, soot) {
            const need = Math.max(10, lim ? lim * 1.2 : 30, has(soot) ? soot * 1.08 : 0);
            if (!sootTop || need > sootTop || need < sootTop * 0.72) {
                const every = need <= 40 ? 5 : need <= 80 ? 10 : need <= 160 ? 20 : 50;
                sootTop = Math.ceil(need / every - 1e-9) * every;
            }
            return { max: sootTop, every: sootTop <= 40 ? 5 : sootTop <= 80 ? 10 : sootTop <= 160 ? 20 : 50 };
        }

        /** The soot as a tach bar: the regeneration point marked and named, amber from just before it, all amber while it burns. */
        function sootBar(cv, t, d, st, h) {
            const x = LX, y = G.TOP, w = LW, lim = has(d.sootMax) && d.sootMax > 0 ? d.sootMax : null;
            const sc = sootScale(lim, d.soot), max = sc.max, every = sc.every, step = every / 2;
            G.segBar(cv, t, x, y, w, h, {
                label: 'Soot', value: d.soot, unit: 'g', decimals: 1, min: 0, max, step, scale: { every }, color: st.key === 'active' ? 'warn' : undefined,
                zones: lim ? [{ from: Math.round(lim * 0.9 / step) * step, to: max, color: 'warn' }] : [], marks: lim ? [{ value: lim, color: t.warn }] : [],
            });
            // beside the title: the soot's two sources (the big number is what the engine unit regenerates by)
            const note = has(d.soot) ? [has(d.sootMeas) && 'measured ' + d.sootMeas.toFixed(1) + ' g', has(d.sootSim) && 'soot model ' + d.sootSim.toFixed(1) + ' g'].filter(Boolean).join('  ·  ') : d.why('soot');
            cv.text(note, x + 40 + cv.textWidth('Soot', 26, { font: 'bold' }), y + 42, 20, t.dim);
            if (!lim) return;
            // the mark's name, at it (G.segBar's bar: from x + 24, w - 66 long, its top edge 18 further right, 80 under the top)
            const mx = x + 42 + G.clamp(lim / max, 0, 1) * (w - 66), name = 'regeneration at ' + (d.thrBy === 'typical' ? 'about ' : '') + Math.round(lim) + ' g';
            const left = mx - 10 - cv.textWidth(name, 20) >= x + 24;
            cv.text(name, left ? mx - 10 : mx + 10, y + 70, 20, t.dim, { align: left ? 'right' : 'left' });
        }

        /**
         * The EGR valves in short, along a card's bottom (yb): OPEN (in the flow's colour) / CLOSED with the opening, for
         * each valve the car has; quiet, so the card's own state stays the loudest. Returns where it starts (its line),
         * yb without a valve.
         */
        function egrStrip(cv, t, x, w, yb, d) {
            const vs = [['EGR HIGH PRESSURE', d.egrHp], ['EGR LOW PRESSURE', d.egrLp]].filter((v) => has(v[1].pos) || v[1].why !== 'not on this car');
            if (!vs.length) return yb;
            const gap = 16, cw = (w - gap * (vs.length - 1)) / vs.length, y = yb - 46;
            cv.fillRect(x, y - 50, w, 1, withAlpha(t.tick, 0.6));
            vs.forEach((v, i) => {
                const cx = x + i * (cw + gap), pos = v[1].pos, open = has(pos) && pos >= EGR_OPEN, col = flow(t), ink = open ? col : has(pos) ? t.text : t.dim;
                cv.text(vs.length > 1 ? v[0] : 'EGR VALVE', cx, y - 12, 22, t.dim, { font: 'bold', spacing: 1.5 });
                cv.roundRect(cx, y, cw, 46, 10, open ? withAlpha(col, 0.34) : withAlpha(has(pos) ? '#ffffff' : t.dim, has(pos) ? 0.1 : 0.16));
                cv.text(has(pos) ? (open ? 'OPEN' : 'CLOSED') : '--', cx + 18, y + 33, 28, ink, { font: 'bold', spacing: 2 });
                cv.text(has(pos) ? Math.round(Math.max(0, pos)) + ' %' : fitText(cv, v[1].why, 22, cw - 90), cx + cw - 18, y + 33, has(pos) ? 28 : 22, ink, { align: 'right', font: has(pos) ? 'bold' : 'label' });
            });
            return y - 50;
        }

        /** The filter's card: the state, what to do about it, what it comes from; the EGR valves along the bottom. */
        function dpfCard(cv, t, d, st, now) {
            const sp = G.panel(cv, t, RX, G.TOP, RW, 468, null), x = RX + PAD, w = RW - 2 * PAD, bot = sp.y + sp.h;
            banner(cv, t, x, G.TOP + 26, w, 60, st.word, st.col, st.how, now);
            const floor = egrStrip(cv, t, x, w, bot - G.MARGIN, d);
            let top = G.TOP + 86;
            /** two lines under the banner: what to do (large for the one that matters while driving) */
            const head = (a, b, large) => {
                cv.text(a, x, top + (large ? 52 : 46), large ? 40 : 30, t.text, { font: 'bold' });
                cv.text(b, x, top + (large ? 86 : 78), large ? 26 : 24, large ? t.text : t.dim, { font: large ? 'bold' : 'label' });
                top += large ? 98 : 90;
            };
            const pct = has(d.load) ? Math.round(d.load * 100) : null;
            const load = { h: 48, draw: (y) => row(cv, t, x, w, y + 16, 'SOOT LOAD', pct === null ? '--' : String(pct), '%',
                pct === null ? d.why('soot') : 'of the regeneration point' + (has(d.sootMax) ? ', ' + (d.thrBy === 'typical' ? 'about ' : '') + Math.round(d.sootMax) + ' g' : ''), pct !== null && pct >= 100 ? t.warn : null) };
            const since = { h: 48, draw: (y) => row(cv, t, x, w, y + 16, 'SINCE LAST REGENERATION', big(Dk(d.sinceKm)), dU(),
                has(d.sinceKm) ? (has(d.sinceS) ? hm(d.sinceS) + ' of driving' : '') : d.why('sinceKm')) };
            const next = { h: 48, draw: (y) => row(cv, t, x, w, y + 16, 'NEXT ONE IN ABOUT', big(Dk(d.nextKm)), dU(),
                has(d.nextKm) ? (d.nextKm > 0 ? 'average interval ' : 'past the average interval of ') + big(Dk(d.avgKm)) + ' ' + dU() : has(d.sinceKm) ? d.why('avgKm') : '') };
            let blocks = [load, since, next];
            if (st.key === 'active') {
                const r = d.run || {};
                head('Keep driving', 'Don\'t switch the engine off', true);
                blocks = [{ h: 68, draw: (y) => {
                    row(cv, t, x, w, y + 16, 'SOOT BURNT', has(r.progress) ? String(Math.round(r.progress * 100)) : '--', '%');
                    meter(cv, t, x, y + 52, w, 16, r.progress, [t.warn, GO]);
                } }, { h: 48, draw: (y) => row(cv, t, x, w, y + 16, 'RUNNING FOR', !has(r.s) ? '--' : String(r.s < 60 ? Math.max(0, r.s) : Math.floor(r.s / 60)), has(r.s) && r.s < 60 ? 's' : 'minutes',
                    [has(r.km) && num(Dk(r.km), 0) + ' ' + dU(), has(r.soot0) && 'started at ' + r.soot0.toFixed(1) + ' g', r.by === 'heat' && 'seen by its heat'].filter(Boolean).join('  ·  ')) }];
            } else if (st.key === 'due') {
                head(d.requested ? 'The engine has asked for one' : d.asked ? 'Requested from the app' : pct !== null && pct >= 125 ? 'The soot is well past the regeneration point' : 'The soot is at the regeneration point',
                    '20-30 min at a steady ' + (MI() ? '40 mph' : '60 km/h') + ' or more lets it run');
                blocks = [load, since];
            }
            const ys = spread(top, floor, blocks.map((b) => b.h));
            blocks.forEach((b, i) => b.draw(ys[i]));
        }

        function renderDpf(cv, t, d, now) {
            // the room below the page (on the car, with no bar under it): half to the soot, half to the tiles
            const half = Math.round((G.pageBottom(cv) - G.BOTTOM) / 2), st = dpfState(t, d);
            sootBar(cv, t, d, st, 225 + half);
            // ---- tiles: the heat into the filter (a regeneration's tell-tale), the pressure drop, ash
            const ty = G.TOP + 242 + half, th = 226 - half, tw = 280, hot = has(d.tIn) && d.tIn >= Regen.REGEN_C;
            tile(cv, t, LX, ty, tw, th, { label: 'Before the filter', value: T(d.tIn), unit: tU(), color: hot ? t.warn : null, side: { label: 'OXI CAT', value: T(d.tDoc) },
                trace: trace.tIn, conv: T, minSpan: F() ? 108 : 60, sub: has(d.tIn) ? (traced(trace.tIn) ? 'last 2 min' : 'exhaust temperature') : d.why('tDpf') });
            tile(cv, t, LX + 300, ty, tw, th, { label: 'Pressure drop', value: d.dp, unit: 'hPa', trace: trace.dp, minSpan: 10,
                sub: has(d.dp) ? (traced(trace.dp) ? 'last 2 min' : 'across the filter') : d.why('dp') });
            tile(cv, t, LX + 600, ty, tw, th, { label: 'Ash', value: d.ash, unit: 'g', foot: has(d.ash) && has(d.lifeKm) ? { label: 'FILTER LIFE LEFT', text: big(Dk(d.lifeKm)) + ' ' + dU() } : null,
                sub: has(d.ash) ? 'oil ash, stays in the filter' : d.why('ash') });
            dpfCard(cv, t, d, st, now);
        }

        /* ---------- the regeneration request: what it does, what it needs, then the one write ---------- */

        const canForce = (d) => force.can({ family: d.family, status: d.status, phase: d.phase, locked: d.locked, demo: d.demo });
        function askRegen() {
            if (!sheet || sheet.state === 'sending') return null;
            const d = data(), why = canForce(d);
            if (why) { sheet = { state: 'failed', why }; return render(); }
            sheet = { state: 'sending' };
            const r = rg();
            force.request(d.family, d.demo).then((res) => {
                if (res.ok) { r.asked(); sheet = null; } else sheet = { state: 'failed', why: res.why };
                return render();
            }).catch((e) => { sheet = { state: 'failed', why: String(e && e.message || e) }; return render(); });
            return render();
        }

        function renderSheet(cv, t, d) {
            const p = G.panel(cv, t, LX, G.TOP, W - 2 * LX, 468, 'Request regeneration'), x = LX + PAD + 8, bot = p.y + p.h;
            const sending = sheet.state === 'sending', failed = sheet.state === 'failed';
            let y = G.TOP + 104;
            cv.text('The engine unit is told that a regeneration is due, and runs it once the driving allows:', x, y, 26, t.text, { font: 'bold' });
            y += 58;
            ['The engine warm: coolant over ' + Math.round(T(75)) + tU(), 'Fuel not on reserve, no exhaust or sensor faults stored',
                '20-30 min at a steady ' + (MI() ? '40 mph' : '60 km/h') + ' or more; don\'t switch the engine off while it runs'].forEach((line) => {
                cv.circle(x + 7, y - 9, 5, t.warn);
                cv.text(line, x + 28, y, 24, t.text);
                y += 46;
            });
            cv.text(failed ? tr('Not sent') + ': ' + tr(sheet.why) : d.demo ? 'Demo: nothing is sent to the car.' : 'One write to the engine unit, as BimmerLink sends it. Not tried on every engine unit.',
                x, y + 14, 22, failed ? t.crit : t.dim);
            const by = bot - G.MARGIN - 52;
            if (!cv.own) {
                // (the HMI's bar has the buttons)
                cv.text(sending ? 'Requesting...' : 'Press Request regeneration again to send it, Next page to cancel', x, bot - G.MARGIN, 24, sending ? t.dim : t.text, { font: 'bold' });
                return;
            }
            G.button(cv, t, W - LX - PAD - 300, by, 300, 56, sending ? 'Requesting...' : failed ? 'Send again' : 'Send request', sending ? null : askRegen,
                { key: 'regenGo', primary: true, busy: sending, color: t.warn });
            G.button(cv, t, W - LX - PAD - 300 - 24 - 220, by, 220, 56, 'Cancel', sending ? null : () => { sheet = null; return render(); }, { key: 'regenNo', busy: sending });
        }

        /* ---------- Regenerations ---------- */

        function renderRegens(cv, t, d) {
            const lw = 1040, rx = LX + lw + 24, rw = W - LX - rx, x = LX + PAD, w = lw - 2 * PAD, y0 = 106, hs = 20, rh = 56, top = y0 + hs + 14;
            const day = (ms) => { const a = new Date(ms); return a.getDate() + '.' + two(a.getMonth() + 1) + '.'; };
            const time = (ms) => { const a = new Date(ms); return a.getHours() + ':' + two(a.getMinutes()); };
            // the one running first (it joins the log when it ends)
            const r = d.phase === 'active' && d.run ? { t0: d.run.t0, s: d.run.s, km: d.run.km, interval: has(d.sinceKm) && has(d.run.km) ? Math.max(0, d.sinceKm - d.run.km) : null,
                soot0: d.run.soot0, soot1: d.soot, peak: d.run.peak, result: 'running' } : null;
            const log = (r ? [r] : []).concat(d.log), mine = log.length > 0;
            const lp = G.panel(cv, t, LX, G.TOP, lw, 468, mine ? 'Logged by the app' : 'The engine unit\'s last five'), lb = lp.y + lp.h;
            if (mine) {
                const n = Math.floor((lb - 16 - top) / rh), shown = log.slice(0, n);
                cv.text('newest first' + (log.length > n ? '  ·  ' + n + ' of ' + log.length : ''), LX + lw - PAD, G.TOP + 42, 20, t.dim, { align: 'right' });
                // (one the app saw only by its end, the distance since the last starting again, has no duration, distance or soot before)
                G.table(cv, t, x, y0, w, [{ label: 'Started', w: 92 }, { label: '', w: 78, align: 'right' }, { label: 'Interval', w: 132, align: 'right' }, { label: 'Took', w: 108, align: 'right' },
                    { label: 'Distance', w: 120, align: 'right' }, { label: 'Soot', w: 180, align: 'right' }, { label: 'Peak', w: 108, align: 'right' }],
                    shown.map((e) => [day(e.t0), time(e.t0), has(e.interval) ? big(Dk(e.interval)) + ' ' + dU() : '--', has(e.s) ? Math.max(1, Math.round(e.s / 60)) + ' min' : '--',
                        has(e.km) ? num(Dk(e.km), 0) + ' ' + dU() : '--', has(e.soot0) || has(e.soot1) ? num(e.soot0, 1) + ' ' + tr('to') + ' ' + num(e.soot1, 1) + ' g' : '--',
                        has(e.peak) ? Math.round(T(e.peak)) + tU() : '--']),
                    { rowH: rh, size: 26, headerSize: hs, middle: true });
                // how each ended: a pill (as Service's)
                shown.forEach((e, i) => {
                    const run = e.result === 'running', ok = e.result === 'complete', col = ok ? GO : t.warn, py = top + i * rh + (rh - 34) / 2;
                    cv.roundRect(x + w - 152, py, 152, 34, 6, run ? col : withAlpha(col, 0.22));
                    cv.text(run ? 'running' : ok ? 'done' : 'stopped early', x + w - 76, py + 25, 22, run ? inkOn(t, col) : col, { align: 'center', font: 'bold' });
                });
            } else {
                // nothing seen here yet: the engine unit's own last five (odometer at each, the distances between them)
                const odo = d.odo.filter(has);
                if (odo.length) {
                    G.table(cv, t, x, y0, w, [{ label: 'Regeneration', w: 330 }, { label: 'Odometer', w: 300, align: 'right' }, { label: 'Interval', w: 300, align: 'right' }],
                        odo.map((km, i) => [['Last', 'The one before', 'Third last', 'Fourth last', 'Fifth last'][i], big(Dk(km)) + ' ' + dU(), i + 1 < odo.length ? big(Dk(km - odo[i + 1])) + ' ' + dU() : '--']),
                        { rowH: rh, size: 26, headerSize: hs, middle: true });
                } else cv.text(d.why('odo1') === 'reading...' ? 'reading...' : 'none on record here: ' + d.why('odo1'), x, top + 38, 26, t.dim);
                cv.text('Each regeneration from now on is logged with its time, soot and heat,', x, lb - 50, 22, t.dim);
                cv.text('also with the app closed.', x, lb - G.MARGIN, 22, t.dim);
            }
            // ---- totals, and the soot over the last 1,000 km (the app's own log): the sawtooth of the regenerations
            const rp = G.panel(cv, t, rx, G.TOP, rw, 468, 'Totals'), ix = rx + PAD, iw = rw - 2 * PAD, rb = rp.y + rp.h;
            const gh = 142 + rp.h - 468, gy = rb - 14 - gh, span = MI() ? 600 : Regen.HIST_KM, pts = [];
            // (the log's 1,000 km are 621 miles: the line starts at the chart's left edge, not before it)
            d.hist.map((p) => [Dk(p[0]), p[1]]).forEach((p, i, all) => {
                if (p[0] < -span) return;
                const a = all[i - 1];
                if (!pts.length && a && a[0] < -span && p[0] > a[0]) pts.push([-span, a[1] + (p[1] - a[1]) * (-span - a[0]) / (p[0] - a[0])]);
                pts.push(p);
            });
            const yNeed = Math.max(30, Math.max.apply(null, [d.sootMax].concat(pts.map((p) => p[1]))) * 1.1), yStep = yNeed <= 30 ? 10 : yNeed <= 60 ? 20 : 50, yTop = Math.ceil(yNeed / yStep - 1e-9) * yStep;
            const stopped = d.log.filter((e) => e.result !== 'complete').length;
            const rows = [(y) => row(cv, t, ix, iw, y + 16, 'REGENERATIONS', big(d.regens), '', has(d.regens) ? 'successful, in the engine unit' : d.why('regens')),
                (y) => row(cv, t, ix, iw, y + 16, 'ON AVERAGE EVERY', big(Dk(d.avgKm)), dU(), has(d.avgKm) ? 'from one to the next' : d.why('avgKm'))]
                .concat(d.log.length ? [(y) => row(cv, t, ix, iw, y + 16, 'STOPPED EARLY', String(stopped), '', 'logged by the app: ' + d.log.length)] : []);
            spread(G.TOP + 56, gy - 34, rows.map(() => 48)).forEach((y, i) => rows[i](y));
            cv.text('SOOT, LAST ' + span + ' ' + dU().toUpperCase(), ix, gy - 12, 22, t.dim, { font: 'bold', spacing: 1.5 });
            G.chart(cv, t, ix, gy, iw, gh, { xMin: -span, xMax: 0, yMin: 0, yMax: yTop, yStep, xStep: span / (MI() ? 3 : 4),
                padLeft: 34, padRight: 22, xUnit: dU(), empty: 'logged as you drive', marks: [{ y: d.sootMax, color: t.warn }],
                series: [{ pts, color: flow(t), fill: true }] });
        }

        /* ---------- AdBlue ---------- */

        /** The AdBlue's state, from its range (BMW's own warnings: the reserve, then the last one). */
        function adblueState(t, d) {
            if (!has(d.adRange)) return { key: 'none', word: waiting(d, 'adRange') ? 'NO DATA YET' : 'NO RANGE VALUE', col: t.dim, how: 'off' };
            if (d.adRange <= AD_NOW_KM) return { key: 'now', word: 'REFILL NOW', col: t.crit, how: 'fill' };
            if (d.adRange <= AD_SOON_KM) return { key: 'soon', word: 'REFILL SOON', col: t.warn, how: 'ring' };
            return { key: 'ok', word: 'ADBLUE OK', col: GO, how: 'tint' };
        }

        function renderAdblue(cv, t, d, now) {
            const none = !d.demo && d.why('adRange') === 'not on this car' && d.why('noxIn') === 'not on this car';
            if (none) return message(cv, t, 'No AdBlue system on this car', 'The engine unit has no SCR catalyst values (a B47 without AdBlue).', null, t.text);
            const half = Math.round((G.pageBottom(cv) - G.BOTTOM) / 2), st = adblueState(t, d);
            // ---- the level (20 l is the usual tank; a bigger one gets the longer scale)
            const max = has(d.adLevel) && d.adLevel > 20 ? 40 : 20;
            G.segBar(cv, t, LX, G.TOP, LW, 225 + half, { label: 'AdBlue', value: d.adLevel, unit: 'L', decimals: 1, min: 0, max, step: max / 20, scale: { every: max / 4 },
                color: st.key === 'now' ? 'crit' : st.key === 'soon' ? 'warn' : undefined });
            cv.text(d.adLevelEst ? 'estimated, from the engine unit\'s figure' : has(d.adLevel) ? '' : d.why('adLevel'), LX + 40 + cv.textWidth('AdBlue', 26, { font: 'bold' }), G.TOP + 42, 20, t.dim);
            // ---- tiles: NOx before and after the SCR catalyst, how much of it the catalyst takes out, its heat
            const ty = G.TOP + 242 + half, th = 226 - half, tw = 280, cold = has(d.scrT) && d.scrT < SCR_WARM_C;
            tile(cv, t, LX, ty, tw, th, { label: 'NOx before the SCR', value: d.noxIn, unit: 'ppm', side: { label: 'AFTER SCR', value: d.noxOut }, trace: trace.nox, minSpan: 100,
                sub: has(d.noxIn) ? (traced(trace.nox) ? 'last 2 min' : 'engine out') : d.why('noxIn') });
            tile(cv, t, LX + 300, ty, tw, th, { label: 'NOx removed', value: d.conv, unit: '%', meter: { f: has(d.conv) ? d.conv / 100 : null, color: GO },
                sub: has(d.conv) ? 'by the SCR catalyst, now' : cold ? 'the catalyst is still cold' : !has(d.noxIn) ? d.why('noxIn') : !has(d.noxOut) ? d.why('noxOut') : !has(d.scrT) ? d.why('scrT') : 'too little NOx to tell' });
            tile(cv, t, LX + 600, ty, tw, th, { label: 'SCR catalyst', value: T(d.scrT), unit: tU(), color: cold ? t.cold : null, side: { label: 'BEFORE SCR', value: T(d.tScr) }, trace: trace.scr, conv: T,
                minSpan: F() ? 108 : 60, sub: has(d.scrT) ? (cold ? 'works from ' + Math.round(T(SCR_WARM_C)) + tU() : traced(trace.scr) ? 'last 2 min' : 'its temperature') : d.why('scrT') });
            // ---- the card: the state, the range (what the car's own warnings go by), the averages
            const sp = G.panel(cv, t, RX, G.TOP, RW, 468, null), x = RX + PAD, w = RW - 2 * PAD, bot = sp.y + sp.h;
            banner(cv, t, x, G.TOP + 26, w, 60, st.word, st.col, st.how, now);
            let top = G.TOP + 86;
            if (st.key === 'now') { cv.text('No engine start once the range is used up', x, top + 44, 26, t.text, { font: 'bold' }); top += 52; }
            const blocks = [{ h: 100, draw: (y) => {
                cv.text('RANGE, ABOUT', x, y + 16, 22, t.dim, { font: 'bold', spacing: 1.5 });
                const vw = cv.text(big(Dk(d.adRange)), x, y + 92, 76, !has(d.adRange) ? t.dim : st.key === 'ok' ? t.text : st.col, { font: 'num' });
                cv.text(dU(), x + vw + 10, y + 92, 30, t.dim);
                if (!has(d.adRange)) cv.text(d.why('adRange'), x + w, y + 90, 22, t.dim, { align: 'right' });
            } }, { h: 48, draw: (y) => row(cv, t, x, w, y + 16, 'NOX REMOVED, AVERAGE', num(d.scrEff, 1), '%', has(d.scrEff) ? 'as the engine unit keeps it' : d.why('scrEff')) },
            { h: 48, draw: (y) => row(cv, t, x, w, y + 16, 'ADBLUE QUALITY', num(d.adQual, 1), '%', has(d.adQual) ? 'urea in it: 32.5 % as sold' : d.why('adQual')) }];
            const ys = spread(top, bot - G.MARGIN + 6, blocks.map((b) => b.h));
            blocks.forEach((b, i) => b.draw(ys[i]));
        }

        /* ---------- Engine ---------- */

        /**
         * An EGR valve in its pipe, from the side: the exhaust gas comes from the left; the plate across the pipe holds it
         * back (closed) or, turned, lets a stream through that is as thick as the valve is open. open = 0..1, null: not known.
         */
        function valve(cv, t, x, y, w, h, open, col) {
            const known = has(open), f = known ? G.clamp(open, 0, 1) : 0, cx = x + w / 2, cy = y + h / 2, R = h / 2 - 9, lit = withAlpha(col, 0.95);
            const arrow = (px, s) => { const k = Math.min(s - 3, 9); if (k >= 3) { cv.line(px - k * 0.75, cy - k, px, cy, 3, lit); cv.line(px, cy, px - k * 0.75, cy + k, 3, lit); } };
            cv.fillRect(x, cy - R, w, 2 * R, t.track);
            if (known) {
                cv.fillRect(x, cy - R, cx - x, 2 * R, withAlpha(col, f > 0 ? 0.3 : 0.14));           // the gas up to the plate
                if (f > 0) {
                    const s = Math.max(2, R * f);
                    cv.fillRect(cx, cy - s, x + w - cx, 2 * s, withAlpha(col, 0.3));                // what gets past it
                    [0.3, 0.64].forEach((k) => arrow(x + (cx - x) * k, R));
                    [0.4, 0.74].forEach((k) => arrow(cx + (x + w - cx) * k, s));
                }
            }
            cv.fillRect(x, cy - R - 4, w, 4, t.tick); cv.fillRect(x, cy + R, w, 4, t.tick);          // the pipe
            cv.arc(cx, cy, R + 5, R + 9, 0, 360, t.tick);                                             // the valve's body
            const a = f * 80 * Math.PI / 180, dx = Math.sin(a) * (R - 2), dy = Math.cos(a) * (R - 2), pc = known ? t.text : t.tick;
            cv.line(cx - dx, cy + dy, cx + dx, cy - dy, 7, pc);                                       // the plate
            cv.circle(cx, cy, 5.5, t.bg); cv.circle(cx, cy, 2.5, pc);
        }

        /** One EGR valve in its column (ys: the tops of its pill, picture and row): OPEN / CLOSED, the opening, the target. */
        function egr(cv, t, x, w, ys, label, v) {
            const known = has(v.pos), open = known && v.pos >= EGR_OPEN, absent = !known && v.why === 'not on this car';
            cv.text(label, x, ys[0] + 16, 22, t.dim, { font: 'bold', spacing: 1.5 });
            banner(cv, t, x, ys[0] + 30, w, 60, known ? (open ? 'OPEN' : 'CLOSED') : absent ? 'NOT FITTED' : '--', flow(t), open ? 'fill' : known ? 'plain' : 'off');
            valve(cv, t, x, ys[1], w, 68, known ? Math.max(0, v.pos) / 100 : null, flow(t));
            if (known) row(cv, t, x, w, ys[2] + 16, 'VALVE OPENING', String(Math.round(Math.max(0, v.pos))), '%', has(v.target) ? 'target ' + Math.round(Math.max(0, v.target)) + ' %' : '');
            else cv.text(absent ? 'this engine has none' : fitText(cv, v.why, 22, w), x, ys[2] + 30, 22, t.dim);
        }

        /** A bar (G.bar) with its target: a tick over the bar where the value should be, the number beside the label. */
        function targetBar(cv, t, x, y, w, g) {
            G.bar(cv, t, x, y, w, 96, g);
            if (!has(g.target)) return;
            cv.text('target ' + G.fmt(g.target, g.decimals), x + 20 + cv.textWidth(g.label.toUpperCase(), 22, { font: 'bold', spacing: 2 }), y + 26, 20, t.dim);
            cv.fillRect(x + G.clamp(g.target / g.max, 0, 1) * (w - 18) + 16, y + 33, 4, 9, t.text);
        }

        /**
         * The injectors' quantity corrections: a cell a cylinder (as M Vitals' misfires), in the cylinders' order (cyl: the
         * cylinder of each of inj), the bar from the middle (right = more fuel).
         */
        function injectors(cv, t, x, y, w, h, inj, cyl) {
            const n = inj.length, gap = 8, cw = (w - gap * (n - 1)) / n;
            inj.map((q, i) => ({ q, cyl: cyl[i] })).sort((a, b) => a.cyl - b.cyl).forEach((c, i) => {
                const q = c.q, cx = x + i * (cw + gap), mid = cx + cw / 2, ok = has(q), hit = ok && Math.abs(q) > INJ_WARN, by = y + h - 20;
                cv.roundRect(cx, y, cw, h, 8, withAlpha(hit ? t.warn : t.track, hit ? 0.18 : 0.9));
                cv.text((cw > 84 ? 'Cyl ' : '') + c.cyl, mid, y + 28, 22, t.dim, { align: 'center', font: 'bold' });
                cv.text(ok ? (q > 0 ? '+' : '') + q.toFixed(1) : '--', mid, by - 12, cw > 84 ? 34 : 28, !ok ? t.dim : hit ? t.warn : t.text, { align: 'center', font: 'num' });
                cv.roundRect(cx + 12, by, cw - 24, 6, 3, withAlpha(t.tick, 0.55));
                if (ok) { const len = Math.max(3, G.clamp(Math.abs(q) / INJ_FULL, 0, 1) * (cw - 24) / 2); cv.roundRect(q > 0 ? mid : mid - len, by, len, 6, 3, hit ? t.warn : flow(t)); }
                cv.fillRect(mid - 1, by - 3, 2, 12, t.text);
            });
        }

        function renderEngine(cv, t, d) {
            // ---- the EGR valves, a column each; under them what they are there for
            const p = G.panel(cv, t, LX, G.TOP, LW, 468, 'EGR valves'), pb = p.y + p.h, cw = 400, x1 = LX + PAD, x2 = LX + LW - PAD - cw;
            const shut = (v) => has(v.pos) ? v.pos < EGR_OPEN : v.why === 'not on this car';
            if (d.phase === 'active' && has(d.egrHp.pos) && shut(d.egrHp) && shut(d.egrLp)) cv.text('closed while the filter regenerates', LX + LW - PAD, G.TOP + 42, 20, t.dim, { align: 'right' });
            const ys = spread(G.TOP + 52, pb - G.MARGIN + 6, [90, 68, 48, 1, 48]);
            egr(cv, t, x1, cw, ys, 'HIGH PRESSURE', d.egrHp);
            egr(cv, t, x2, cw, ys, 'LOW PRESSURE', d.egrLp);
            cv.fillRect(x1, ys[3], LW - 2 * PAD, 1, withAlpha(t.tick, 0.6));
            row(cv, t, x1, cw, ys[4] + 16, 'EGR RATE', num(d.egrRate, 0), '%', has(d.egrRate) ? 'exhaust gas in the intake air' : d.why('egrRate'));
            row(cv, t, x2, cw, ys[4] + 16, 'AIR MASS', num(d.air, 0), 'mg/stroke', has(d.air) ? (has(d.airTarget) ? 'target ' + Math.round(d.airTarget) : '') : d.why('air'));
            // ---- fuel and boost against their targets, the injectors
            const q = G.panel(cv, t, RX, G.TOP, RW, 468, 'Fuel and boost'), x = RX + PAD, w = RW - 2 * PAD, qb = q.y + q.h, ih = 96 + Math.round((q.h - 468) / 2);
            const bs = spread(G.TOP + 46, qb - G.MARGIN + 10, [96, 96, 36 + ih]);
            const over = (a, b, lim) => (has(a) && a > lim) || (has(b) && b > lim);            // (a longer scale for the few engines past the usual one)
            targetBar(cv, t, x, bs[0], w, { label: 'Rail pressure', value: d.rail, unit: 'bar', max: over(d.rail, d.railTarget, 2500) ? 3000 : 2500, step: 500, decimals: 0, target: d.railTarget });
            targetBar(cv, t, x, bs[1], w, { label: 'Boost', value: d.boost, unit: 'bar', max: over(d.boost, d.boostTarget, 3) ? 4 : 3, step: 0.5, decimals: 2, target: d.boostTarget });
            cv.text('INJECTOR CORRECTION', x, bs[2] + 18, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text('mg/stroke, at warm idle', x + 14 + cv.textWidth('INJECTOR CORRECTION', 22, { font: 'bold', spacing: 1.5 }), bs[2] + 18, 20, t.dim);
            injectors(cv, t, x, bs[2] + 36, w, ih, d.inj, d.injCyl);
        }

        /* ---------- Details ---------- */

        /** Every value with its identifier and the reply's bytes, in two columns (the pages turn: Prev / Next, or every 8 s). */
        function renderDetails(cv, t, d) {
            const s = src(), rows = s.rows(), y0 = 118, pitch = 37;
            const per = 2 * (Math.floor((G.pageBottom(cv) - G.MARGIN - y0) / pitch) + 1), pages = Math.max(1, Math.ceil(rows.length / per));
            if (!cv.own && Date.now() - detailT > 8000) { detail = (detail + 1) % pages; detailT = Date.now(); }
            detail = Math.min(detail, pages - 1);
            const title = 'Details' + (pages > 1 ? '  ' + (detail + 1) + '/' + pages : ''), p = G.panel(cv, t, LX, G.TOP, W - 2 * LX, 468, title);
            // (drawn literally for the identifiers: its words translated first)
            const id = d.demo ? tr('DEMO') : d.index ? tr('engine unit') + ' ' + d.index + (d.family ? ' · ' + (d.family === 'other' ? tr('Not a diesel') : D.NAMES[d.family] || d.family)
                + (d.verified ? '' : ' · ' + tr('Unverified')) : ': ' + tr('not identified yet')) : tr('engine unit') + ': ' + tr('not identified yet');
            const scr = d.scrIndex ? '  ·  ' + tr('AdBlue unit') + ' ' + d.scrIndex + (d.scr ? ' (' + d.scr.toUpperCase() + ')' : '') : '';
            // (left of the page's buttons where the kit draws them)
            const paged = cv.own && pages > 1, ir = paged ? 1312 : W - LX - PAD, tw = cv.textWidth(title, 26, { font: 'bold' });
            cv.text(fitText(cv, id + scr, 20, ir - (LX + 18 + tw + 24), { literal: true }), ir, p.y + 42, 20, t.dim, { align: 'right', literal: true });
            if (!rows.length) { cv.text('Nothing read yet', LX + PAD, 140, 26, t.dim); return; }
            rows.slice(detail * per, detail * per + per).forEach((r, i) => {
                const x = LX + PAD + (i >= per / 2 ? 764 : 0), y = y0 + (i % (per / 2)) * pitch, n = r.value, ok = n !== null;
                cv.text(LABELS[r.key] || r.key, x, y, 22, t.text);
                cv.text((r.ecu === D.SCR ? '0B ' : '') + r.did, x + 290, y, 18, t.dim, { literal: true });
                if (ok) {
                    cv.text((Math.abs(n) >= 1000 ? thousands(n) : Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) < 10 ? 2 : 1)) + (r.unit ? ' ' + (r.unit === 'l' ? 'L' : r.unit) : ''),
                        x + 530, y, 22, t.text, { align: 'right', literal: true });
                } else {
                    // why there is none: under the values where it is short, else from the identifier on (over the bytes' room)
                    const long = cv.textWidth(r.why, 22) > 150;
                    cv.text(fitText(cv, r.why, 22, long && r.bytes ? 166 : 360), long ? x + 372 : x + 530, y, 22, t.dim, { align: long ? 'left' : 'right' });
                }
                if (r.bytes) cv.text(fitText(cv, r.bytes, 18, 190, { literal: true }), x + 546, y, 18, t.dim, { literal: true });
            });
            if (pages > 1) {
                G.button(cv, t, 1336, p.y + 12, 104, 40, '<', () => { detail = (detail + pages - 1) % pages; return render(); }, { key: 'dprev' });
                G.button(cv, t, 1452, p.y + 12, 104, 40, '>', () => { detail = (detail + 1) % pages; return render(); }, { key: 'dnext' });
            }
        }

        function render() {
            const t = ctx.theme(), now = Date.now(), d = data();
            sample(d);
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (!d.demo && d.family === 'other') message(cv, t, 'Not a diesel engine unit', 'This car\'s engine unit (SGBD index ' + d.index + ') is not a diesel one (DDE).', 'The app reads B47 / B57 diesels only.');
            else if (!d.demo && page !== 4 && (d.status === 'NO LINK' || (!d.family && d.status !== 'IDENTIFYING'))) {
                const parked = d.status === 'PARKED';
                message(cv, t, d.status === 'NO LINK' ? 'No diagnostic link' : parked ? 'The car is parked and locked' : 'The engine unit doesn\'t answer',
                    d.status === 'NO LINK' ? 'The head unit\'s diagnostic service isn\'t there yet.' : 'Switch the ignition on or start the engine.', null, parked ? t.text : null);
            } else if (sheet) renderSheet(cv, t, d);
            else [renderDpf, renderRegens, renderAdblue, renderEngine, renderDetails][page](cv, t, d, now);
            // the state's badge: an unverified engine unit's LIVE says UNVERIFIED instead (two badges at most: with REGEN, not
            // the whole word, the header still has room for the app's name, so the tabs stay where they are)
            const state = d.demo ? 'DEMO' : d.status === 'LIVE' && d.diesel && !d.verified ? 'UNVERIFIED' : d.status === 'PARKED' ? 'CAR PARKED' : d.status;
            G.frame(cv, t, TABS, page, [
                d.phase === 'active' && page !== 0 && { text: 'DPF REGEN', color: t.warn },
                { text: state, color: state === 'LIVE' ? BLUE : t.warn },
            ]);
            // the demo switched off (the link came up) or on: what to read follows
            if (d.demo !== lastDemo) { lastDemo = d.demo; wanted(); }
            return ui.image('MAIN_GFX', cv);
        }

        // every screen refresh (60 fps) with the GPU renderer; 4 fps in software
        ctx.loop('MAIN', 4, render);
        render().then(() => ctx.log.info('first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});
