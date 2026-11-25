'use strict';
/**
 * dde.js - what the Diesel app reads, and where: a B47 / B57 diesel's engine unit (DDE, address 0x12) and the AdBlue
 * unit (SCR, 0x0B), with UDS ReadDataByIdentifier (22) only (the regeneration request's one write: force.js).
 *
 * The identifiers and their layouts are from the units' SGBDs (the public EDIABAS reference,
 * https://emdzej.github.io/ediabasx-docs-sgbd/): D83BX7C0 (DDE 8.3x, the G-series B47 / B57), D75BX7A0 and D70BX7A0
 * (DDE 7.x, F-series B47 / N47 / N57), SCR04 and SCR03 (the AdBlue units). Each was checked field by field against
 * the SGBD's own tables. The engine unit tells which SGBD it has by its SGBD index (22 F1 50); FAMILY maps the index to
 * a layout family:
 *   d83  D83BX7C0                         layouts as in its SGBD
 *   d7x  D75BX7A0 / D70BX7A0              the same identifiers for the filter; other ones (and scales) for EGR and
 *                                         injectors; no 53xx after-treatment status, no 4B5x averages
 *   d94  D94BX7A0 (the newest DDE)        no public SGBD: read like d83, shown as unverified
 * A unit whose index isn't here (an unknown DDE) is read like d83 too, also unverified, once it answers like a DDE.
 *
 * VALUES[key] = { unit, live, d83: spec, d7x: spec, scr04: spec, scr03: spec }   (a missing family = not on that unit)
 *   spec = { did, bytes, at, factor, offset, signed, bit, min, max }  (kit/dids.js candidates)
 *   value = raw * factor + offset; outside min..max = not plausible (no value).
 *   live: read every few seconds while shown; else every SLOW_MS.
 */
const DDE = 0x12, SCR = 0x0B;

// the engine unit's SGBD index (22 F1 50) -> layout family (apps/live_data/builtin/sgbd_index.json, "12 <index>")
const FAMILY = {
    '0F1FE8': 'd83', '0F1FF0': 'd83', '0F1FF4': 'd83', '0F1FF8': 'd83', '0F2670': 'd83', '0F2674': 'd83', '0F2678': 'd83', '0F267C': 'd83',
    '0F1F70': 'd7x', '0F1F80': 'd7x', '0F1F90': 'd7x', '0F1FA0': 'd7x',
    '0F2C80': 'd94',
};
// petrol engine units (the index's other "12 <index>" SGBDs: DME8FF_R, MEVD17, MSD8x, S55, S63TU, N63TU, DME_BX8, DME9x...):
// definitely not a diesel, never probed
const PETROL = ['0F1090', '0F1370', '0F1380', '0F13E0', '0F13F0', '0F1780', '0F17F0', '0F1810', '0F1910', '0F19E0', '0F1A10', '0F1A20',
    '0F1D20', '0F1D22', '0F1D24', '0F1D26', '0F1EA0', '0F2220', '0F2422', '0F2424', '0F2426', '0F2427', '0F2428', '0F2429', '0F242A', '0F242C',
    '0F242E', '0F2460', '0F25A0', '0F25A2', '0F26B4', '0F26B8', '0F26BC', '0F26E0', '0F26E4', '0F26E8', '0F28E0', '0F2930', '0F2E00'];
// the AdBlue unit's index ("0B <index>"): SCR04 and SCR03 have the tank; SCR05 / SCR01 have no public layout we use
const SCR_FAMILY = { '0F2940': 'scr04', '0F22B0': 'scr03' };
// families read with another family's layouts, and shown as unverified
const READ_AS = { d94: 'd83', unknown: 'd83' };
const NAMES = { d83: 'DDE 8.3 (D83BX7C0)', d7x: 'DDE 7 (D75BX7A0 / D70BX7A0)', d94: 'DDE 9 (D94BX7A0)', unknown: 'unknown DDE' };

