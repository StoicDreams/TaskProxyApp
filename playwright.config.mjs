import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { existsSync } from 'node:fs';

// Playwright does not provide browser builds for every Linux distribution, so prefer a
// system Chromium there. On other systems run: npx playwright install chromium
const systemChromium = process.platform === 'linux' && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined;
const executablePath = process.env.PW_CHROMIUM_PATH || systemChromium;

// Machine settings, so tests leave room for other work. Unset, Playwright's defaults apply, as on CI.
// PW_WORKERS: how many tests run at once, such as 4 or 25%. --workers on the command line still wins.
// PW_NICE: lowers the priority of the test run and the browsers it starts: 1 to 19, or idle for only spare CPU.
// Chromium sets its own threads' priorities, so on Linux idle uses the idle scheduling class, which it keeps.
const workersSetting = process.env.PW_WORKERS?.trim();
const workers = /^\d+$/.test(workersSetting || '') ? Number(workersSetting) : workersSetting || undefined;
const nice = process.env.PW_NICE?.trim();
if (nice === 'idle' && process.platform === 'linux') {
    try { execFileSync('chrt', ['--all-tasks', '--idle', '-p', '0', `${process.pid}`], { stdio: 'ignore' }); } catch { try { os.setPriority(19); } catch { } }
} else if (nice) {
    try { os.setPriority(nice === 'idle' ? 19 : Math.min(19, Math.max(0, Number(nice) || 0))); } catch { }
}

export default defineConfig({
    testDir: './tests',
    testMatch: '**/*.spec.mjs',
    fullyParallel: true,
    workers,
    forbidOnly: !!process.env.CI,
    // Components load from the live CDN, which can occasionally be slow, so CI tries a failed test again.
    // Locally a test that only passes on its second try fails, so a timing problem shows before CI finds it.
    retries: process.env.CI ? 1 : 0,
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        // Nothing listens here. Tests answer every request, and the loader comes from the CDN, as in the app.
        baseURL: 'http://127.0.0.1:1426',
        serviceWorkers: 'block',
        viewport: { width: 1500, height: 1000 },
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
        launchOptions: executablePath ? { executablePath, args: ['--no-sandbox'] } : {},
    },
    projects: [
        // Source files give failures with readable code and line numbers. Use this while working.
        { name: 'source', use: { useMinified: false } },
        // The minified files are what the app loads. Run this before pushing.
        { name: 'min', use: { useMinified: true } },
    ],
});
