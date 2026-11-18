import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { programEnv } from '../support/program-env.mjs';

// PowerShell/LocalCdn.ps1, which Trunk runs after each build: a development build loads Web UI from a local MyFiCDN
// server. It runs in a temporary staging folder, as Trunk's, never in this repo, and needs PowerShell 7 (pwsh).
const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'PowerShell', 'LocalCdn.ps1');
const temps = [];
test.afterAll(() => temps.forEach(dir => rmSync(dir, { recursive: true, force: true })));

const INDEX = '<link href="https://cdn.myfi.ws/css/webui.min.css" rel="stylesheet" />\n<script src="https://cdn.myfi.ws/webui/loader.min.js"></script>\n';
const PAGE = '<webui-content src="https://cdn.myfi.ws/d/terms.md"></webui-content>\n';
function staging() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'local-cdn-spec-')));
    temps.push(dir);
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'index.html'), INDEX);
    writeFileSync(join(dir, 'd', 'terms.md'), PAGE);
    return dir;
}
// Run without blocking, so a server in this test can answer the script.
function run(dir, env, args = []) {
    return new Promise((resolve, reject) => {
        const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, ...args],
            { cwd: dir, env: programEnv({ TRUNK_STAGING_DIR: dir, ...env }) });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        child.on('error', error => reject(new Error(`Could not run pwsh, which these tests need: ${error.message}`)));
        child.on('close', code => {
            expect(code, output).toBe(0);
            resolve(output);
        });
    });
}
const read = (dir, path) => readFileSync(join(dir, path), 'utf8');

test('a development build loads Web UI from the server TASKPROXY_CDN names', async () => {
    const dir = staging();
    const output = await run(dir, { TRUNK_PROFILE: 'debug', TASKPROXY_CDN: 'http://127.0.0.1:3210/' });
    expect(read(dir, 'index.html')).toBe(INDEX.replaceAll('https://cdn.myfi.ws/', 'http://127.0.0.1:3210/'));
    expect(read(dir, 'd/terms.md')).toBe(PAGE.replace('https://cdn.myfi.ws/', 'http://127.0.0.1:3210/'));
    expect(output).toContain('http://127.0.0.1:3210');
});

test('a release build, or TASKPROXY_CDN=live, keeps cdn.myfi.ws', async () => {
    const release = staging();
    await run(release, { TRUNK_PROFILE: 'release', TASKPROXY_CDN: 'http://127.0.0.1:3210' });
    expect(read(release, 'index.html')).toBe(INDEX);
    const live = staging();
    await run(live, { TRUNK_PROFILE: 'debug', TASKPROXY_CDN: 'live' });
    expect(read(live, 'index.html')).toBe(INDEX);
    expect(read(live, 'd/terms.md')).toBe(PAGE);
});

test('without TASKPROXY_CDN, a development build uses the local server when it answers, and cdn.myfi.ws when not', async () => {
    const server = createServer((request, response) => {
        response.statusCode = request.url === '/webui/loader.min.js' ? 200 : 404;
        response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${server.address().port}`;
    const running = staging();
    await run(running, { TRUNK_PROFILE: 'debug' }, ['-LocalAddress', address]);
    expect(read(running, 'index.html')).toBe(INDEX.replaceAll('https://cdn.myfi.ws/', `${address}/`));
    await new Promise(resolve => server.close(resolve));
    const stopped = staging();
    await run(stopped, { TRUNK_PROFILE: 'debug' }, ['-LocalAddress', address]);
    expect(read(stopped, 'index.html')).toBe(INDEX);
    expect(read(stopped, 'd/terms.md')).toBe(PAGE);
});
