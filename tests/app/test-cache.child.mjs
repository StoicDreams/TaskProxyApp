// Runs the UI test cache (tests/support/test-cache.mjs) for tests/app/test-cache.spec.mjs, in a process of its own on
// the temporary folder PW_TEST_CACHE_ROOT names, so nothing it does reaches the repo, the test run, or another test.
// The steps come as JSON in the first argument, and what each check found is printed as JSON.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cdnBodyFingerprint, finishRecording, noteCdn, startRecording, unchangedSincePassing } from '../support/test-cache.mjs';

const root = process.env.PW_TEST_CACHE_ROOT;
const steps = JSON.parse(process.argv[2]);
/** A made-up test as Playwright describes it to fixtures. */
const testInfo = (overrides = {}) => ({
    project: { name: 'cache-check', repeatEach: 1 },
    file: join(root, 'tests', 'made-up.spec.mjs'),
    titlePath: ['made-up.spec.mjs', 'made up'],
    retry: 0,
    status: 'passed',
    errors: [],
    ...overrides,
});
const results = [];
for (const step of steps) {
    if (step.write) writeFileSync(join(root, step.write[0]), step.write[1]);
    if (step.env) {
        for (const [key, value] of Object.entries(step.env)) {
            if (value === null) delete process.env[key];
            else process.env[key] = value;
        }
    }
    if (step.run) {
        const info = testInfo(step.run.info);
        startRecording(info);
        (step.run.reads || []).forEach(name => readFileSync(join(root, name)));
        Object.entries(step.run.cdn || {}).forEach(([url, body]) => noteCdn(url, Buffer.from(body)));
        if (step.run.errors) info.errors = step.run.errors.map(message => new Error(message));
        finishRecording(info);
    }
    if (step.check) {
        const cdn = step.check.cdn || {};
        results.push(await unchangedSincePassing(testInfo(step.check.info), async url => cdnBodyFingerprint(cdn[url] === undefined ? undefined : Buffer.from(cdn[url]))));
    }
}
process.stdout.write(JSON.stringify(results));
