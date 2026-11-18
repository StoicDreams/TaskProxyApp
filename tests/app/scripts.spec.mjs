import { test, expect } from '@playwright/test';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// The PowerShell scripts in every site, the CDN, and Task Proxy, so change this spec in all of them at once.
// Each test runs a script in a temporary folder, never in this repo. They need PowerShell 7 (pwsh).
let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(root, 'PowerShell', 'Publish.ps1'))) {
    if (dirname(root) === root) throw new Error('No PowerShell/Publish.ps1 above this spec.');
    root = dirname(root);
}
const scripts = join(root, 'PowerShell');
const publishHasSiteMap = readFileSync(join(scripts, 'Publish.ps1'), 'utf8').includes('SkipSiteMap');
const temps = [];
test.afterAll(() => temps.forEach(dir => rmSync(dir, { recursive: true, force: true })));

// Programs these tests start get the same environment wherever the tests run: the run's own settings, such as CI's
// and Publish's, are left out, so a script never behaves differently on CI, in a full run, or beside other specs.
const RUN_SETTINGS = ['CI', 'GITHUB_ACTIONS', 'PW_NO_CACHE', 'PW_WORKERS', 'PW_NICE', 'PW_TEST_CACHE_ROOT', 'WEBUI_CDN_ROOT', 'TASKPROXY_CDN'];
function programEnv(env = {}) {
    const clean = { ...process.env };
    for (const key of Object.keys(clean)) if (RUN_SETTINGS.includes(key.toUpperCase())) delete clean[key];
    return { ...clean, ...env };
}

function tempFolder() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scripts-spec-')));
    temps.push(dir);
    mkdirSync(join(dir, 'PowerShell'));
    return dir;
}
function write(dir, path, text) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
}
function pwsh(cwd, script, args = [], env = {}) {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, ...args],
        { cwd, encoding: 'utf8', env: programEnv(env), timeout: 180000 });
    if (result.error) throw new Error(`Could not run pwsh, which these tests need: ${result.error.message}`);
    return { code: result.status, output: result.stdout + result.stderr };
}

