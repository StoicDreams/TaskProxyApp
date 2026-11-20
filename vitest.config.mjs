import { defineConfig } from 'vitest/config';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

// PW_NICE, the machine setting the Playwright config reads, lowers the priority of the test run: 1 to 19, or idle for
// only spare CPU. PW_WORKERS is not used here: these tests run one at a time (see below).
const nice = process.env.PW_NICE?.trim();
if (nice === 'idle' && process.platform === 'linux') {
    try { execFileSync('chrt', ['--all-tasks', '--idle', '-p', '0', `${process.pid}`], { stdio: 'ignore' }); } catch { try { os.setPriority(19); } catch { } }
} else if (nice) {
    try { os.setPriority(nice === 'idle' ? 19 : Math.min(19, Math.max(0, Number(nice) || 0))); } catch { }
}

// The unit tests: plain logic in Node, and the minified app with its components in jsdom
// (tests/unit/support/app.mjs). Tests that need a real browser run in Playwright (tests/browser).
export default defineConfig({
    test: {
        include: ['tests/unit/**/*.test.mjs'],
        environment: 'node',
        pool: 'threads',
        // One test at a time: one file after another, and a file's tests in order. Tests running side by side compete
        // for the machine, and a test that fails because of that costs far more time than running them in turn.
        fileParallelism: false,
        maxWorkers: 1,
        // As long as Playwright gives a test, since a busy machine can slow a test well past its usual time.
        testTimeout: 60000,
        hookTimeout: 60000,
        // expect.poll waits as long as every other check (15 s, see tests/unit/support/page.mjs), checking often.
        expect: { poll: { timeout: 15000, interval: 20 } },
        // A failure is a failure: nothing is retried, so a test that only sometimes passes shows up.
        retry: 0,
        reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],
        // Closing a dialog with Cancel rejects its promise with 'canceled', which most callers have no use for, as in
        // the browser tests. Every other unhandled error fails the run.
        onUnhandledError: error => !(error === 'canceled' || error?.message === 'canceled'),
    },
});
