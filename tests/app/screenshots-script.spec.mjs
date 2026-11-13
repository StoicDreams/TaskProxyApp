import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Task Proxy's own screenshots.ps1, and how Publish.ps1 runs it. The shared script tests are in scripts.spec.mjs.
// Each test runs a script in a temporary folder, never in this repo. They need PowerShell 7 (pwsh).
const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'PowerShell');
const temps = [];
test.afterAll(() => temps.forEach(dir => rmSync(dir, { recursive: true, force: true })));

/** A temporary parent folder, holding a project folder with these files, so the website's place beside it can be tested. */
function tempProject(files) {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'screenshots-spec-')));
    temps.push(parent);
    const dir = join(parent, 'Desktop', 'TaskProxyApp');
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
    }
    return { parent, dir };
}
function pwsh(cwd, script, args = [], env = {}) {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, ...args],
        { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180000 });
    if (result.error) throw new Error(`Could not run pwsh, which these tests need: ${result.error.message}`);
    return { code: result.status, output: result.stdout + result.stderr };
}
const lines = log => existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/) : [];

test.describe('screenshots.ps1', () => {
    // A package.json whose capture script writes what it was asked for to a log, in place of the real captures.
    const capture = code => JSON.stringify({ name: 'spec', private: true, scripts: {
        capture: `node -e "require('fs').appendFileSync(process.env.SPEC_LOG, 'capture ' + process.argv.slice(1).join(' ') + ' out=' + process.env.CAPTURE_OUT + require('os').EOL); process.exit(${code})"`,
    } });
    const run = (project, args = [], code = 0) => {
        const log = join(project.parent, 'spec.log');
        copyFileSync(join(scripts, 'screenshots.ps1'), join(project.dir, 'PowerShell', 'screenshots.ps1'));
        writeFileSync(join(project.dir, 'package.json'), capture(code));
        // Run from another folder, to show it runs from the project root.
        return { ...pwsh(project.parent, join(project.dir, 'PowerShell', 'screenshots.ps1'), args, { SPEC_LOG: log }), ran: lines(log) };
    };

    test('captures every image and video, into the TaskProxy website beside this repo', () => {
        const project = tempProject({ 'PowerShell/.keep': '', '../../Websites/TaskProxy/webapp/root_files/.keep': '' });
        const result = run(project);
        expect(result.code, result.output).toBe(0);
        expect(result.ran).toEqual([`capture  out=${join(project.parent, 'Websites', 'TaskProxy', 'webapp', 'root_files')}`]);
        expect(result.output).toContain('Commit them');
    });
    test('without the website checkout it fails and says where it looked, before capturing anything', () => {
        const project = tempProject({ 'PowerShell/.keep': '' });
        const result = run(project);
        expect(result.code).not.toBe(0);
        expect(result.output).toContain('TaskProxy website checkout was not found');
        expect(result.ran).toEqual([]);
    });
    test('-OutputPath writes somewhere else, with no website needed', () => {
        const project = tempProject({ 'PowerShell/.keep': '' });
        const result = run(project, ['-OutputPath', join(project.parent, 'media')]);
        expect(result.code, result.output).toBe(0);
        expect(result.ran).toEqual([`capture  out=${join(project.parent, 'media')}`]);
    });
    test('a capture that fails makes the script fail', () => {
        const project = tempProject({ 'PowerShell/.keep': '' });
        const result = run(project, ['-OutputPath', join(project.parent, 'media')], 1);
        expect(result.code).not.toBe(0);
        expect(result.output).toContain('Capturing the images and videos failed');
    });
});

test.describe('Publish.ps1 with screenshots.ps1', () => {
    const stub = name => `"${name}" | Add-Content -Path $env:PUBLISH_LOG
if ($env:PUBLISH_FAIL -eq '${name}') { exit 3 }
`;
    function publish(args = [], env = {}, withScreenshots = true) {
        const steps = ['IncrementVersion', 'Minify', ...(withScreenshots ? ['screenshots'] : [])];
        const project = tempProject(Object.fromEntries(steps.map(step => [`PowerShell/${step}.ps1`, stub(step)])));
        copyFileSync(join(scripts, 'Publish.ps1'), join(project.dir, 'PowerShell', 'Publish.ps1'));
        const log = join(project.parent, 'publish.log');
        const result = pwsh(project.dir, join(project.dir, 'PowerShell', 'Publish.ps1'), args, { PUBLISH_LOG: log, ...env });
        return { ...result, ran: lines(log) };
    }

    test('updates the screenshots last, once everything else has passed', () => {
        const result = publish();
        expect(result.code, result.output).toBe(0);
        expect(result.ran).toEqual(['IncrementVersion', 'Minify', 'screenshots']);
        expect(result.output).toContain('Ready to commit.');
    });
    test('-SkipScreenshots, or -SkipMedia, leaves them out', () => {
        for (const flag of ['-SkipScreenshots', '-SkipMedia']) {
            const result = publish([flag]);
            expect(result.code, result.output).toBe(0);
            expect(result.ran).toEqual(['IncrementVersion', 'Minify']);
        }
    });
    test('a failed step before them means no screenshots are taken', () => {
        const result = publish([], { PUBLISH_FAIL: 'Minify' });
        expect(result.code).not.toBe(0);
        expect(result.ran).toEqual(['IncrementVersion', 'Minify']);
    });
    test('failed screenshots make Publish fail', () => {
        const result = publish([], { PUBLISH_FAIL: 'screenshots' });
        expect(result.code).not.toBe(0);
        expect(result.output).toContain('Update the website images and videos failed');
        expect(result.output).not.toContain('Ready to commit.');
    });
    test('a project without screenshots.ps1 publishes as before', () => {
        const result = publish([], {}, false);
        expect(result.code, result.output).toBe(0);
        expect(result.ran).toEqual(['IncrementVersion', 'Minify']);
    });
});
