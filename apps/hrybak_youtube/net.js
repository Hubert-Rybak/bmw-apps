'use strict';
/**
 * net.js - the app's HTTPS requests on the head unit.
 *
 * The head unit's own resolver does not reach the internet: an app the uplink lets out resolves names
 * through the DNS servers of the uplink's lease (mgu-uplink writes it to the app's data folder as
 * uplink.json and to /run/mgu-uplink/lease.json, only while online). Without a lease file on a machine
 * that has no uplink at all (a PC), the system resolver is used.
 *
 *   const net = new Net({ dataDir, log });
 *   net.request(url, { method, headers, body, timeout, maxBytes }) -> Promise<{ status, headers, body }>
 *   net.json(url, opts) -> Promise<object>          (a 2xx answer, parsed)
 *   net.open(url, { headers, timeout }) -> Promise<{ status, headers, stream, url }>   (redirects followed)
 *   net.rangeSource(url, { size, headers, chunk }) -> a player.js source reading the file in ranges
 *
 * Node 8.
 */
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const { PassThrough } = require('stream');

const LEASE_RUN = '/run/mgu-uplink/lease.json';
const MAX_REDIRECTS = 5;
const DNS_TTL_MS = 5 * 60 * 1000;

class NetError extends Error {
    constructor(code, message, status) {
        super(message);
        this.code = code;           // 'offline', 'dns', 'timeout', 'http', 'tls', 'io', 'toobig'
        this.status = status || 0;
    }
}

class Net {
    constructor(o) {
        o = o || {};
        this.log = o.log || { info() {}, warn() {} };
        this.leaseFiles = o.leaseFiles || [o.dataDir ? path.join(o.dataDir, 'uplink.json') : null, LEASE_RUN].filter(Boolean);
        // a unit with the uplink installed: no lease there means no internet, not "ask the unit's resolver"
        this.uplink = o.uplink != null ? !!o.uplink : fs.existsSync(path.dirname(LEASE_RUN));
        this.names = new Map();     // host -> { ip, t }
        this.leaseAt = 0;
        this.lease = null;
        this.agents = { 'https:': new https.Agent({ keepAlive: true, maxSockets: 6 }), 'http:': new http.Agent({ keepAlive: true, maxSockets: 6 }) };
        this._lookup = this._lookup.bind(this);
    }

    /** The uplink's lease as it is now ({ dns: [...] }), null when there is none. Read at most twice a second. */
    _lease() {
        const now = Date.now();
        if (now - this.leaseAt < 500) return this.lease;
        this.leaseAt = now;
        this.lease = null;
        for (const f of this.leaseFiles) {
            try {
                const j = JSON.parse(fs.readFileSync(f, 'utf8'));
                if (j && Array.isArray(j.dns) && j.dns.length) { this.lease = j; break; }
            } catch (e) { /* not there: offline, or no uplink */ }
        }
        return this.lease;
    }

    /** Whether the unit has internet for this app right now (always true where there is no uplink). */
    online() { return !this.uplink || !!this._lease(); }

