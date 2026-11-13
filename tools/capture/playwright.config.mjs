import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// Captures the website's screenshots and videos. Run with: npm run capture
// It is kept apart from the tests, so `npm test` never runs it.
const systemChromium = process.platform === 'linux' && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined;
const executablePath = process.env.PW_CHROMIUM_PATH || systemChromium;

export default defineConfig({
    testDir: '.',
    testMatch: '**/*.capture.mjs',
    // A few at a time keeps a publish quick while leaving each recording enough CPU to come out smooth.
    // Set CAPTURE_WORKERS to change it, such as 1 on a slow machine.
    workers: parseInt(process.env.CAPTURE_WORKERS) || 3,
    retries: 1,
    timeout: 120000,
    reporter: [['list']],
    outputDir: '../../test-results/capture',
    use: {
        baseURL: 'http://127.0.0.1:1426',
        serviceWorkers: 'block',
        viewport: { width: 1440, height: 900 },
        colorScheme: 'dark',
        launchOptions: executablePath ? { executablePath, args: ['--no-sandbox'] } : {},
    },
});
