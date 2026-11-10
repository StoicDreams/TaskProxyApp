import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// Playwright does not provide browser builds for every Linux distribution, so prefer a
// system Chromium there. On other systems run: npx playwright install chromium
const systemChromium = process.platform === 'linux' && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined;
const executablePath = process.env.PW_CHROMIUM_PATH || systemChromium;

export default defineConfig({
    testDir: './tests',
    testMatch: '**/*.spec.mjs',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    // Components load from the live CDN, which can occasionally be slow, so CI tries a failed test again.
    // Locally a test that only passes on its second try fails, so a timing problem shows before CI finds it.
    retries: process.env.CI ? 1 : 0,
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        // Nothing listens here. Tests answer every request, and the loader picks the local copy on this host.
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
