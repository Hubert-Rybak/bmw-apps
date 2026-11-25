'use strict';
/**
 * test_hr_diesel.js - the Diesel app (apps/hr_diesel) without a car or SDK:
 *   - dde.js: the identifier table (every SGBD index BMW lists for the B47 / B57 engine units has its layout family),
 *     the layouts' scalings on crafted bytes, d94 / unknown read as DDE 8.3;
 *   - reader.js against a stand-in engine unit: identification, only 22 reads to 0x12 / 0x0B, one identifier a request
 *     until its length is known and then several, a refusal counted as "not on this car" only after its own single
 *     reads, nothing read while the car is locked and left, a petrol engine unit left alone, DDE 7's EGR identifiers,
 *     the AdBlue unit's tank;
 *   - force.js: the regeneration request's two blocks as BimmerLink sends them, when it may be sent, the answer;
 *   - regen.js: a regeneration by the engine unit's flags (467E, PID 8B) and by the heat, done (the distance since the last one back to
 *     0) or stopped, a stuck flag ignored, the regeneration point from the load % / the average / the log / typical,
 *     due and requested, the soot history and the app's distance, saved and loaded again;
 *   - demo.js: its seeded log and every value the pages draw;
 *   - main.js: every page drawn in the demo, with no link and on a petrol engine unit, without an error.
 *   node tests/test_hr_diesel.js
 * Node 8 compatible (the head unit's).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..'), KIT = path.join(ROOT, 'kit', 'runtime'), APP = path.join(ROOT, 'apps', 'hr_diesel');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), p));
const rmTree = (p) => { try { fs.readdirSync(p).forEach((f) => { const q = path.join(p, f); if (fs.lstatSync(q).isDirectory()) rmTree(q); else fs.unlinkSync(q); }); fs.rmdirSync(p); } catch (e) { /* gone */ } };
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= (eps || 1e-6), (what || '') + ': ' + a + ' vs ' + b);

