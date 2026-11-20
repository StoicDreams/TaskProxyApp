import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { existsSync } from 'node:fs';

// Playwright does not provide browser builds for every Linux distribution, so prefer a
// system Chromium there. On other systems run: npx playwright install chromium
const systemChromium = process.platform === 'linux' && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined;
const executablePath = process.env.PW_CHROMIUM_PATH || systemChromium;

// PW_NICE, a machine setting, lowers the priority of the test run and the browsers it starts: 1 to 19, or idle for
// only spare CPU. Chromium sets its own threads' priorities, so on Linux idle uses the idle scheduling class, which it
// keeps. PW_WORKERS is not used here: these tests run one at a time (see workers below).
const nice = process.env.PW_NICE?.trim();
if (nice === 'idle' && process.platform === 'linux') {
    try { execFileSync('chrt', ['--all-tasks', '--idle', '-p', '0', `${process.pid}`], { stdio: 'ignore' }); } catch { try { os.setPriority(19); } catch { } }
} else if (nice) {
    try { os.setPriority(nice === 'idle' ? 19 : Math.min(19, Math.max(0, Number(nice) || 0))); } catch { }
}

// The browser tier: tests that need a real browser and the end-to-end flows (tests/browser), and the Node checks
// shared by every repo (tests/app/scripts.spec.mjs, tests/app/service-worker.spec.mjs). Everything else is in
// tests/unit, run by Vitest. The captures have their own config (tools/capture).
export default defineConfig({
    testDir: './tests',
    testMatch: ['browser/**/*.spec.mjs', 'app/*.spec.mjs'],
    // One test at a time, everywhere. Tests running side by side compete for the machine, and a test that fails
    // because of that costs far more time, to rerun and look into, than running them in turn. --workers on the command
    // line still wins, which StressTests.ps1 uses to test under load on purpose.
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    // A failure is a failure, here and on CI: a test that only sometimes passes is a bug to fix, not to retry.
    retries: 0,
    // A check stops waiting as soon as it passes, so these limits cost nothing when tests pass. They are long enough
    // that a machine busy with other work only slows a run down, and never fails it; a check that can never pass still
    // fails, just later.
    timeout: 60000,
    expect: { timeout: 15000 },
    // One browser test run at a time on this machine (see the file).
    globalSetup: './tests/browser/support/machine-lock.mjs',
    // On CI the github reporter names each failed test on the run's page, where it can be read without the log.
    reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
    use: {
        // Nothing listens here. Tests answer every request, and the loader comes from the CDN, as in the app.
        baseURL: 'http://127.0.0.1:1426',
        serviceWorkers: 'block',
        viewport: { width: 1500, height: 1000 },
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        launchOptions: executablePath ? { executablePath, args: ['--no-sandbox'] } : {},
    },
    // Only the minified files are tested, since they are what the app loads. The project keeps the name min, which
    // StressTests.ps1 asks for.
    projects: [{ name: 'min' }],
});