test.describe('Publish.ps1', () => {
    // Stand-ins for the real steps, which write what they were asked to do to a log.
    const stub = name => `param([switch]$major, [switch]$minor)
"${name} major=$major minor=$minor in=$((Get-Location).Path)" | Add-Content -Path $env:PUBLISH_LOG
if ($env:PUBLISH_FAIL -eq '${name}') { exit 3 }
if ($env:PUBLISH_THROW -eq '${name}') { throw '${name} broke' }
`;
    // What builds the files the tests check, then the version, which changes only once everything has passed.
    const before = ['Minify', ...(publishHasSiteMap ? ['BuildSiteMap'] : [])];
    const steps = [...before, 'IncrementVersion'];
    const versionLine = result => result.lines.find(line => line.startsWith('IncrementVersion'));
    // The temporary folder has no Cargo.toml or package.json unless a test adds one, so no real tests run.
    function publish(args = [], env = {}, files = {}) {
        const dir = tempFolder();
        copyFileSync(join(scripts, 'Publish.ps1'), join(dir, 'PowerShell', 'Publish.ps1'));
        for (const step of ['IncrementVersion', 'Minify', 'BuildSiteMap']) write(dir, `PowerShell/${step}.ps1`, stub(step));
        for (const [path, text] of Object.entries(files)) write(dir, path, text);
        const log = join(dir, 'publish.log');
        // Run from another folder, to show the steps still run from the project root.
        const result = pwsh(join(dir, 'PowerShell'), join(dir, 'PowerShell', 'Publish.ps1'), args, { PUBLISH_LOG: log, ...env });
        const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/) : [];
        return { ...result, dir, lines, ran: lines.map(line => line.split(' ')[0]) };
    }

    test('runs every step in order from the project root, then says it is ready', () => {
        const result = publish();
        expect(result.code, result.output).toBe(0);
        expect(result.ran).toEqual(steps);
        for (const line of result.lines) expect(line).toContain(`in=${result.dir}`);
        expect(versionLine(result)).toContain('major=False minor=False');
        expect(result.output).toContain('Ready to commit.');
    });

    test('-Version minor and -Version major are passed to IncrementVersion', () => {
        expect(versionLine(publish(['-Version', 'minor']))).toContain('major=False minor=True');
        expect(versionLine(publish(['-Version', 'major']))).toContain('major=True minor=False');
    });

    test('an unknown -Version is refused before anything runs', () => {
        const result = publish(['-Version', 'huge']);
        expect(result.code).not.toBe(0);
        expect(result.ran).toEqual([]);
    });

    for (const step of steps) {
        const skip = step === 'IncrementVersion' ? '-SkipIncrementVersion' : step === 'Minify' ? '-SkipMinify' : '-SkipSiteMap';
        test(`${skip} leaves out ${step}`, () => {
            const result = publish([skip]);
            expect(result.code, result.output).toBe(0);
            expect(result.ran).toEqual(steps.filter(name => name !== step));
        });
    }

    test('a step that exits with an error stops Publish, and Publish fails, leaving the version alone', () => {
        const result = publish([], { PUBLISH_FAIL: 'Minify' });
        expect(result.code).not.toBe(0);
        expect(result.ran).toEqual(['Minify']);
        expect(result.output).toContain('exit code 3');
        expect(result.output).not.toContain('Ready to commit.');
    });

    test('a step that throws stops Publish, and Publish fails', () => {
        const result = publish([], { PUBLISH_THROW: 'IncrementVersion' });
        expect(result.code).not.toBe(0);
        expect(result.ran).toEqual(steps);
        expect(result.output).toContain('IncrementVersion broke');
    });

    // A package.json whose test scripts only write to the log, or fail.
    const logLine = name => `node -e "require('fs').appendFileSync(process.env.PUBLISH_LOG, '${name}' + require('os').EOL)"`;
    const packageJson = scripts => ({ 'package.json': JSON.stringify({ name: 'publish-spec', private: true, scripts }) });

    test('runs the UI tests once the files they test are ready, and before the version changes', () => {
        const result = publish([], {}, packageJson({ test: logLine('npm-test') }));
        expect(result.code, result.output).toBe(0);
        expect(result.ran).toEqual([...before, 'npm-test', 'IncrementVersion']);
        expect(result.output).toContain('Ready to commit.');
    });

    test('runs test:min instead when the project has it, as its CI does', () => {
        const result = publish([], {}, packageJson({ test: logLine('npm-test'), 'test:min': logLine('npm-test-min') }));
        expect(result.code, result.output).toBe(0);
        expect(result.ran).toEqual([...before, 'npm-test-min', 'IncrementVersion']);
    });

    test('failing tests make Publish fail, and leave the version alone so running it again bumps it once', () => {
        const result = publish([], {}, packageJson({ test: 'node -e "process.exit(1)"' }));
        expect(result.code).not.toBe(0);
        expect(result.ran).toEqual(before);
        expect(result.output).toContain('Run the UI tests failed');
        expect(result.output).not.toContain('Ready to commit.');
    });

    test('-SkipTests leaves out the tests', () => {
        const result = publish(['-SkipTests'], {}, packageJson({ test: logLine('npm-test') }));
        expect(result.code, result.output).toBe(0);
        expect(result.ran).toEqual(steps);
    });
});