const u16 = (did, factor, offset, min, max, extra) => Object.assign({ did, bytes: 2, factor, offset: offset || 0, min, max }, extra);
const u32 = (did, factor, offset, min, max) => ({ did, bytes: 4, factor, offset: offset || 0, min, max });
const u8 = (did, min, max, extra) => Object.assign({ did, bytes: 1, factor: 1, offset: 0, min, max }, extra);
const same = (spec) => ({ d83: spec, d7x: spec });

// exhaust temperatures (DDE 7 and 8 alike): x 0.03128099 - 50 deg C
const EGT = (did) => u16(did, 0.03128099, -50, -45, 1100);
// EGR / throttle positions: DDE 8 x 0.01220703 - 399.98779297 %, DDE 7 x 0.004578 - 100 %
const POS8 = (did) => u16(did, 0.01220703, -399.98779297, -5, 105);
const POS7 = (did) => u16(did, 0.004578, -100, -5, 105);
// injector quantity corrections (fuel balancing): DDE 8 x 0.01 - 327.67, DDE 7 x 0.003052 - 100 mg/stroke
const INJ8 = (did) => u16(did, 0.01, -327.67, -20, 20);
const INJ7 = (did) => u16(did, 0.003052, -100, -20, 20);

const VALUES = {
    /* ---- the particulate filter (DDE 7 and 8: the same identifiers) ---- */
    soot: Object.assign({ unit: 'g', live: true }, same(u16('44BE', 0.01525902, 0, 0, 200))),           // the regeneration coordinator's soot mass
    sootMeas: Object.assign({ unit: 'g', live: true }, same(u16('44B9', 0.01, 0, 0, 200))),             // from the pressure drop
    sootSim: Object.assign({ unit: 'g', live: true }, same(u16('44C1', 0.01, 0, 0, 200))),              // the soot model
    ash: Object.assign({ unit: 'g' }, same(u16('44BD', 0.01525902, 0, 0, 900))),                       // (FF FF = 1,000 g: no value)
    dp: Object.assign({ unit: 'hPa', live: true }, same(u16('44ED', 0.04577707, -1000, -200, 1500))),   // pressure drop across the filter
    tDpf: Object.assign({ unit: '°C', live: true }, same(EGT('44EF'))),                                 // before the filter (corrected)
    tDpfSens: Object.assign({ unit: '°C', live: true }, same(EGT('4502'))),                             // the same, sensor value
    tDoc: Object.assign({ unit: '°C', live: true }, same(EGT('44F2'))),                                 // before the oxidation catalyst
    sinceKm: Object.assign({ unit: 'km', live: true }, same(u32('44BF', 0.001, 0, 0, 100000))),         // since the last successful regeneration
    sinceS: Object.assign({ unit: 's' }, same(u32('44B7', 1, 0, 0, 36000000))),                         // engine time since it
    sinceL: Object.assign({ unit: 'l' }, same(u16('44BC', 0.01, 0, 0, 650))),                           // fuel since it
    regens: Object.assign({ unit: '' }, same(u16('44B8', 1, 0, 0, 65000))),                             // successful regenerations
    avgKm: Object.assign({ unit: 'km' }, same(u16('44C7', 1, 0, 1, 65000))),                            // average distance between them
    odo1: Object.assign({ unit: 'km' }, same(u32('44D1', 0.001, 0, 1, 3000000))),                       // odometer at the last 5 successful ones
    odo2: Object.assign({ unit: 'km' }, same(u32('44D2', 0.001, 0, 1, 3000000))),
    odo3: Object.assign({ unit: 'km' }, same(u32('44D3', 0.001, 0, 1, 3000000))),
    odo4: Object.assign({ unit: 'km' }, same(u32('44D4', 0.001, 0, 1, 3000000))),
    odo5: Object.assign({ unit: 'km' }, same(u32('44D5', 0.001, 0, 1, 3000000))),
    lifeKm: Object.assign({ unit: 'km' }, same(u16('4C78', 10, 0, 0, 600000))),                         // the filter's remaining distance (service; FF FF: none)
    rgnNum: Object.assign({ unit: '', live: true }, same(u8('44BB', 0, 255))),                          // PFltRgn_numRgn: 4..6 = regeneration requested (BimmerLink)
    rgnLock: Object.assign({ unit: '', live: true }, same(u8('44C2', 0, 255))),                         // PFltRgn_stLck: 1 = blocked (BimmerLink)
    rgnIntr: Object.assign({ unit: '' }, same(u16('44C0', 1, 0, 0, 65535))),                            // PFltRgn_stIntr: 1 = interrupted (BimmerLink)
    // CoEOM_stOpModeAct: the engine's operating mode, a bit each; bit 1 (2) = regeneration mode, as BimmerLink reads it
    opMode: Object.assign({ unit: '', live: true }, same(u32('467E', 1, 0, 0, 4294967295))),
    // DDE 8 only: the after-treatment status as OBD PID 8B has it (bit 0 = regenerating, bit 1 = active), the soot load
    // against the regeneration point (0 % after one, 100 % = due), and the averages at a regeneration's start / end
    pid8b: { unit: '', live: true, d83: u8('5372', 0, 255) },
    loadPct: { unit: '%', live: true, d83: u16('5371', 0.392156, -12849.77565206, -5, 250) },
    avgStart: { unit: 'g', d83: u16('4B52', 0.01, -327.67, 1, 150) },
    avgEnd: { unit: 'g', d83: u16('4B53', 0.01, -327.67, 0, 150) },

    /* ---- AdBlue / SCR: the strategy and the NOx sensors are the DDE's, the tank the SCR unit's ---- */
    adRange: Object.assign({ unit: 'km' }, same(u16('4692', 0.15259022, 0, 0, 10000))),
    adQual: { unit: '%', d83: u8('469C', 0, 50.9, { factor: 0.2 }) },                                   // (FF = 51 %: no value)
    adMass: Object.assign({ unit: 'g' }, same(u16('4693', 0.5, 0, 0, 30000))),                          // the tank as the DDE receives it (unverified)
    noxIn: Object.assign({ unit: 'ppm', live: true }, same(u16('450A', 0.03204395, -100, -50, 2000))), // before the SCR catalyst
    noxOut: Object.assign({ unit: 'ppm', live: true }, same(u16('4508', 0.03204395, -100, -50, 2000))),// after it
    scrT: Object.assign({ unit: '°C', live: true }, same(u16('532E', 0.03128099, -50, -45, 900))),     // the SCR catalyst
    tScr: Object.assign({ unit: '°C', live: true }, same(EGT('5308'))),                                 // before it
    scrEff: Object.assign({ unit: '%' }, same(u16('4DF7', 0.1, 0, 0, 105))),                            // the stored average conversion
    adLevel: { unit: 'l', scr04: u16('E439', 0.00097656, 0, 0, 40), scr03: u16('D4D1', 0.00097656, 0, 0, 40) },

    /* ---- the engine: EGR, air, rail, boost, injectors ---- */
    egrHp: { unit: '%', live: true, d83: POS8('4D8C'), d7x: POS7('4C97') },                            // high-pressure EGR valve: actual
    egrHpSet: { unit: '%', live: true, d83: POS8('4D8A'), d7x: POS7('4C93') },                         // its target
    egrLp: { unit: '%', live: true, d83: POS8('4D3B'), d7x: POS7('4C73') },                            // low-pressure EGR valve: actual
    egrLpSet: { unit: '%', live: true, d83: POS8('4D39') },                                            // (DDE 7: only a duty cycle)
    egrRate: Object.assign({ unit: '%', live: true }, same(u16('4D88', 0.01, 0, 0, 100))),              // exhaust gas let back in
    air: Object.assign({ unit: 'mg', live: true }, same(u16('47DD', 0.03891051, 0, 0, 2500))),          // air mass per stroke
    airSet: Object.assign({ unit: 'mg', live: true }, same(u16('4872', 0.03051804, 0, 0, 1900))),
    rail: Object.assign({ unit: 'bar', live: true }, same(u16('4748', 0.04577707, 0, 0, 3000))),
    railSet: Object.assign({ unit: 'bar', live: true }, same(u16('4715', 0.04577707, 0, 0, 3000))),
    boostAbs: Object.assign({ unit: 'hPa', live: true }, same(u16('4841', 0.15259022, 0, 300, 5000))), // absolute
    boostSetAbs: Object.assign({ unit: 'hPa', live: true }, same(u16('42C8', 0.09155413, 0, 300, 5000))),
    ambient: Object.assign({ unit: 'hPa' }, same(u16('4CF0', 0.03051804, 0, 500, 1100))),
    inj1: { unit: 'mg', d83: INJ8('5570'), d7x: INJ7('5570') },
    inj2: { unit: 'mg', d83: INJ8('5571'), d7x: INJ7('5571') },
    inj3: { unit: 'mg', d83: INJ8('5572'), d7x: INJ7('5572') },
    inj4: { unit: 'mg', d83: INJ8('5573'), d7x: INJ7('5573') },
    inj5: { unit: 'mg', d83: INJ8('5574'), d7x: INJ7('5574') },
    inj6: { unit: 'mg', d83: INJ8('5575'), d7x: INJ7('5575') },
};
// the injector corrections are in firing order (the SGBDs: "fuer Zylinder N (in Zuendfolge)"): slot i is cylinder FIRING[n][i]
const INJ = ['inj1', 'inj2', 'inj3', 'inj4', 'inj5', 'inj6'];
const FIRING = { 4: [1, 3, 4, 2], 6: [1, 5, 3, 6, 2, 4] };
const ODO = ['odo1', 'odo2', 'odo3', 'odo4', 'odo5'];
// keys read from the AdBlue unit (the rest: the engine unit)
const ON_SCR = { adLevel: true };