// the app's files require './kit/<x>' (build.py copies kit/runtime there) and their siblings './<x>'
const load = Module._load;
let stubs = {};
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.indexOf('./kit/') === 0) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    if (parent && parent.filename && path.dirname(parent.filename) === APP && req.indexOf('./') === 0) return load.call(this, path.join(APP, req.slice(2)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const D = require(path.join(APP, 'dde'));
const { Reader } = require(path.join(APP, 'reader'));
const { Regen } = require(path.join(APP, 'regen'));
const { DemoReader } = require(path.join(APP, 'demo'));

const hex2 = (b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
const u16 = (v) => [(v >> 8) & 0xFF, v & 0xFF];
const u32 = (v) => [(v >>> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
const quiet = () => { const logs = []; return { logs, info: (m) => logs.push(m), warn: (m) => logs.push('W ' + m), error: (m) => logs.push('E ' + m) }; };

/**
 * A stand-in diagnostic link with units = { 0x12: { index: '0F2670', dids: { '44BE': [bytes] }, refuse: { '4D3B': 0x31 } }, 0x0B: ... }:
 * 22 F1 50 answers the index; 22 <DID>... answers the DIDs it has (one reply, 62 <DID> <data> ...), or 7F 22 31 / the
 * refusal. sent: ['12:22 44BE 44B9', ...]
 */
function fakeLink(units) {
    const l = { sent: [], ready: true, available: true, woken: [], cancelled: 0 };
    l.silent = () => false;
    l.wake = (t) => l.woken.push(t);
    l.cancel = () => { l.cancelled++; };
    l.physical = (target, sid, data, timeoutMs, accept) => {
        const ids = [];
        for (let i = 0; i + 1 < data.length; i += 2) ids.push(hex2(data[i]) + hex2(data[i + 1]));
        l.sent.push(hex2(target) + ':' + hex2(sid) + ' ' + ids.join(' '));
        assert.strictEqual(sid, 0x22, 'only 22 is ever sent');
        const u = units[target];
        if (!u) return Promise.resolve(null);
        let r;
        if (ids.length === 1 && ids[0] === 'F150') r = u.index ? [0x62, 0xF1, 0x50].concat([0, 2, 4].map((i) => parseInt(u.index.slice(i, i + 2), 16))) : [0x7F, 0x22, 0x31];
        else {
            const refused = ids.length === 1 && u.refuse && u.refuse[ids[0]];
            if (refused) r = [0x7F, 0x22, refused];
            else {
                r = [0x62];
                ids.forEach((id) => { if (u.dids[id]) r = r.concat(u16(parseInt(id, 16)), u.dids[id]); });
                if (r.length === 1) r = [0x7F, 0x22, 0x31];
            }
        }
        if (accept && !accept(r)) throw new Error('reply not accepted: ' + r.map(hex2).join(' '));
        return Promise.resolve(r);
    };
    l.readMany = (target, dids, ms) => l.physical(target, 0x22, [].concat.apply([], dids.map((d) => u16(d))), ms, (u) => (u[0] === 0x62 && dids.indexOf((u[1] << 8) | u[2]) >= 0) || (u[0] === 0x7F && u[1] === 0x22));
    l.read = (target, did, ms) => l.readMany(target, [did], ms);
    return l;
}
const settings = (o) => { const s = Object.assign({ demo: 'off' }, o); return { get: (k) => s[k], set: (k, v) => { s[k] = v; }, onChange() {} }; };
async function until(fn, ms, what) {
    const t0 = Date.now();
    while (!fn()) { if (Date.now() - t0 > (ms || 4000)) throw new Error('timed out: ' + (what || fn)); await sleep(20); }
}
// a B57's engine unit (DDE 8.3) with the filter's values: soot 11.72 g, 260 km since the last regeneration ...
const DDE83 = () => ({
    index: '0F2670',
    dids: {
        '44BE': u16(768), '44B9': u16(1200), '44BD': u16(2500), '44ED': u16(Math.round(1012 / 0.04577707) + 1), '44EF': u16(Math.round(350 / 0.03128099)),
        '44BF': u32(260000), '44B8': u16(287), '44C7': u16(441), '5372': [0x00], '5371': u16(32767 + 128), '4D8C': u16(Math.round(434 / 0.01220703)),
        '4D8A': u16(Math.round(436 / 0.01220703)),
    },
    refuse: { '4D3B': 0x31 },
});

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/* ---------- force.js ---------- */
test('force: BimmerLink\'s two blocks byte for byte; none for an engine unit it doesn\'t know', () => {
    const { Force } = require(path.join(APP, 'force'));
    const z = (n) => new Array(n + 1).join('00');
    // as in BimmerLink 2.38.1 (models/b$c: the 2E request to 0x12), DDE 8.3 (its SGBD indexes) and every other DDE
    const A = '2e5f' + 'b4' + z(15) + z(16) + z(12) + '4e200000' + z(16) + z(16) + z(16);
    const B = '2e5f' + 'b4040605' + z(12) + z(16) + z(14) + '4e20' + z(16) + z(16) + z(16) + '0000';
    const req = (f) => [0x2E].concat(Force.block(f)).map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
    assert.strictEqual(req('d83'), A); assert.strictEqual(req('d83').length / 2, 98);
    assert.strictEqual(req('d7x'), B); assert.strictEqual(req('d94'), B); assert.strictEqual(B.length / 2, 100);
    assert.strictEqual(Force.block('unknown'), null); assert.strictEqual(Force.block('other'), null); assert.strictEqual(Force.block(null), null);
});

test('force: sent only when it may be, once; the engine unit\'s answer told', async () => {
    const real = require(path.join(KIT, 'diag')), sent = [];
    let answer = [0x6E, 0x5F, 0xB4];
    class FakeDiag { init() { return Promise.resolve(this); } physical(target, sid, data, ms, accept) {
        sent.push([target, sid].concat(data)); const u = answer; return Promise.resolve(accept(u) ? u : null); } }
    stubs['./kit/diag'] = Object.assign({}, real, { Diag: FakeDiag });
    delete require.cache[require.resolve(path.join(APP, 'force'))];
    try {
        const { Force } = require(path.join(APP, 'force'));
        const f = new Force({ signals: {}, log: quiet() }), ok = { family: 'd83', status: 'LIVE', phase: 'ok', locked: false, demo: false };
        assert.strictEqual(f.can(ok), null);
        assert.strictEqual(f.can(Object.assign({}, ok, { family: 'unknown' })), 'not for this engine unit');
        assert.strictEqual(f.can(Object.assign({}, ok, { status: 'NO ANSWER' })), 'the engine unit isn\'t answering');
        assert.strictEqual(f.can(Object.assign({}, ok, { phase: 'active' })), 'regenerating');
        assert.strictEqual(f.can(Object.assign({}, ok, { locked: true })), 'blocked by the engine unit');
        assert.deepStrictEqual(await f.request('d83', true), { ok: true, demo: true }); assert.strictEqual(sent.length, 0, 'the demo sends nothing');
        const g = new Force({ signals: {}, log: quiet() });
        answer = [0x7F, 0x2E, 0x22];
        assert.deepStrictEqual(await g.request('d7x'), { ok: false, why: 'conditions not correct' });
        assert.strictEqual(g.can(ok), null, 'a refused one may be tried again');
        answer = [0x6E, 0x5F, 0xB4];
        assert.deepStrictEqual(await g.request('d7x'), { ok: true });
        assert.strictEqual(sent.length, 2); assert.strictEqual(sent[1][0], 0x12); assert.strictEqual(sent[1][1], 0x2E); assert.strictEqual(sent[1].length, 1 + 100);
        assert.strictEqual(g.can(ok), 'already requested', 'then none for a while');
        assert.deepStrictEqual(await g.request('unknown'), { ok: false, why: 'not for this engine unit' }); assert.strictEqual(sent.length, 2);
    } finally { delete stubs['./kit/diag']; delete require.cache[require.resolve(path.join(APP, 'force'))]; }
});

/* ---------- dde.js ---------- */
test('dde: every B47 / B57 engine unit in BMW\'s index has its layout family', () => {
    const I = require(path.join(ROOT, 'kit', 'tools', 'fixtures', 'sgbd_index.json'));
    const want = { D83BX7C0: 'd83', D75BX7A0: 'd7x', D70BX7A0: 'd7x', D94BX7A0: 'd94' };
    let n = 0;
    Object.keys(I).filter((k) => /^12 /.test(k) && want[I[k]]).forEach((k) => { n++; assert.strictEqual(D.familyOf(k.slice(3)), want[I[k]], k + ' ' + I[k]); });
    assert.ok(n >= 13, n + ' indexes');
    Object.keys(D.FAMILY).forEach((i) => assert.ok(want[I['12 ' + i]], i + ' is a diesel engine unit in the index'));
    assert.strictEqual(D.familyOf('0F26E8'), null, 'a B58 (DME8FF_R) is not one');
    assert.strictEqual(D.scrFamilyOf('0F2940'), 'scr04');
    assert.strictEqual(D.scrFamilyOf('0F22B0'), 'scr03');
});

test('dde: the layouts are whole and their scalings right on crafted bytes', () => {
    Object.keys(D.VALUES).forEach((k) => {
        const v = D.VALUES[k];
        ['d83', 'd7x', 'scr04', 'scr03'].forEach((f) => {
            const s = v[f];
            if (!s) return;
            assert.ok(/^[0-9A-F]{4}$/.test(s.did), k + ' ' + f + ' did');
            assert.ok([1, 2, 4].indexOf(s.bytes) >= 0, k + ' ' + f + ' bytes');
            assert.ok(typeof s.min === 'number' && typeof s.max === 'number' && s.min < s.max, k + ' ' + f + ' range');
        });
        assert.ok(v.d83 || v.scr04, k + ' has a layout');
    });
    near(D.decode(D.specOf('soot', 'd83'), u16(768)), 11.7189, 1e-3, 'soot');
    near(D.decode(D.specOf('sinceKm', 'd7x'), u32(260000)), 260, 1e-9, 'distance since the last regeneration (m)');
    near(D.decode(D.specOf('loadPct', 'd83'), u16(32767 + 255)), 100, 0.01, 'load % (PID 8B C)');
    near(D.decode(D.specOf('dp', 'd83'), u16(Math.round(1012 / 0.04577707))), 12, 0.03, 'pressure drop');
    near(D.decode(D.specOf('tDpf', 'd83'), u16(Math.round(650 / 0.03128099))), 600, 0.02, 'heat before the filter');
    near(D.decode(D.specOf('egrHp', 'd83'), u16(Math.round(434 / 0.01220703))), 34, 0.02, 'DDE 8 EGR');
    near(D.decode(D.specOf('egrHp', 'd7x'), u16(Math.round(134 / 0.004578))), 34, 0.01, 'DDE 7 EGR');
    near(D.decode(D.specOf('inj1', 'd83'), u16(32767 + 120)), 1.2, 1e-6, 'DDE 8 injector');
    near(D.decode(D.specOf('inj1', 'd7x'), u16(Math.round(100.5 / 0.003052))), 0.5, 0.002, 'DDE 7 injector');
    assert.strictEqual(D.decode(D.specOf('soot', 'd83'), [0xFF, 0xFF]), null, 'out of range (1,000 g) = no value');
    assert.strictEqual(D.decode(D.specOf('soot', 'd83'), [0x01]), null, 'too short');
    assert.strictEqual(D.specOf('egrHp', 'd7x').did, '4C97', 'DDE 7: the position, not the duty cycle (4C8C)');
    assert.strictEqual(D.specOf('egrHp', 'd94').did, '4D8C', 'DDE 9 read as DDE 8.3');
    assert.strictEqual(D.specOf('pid8b', 'd7x'), null, 'no PID 8B status on DDE 7');
    assert.ok(!D.verified('d94') && !D.verified('unknown') && D.verified('d83') && D.verified('d7x'));
});

/* ---------- reader.js ---------- */
async function reading(units, opts, fn) {
    const link = fakeLink(units), log = quiet();
    const r = new Reader(Object.assign({ link, log, settings: settings() }, opts)).start();
    try { await fn(r, link, log); } finally { r.stop(); }
}

test('reader: identifies a DDE 8.3, reads only 22 from 0x12, batches once the lengths are known', () => reading({ 0x12: DDE83() }, {}, async (r, link) => {
    r.want('ui', ['soot', 'sootMeas', 'ash', 'dp', 'tDpf', 'sinceKm', 'regens', 'avgKm'], 150);
    await until(() => r.value('soot') !== null && r.value('avgKm') !== null, 5000, 'first values');
    assert.strictEqual(r.family, 'd83'); assert.ok(r.verified); assert.ok(r.diesel);
    near(r.value('soot'), 11.7189, 1e-3); near(r.value('sinceKm'), 260, 1e-9); assert.strictEqual(r.value('regens'), 287);
    await until(() => link.sent.some((s) => s.split(' ').length > 2), 5000, 'a request with several identifiers');
    assert.ok(link.sent.every((s) => /^12:22 /.test(s)), 'only 22 to the engine unit: ' + link.sent.join(', '));
    assert.ok(link.sent.every((s) => s.split(' ').length - 1 <= 8), 'at most 8 identifiers a request');
    assert.strictEqual(r.status(), 'LIVE');
    assert.strictEqual(r.why('soot'), '');
}));

test('reader: a refusal counts as "not on this car" only after its own single reads; others are not blamed', () => reading({ 0x12: DDE83() }, {}, async (r, link) => {
    r.want('ui', ['egrHp', 'egrLp'], 100);
    await until(() => r.value('egrHp') !== null, 4000, 'EGR high pressure');
    near(r.value('egrHp'), 34, 0.02);
    assert.notStrictEqual(r.why('egrLp'), 'not on this car', 'one refusal is not enough');
    // the retry waits ABSENT_RETRY_MS: bring it forward
    for (let i = 0; i < Reader.ABSENT_AFTER + 1; i++) { Object.keys(r.dids).forEach((k) => { if (/4D3B/.test(k)) r.dids[k].absentUntil = 0; }); await sleep(260); }
    assert.strictEqual(r.why('egrLp'), 'not on this car');
    assert.strictEqual(r.value('egrHp') !== null, true, 'the high-pressure valve still read');
    assert.ok(link.sent.filter((s) => /4D3B/.test(s)).every((s) => s === '12:22 4D3B' || s.split(' ').length > 2), 'refused one asked alone');
}));

test('reader: nothing is read while the car is locked and left', async () => {
    let left = true;
    await reading({ 0x12: DDE83() }, { canRead: () => !left }, async (r, link) => {
        r.want('bg', ['soot'], 100);
        await sleep(600);
        assert.deepStrictEqual(link.sent, [], 'no request');
        assert.strictEqual(r.status(), 'PARKED');
        left = false;
        await until(() => r.value('soot') !== null, 4000, 'read once back');
    });
});

test('reader: a petrol engine unit is left alone; an unknown one that answers like a DDE is read, unverified', async () => {
    await reading({ 0x12: { index: '0F26E8', dids: {} } }, { engineType: () => 'petrol' }, async (r, link) => {
        r.want('ui', ['soot', 'dp'], 100);
        await until(() => r.family !== null, 3000, 'identified');
        await sleep(400);
        assert.strictEqual(r.family, 'other'); assert.ok(!r.diesel);
        assert.deepStrictEqual(link.sent, ['12:22 F150'], 'only its index asked');
        assert.strictEqual(r.status(), 'NOT A DIESEL');
        assert.strictEqual(r.why('soot'), 'not a diesel engine unit');
    });
    const unknown = DDE83(); unknown.index = '0F3000';
    await reading({ 0x12: unknown }, {}, async (r) => {
        r.want('ui', ['soot'], 100);
        await until(() => r.value('soot') !== null, 4000, 'soot');
        assert.strictEqual(r.family, 'unknown'); assert.ok(r.diesel); assert.ok(!r.verified);
    });
});

test('reader: an unknown index is "not a diesel" only on two definite refusals; a tap on the tab asks again', async () => {
    const u = { index: '0F3000', dids: {}, refuse: { '44BE': 0x22, '44BF': 0x22 } };
    await reading({ 0x12: u }, {}, async (r, link) => {
        r.want('ui', ['soot'], 100);
        await until(() => link.sent.filter((x) => x === '12:22 F150').length >= 2, 9000, 'asked again after an inconclusive answer');
        assert.strictEqual(r.family, null, '7F 22 22 (conditions) decides nothing');
        u.refuse = { '44BE': 0x31, '44BF': 0x31 };
        await until(() => r.family === 'other', 9000, 'refused as unknown: not a diesel');
        assert.strictEqual(r.status(), 'NOT A DIESEL');
        u.refuse = {}; u.dids = DDE83().dids;
        r.refresh();
        await until(() => r.value('soot') !== null, 9000, 'identified again on refresh');
        assert.strictEqual(r.family, 'unknown');
    });
    await reading({ 0x12: { index: '0F26E8', dids: DDE83().dids } }, {}, async (r, link) => {
        r.want('ui', ['soot'], 100);
        await until(() => r.family !== null, 3000, 'identified');
        r.refresh(); await sleep(400);
        assert.strictEqual(r.family, 'other', 'a known petrol unit stays one');
        assert.deepStrictEqual(link.sent, ['12:22 F150'], 'and is never probed');
    });
});

test('reader: NO ANSWER holds until the engine unit answers again, not just until it is woken', () => reading({ 0x12: DDE83() }, {}, async (r, link) => {
    let quiet = false;
    link.silent = () => quiet;
    r.want('ui', ['soot'], 100);
    await until(() => r.value('soot') !== null, 4000, 'first value');
    quiet = true; await sleep(700);
    assert.strictEqual(r.status(), 'NO ANSWER');
    quiet = false;                                                   // woken: the counter cleared, no answer yet
    assert.strictEqual(r.status(), 'NO ANSWER', 'still, until a reply');
    await until(() => r.status() === 'LIVE', 4000, 'live again after a reply');
}));

test('reader: DDE 7 reads its own EGR identifiers; the AdBlue unit\'s tank from 0x0B', () => {
    const dde7 = { index: '0F1F80', dids: { '4C97': u16(Math.round(125 / 0.004578)), '4C93': u16(Math.round(126 / 0.004578)), '4692': u16(Math.round(5000 / 0.15259022)) } };
    const scr = { index: '0F2940', dids: { E439: u16(Math.round(11.5 / 0.00097656)) } };
    return reading({ 0x12: dde7, 0x0B: scr }, {}, async (r, link) => {
        r.want('ui', ['egrHp', 'egrHpSet', 'adRange', 'adLevel'], 100);
        await until(() => r.value('egrHp') !== null && r.value('adLevel') !== null, 5000, 'EGR and the tank');
        assert.strictEqual(r.family, 'd7x'); near(r.value('egrHp'), 25, 0.01); near(r.value('adLevel'), 11.5, 0.01); near(r.value('adRange'), 5000, 0.2);
        assert.ok(link.sent.some((s) => s === '0B:22 E439'), 'tank asked of the AdBlue unit');
        assert.ok(link.sent.filter((s) => /^0B:/.test(s)).every((s) => /^0B:22 (F150|E439)$/.test(s)), 'nothing else of it: ' + link.sent.join(', '));
        assert.ok(!link.sent.some((s) => /4D8C|4C8C/.test(s)), 'not the DDE 8 one, nor the duty cycle');
    });
});

/* ---------- regen.js ---------- */
const T0 = 1700000000000, S = 1000, MIN = 60 * S;
/**
 * Feeds rg as the background does, every `every` ms: legs = [[ms, values], ...], each leg's values fed (the numbers
 * held) until its time has passed; t continues from rg.t (wall clock).
 */
function drive(rg, legs, every) {
    every = every || 5 * S;
    if (rg.t === undefined) rg.t = T0;
    legs.forEach((leg) => { const end = rg.t + leg[0]; do { rg.feed(leg[1], rg.t); rg.t += every; } while (rg.t < end); });
}
const events = (rg) => { const ev = []; rg.onEvent((w) => ev.push(w)); return ev; };

test('regen: by the engine unit\'s flag, done when the distance since the last one starts again', () => {
    const rg = new Regen({}), ev = events(rg);
    drive(rg, [[10 * S, { soot: 23.8, sinceKm: 430, pid8b: 0, tDpf: 300, engine: true, loadPct: 99 }], [5 * S, { pid8b: 3, soot: 24.1 }],
        [8 * MIN, { soot: 12, sinceKm: 431, tDpf: 640 }]]);
    assert.strictEqual(rg.state().phase, 'active'); assert.strictEqual(rg.state().by, 'flag');
    near(rg.state().run.s, 8 * 60 + 5, 6, 'running time');
    drive(rg, [[5 * S, { soot: 2.4, sinceKm: 0.2, pid8b: 0, tDpf: 560 }]]);
    assert.deepStrictEqual(ev, ['start', 'complete']);
    const e = rg.log[0];
    assert.strictEqual(e.result, 'complete'); near(e.s, 8 * 60 + 5, 6); assert.strictEqual(e.interval, 430);
    assert.strictEqual(e.soot0, 24.1); assert.strictEqual(e.soot1, 2.4); assert.strictEqual(e.peak, 640);
    assert.strictEqual(rg.state().phase, 'ok');
});

test('regen: a wall-clock jump of hours is no time; a short pause (lights) goes on as the same one', () => {
    const rg = new Regen({}), ev = events(rg);
    drive(rg, [[10 * S, { soot: 24, sinceKm: 420, pid8b: 0, engine: true }], [4 * MIN, { pid8b: 3, soot: 18 }]]);
    rg.t += 2 * 3600 * S;                                                      // the head unit sets its clock
    drive(rg, [[2 * MIN, { pid8b: 3, soot: 15 }], [40 * S, { pid8b: 2, soot: 15 }], [3 * MIN, { pid8b: 3, soot: 3 }]]);
    rg.t -= 5 * 3600 * S;                                                      // and back
    drive(rg, [[5 * S, { pid8b: 0, sinceKm: 0.3, soot: 2.5 }]]);
    assert.deepStrictEqual(ev, ['start', 'complete'], 'one regeneration');
    near(rg.log[0].s, 4 * 60 + 2 * 60 + 3 * 60, 15, 'its running time: the jumps and the pause left out');
});

test('regen: one that ends without the distance starting again counts as stopped, only once the distance was read', () => {
    const rg = new Regen({});
    drive(rg, [[10 * S, { soot: 24, sinceKm: 420, pid8b: 0, engine: true }], [5 * MIN, { pid8b: 1, soot: 20 }], [S, { engine: false }]]);
    assert.strictEqual(rg.run, null, 'ended with the engine');
    // the next drive: the first feeds without the distance decide nothing
    drive(rg, [[Regen.SETTLE_MS + MIN, { engine: true, pid8b: 0, soot: 20 }]]);
    assert.strictEqual(rg.log.length, 0, 'not without the distance read');
    drive(rg, [[5 * S, { sinceKm: 424 }]]);
    assert.strictEqual(rg.log[0].result, 'stopped'); assert.strictEqual(rg.log[0].soot1, 20);
    const r2 = new Regen({});
    drive(r2, [[10 * S, { soot: 24, sinceKm: 420, pid8b: 0, engine: true }], [5 * MIN, { pid8b: 1, soot: 4 }], [S, { engine: false }],
        [Regen.SETTLE_MS + MIN, { engine: true, pid8b: 0 }], [5 * S, { sinceKm: 0.4 }]]);
    assert.strictEqual(r2.log[0].result, 'complete', 'its end read on the next drive: done');
});

test('regen: by the heat; a flag stuck at 0 or never seen at 0 doesn\'t stop it; no new one while the heat lingers', () => {
    [{ pid8b: 1 }, { pid8b: 0 }, {}].forEach((flag) => {
        const rg = new Regen({});
        drive(rg, [[10 * S, Object.assign({ soot: 24, sinceKm: 400, tDpf: 300, engine: true }, flag)], [25 * S, { tDpf: 600 }]]);
        assert.ok(!rg.run, 'not yet: 30 s of heat');
        drive(rg, [[15 * S, { tDpf: 600 }]]);
        assert.ok(rg.run, 'running by the heat, flag ' + JSON.stringify(flag)); assert.strictEqual(rg.state().by, 'heat');
        drive(rg, [[10 * MIN, { tDpf: 610, soot: 3 }], [5 * S, { sinceKm: 0.1, tDpf: 590 }]]);
        assert.strictEqual(rg.log[0].result, 'complete');
        drive(rg, [[MIN, { tDpf: 580 }]]);
        assert.strictEqual(rg.run, null, 'the lingering heat starts no new one');
    });
    const rg = new Regen({});
    drive(rg, [[10 * S, { soot: 24, sinceKm: 400, tDpf: 300, engine: true }], [MIN, { tDpf: 620 }], [10 * MIN, { soot: 3, tDpf: 620 }],
        [5 * S, { sinceKm: 0.1 }], [MIN, { tDpf: 300 }], [10 * S, { soot: 14 }], [MIN, { tDpf: 620 }]]);
    assert.ok(rg.run, 'after cooling, heat again (soot half way) is a new one');
});

test('regen: heat that burns no soot (towing) is not logged; a low soot is no regeneration by heat', () => {
    const rg = new Regen({}), ev = events(rg);
    drive(rg, [[10 * S, { soot: 20, sinceKm: 200, tDpf: 300, engine: true }], [4 * MIN, { tDpf: 530, soot: 20.1 }], [Regen.SETTLE_MS + MIN, { tDpf: 380, soot: 20.3, sinceKm: 204 }]]);
    assert.deepStrictEqual(ev, ['start']); assert.strictEqual(rg.log.length, 0, 'dropped');
    const r2 = new Regen({});
    drive(r2, [[10 * S, { soot: 6, sinceKm: 60, tDpf: 300, engine: true }], [4 * MIN, { tDpf: 540 }]]);
    assert.strictEqual(r2.run, null, '6 g of 24: not a regeneration');
});

test('regen: a restart in the middle goes on with the same one; a reset without a start is logged by its end', () => {
    const dir = tmp('diesel-'), file = path.join(dir, 'diesel.json');
    try {
        const a = new Regen({ file });
        drive(a, [[10 * S, { soot: 24, sinceKm: 430, pid8b: 0, engine: true }], [MIN, { pid8b: 3 }], [2 * MIN, { pid8b: 3, soot: 18 }]]);
        a.save(true);
        const b = new Regen({ file }), ev = events(b);
        b.t = a.t + 20 * S;
        drive(b, [[10 * S, { soot: 17.5 }], [3 * MIN, { pid8b: 3, soot: 10 }], [5 * S, { pid8b: 0, sinceKm: 0.2, soot: 2.6 }]]);
        assert.deepStrictEqual(ev, ['complete'], 'no stop, no second start');
        assert.strictEqual(b.log.length, 1); assert.strictEqual(b.log[0].soot0, 24); near(b.log[0].s, 6 * 60 + 10, 15);
        const c = new Regen({});
        drive(c, [[10 * S, { soot: 20, sinceKm: 380, engine: true }], [5 * S, { sinceKm: 0.3, soot: 2.2 }]]);
        assert.strictEqual(c.log[0].by, 'reset'); assert.strictEqual(c.log[0].interval, 380); assert.strictEqual(c.log[0].s, null);
    } finally { rmTree(dir); }
});

test('regen: the regeneration point from the load %, the average start, the log, else typical; due and requested', () => {
    const rg = new Regen({});
    assert.strictEqual(rg.threshold().by, 'typical'); assert.strictEqual(rg.threshold().g, Regen.TYPICAL_G);
    rg.feed({ avgStart: 26.5 }, T0); assert.deepStrictEqual(rg.threshold(), { g: 26.5, by: 'average' });
    rg.feed({ soot: 13, loadPct: 50 }, T0 + S); assert.strictEqual(rg.threshold().by, 'load'); near(rg.threshold().g, 26, 1e-9);
    assert.strictEqual(rg.state().phase, 'ok');
    rg.feed({ loadPct: 101 }, T0 + 2 * S); assert.strictEqual(rg.state().phase, 'due');
    const r2 = new Regen({});
    r2.log = [{ t0: 1, result: 'complete', soot0: 22 }, { t0: 2, result: 'complete', soot0: 26 }, { t0: 3, result: 'stopped', soot0: 40 }, { t0: 4, result: 'complete', soot0: 23 }];
    assert.deepStrictEqual(r2.threshold(), { g: 23, by: 'learned' });
    r2.feed({ soot: 10, rgnNum: 2 }, T0); assert.strictEqual(r2.state().requested, false, 'requested: 44BB at 4..6 (BimmerLink)');
    r2.feed({ rgnNum: 5 }, T0 + S);
    assert.strictEqual(r2.state().requested, true); assert.strictEqual(r2.state().phase, 'due');
    r2.feed({ rgnNum: 0 }, T0 + 2 * S); assert.strictEqual(r2.state().phase, 'ok');
    // asked for by the driver (force.js): due, and the next one within ASK_MS of driving is that one
    r2.asked(); assert.strictEqual(r2.state().asked, true); assert.strictEqual(r2.state().phase, 'due');
    r2.feed({ avgKm: 441, sinceKm: 300 }, T0 + 3 * S); near(r2.state().nextKm, 141, 1e-9);
});

test('regen: the operating mode\'s regeneration bit (467E bit 1) runs one, before PID 8B; one asked for is marked', () => {
    const rg = new Regen({}), ev = events(rg);
    rg.asked();
    drive(rg, [[10 * S, { soot: 20, sinceKm: 300, opMode: 1, pid8b: 0, tDpf: 300, engine: true }], [5 * MIN, { opMode: 3, soot: 15, tDpf: 300 }]]);
    assert.strictEqual(rg.state().phase, 'active', 'the bit alone, with no heat'); assert.strictEqual(rg.state().by, 'flag');
    assert.strictEqual(rg.state().asked, false, 'the asked one has started');
    drive(rg, [[5 * S, { opMode: 1, soot: 4, tDpf: 300 }]]);
    assert.notStrictEqual(rg.state().phase, 'active', 'the bit seen at 0 and 1: it alone ends it');
    drive(rg, [[5 * S, { sinceKm: 0.1, soot: 3 }]]);
    assert.deepStrictEqual(ev, ['start', 'complete']); assert.strictEqual(rg.log[0].asked, true);
    // the time to start it runs out with the driving
    const r2 = new Regen({});
    r2.asked(); drive(r2, [[Regen.ASK_MS + MIN, { soot: 10, sinceKm: 100, opMode: 1, engine: true }]], 60 * S);
    assert.strictEqual(r2.state().asked, false);
});

test('regen: the regeneration point holds while one runs (the load % stays up as the soot burns) and isn\'t learnt from it', () => {
    const dir = tmp('diesel-'), file = path.join(dir, 'diesel.json');
    try {
        // as on a G05 xDrive40d: the point 34 g, then a regeneration with the load % held near 100 while the soot falls
        const rg = new Regen({ file });
        drive(rg, [[2 * MIN, { soot: 33.6, loadPct: 98.8, sinceKm: 330, opMode: 1, tDpf: 300, engine: true }], [5 * S, { opMode: 3, soot: 34.3, loadPct: 100.9 }]]);
        near(rg.state().threshold, 34, 0.2, 'the point at the start');
        assert.strictEqual(rg.state().phase, 'active');
        drive(rg, [[6 * MIN, { soot: 26, loadPct: 96 }], [6 * MIN, { soot: 15, loadPct: 94 }]]);
        near(rg.state().threshold, 34, 0.2, 'the point while it runs');
        drive(rg, [[5 * S, { opMode: 1, soot: 3, loadPct: 9, sinceKm: 0.3 }]]);
        assert.strictEqual(rg.log[0].result, 'complete');
        near(rg.state().threshold, 34, 0.2, 'after it, not the soot it ended at');
        assert.strictEqual(rg.state().thresholdBy, 'load');
        rg.save(true);
        // a point saved before 0.10.2 (no thrV) may have followed the soot down: learnt again, the average meanwhile
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        near(new Regen({ file }).threshold().g, 34, 0.2, 'kept when saved with its version');
        delete saved.thrV; saved.thrLoad = 15.4; fs.writeFileSync(file, JSON.stringify(saved));
        const old = new Regen({ file });
        old.feed({ avgStart: 33.2 }, T0);
        assert.deepStrictEqual(old.threshold(), { g: 33.2, by: 'average' });
    } finally { rmTree(dir); }
});

test('regen: the app\'s distance through resets, the soot history, saved and loaded', () => {
    const dir = tmp('diesel-'), file = path.join(dir, 'diesel.json');
    try {
        const rg = new Regen({ file });
        let t = T0;
        for (let km = 0; km <= 1500; km += 1) {
            const since = km % 500, soot = 2 + since / 500 * 22;
            rg.feed({ soot, sinceKm: since, pid8b: 0, engine: true }, t += 60 * S);
        }
        near(rg.dist, 1500, 3, 'distance across 3 resets (at most a read\'s step lost at each)');
        assert.ok(rg.samples[0][0] >= rg.dist - Regen.HIST_KM - 2, 'history kept to the last 1,000 km');
        assert.ok(rg.samples.length > 100 && rg.samples.length <= 800);
        rg.save(true);
        const back = new Regen({ file });
        near(back.dist, rg.dist, 0.01); assert.strictEqual(back.samples.length, rg.samples.length); assert.strictEqual(back.lastSince, rg.lastSince);
        assert.strictEqual(back.seen0.pid8b, true); assert.deepStrictEqual(back.log.map((e) => e.by), rg.log.map((e) => e.by));
        fs.writeFileSync(file, '{ broken');
        assert.strictEqual(new Regen({ file }).dist, 0, 'a broken file starts afresh');
    } finally { rmTree(dir); }
});

/* ---------- demo.js ---------- */
test('demo: a seeded log with a stopped one, and every value the pages draw', () => {
    const d = new DemoReader(), rg = new Regen({});
    d.seed(rg);
    assert.ok(rg.log.length >= 4, rg.log.length + ' regenerations');
    assert.ok(rg.log.some((e) => e.result === 'stopped') && rg.log.some((e) => e.result === 'complete'));
    rg.log.filter((e) => e.result === 'complete').forEach((e) => { assert.ok(e.s >= 600 && e.s <= 1500, 'about 15 min: ' + e.s); assert.ok(e.peak > 550); });
    assert.ok(rg.samples.length > 100);
    Object.keys(D.VALUES).filter((k) => k !== 'inj5' && k !== 'inj6').forEach((k) => assert.ok(typeof d.value(k) === 'number', k));
    const m = DemoReader.model(DemoReader.LOAD_S + 30);
    assert.ok(m.regen && m.tDpf > 550 && (m.pid8b & 1) === 1, 'regenerating half way');
});

/* ---------- main.js ---------- */
const { Recorder } = require(path.join(KIT, 'record'));
const themes = require(path.join(KIT, 'themes'));
const SPEC = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));

/** main.js with a stubbed head unit and a stand-in reader: frames of every page as the texts drawn. */
async function app(opts) {
    let spec = null;
    const dir = tmp('diesel-app-'), S0 = {};
    SPEC.settings.forEach((s) => { S0[s.key] = s.default; });
    Object.assign(S0, opts.sets || {});
    let frame = null, tab = null; const handlers = {}, logs = [];
    const fake = opts.reader;
    stubs = {
        './kit/mgu': { run(a) { spec = a; } },
        './reader': { Reader: function () { return fake; } },
    };
    const main = path.join(APP, 'main.js');
    delete require.cache[main];
    require(main);
    stubs = {};
    const ctx = {
        settings: { get: (k) => S0[k], set: (k, v) => { S0[k] = v; }, onChange() {} },
        log: { info: (m) => logs.push(m), warn: (m) => logs.push('W ' + m), error: (m) => logs.push('E ' + m) },
        dataDir: dir, signals: { watch: () => Promise.resolve() },
        ui: { image: async () => {}, isVisible: () => true, onVisible() {}, onClick: (n, fn) => { handlers[n] = fn; } },
        theme: () => themes.theme(S0.theme), loop: (n, fps, fn) => { frame = fn; }, onTab: (fn) => { tab = fn; },
        canvas: (w, h) => { const c = new Recorder(w, h), texts = []; const tx = c.text.bind(c); c.text = (s, x, y, size, col, o) => { texts.push(String(s)); return tx(s, x, y, size, col, o); }; c.texts = texts; frames.push(c); return c; },
    };
    const frames = [];
    const realInterval = global.setInterval, timers = [];
    global.setInterval = (fn, ms) => { const h = realInterval(fn, ms); timers.push(h); return h; };
    try { await spec.start(ctx); } finally { global.setInterval = realInterval; }
    const pages = [];
    for (let p = 0; p < 5; p++) {
        if (p) await handlers.BTN_PAGE();
        await frame();
        pages.push(frames[frames.length - 1].texts.join(' | '));
    }
    timers.forEach((h) => clearInterval(h));
    rmTree(dir);
    return { pages, logs, tab, handlers };
}
const stand = (o) => Object.assign({ replied: false, family: null, index: null, scr: undefined, scrIndex: null, diesel: false, verified: false, lastGood: 0,
    link: { available: false, ready: false }, want() {}, refresh() {}, start() { return this; }, value: () => null, raw: () => null, age: () => null, why: () => 'reading...',
    status: () => 'NO LINK', rows: () => [] }, o);

test('main: every page in the demo, with no link and on a petrol engine unit, draws without an error', async () => {
    const demo = await app({ reader: stand(), sets: { demo: 'auto' } });
    assert.ok(/FILTER OK|REGENERATING|REGENERATION DUE/.test(demo.pages[0]), 'DPF status: ' + demo.pages[0].slice(0, 300));
    assert.ok(/DEMO/.test(demo.pages[0]));
    assert.ok(/ min /.test(demo.pages[1] + ' ') && / g/.test(demo.pages[1]), 'the demo log: ' + demo.pages[1].slice(0, 400));
    assert.ok(/ppm/.test(demo.pages[2]), 'AdBlue (NOx in ppm): ' + demo.pages[2].slice(0, 300));
    assert.ok(/OPEN|CLOSED/.test(demo.pages[3]), 'Engine: ' + demo.pages[3].slice(0, 300));
    assert.ok(/44BE/.test(demo.pages[4]), 'Details: ' + demo.pages[4].slice(0, 300));
    assert.deepStrictEqual(demo.logs.filter((m) => /^E |^W /.test(m)), [], 'no warnings');
    const off = await app({ reader: stand(), sets: { demo: 'off' } });
    assert.ok(/No diagnostic link/.test(off.pages[0]), off.pages[0].slice(0, 200));
    const petrol = await app({ reader: stand({ replied: true, family: 'other', index: '0F26E8', link: { available: true, ready: true }, status: () => 'NOT A DIESEL', why: () => 'not a diesel engine unit' }), sets: { demo: 'auto' } });
    assert.ok(/Not a diesel engine unit/.test(petrol.pages[0]) && /0F26E8/.test(petrol.pages[0]));
    const blank = await app({ reader: stand({ replied: true, family: 'd83', index: '0F2670', diesel: true, verified: true, link: { available: true, ready: true }, status: () => 'LIVE' }), sets: { demo: 'auto', distUnit: 'mi', tempUnit: 'f' } });
    assert.ok(/--/.test(blank.pages[0]) && /reading\.\.\./.test(blank.pages[0]), 'no values yet: dashes and why');
    assert.ok(/mi/.test(blank.pages[0]), 'miles');
});

(async () => {
    let failed = 0;
    for (const c of cases) {
        try { await c[1](); console.log('ok   ' + c[0]); } catch (e) { failed++; console.log('FAIL ' + c[0] + '\n     ' + (e && e.stack || e)); }
    }
    console.log('diesel: ' + cases.length + ' checks, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
})();