test.describe('Minify.ps1', () => {
    // Minify downloads esbuild the first time it runs on a computer.
    test.describe.configure({ timeout: 240000 });
    const source = `// A comment that minifying removes.
function addTogether(firstNumber, secondNumber) {
    const total = firstNumber + secondNumber;
    return total;
}
globalThis.result = addTogether(2, 3);
`;
    function minify(files, args = []) {
        const dir = tempFolder();
        copyFileSync(join(scripts, 'Minify.ps1'), join(dir, 'PowerShell', 'Minify.ps1'));
        for (const [path, text] of Object.entries(files)) write(dir, path, text);
        return { ...pwsh(dir, join(dir, 'PowerShell', 'Minify.ps1'), args), dir, has: path => existsSync(join(dir, path)), read: path => readFileSync(join(dir, path), 'utf8') };
    }
    const runs = code => {
        const sandbox = {};
        vm.runInNewContext(code, sandbox);
        return sandbox.result;
    };

    test('a site has its components, root files, and CSS minified, and nothing else', () => {
        const result = minify({
            'webapp/wc/sum.js': source,
            'webapp/root_files/start.js': source,
            'webapp/css/app.css': '.box {\n    color: #ff0000;\n    margin: 0px;\n}\n',
            'webapp/wc/vendor/library.js': source,
            'webapp/wc/node_modules/package.js': source,
            'webapp/wc/done.min.js': 'kept',
            'webapp/d/notes.js': source,
        });
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('Minified 3 files with esbuild');
        const minified = result.read('webapp/wc/sum.min.js');
        expect(minified.length).toBeLessThan(source.length);
        expect(minified).not.toContain('A comment');
        expect(runs(minified)).toBe(5);
        expect(runs(result.read('webapp/root_files/start.min.js'))).toBe(5);
        expect(result.read('webapp/css/app.min.css').trim()).toBe('.box{color:red;margin:0}');
        for (const path of ['webapp/wc/vendor/library.min.js', 'webapp/wc/node_modules/package.min.js', 'webapp/wc/done.min.min.js', 'webapp/d/notes.min.js']) {
            expect(result.has(path), path).toBe(false);
        }
        expect(result.read('webapp/wc/done.min.js')).toBe('kept');
    });

    test('without a webapp folder, wc, root_files, and css are minified, leaving out the component template', () => {
        const result = minify({ 'wc/sum.js': source, 'wc/template.js': source, 'css/app.css': '.a { color: red; }' });
        expect(result.code, result.output).toBe(0);
        expect(result.has('wc/sum.min.js')).toBe(true);
        expect(result.has('css/app.min.css')).toBe(true);
        expect(result.has('wc/template.min.js')).toBe(false);
    });

    test('the CDN has its cdn folder minified', () => {
        const result = minify({ 'cdn/webui/sum.js': source });
        expect(result.code, result.output).toBe(0);
        expect(runs(result.read('cdn/webui/sum.min.js'))).toBe(5);
    });

    test('-Path and -Exclude choose the files', () => {
        const result = minify({ 'lib/sum.js': source, 'lib/skip.js': source, 'wc/other.js': source }, ['-Path', 'lib', '-Exclude', 'lib/skip.js']);
        expect(result.code, result.output).toBe(0);
        expect(result.has('lib/sum.min.js')).toBe(true);
        expect(result.has('lib/skip.min.js')).toBe(false);
        expect(result.has('wc/other.min.js')).toBe(false);
    });

    test('a file that cannot be parsed makes Minify fail', () => {
        const result = minify({ 'wc/broken.js': 'function (' });
        expect(result.code).not.toBe(0);
        expect(result.output).toContain('esbuild could not minify');
    });

    test('with nothing to minify it says so, without downloading anything', () => {
        const result = minify({ 'wc/readme.txt': 'x' });
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('No CSS or JavaScript files to minify');
    });
});