/** The layout of key for a family (d94 / unknown read as d83), or null when that unit hasn't it. */
function specOf(key, family) {
    const v = VALUES[key];
    if (!v) return null;
    return v[READ_AS[family] || family] || null;
}

/** The family of an engine unit's SGBD index ('0F2670' -> 'd83'), or null when it isn't a DDE we know. */
const familyOf = (index) => FAMILY[String(index || '').toUpperCase()] || null;
const petrol = (index) => PETROL.indexOf(String(index || '').toUpperCase()) >= 0;
const scrFamilyOf = (index) => SCR_FAMILY[String(index || '').toUpperCase()] || null;
const verified = (family) => family === 'd83' || family === 'd7x';

/**
 * A value from a positive reply's data bytes (after 62 <DID>), as kit/dids.js does: null when too short or not
 * plausible. data = an array of bytes.
 */
function decode(spec, data) {
    const at = spec.at || 0, n = spec.bytes || 1;
    if (!data || data.length < at + n) return null;
    let raw = 0;
    for (let i = 0; i < n; i++) raw = raw * 256 + data[at + i];
    if (spec.signed && raw >= Math.pow(2, 8 * n - 1)) raw -= Math.pow(2, 8 * n);
    if (spec.bit != null) raw = Math.floor(raw / Math.pow(2, spec.bit)) % 2;
    const v = raw * (spec.factor == null ? 1 : spec.factor) + (spec.offset || 0);
    if ((spec.min != null && v < spec.min) || (spec.max != null && v > spec.max)) return null;
    return v;
}

/** The raw number of a reply's data (no factor, no range), for the status words without a value table. */
function rawOf(spec, data) {
    const at = spec.at || 0, n = spec.bytes || 1;
    if (!data || data.length < at + n) return null;
    let raw = 0;
    for (let i = 0; i < n; i++) raw = raw * 256 + data[at + i];
    return raw;
}

module.exports = { DDE, SCR, FAMILY, PETROL, SCR_FAMILY, NAMES, VALUES, INJ, ODO, ON_SCR, FIRING, specOf, familyOf, petrol, scrFamilyOf, verified, decode, rawOf };
