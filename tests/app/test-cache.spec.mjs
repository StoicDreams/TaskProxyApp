import { test, expect } from '@playwright/test';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdnBodyFingerprint, finishRecording, noteCdn, startRecording, startedHere, unchangedSincePassing } from '../support/test-cache.mjs';
import fs from 'node:fs';

// The UI tests' result cache (tests/support/test-cache.mjs), with made-up tests, so its own tests run every time.
// This spec uses Playwright's test directly, since the harness's cache would record these tests too.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Each worker has its own folder, since these run in parallel.
const SCRATCH = join(ROOT, 'tests', '.cache-check', `${process.pid}`);
const file = name => join(SCRATCH, name);
let count = 0;

/** A test as Playwright describes it to fixtures. */
function testInfo(overrides = {}) {
    return {
        project: { name: 'cache-check', repeatEach: 1 },
        file: fileURLToPath(import.meta.url),
        titlePath: ['test-cache.spec.mjs', `made up ${process.pid} ${++count}`],
        retry: 0,
        status: 'passed',
        errors: [],
        ...overrides,
    };
}

/** Runs a made-up test that reads `reads` and downloads `cdn` ({url: body}), and ends as `info` says. */
function run(info, reads = [], cdn = {}) {
    startRecording(info);
    reads.forEach(path => fs.readFileSync(path));
    Object.entries(cdn).forEach(([url, body]) => noteCdn(url, body));
    finishRecording(info);
}
const cdnNow = files => async url => cdnBodyFingerprint(files[url]);

test.beforeAll(() => mkdirSync(SCRATCH, { recursive: true }));
test.afterAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    // The made-up tests' entries, which no real run needs.
    const cache = join(ROOT, '.test-cache');
    for (const name of (() => { try { return readdirSync(cache); } catch { return []; } })()) {
        try {
            if (JSON.parse(readFileSync(join(cache, name), 'utf8')).id.includes(`made up ${process.pid} `)) rmSync(join(cache, name));
        } catch { }
    }
});
test.afterEach(() => { delete process.env.PW_NO_CACHE; });

test('a test that passed is skipped while nothing it used changes', async () => {
    writeFileSync(file('a.txt'), 'one');
    const info = testInfo();
    run(info, [file('a.txt')]);
    expect(await unchangedSincePassing(info, cdnNow({}))).toBe(true);
});

test('a change to a file it read runs it again', async () => {
    writeFileSync(file('b.txt'), 'one');
    const info = testInfo();
    run(info, [file('b.txt')]);
    writeFileSync(file('b.txt'), 'two, a different size');
    expect(await unchangedSincePassing(info, cdnNow({}))).toBe(false);
});

test('a change to a CDN file it downloaded runs it again', async () => {
    const info = testInfo();
    const url = 'https://cdn.myfi.ws/webui/example.min.js';
    run(info, [], { [url]: Buffer.from('old') });
    expect(await unchangedSincePassing(info, cdnNow({ [url]: Buffer.from('old') }))).toBe(true);
    expect(await unchangedSincePassing(info, cdnNow({ [url]: Buffer.from('new') }))).toBe(false);
});

test('a test that failed, or had errors, runs again', async () => {
    const failed = testInfo({ status: 'failed' });
    run(failed);
    expect(await unchangedSincePassing(failed, cdnNow({}))).toBe(false);
    const errored = testInfo({ errors: [new Error('Uncaught errors happened')] });
    run(errored);
    expect(await unchangedSincePassing(errored, cdnNow({}))).toBe(false);
});

test('a test that fails after passing forgets its pass', async () => {
    const title = testInfo().titlePath;
    run(testInfo({ titlePath: title }));
    run(testInfo({ titlePath: title, status: 'failed' }));
    expect(await unchangedSincePassing(testInfo({ titlePath: title }), cdnNow({}))).toBe(false);
});

test('every test runs with PW_NO_CACHE, under --repeat-each, and on a retry', async () => {
    const title = testInfo().titlePath;
    run(testInfo({ titlePath: title }));
    process.env.PW_NO_CACHE = '1';
    expect(await unchangedSincePassing(testInfo({ titlePath: title }), cdnNow({}))).toBe(false);
    delete process.env.PW_NO_CACHE;
    expect(await unchangedSincePassing(testInfo({ titlePath: title, project: { name: 'cache-check', repeatEach: 10 } }), cdnNow({}))).toBe(false);
    expect(await unchangedSincePassing(testInfo({ titlePath: title, retry: 1 }), cdnNow({}))).toBe(false);
    expect(await unchangedSincePassing(testInfo({ titlePath: title }), cdnNow({}))).toBe(true);
});

test('a program a spec starts is seen, and one Playwright starts is not', () => {
    const spec = `Error\n    at ChildProcess.spawn (${join(ROOT, 'tests/support/test-cache.mjs')}:60:20)\n    at runScript (${join(ROOT, 'tests/app/scripts.spec.mjs')}:12:5)`;
    const playwright = `Error\n    at ChildProcess.spawn (${join(ROOT, 'tests/support/test-cache.mjs')}:60:20)\n    at launch (${join(ROOT, 'node_modules/playwright-core/lib/server/browser.js')}:88:3)`;
    expect(startedHere(spec)).toBe(true);
    expect(startedHere(playwright)).toBe(false);
});