test.describe('IncrementVersion.ps1', () => {
    // The version is in the service worker everywhere, and the files that hold it are found with git,
    // so this works the same in every repo without listing each repo's version files here.
    const worker = ['webapp/root_files/service-worker.js', 'cdn/service-worker.js', 'root_files/service-worker.js'].find(path => existsSync(join(root, path)));
    const current = readFileSync(join(root, worker), 'utf8').match(/currentVersion = '([^']+)'/)[1];
    const versionFiles = execFileSync('git', ['grep', '-lF', current, '--', '.', ':!*.lock', ':!package-lock.json', ':!*.spec.mjs'], { cwd: root, encoding: 'utf8' })
        .trim().split('\n').filter(Boolean);
    const bump = (version, part) => {
        const [major, minor, patch] = version.split('.').map(Number);
        return part === 'major' ? `${major + 1}.0.0` : part === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
    };

    test('with no version to find, it fails so Publish stops', () => {
        const dir = tempFolder();
        for (const name of readdirSync(scripts).filter(name => name.endsWith('.ps1'))) copyFileSync(join(scripts, name), join(dir, 'PowerShell', name));
        const result = pwsh(dir, join(dir, 'PowerShell', 'IncrementVersion.ps1'));
        expect(result.code, result.output).not.toBe(0);
    });

    for (const part of ['patch', 'minor', 'major']) {
        test(`a ${part} update changes the version in every file that holds it`, () => {
            const dir = tempFolder();
            // Some versions of it load helper scripts from beside it.
            for (const name of readdirSync(scripts).filter(name => name.endsWith('.ps1'))) copyFileSync(join(scripts, name), join(dir, 'PowerShell', name));
            for (const path of versionFiles) write(dir, path, readFileSync(join(root, path), 'utf8'));
            const result = pwsh(dir, join(dir, 'PowerShell', 'IncrementVersion.ps1'), part === 'patch' ? [] : [`-${part}`]);
            expect(result.code, result.output).toBe(0);
            const expected = bump(current, part);
            const stale = versionFiles.filter(path => readFileSync(join(dir, path), 'utf8').includes(current));
            expect(stale, `These files still have version ${current}`).toEqual([]);
            const missing = versionFiles.filter(path => !readFileSync(join(dir, path), 'utf8').includes(expected));
            expect(missing, `These files do not have version ${expected}`).toEqual([]);
        });
    }
});

