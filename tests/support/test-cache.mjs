// Skips a UI test when nothing it used has changed since it last passed.
//
// While a test runs, this records every file it used: those served to the page (tests/support/app.mjs reads each
// one), files the spec reads itself, the CDN files it downloaded, and the specs and support files around it. When it
// passes, the list is saved with a hash of each, one file per test in .test-cache/, so parallel workers never write
// the same file. Next run, a test whose files all hash the same is skipped as unchanged.
//
// Every test runs when PW_NO_CACHE=1, under --repeat-each (so stress runs always run), and on a retry. A test that
// starts another program can't be seen reading files, so it always runs.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// PW_TEST_CACHE_ROOT stands in for the repo in the cache's own tests (tests/app/test-cache.spec.mjs), which run it in
// a process of their own on a temporary folder, so they can never touch this repo's cache or another test's state.
const ROOT = resolve(process.env.PW_TEST_CACHE_ROOT || fileURLToPath(new URL('../..', import.meta.url)));
const CACHE_DIR = join(ROOT, '.test-cache');
/**
 * Files every test depends on, beyond what it is seen using: the config, the installed tools, and the support files,
 * which specs import rather than read, such as the mock backend.
 */
const ALWAYS = ['playwright.config.mjs', 'package-lock.json', ...(fs.existsSync(join(ROOT, 'tests', 'support')) ? fs.readdirSync(join(ROOT, 'tests', 'support')) : [])
    .filter(name => name.endsWith('.mjs') || name.endsWith('.js'))
    .map(name => `tests/support/${name}`)];
/** Folders whose files never decide a result, and change on every run. */
const IGNORED = ['node_modules', 'test-results', 'playwright-report', '.test-cache', '.git', 'target'];

const original = {
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    readFile: fs.promises.readFile,
};

/** What the running test has used, as `kind:path` keys. Null between tests. */
let current = null;
/** What specs and support files read as they loaded, before any test, which every test then depends on. */
const loading = new Set();
let spawned = false;

/** A MyFiCDN checkout the tests load Web UI from instead of the live CDN, whose files count like the repo's. */
const CDN_ROOT = process.env.WEBUI_CDN_ROOT ? resolve(process.env.WEBUI_CDN_ROOT) : null;

function repoPath(path) {
    if (typeof path !== 'string' && !(path instanceof URL)) return null;
    const absolute = resolve(path instanceof URL ? fileURLToPath(path) : path);
    if (CDN_ROOT && (absolute === CDN_ROOT || absolute.startsWith(CDN_ROOT + sep))) {
        return `@cdn/${relative(CDN_ROOT, absolute).split(sep).join('/')}`;
    }
    if (absolute !== ROOT && !absolute.startsWith(ROOT + sep)) return null;
    const inRepo = relative(ROOT, absolute).split(sep).join('/');
    return IGNORED.some(folder => inRepo === folder || inRepo.startsWith(`${folder}/`)) ? null : inRepo;
}

function note(kind, path) {
    const inRepo = repoPath(path);
    if (inRepo === null) return;
    (current ?? loading).add(`${kind}:${inRepo}`);
}

fs.readFileSync = function (path, ...args) { note('file', path); return original.readFileSync.call(this, path, ...args); };
fs.readdirSync = function (path, ...args) { note('dir', path); return original.readdirSync.call(this, path, ...args); };
fs.existsSync = function (path) { note('exists', path); return original.existsSync.call(this, path); };
fs.statSync = function (path, ...args) { note('exists', path); return original.statSync.call(this, path, ...args); };
fs.promises.readFile = function (path, ...args) { note('file', path); return original.readFile.call(this, path, ...args); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const run = childProcess[name];
    childProcess[name] = function (...args) {
        if (current && startedHere(new Error().stack)) spawned = true;
        return run.apply(this, args);
    };
}
/**
 * Whether a spec or a support file started the program, rather than Playwright, which starts browsers and helpers of
 * its own while tests run. The first caller outside this file says which.
 */
