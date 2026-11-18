import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startedHere } from '../support/test-cache.mjs';

// The UI tests' result cache (tests/support/test-cache.mjs), with made-up tests. Each test runs the cache in a Node
// process of its own (test-cache.child.mjs), on a temporary folder in place of the repo and with only the environment
// it sets, so it can't touch this repo's cache, and nothing else in the run, such as PW_NO_CACHE, can reach it.
// This spec uses Playwright's test directly, since the harness's cache would record these tests too.
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const temps = [];
test.afterAll(() => temps.forEach(dir => rmSync(dir, { recursive: true, force: true })));

/** Runs `steps` against a fresh folder, and gives what each check found: whether the made-up test would be skipped. */
function cache(steps) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-cache-spec-')));
    temps.push(root);
    mkdirSync(join(root, 'tests'));
    const result = spawnSync(process.execPath, [join(here, 'test-cache.child.mjs'), JSON.stringify(steps)], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, PW_TEST_CACHE_ROOT: root },
        timeout: 60000,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
}
const passed = (reads = [], cdn = {}) => ({ run: { reads, cdn } });
const check = (info = {}, cdn = {}) => ({ check: { info, cdn } });

test('a test that passed is skipped while nothing it used changes', () => {
    expect(cache([{ write: ['a.txt', 'one'] }, passed(['a.txt']), check()])).toEqual([true]);
});

test('a change to a file it read runs it again', () => {
    expect(cache([{ write: ['b.txt', 'one'] }, passed(['b.txt']), { write: ['b.txt', 'two, a different size'] }, check()])).toEqual([false]);
});

test('a change to a CDN file it downloaded runs it again', () => {
    const url = 'https://cdn.myfi.ws/webui/example.min.js';
    expect(cache([passed([], { [url]: 'old' }), check({}, { [url]: 'old' }), check({}, { [url]: 'new' })])).toEqual([true, false]);
});

test('a test that failed, or had errors, runs again', () => {
    expect(cache([{ run: { info: { status: 'failed' } } }, check()])).toEqual([false]);
    expect(cache([{ run: { errors: ['Uncaught errors happened'] } }, check()])).toEqual([false]);
});

test('a test that fails after passing forgets its pass', () => {
    expect(cache([passed(), check(), { run: { info: { status: 'failed' } } }, check()])).toEqual([true, false]);
});

test('every test runs with PW_NO_CACHE, under --repeat-each, and on a retry', () => {
    expect(cache([
        passed(),
        { env: { PW_NO_CACHE: '1' } }, check(), { env: { PW_NO_CACHE: null } },
        check({ project: { name: 'cache-check', repeatEach: 10 } }),
        check({ retry: 1 }),
        check(),
    ])).toEqual([false, false, false, true]);
});

test('a program a spec starts is seen, and one Playwright starts is not', () => {
    const spec = `Error\n    at ChildProcess.spawn (${join(ROOT, 'tests/support/test-cache.mjs')}:60:20)\n    at runScript (${join(ROOT, 'tests/app/scripts.spec.mjs')}:12:5)`;
    const playwright = `Error\n    at ChildProcess.spawn (${join(ROOT, 'tests/support/test-cache.mjs')}:60:20)\n    at launch (${join(ROOT, 'node_modules/playwright-core/lib/server/browser.js')}:88:3)`;
    expect(startedHere(spec)).toBe(true);
    expect(startedHere(playwright)).toBe(false);
});