test.describe('StressTests.ps1', () => {
    // A project in a git repo, with a stand-in npx first on the PATH that logs what it was asked to run, or fails.
    function project({ files = {}, oldFiles = {}, scripts = { test: 'playwright test --project=live-cdn' } } = {}) {
        const dir = tempFolder();
        copyFileSync(join(root, 'PowerShell', 'StressTests.ps1'), join(dir, 'PowerShell', 'StressTests.ps1'));
        write(dir, 'package.json', JSON.stringify({ name: 'stress-spec', private: true, scripts }));
        const git = (args, env = {}) => execFileSync('git', args, { cwd: dir, env: programEnv(env), stdio: 'pipe' });
        git(['init', '-q']);
        git(['config', 'user.email', 'spec@example.com']);
        git(['config', 'user.name', 'Spec']);
        // Files committed 30 days ago, which a week's changes leave out.
        const old = new Date(Date.now() - 30 * 86400000).toISOString();
        for (const [path, text] of Object.entries({ 'tests/a.spec.mjs': '', 'tests/b.spec.mjs': '', ...oldFiles })) write(dir, path, text);
        git(['add', '-A']);
        git(['commit', '-q', '-m', 'old'], { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old });
        for (const [path, text] of Object.entries(files)) write(dir, path, text);
        if (Object.keys(files).length) {
            git(['add', '-A']);
            git(['commit', '-q', '-m', 'this week']);
        }
        const bin = join(tempFolder(), 'bin');
        write(bin, 'npx', '#!/bin/sh\necho "npx $* nocache=$PW_NO_CACHE" >> "$STRESS_LOG"\n[ -n "$STRESS_FAIL" ] && exit 1\nexit 0\n');
        chmodSync(join(bin, 'npx'), 0o755);
        write(bin, 'npx.cmd', '@echo npx %* nocache=%PW_NO_CACHE%>> "%STRESS_LOG%"\r\n@if not "%STRESS_FAIL%"=="" exit /b 1\r\n@exit /b 0\r\n');
        const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
        const log = join(dir, 'stress.log');
        const run = (args = [], env = {}) => {
            const result = pwsh(dir, join(dir, 'PowerShell', 'StressTests.ps1'), args,
                { [pathKey]: bin + (process.platform === 'win32' ? ';' : ':') + process.env[pathKey], STRESS_LOG: log, PW_NO_CACHE: '', ...env });
            return { ...result, ran: existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/) : [] };
        };
        return { dir, run };
    }
    // A test cache entry, as tests/support/test-cache.mjs writes one, for a test in `spec` that used `files`.
    const entry = (spec, files) => JSON.stringify({ id: `min > ${spec} > a test`, deps: Object.fromEntries(files.map(file => [`file:${file}`, 'x'])) });

    test('with nothing changed in the last week it says so and runs nothing', () => {
        const result = project().run();
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('Nothing changed in the last 7 days');
        expect(result.ran).toEqual([]);
    });

    test('a change this week stresses every spec without a cache, many times, under load, with no retries or cache', () => {
        const result = project({ files: { 'webapp/page.md': 'new' } }).run();
        expect(result.code, result.output).toBe(0);
        expect(result.ran).toEqual(['npx playwright test --repeat-each=10 --workers=150% --retries=0 --timeout=60000 --reporter=dot --project=live-cdn nocache=1']);
        expect(result.output).toContain('Every test passed 10 times under load.');
    });

    test('work not committed yet counts as a change', () => {
        const { dir, run } = project();
        write(dir, 'webapp/new.md', 'not committed');
        expect(run().ran).toHaveLength(1);
    });

    test('with the test cache, only the specs whose tests used a changed file are stressed', () => {
        const { dir, run } = project({ files: { 'wc/changed.js': 'new' }, scripts: { test: 'playwright test', 'test:min': 'playwright test --project=min' } });
        write(dir, '.test-cache/1.json', entry('tests/a.spec.mjs', ['wc/changed.js', 'index.html']));
        write(dir, '.test-cache/2.json', entry('tests/b.spec.mjs', ['wc/other.js', 'index.html']));
        const result = run();
        expect(result.code, result.output).toBe(0);
        // The files CI tests: the minified ones, for a project with test:min.
        expect(result.ran).toEqual(['npx playwright test tests/a.spec.mjs --repeat-each=10 --workers=150% --retries=0 --timeout=60000 --reporter=dot --project=min nocache=1']);
    });

    test('with the test cache, a change nothing uses stresses nothing', () => {
        const { dir, run } = project({ files: { 'Docs/notes.md': 'new' } });
        write(dir, '.test-cache/1.json', entry('tests/a.spec.mjs', ['wc/a.js']));
        const result = run();
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('Nothing the UI tests use changed');
        expect(result.ran).toEqual([]);
    });

    test('a changed test setup stresses every spec, even with the cache', () => {
        const { dir, run } = project({ files: { 'tests/support/helpers.mjs': 'new' } });
        write(dir, '.test-cache/1.json', entry('tests/a.spec.mjs', ['wc/a.js']));
        expect(run().ran[0]).toMatch(/^npx playwright test --repeat-each=10/);
    });

    test('-Days, -Repeat, and -All choose what runs and how often', () => {
        const { run } = project();
        expect(run(['-Days', '60']).ran).toHaveLength(1);
        const all = run(['-All', '-Repeat', '3']).ran.at(-1);
        expect(all).toContain('--repeat-each=3');
    });

    test('a test that fails under load makes the script fail', () => {
        const result = project({ files: { 'webapp/page.md': 'new' } }).run([], { STRESS_FAIL: '1' });
        expect(result.code).not.toBe(0);
        expect(result.output).toContain('Some tests failed under load.');
    });
});