export function startedHere(stack) {
    const caller = `${stack}`.split('\n').slice(1).find(line => !line.includes(fileURLToPath(import.meta.url)) && !line.includes('node:'));
    if (!caller) return false;
    const path = caller.match(/\((?:file:\/\/)?([^():]+):\d+:\d+\)|at (?:file:\/\/)?([^\s():]+):\d+:\d+/);
    const file = path && (path[1] || path[2]);
    return !!file && repoPath(file) !== null;
}

// Specs import these by name, so their bindings must see the recording versions too.
syncBuiltinESMExports();

const hash = data => createHash('sha256').update(data).digest('hex').slice(0, 32);
const fingerprints = new Map();

/**
 * A dependency's fingerprint now: a file's contents, a folder's listing, or whether a path exists. Each is worked out
 * once while the file stays the same size and age, so a file edited during a run is read again.
 */
function fingerprint(key) {
    const at = key.indexOf(':');
    const kind = key.slice(0, at);
    const name = key.slice(at + 1);
    // A file from a local CDN checkout when the tests last used one. Without one now, it counts as changed.
    if (name.startsWith('@cdn/') && !CDN_ROOT) return 'no local CDN';
    const path = name.startsWith('@cdn/') ? join(CDN_ROOT, name.slice(5)) : join(ROOT, name);
    let stamp = 'missing';
    try {
        const stat = original.statSync(path);
        stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch { }
    const known = fingerprints.get(key);
    if (known && known.stamp === stamp) return known.value;
    let value;
    try {
        if (kind === 'file') value = hash(original.readFileSync(path));
        else if (kind === 'dir') value = hash(original.readdirSync(path).sort().join('\n'));
        else value = original.existsSync(path) ? 'exists' : 'missing';
    } catch {
        value = 'missing';
    }
    fingerprints.set(key, { stamp, value });
    return value;
}

export function cacheEnabled(testInfo) {
    return process.env.PW_NO_CACHE !== '1' && testInfo.project.repeatEach <= 1 && testInfo.retry === 0;
}

function entryFile(testInfo) {
    const id = [testInfo.project.name, relative(ROOT, testInfo.file).split(sep).join('/'), ...testInfo.titlePath.slice(1)].join(' > ');
    return { id, file: join(CACHE_DIR, `${hash(id)}.json`) };
}

/**
 * Whether the test passed before with everything it used unchanged. `cdnFingerprint(url)` gives a CDN file's
 * fingerprint now, downloading it when needed.
 */
export async function unchangedSincePassing(testInfo, cdnFingerprint) {
    if (!cacheEnabled(testInfo)) return false;
    const { id, file } = entryFile(testInfo);
    let entry;
    try {
        entry = JSON.parse(original.readFileSync(file, 'utf8'));
    } catch {
        return false;
    }
    if (entry.id !== id || !entry.deps) return false;
    for (const [key, value] of Object.entries(entry.deps)) {
        const now = key.startsWith('cdn:') ? await cdnFingerprint(key.slice(4)) : fingerprint(key);
        if (now !== value) return false;
    }
    return true;
}

/** Starts recording what a test uses. */
export function startRecording(testInfo) {
    current = new Set([...ALWAYS.map(path => `file:${path}`), `file:${relative(ROOT, testInfo.file).split(sep).join('/')}`]);
    spawned = false;
}

/** A CDN file's fingerprint, from its downloaded body. */
export const cdnBodyFingerprint = body => body ? hash(body) : 'missing';

/** A CDN file the test downloaded, with its fingerprint. */
const cdnSeen = new Map();
export function noteCdn(url, body) {
    if (!current) return;
    const key = `cdn:${url}`;
    current.add(key);
    cdnSeen.set(key, cdnBodyFingerprint(body));
}

/** Saves what a test that passed used, or forgets it when it didn't pass. */
export function finishRecording(testInfo) {
    const used = current;
    current = null;
    if (!used || !cacheEnabled(testInfo)) return;
    const { id, file } = entryFile(testInfo);
    if (testInfo.status !== 'passed' || testInfo.errors.length || spawned) {
        fs.rmSync(file, { force: true });
        return;
    }
    const deps = {};
    for (const key of [...loading, ...used].sort()) {
        deps[key] = key.startsWith('cdn:') ? cdnSeen.get(key) : fingerprint(key);
    }
    fs.mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ id, passedAt: new Date().toISOString(), deps }));
    fs.renameSync(temp, file);
}
