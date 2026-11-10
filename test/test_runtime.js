'use strict';
/**
 * The app's start as the head unit runs it: a full build (kit/tools/build.py, as the Store runs it) with a
 * stand-in for BMW's SDK, then the built package's own entry point under this Node, through the kit's real
 * mgu.js: start, entry point, the first frame handed to the "HMI", a bar button, shutdown. An error here is
 * what would show on the car as a tile that says "Loading app" for ever.
 *
 *   node test/test_runtime.js          (Node 8 too: the head unit's)
 *
 * The stand-in SDK only records what the app asks of it; it holds no BMW code. dist/ is rebuilt.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const STAGE = path.join(ROOT, 'dist', 'hrybak_youtube');
const SDK = path.join(ROOT, 'oap-sdk');
function assert(ok, what) { if (!ok) throw new Error('assertion failed: ' + what); }

const FAKE_SDK = `'use strict';
// A stand-in for the oap-sdk: the calls the kit makes, answered and recorded (test/test_runtime.js).
const EventEmitter = require('events');
const fs = require('fs');
const trace = (o) => fs.appendFileSync(process.env.FAKE_SDK_TRACE, JSON.stringify(o) + '\\n');
class Component extends EventEmitter {
    constructor(name, id) { super(); this.name = name; this.id = id; }
    getId() { return this.id; }
    setValue(a, b, c, d) { trace({ call: 'setValue', comp: this.name, args: [a, b, typeof c === 'object' ? 'handle' : c, d] }); return Promise.resolve(); }
    setProperty(k, v) { trace({ call: 'setProperty', comp: this.name, args: [k, v] }); return Promise.resolve(); }
    setRowCount() { return Promise.resolve(); }
    updateResources() { return Promise.resolve(); }
    getStringBundle() { return { setStrings: () => Promise.resolve() }; }
    getResourceBundle() { return bundle; }
}
const bundle = {
    createResourceHandles(files) { files.forEach((f) => trace({ call: 'image', file: require('path').basename(f), bytes: fs.statSync(f).size, png: fs.readFileSync(f).slice(1, 4).toString() })); return Promise.resolve(); },
    getResourceHandle: (f) => ({ file: f }),
    destroyResourceHandles: () => Promise.resolve(),
};
class Rhmi extends EventEmitter {
    constructor() { super(); this.comps = {}; this.n = 0; }
    getByName(name) { return this.comps[name] || (this.comps[name] = new Component(name, ++this.n)); }
    getResourceBundle() { return bundle; }
    mapEntryState(uuid, state) { trace({ call: 'mapEntryState', uuid, state: state && state.name }); return Promise.resolve(); }
    openEntryState(uuid) { trace({ call: 'openEntryState', uuid }); return Promise.resolve(); }
    openState(n) { trace({ call: 'openState', n }); return Promise.resolve(); }
    closeState(n) { trace({ call: 'closeState', n }); return Promise.resolve(); }
}
class OnlineApp extends EventEmitter {
    constructor() { super(); this.rhmiApplication = new Rhmi(); this.startReason = 'ENTRY_POINT'; }
    start() { trace({ call: 'start' }); return Promise.resolve(); }
    registerActive() { trace({ call: 'registerActive' }); return Promise.resolve(); }
    registerHmiVisible() { return Promise.resolve(); }
    unregisterHmiVisible() { return Promise.resolve(); }
    getLastExecutedEntryPointUuid() { return JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', '..', '..', 'rhmiData', 'application.json'), 'utf8')).application.entryPoints[0].uuid; }
    initialized() {
        trace({ call: 'initialized' });
        // the HMI shows the screen, the user presses the bar's button, the platform stops the app
        setTimeout(() => this.rhmiApplication.getByName('MAIN').emit('visible', { visible: true }), 300);
        setTimeout(() => this.rhmiApplication.getByName('BTN_PLAY').emit('action', {}), 2500);
        setTimeout(() => this.emit('shutdown'), 3200);
        return Promise.resolve();
    }
}
const logger = {};
['error', 'warn', 'info', 'debug'].forEach((l) => { logger[l] = (m) => trace({ log: l, m: String(m) }); });
module.exports = { OnlineApp, logging: { getSDKLogger: () => logger } };
`;

(async () => {
    let failed = 0;
    const hadSdk = fs.existsSync(SDK);
    const data = path.join(STAGE, 'data');
    const traceFile = path.join(os.tmpdir(), 'yt-runtime-trace-' + process.pid + '.jsonl');
    try {
        assert(!hadSdk, 'oap-sdk/ exists: this test builds with a stand-in and will not touch a real SDK');
        fs.mkdirSync(SDK);
        fs.writeFileSync(path.join(SDK, 'index.js'), FAKE_SDK);
        fs.writeFileSync(path.join(SDK, 'package.json'), JSON.stringify({ name: 'oap-sdk', version: '0.0.0-test' }));
        const b = spawnSync('python3', [path.join(ROOT, 'kit/tools/build.py'), 'hrybak_youtube'], { cwd: ROOT, encoding: 'utf8' });
        assert(b.status === 0, 'the build: ' + b.stdout + b.stderr);
        const pkg = JSON.parse(fs.readFileSync(path.join(STAGE, 'source', 'package.json'), 'utf8'));
        assert(pkg.name === 'hrybak_youtube' && pkg.mguInternet === true && pkg.main === 'javascript/app.js', 'package.json: ' + JSON.stringify(pkg).slice(0, 200));
        const tgz = path.join(ROOT, 'dist', 'hrybak_youtube@' + pkg.version + '.tgz');
        assert(fs.existsSync(tgz) && fs.statSync(tgz).size > 100000, 'the package the Store installs: ' + tgz);
        const manifest = JSON.parse(fs.readFileSync(path.join(STAGE, 'source', 'manifest.json'), 'utf8'));
        assert(manifest.proxies['de.bmw.infotainment.vehicle.Vehicle2'].attributes.statusCarSpeed2 === 'rs', 'the speed signal in the manifest');
        const app = JSON.parse(fs.readFileSync(path.join(STAGE, 'rhmiData', 'application.json'), 'utf8')).application;
        assert(app.name === 'hrybak_youtube' && app.entryPoints.length === 1, 'one entry point (the tile)');

        if (!fs.existsSync(data)) fs.mkdirSync(data);
        const child = spawn(process.execPath, [path.join(STAGE, 'source', 'javascript', 'app.js')], {
            cwd: data, stdio: ['ignore', 'pipe', 'pipe'],
            // no renderer and no player here: the app must start all the same
            env: Object.assign({}, process.env, { FAKE_SDK_TRACE: traceFile, MGU_RENDERD_SOCKET: path.join(data, 'no-renderer.sock'), YTPLAY_SOCKET: path.join(data, 'no-player.sock') }),
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const code = await new Promise((res) => { child.on('exit', res); setTimeout(() => { child.kill('SIGKILL'); res('timeout'); }, 15000); });
        const trace = fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const calls = trace.filter((t) => t.call).map((t) => t.call);
        const log = fs.readFileSync(path.join(data, 'hrybak_youtube.log'), 'utf8');
        assert(code === 0, 'exits cleanly when the platform stops it: ' + code + '\n' + out + '\n' + log);
        assert(calls.indexOf('start') >= 0 && calls.indexOf('registerActive') > 0 && calls.indexOf('initialized') > 0, 'the start: ' + calls.slice(0, 12).join(' '));
        assert(calls.indexOf('mapEntryState') >= 0 && calls.indexOf('openEntryState') > calls.indexOf('initialized'), 'the tile opens the screen');
        const images = trace.filter((t) => t.call === 'image');
        assert(images.length >= 1 && images[0].png === 'PNG' && images[0].bytes > 2000, 'a drawn frame handed to the HMI as a PNG: ' + JSON.stringify(images[0]));
        assert(trace.some((t) => t.call === 'setValue' && t.comp === 'MAIN_GFX' && t.args[3] === 'Asset'), 'shown in the screen\'s image');
        assert(/initialized \(start reason ENTRY_POINT\)/.test(log) && /shutdown requested/.test(log), 'the app\'s log says so');
        assert(!/FATAL|ERROR /.test(log), 'no errors in the app\'s log:\n' + log);
        const bad = trace.filter((t) => t.log === 'error');
        assert(!bad.length, 'no errors through the SDK\'s logger: ' + JSON.stringify(bad));
        console.log('ok   the built package starts through the kit\'s own start-up, draws and stops (Node ' + process.version + ')');
    } catch (e) {
        failed = 1;
        console.log('FAIL ' + (e && e.stack || e));
    }
    // the stand-in never stays where a real SDK would be looked for, nor in a package someone might install
    if (!hadSdk) { try { fs.unlinkSync(path.join(SDK, 'index.js')); fs.unlinkSync(path.join(SDK, 'package.json')); fs.rmdirSync(SDK); } catch (e) { /* not made */ } }
    try { fs.unlinkSync(traceFile); } catch (e) { /* none */ }
    spawnSync('python3', [path.join(ROOT, 'kit/tools/build.py'), '--preview-only', 'hrybak_youtube'], { cwd: ROOT });
    fs.readdirSync(path.join(ROOT, 'dist')).filter((f) => /\.(tgz|mgu)$/.test(f)).forEach((f) => fs.unlinkSync(path.join(ROOT, 'dist', f)));
    process.exit(failed);
})();