    /** net.connect's lookup: the lease's DNS servers, each answer kept for a few minutes. */
    _lookup(hostname, options, cb) {
        if (typeof options === 'function') { cb = options; options = {}; }
        const lease = this._lease();
        if (!lease) {
            if (this.uplink) { cb(new NetError('offline', 'No internet connection')); return; }
            dns.lookup(hostname, options, cb);
            return;
        }
        // (newer Node asks for every address at once: options.all)
        const give = (ip) => (options && options.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4));
        const hit = this.names.get(hostname);
        if (hit && Date.now() - hit.t < DNS_TTL_MS) { give(hit.ip); return; }
        const key = lease.dns.join(',');
        if (!this.resolver || this.resolverKey !== key) {
            this.resolver = new dns.Resolver();
            try { this.resolver.setServers(lease.dns); } catch (e) { cb(new NetError('dns', 'Bad DNS servers in the uplink lease')); return; }
            this.resolverKey = key;
            this.names.clear();
        }
        this.resolver.resolve4(hostname, (err, addrs) => {
            if (err || !addrs || !addrs.length) {
                // a name that stopped resolving keeps its last address for this try (a hiccup of the phone's DNS)
                if (hit) { give(hit.ip); return; }
                cb(new NetError('dns', 'Cannot find ' + hostname + (err && err.code ? ' (' + err.code + ')' : '')));
                return;
            }
            this.names.set(hostname, { ip: addrs[0], t: Date.now() });
            give(addrs[0]);
        });
    }

    /** One request, no redirects followed: resolves with the response (headers received). */
    _once(url, o) {
        return new Promise((resolve, reject) => {
            let u;
            try { u = new URL(url); } catch (e) { reject(new NetError('http', 'Bad address: ' + String(url).slice(0, 80))); return; }
            if (u.protocol !== 'https:' && u.protocol !== 'http:') { reject(new NetError('http', 'Not an http address')); return; }
            // (asked here too: a connection kept from before needs no name lookup)
            if (this.uplink && !this._lease()) { reject(new NetError('offline', 'No internet connection')); return; }
            const mod = u.protocol === 'https:' ? https : http;
            const body = o.body == null ? null : Buffer.isBuffer(o.body) ? o.body : Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
            const headers = Object.assign({ 'Accept-Encoding': o.raw ? 'identity' : 'gzip' }, o.headers || {});
            if (body) {
                if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = body.length;
            }
            const req = mod.request({
                protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
                method: o.method || (body ? 'POST' : 'GET'), headers, agent: this.agents[u.protocol], lookup: this._lookup,
            });
            const ms = o.timeout || 15000;
            let done = false;
            const fail = (e) => {
                if (done) return;
                done = true;
                req.destroy();
                if (e instanceof NetError) reject(e);
                else {
                    const code = e && e.code || '';
                    const tls = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code);
                    reject(new NetError(tls ? 'tls' : 'io', tls ? 'Secure connection refused (' + code + '): check the car\'s date and time' : (e && e.message) || 'connection failed'));
                }
            };
            const timer = setTimeout(() => fail(new NetError('timeout', 'No answer from ' + u.hostname + ' in ' + Math.round(ms / 1000) + ' s')), ms);
            req.on('error', fail);
            req.on('response', (res) => {
                if (done) { res.destroy(); return; }
                done = true;
                clearTimeout(timer);
                resolve(res);
            });
            req.end(body);
        });
    }

    /** The response to url with redirects followed (GET only): { status, headers, stream, url }. */
    open(url, o) {
        o = o || {};
        const hop = (u, n) => this._once(u, Object.assign({}, o, { raw: true })).then((res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n < MAX_REDIRECTS) {
                res.resume();
                return hop(new URL(res.headers.location, u).toString(), n + 1);
            }
            return { status: res.statusCode, headers: res.headers, stream: res, url: u };
        });
        return hop(url, 0);
    }

    /** The whole answer in memory: { status, headers, body }. */
    request(url, o) {
        o = o || {};
        const max = o.maxBytes || 8 * 1024 * 1024;
        const first = o.method && o.method !== 'GET' ? this._once(url, o).then((res) => ({ status: res.statusCode, headers: res.headers, stream: res })) : this.open(url, Object.assign({}, o, { raw: false }));
        // (open() asks for identity; a POST may come back gzipped)
        return first.then((r) => new Promise((resolve, reject) => {
            const chunks = [];
            let n = 0, ended = false;
            const ms = o.timeout || 15000;
            const timer = setTimeout(() => { if (!ended) { ended = true; r.stream.destroy(); reject(new NetError('timeout', 'The answer stopped coming')); } }, ms + 15000);
            r.stream.on('data', (d) => {
                n += d.length;
                if (n > max) { ended = true; clearTimeout(timer); r.stream.destroy(); reject(new NetError('toobig', 'The answer is larger than expected')); return; }
                chunks.push(d);
            });
            r.stream.on('error', (e) => { if (!ended) { ended = true; clearTimeout(timer); reject(new NetError('io', e.message)); } });
            r.stream.on('end', () => {
                if (ended) return;
                ended = true;
                clearTimeout(timer);
                let body = Buffer.concat(chunks);
                if (r.headers['content-encoding'] === 'gzip') {
                    try { body = zlib.gunzipSync(body); } catch (e) { reject(new NetError('io', 'Damaged answer')); return; }
                }
                resolve({ status: r.status, headers: r.headers, body });
            });
        }));
    }

    /** A 2xx answer's JSON; anything else is an error with the HTTP status. */
    json(url, o) {
        return this.request(url, o).then((r) => {
            if (r.status < 200 || r.status >= 300) throw new NetError('http', 'HTTP ' + r.status + ' from ' + new URL(url).hostname, r.status);
            try { return JSON.parse(r.body.toString('utf8')); } catch (e) { throw new NetError('http', 'Not a JSON answer from ' + new URL(url).hostname, r.status); }
        });
    }

    /**
     * A file on a server as a player.js source, read in ranges of `chunk` bytes one after the other (video
     * servers serve an asked-for range at full speed, and an open-ended read slowly): open(offset) gives a
     * stream that goes on to the file's end, fetching the next range when the reader has taken the last.
     * A range that fails ends the stream with an error; the player then asks again from where it is.
     */
    rangeSource(url, o) {
        o = o || {};
        const self = this;
        const chunk = o.chunk || 2 * 1024 * 1024;
        const source = {
            size: o.size > 0 ? o.size : -1,
            url,
            open(offset) {
                return new Promise((resolve, reject) => {
                    const out = new PassThrough({ highWaterMark: 256 * 1024 });
                    let pos = offset, cur = null, dead = false, first = true, blocked = false;
                    const realDestroy = out.destroy.bind(out);
                    out.destroy = () => { dead = true; if (cur) cur.destroy(); realDestroy(); };
                    out.on('drain', () => { blocked = false; });
                    // the stream ends in an error the reader sees before any 'end' (Node 8 ends a destroyed stream first)
                    const failOut = (e) => { if (dead) return; out.emit('error', e); out.destroy(); };
                    const next = () => {
                        if (dead) return;
                        if (source.size > 0 && pos >= source.size) { out.end(); return; }
                        const end = source.size > 0 ? Math.min(source.size, pos + chunk) - 1 : pos + chunk - 1;
                        self.open(source.url, { headers: Object.assign({}, o.headers || {}, { Range: 'bytes=' + pos + '-' + end }), timeout: o.timeout || 20000 }).then((r) => {
                            if (dead) { r.stream.destroy(); return; }
                            if (r.status === 416) { r.stream.resume(); out.end(); return; }      // past the end
                            if (r.status !== 206 && !(r.status === 200 && pos === 0)) {
                                r.stream.resume();
                                const err = new NetError('http', 'HTTP ' + r.status + ' from the video server', r.status);
                                if (first) reject(err); else failOut(err);
                                return;
                            }
                            // the server that answered (after its redirects) serves the next ranges too
                            source.url = r.url;
                            const total = /\/(\d+)\s*$/.exec(r.headers['content-range'] || '');
                            if (total) source.size = Number(total[1]);
                            else if (r.status === 200 && r.headers['content-length']) source.size = Number(r.headers['content-length']);
                            const whole = r.status === 200;
                            cur = r.stream;
                            let got = 0;
                            // quiet for 20 s: the connection is dead
                            let idle = setTimeout(() => r.stream.destroy(new NetError('timeout', 'The video server went quiet')), 20000);
                            r.stream.on('data', (d) => {
                                got += d.length;
                                clearTimeout(idle);
                                idle = setTimeout(() => r.stream.destroy(new NetError('timeout', 'The video server went quiet')), 20000);
                                if (!out.write(d)) { blocked = true; r.stream.pause(); out.once('drain', () => r.stream.resume()); }
                            });
                            r.stream.on('error', (e) => { clearTimeout(idle); failOut(e); });
                            r.stream.on('end', () => {
                                clearTimeout(idle);
                                cur = null;
                                pos += got;
                                if (dead) return;
                                if (whole || !got) { out.end(); return; }
                                // the next range once the reader has caught up with this one
                                if (blocked) out.once('drain', next); else next();
                            });
                            if (first) { first = false; resolve({ stream: out, size: source.size }); }
                        }).catch((e) => { if (first) reject(e); else failOut(e); });
                    };
                    next();
                });
            },
        };
        return source;
    }
}

module.exports = { Net, NetError };
