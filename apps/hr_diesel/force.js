'use strict';
/**
 * force.js - asks the engine unit (DDE, 0x12) for a particulate filter regeneration: the one request the Diesel app
 * sends that isn't a read, and only when the driver confirms it on the DPF page.
 *
 * How (as BimmerLink 2.38 does it, io.sgsoftware.bimmerlink: DPFActivity -> VehicleInterface z0): one
 * WriteDataByIdentifier (2E) to 5FB4, the SGBD's "CSF service library" (ABGLEICH_CSF_PROG, table CSF_WERTE). The
 * block it writes sets QFL, the fuel burnt since the last regeneration, to 200.00 l (4E 20, x 0.01 l); the engine unit
 * then counts a regeneration as due and runs one as soon as the driving allows it (warm engine, a steady 60 km/h or
 * more). Nothing else in the block is set: the zeros are BimmerLink's own, byte for byte.
 *   d83 (DDE 8.3, D83BX7C0, the SGBD indexes 0F1FE8 ... 0F267C)  2E 5F B4 + 95 bytes, QFL at byte 46 (CSF_WERTE POS 46)
 *   d7x / d94 (every other DDE BimmerLink sends it to)            2E 5F B4 04 06 05 + 94 bytes, QFL at byte 48: the
 *       block's NUMID (POS 4) = service case 06 (EEPROM, "Initialisierung einzelner EEPROM-Werte") with value 05 (QFL)
 * A positive answer is 6E 5F B4. An engine unit the app doesn't know (family 'unknown') gets nothing.
 *
 * The link is the head unit's own (kit/diag.js), opened on the first request only, and it sends nothing but that block:
 * the reading stays on kit/readonly-diag.js.
 *
 *   const f = new Force({ signals, log });
 *   f.can({ family, status, phase, locked, demo }) -> null (may send) | why not ('regenerating', ...)
 *   await f.request(family)  -> { ok: true } | { ok: false, why }
 */
const { Diag, NRC, replyTo } = require('./kit/diag');

const DDE = 0x12;
const DID = [0x5F, 0xB4];
const QFL = [0x4E, 0x20];                 // 200.00 l
const COOLDOWN_MS = 10 * 60 * 1000;       // one request, then none for 10 minutes (the engine unit has it)

/** The bytes after 2E for the family's block (null: no block for it). */
function block(family) {
    let data;
    if (family === 'd83') {
        data = DID.concat(new Array(95).fill(0));          // 2E 5F B4 + 95 bytes: 98 in all
        data[46 - 1] = QFL[0]; data[47 - 1] = QFL[1];      // (positions from the request's first byte, 2E)
    } else if (family === 'd7x' || family === 'd94') {
        data = DID.concat([0x04, 0x06, 0x05], new Array(94).fill(0));   // 100 in all
        data[48 - 1] = QFL[0]; data[49 - 1] = QFL[1];
    } else return null;
    return data;
}

class Force {
    constructor(opts) {
        this.signals = opts.signals; this.log = opts.log || { info() {}, warn() {} };
        this.diag = null; this.busy = false; this.at = null;   // (steady clock, ms) of the last accepted request
    }

    /** Why a request can't go now (null: it can). */
    can(s) {
        if (this.busy) return 'sending';
        if (s.phase === 'active') return 'regenerating';
        if (s.locked) return 'blocked by the engine unit';
        if (s.demo) return null;
        if (!block(s.family)) return 'not for this engine unit';
        if (s.status !== 'LIVE') return 'the engine unit isn\'t answering';
        if (this.at !== null && mono() - this.at < COOLDOWN_MS) return 'already requested';
        return null;
    }

    async request(family, demo) {
        if (this.busy) return { ok: false, why: 'sending' };
        if (demo) { this.at = mono(); return { ok: true, demo: true }; }
        const data = block(family);
        if (!data) return { ok: false, why: 'not for this engine unit' };
        this.busy = true;
        try {
            if (!this.diag) { this.diag = new Diag(this.signals, this.log); await this.diag.init(); }
            this.log.info('regeneration requested by the driver: 2E 5F B4 to the DDE (' + family + ', QFL 200 l)');
            const u = await this.diag.physical(DDE, 0x2E, data, 5000, replyTo(0x2E, DID));
            if (u && u[0] === 0x6E) { this.at = mono(); this.log.info('regeneration request accepted'); return { ok: true }; }
            const why = !u ? 'no answer' : u[0] === 0x7F ? (NRC[u[2]] || 'refused (' + u[2] + ')') : 'unexpected answer';
            this.log.warn('regeneration request: ' + why);
            return { ok: false, why };
        } catch (e) {
            this.log.warn('regeneration request: ' + (e && e.message || e));
            return { ok: false, why: 'no diagnostic link' };
        } finally { this.busy = false; }
    }
}

function mono() { const h = process.hrtime(); return h[0] * 1000 + h[1] / 1e6; }

Force.block = block; Force.COOLDOWN_MS = COOLDOWN_MS;
module.exports = { Force };
