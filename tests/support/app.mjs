import { test as base, expect, request as apiRequest } from '@playwright/test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBackend } from './backend.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Set to a MyFiCDN checkout's cdn folder to test against unreleased components instead of the live CDN.
const CDN_ROOT = process.env.WEBUI_CDN_ROOT;
const MIME = {
    '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.md': 'text/plain', '.wasm': 'application/wasm',
};

// What Trunk does to index.html, without needing a build.
function buildIndex() {
    return readFileSync(join(ROOT, 'index.html'), 'utf8')
        .replace(/<link data-trunk [^>]*rel="copy-dir"[^>]*>/g, '')
        .replace(/<link data-trunk href="css\/app\.min\.css" rel="css" \/>/, '<link href="/css/app.min.css" rel="stylesheet" />')
        .replace(/<script data-trunk src="root_files\/app\.min\.js" data-no-minify><\/script>/, '<script src="/app.min.js"></script>');
}

// Only the minified files are tested: they are what the app loads.
function resolveFile(pathname) {
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
    for (const folder of ['root_files', '']) {
        const file = normalize(join(ROOT, folder, relative));
        if (!file.startsWith(ROOT.replace(/[\\/]+$/, '') + sep)) continue;
        if (existsSync(file) && statSync(file).isFile()) return file;
    }
    return null;
}

// Each framework file is downloaded from cdn.myfi.ws once per test worker and kept, instead of once per test, as the
// websites' tests do. Thousands of requests per run meant a dropped or stalled connection now and then, which failed
// whichever test it hit. A failed download is retried, and if it never succeeds the browser asks itself.
const liveCdn = new Map();
let liveCdnClient;
// A file takes well under a second, so a download that stalls is given up on soon enough to retry within one test.
const LIVE_CDN_ATTEMPTS = 4;
const LIVE_CDN_TIMEOUT = 5000;

async function downloadLiveCdn(url) {
    liveCdnClient ??= await apiRequest.newContext();
    for (let attempt = 1; ; attempt++) {
        try {
            const response = await liveCdnClient.get(url, { timeout: LIVE_CDN_TIMEOUT });
            if (response.status() < 500 || attempt === LIVE_CDN_ATTEMPTS) {
                return { status: response.status(), contentType: response.headers()['content-type'], body: await response.body() };
            }
        } catch (error) {
            if (attempt === LIVE_CDN_ATTEMPTS) return null;
        }
        await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
}

async function serveLiveCdn(route) {
    const request = route.request();
    if (request.method() !== 'GET') return route.continue();
    const url = `https://cdn.myfi.ws${new URL(request.url()).pathname}`;
    if (!liveCdn.has(url)) liveCdn.set(url, downloadLiveCdn(url));
    const file = await liveCdn.get(url);
    if (!file) {
        liveCdn.delete(url);
        return route.continue();
    }
    return route.fulfill({ status: file.status, contentType: file.contentType, body: file.body, headers: { 'access-control-allow-origin': '*' } });
}

function serve(route) {
    const url = new URL(route.request().url());
    // Components load from the live CDN, as they do in the app, so a breaking deploy fails these tests.
    if (url.hostname === 'cdn.myfi.ws') {
        if (!CDN_ROOT) return serveLiveCdn(route);
        const file = normalize(join(CDN_ROOT, decodeURIComponent(url.pathname)));
        const found = existsSync(file) && statSync(file).isFile() ? file : null;
        if (!found) return route.fulfill({ status: 404, body: 'Not Found' });
        return route.fulfill({ contentType: MIME[extname(found)] || 'application/octet-stream', body: readFileSync(found), headers: { 'access-control-allow-origin': '*' } });
    }
    if (url.hostname !== '127.0.0.1') return route.abort();
    const file = url.pathname === '/' ? null : resolveFile(url.pathname);
    if (file) {
        return route.fulfill({ contentType: MIME[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
    }
    if (extname(url.pathname)) {
        return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
    }
    // Page routes fall back to the app shell, the same as the deployed app.
    return route.fulfill({ contentType: 'text/html', body: buildIndex() });
}

// The browser tests (tests/browser) and the captures (tools/capture): what needs a real browser. Everything else is in
// tests/unit, which runs the same app in jsdom (tests/unit/support/app.mjs).
export const test = base.extend({
    // A worker's first test would otherwise download every framework file the app loads while it opens the app. With
    // many workers starting at once on a busy machine, that took most of a test's time, so whichever test ran first in
    // a worker could time out. Each worker opens the app once, in its own time, before its first test that loads a
    // page, so tests start with the files in memory.
    warmCdn: [async ({ browser }, use, workerInfo) => {
        if (!CDN_ROOT) {
            const { baseURL, serviceWorkers, viewport } = workerInfo.project.use;
            const context = await browser.newContext({ baseURL, serviceWorkers, viewport });
            const page = await context.newPage();
            await page.route('**/*', route => serve(route));
            // Only a head start: if it can't finish, tests download what they need as before.
            let timer;
            await Promise.race([openApp(page).catch(() => { }), new Promise(resolve => { timer = setTimeout(resolve, 90000); })]);
            clearTimeout(timer);
            await context.close();
        }
        await use();
    }, { scope: 'worker', timeout: 120000 }],
    page: async ({ page, warmCdn }, use) => {
        const errors = [];
        page.on('pageerror', error => {
            // Closing a dialog with Cancel rejects its promise, which most callers have no use for.
            if (error.message !== 'canceled') errors.push(error.stack || error.message);
        });
        await page.exposeFunction('__reportTestError', message => errors.push(message));
        // The loader handles window errors itself, so they never reach pageerror unless reported from here.
        await page.addInitScript(() => {
            window.addEventListener('error', event => {
                if (/ResizeObserver loop/.test(event.message)) return;
                window.__reportTestError(event.error?.stack || event.message);
            });
            window.addEventListener('unhandledrejection', event => {
                const reason = event.reason;
                if (reason instanceof TypeError || reason instanceof ReferenceError || reason instanceof SyntaxError) {
                    window.__reportTestError(reason.stack || `${reason}`);
                }
            });
        });
        await page.route('**/*', route => serve(route));
        await use(page);
        expect(errors, 'Uncaught errors happened while this test ran').toEqual([]);
    },
});

export { expect };

/** A project opened by default, unless a test passes its own. */
export const PROJECT = { name: 'Repo', path: '/repo' };

/**
 * Start the app against the mock backend. See backend.mjs for what `state` can set.
 * Pass `project: null` for an app with no project open.
 */
export async function openApp(page, state = {}, path = '/') {
    await installBackend(page, state);
    await serveProjectFiles(page, state);
    // Opening, switching, or closing a project reloads its page by going to _reloading and back. Count each
    // reload, so pageSettled can tell when the last one has finished.
    await page.addInitScript(() => {
        const reload = window.__projectReload = { started: 0, navigated: 0, before: [] };
        const pushState = history.pushState;
        history.pushState = function (...args) {
            const result = pushState.apply(this, args);
            if (`${args[2]}`.includes('_reloading')) {
                reload.started++;
                // The page shown before the reload, which the loader removes once the reloaded page is ready.
                const app = document.querySelector('webui-app');
                reload.before = app ? [...app.children].filter(el => !el.slot && el.localName !== 'webui-page-footer') : [];
            } else {
                reload.navigated = reload.started;
            }
            return result;
        };
    });
    await page.goto(path);
    const hasProject = state.project !== null;
    await page.waitForFunction(() => typeof webui === 'object' && webui.proxy && webui.taskProxyData && webui.getProjectData);
    if (hasProject) {
        await page.waitForFunction(() => webui.proxy.projects.isLoaded);
        // The reload replaces the page's components and clears page level data, so tests must start after it.
        await page.waitForFunction(() => window.__projectReload.started > 0);
        await pageSettled(page);
    }
    return page;
}

/**
 * Resolves once the page shown is the one that stays: every project reload that started has finished, the loader
 * has swapped the new page in and ended its transition, and the page's components are defined. Until then the
 * page's components are about to be replaced, and page level data is about to be cleared, so anything a test did
 * to them would be lost.
 *
 * `openApp`, `switchProject`, and `goToPage` already wait for this. Call it after anything else that changes the
 * page, such as a click on a link, before acting on the new page.
 */
export async function pageSettled(page) {
    await page.waitForFunction(() => {
        const reload = window.__projectReload;
        const app = document.querySelector('webui-app');
        if (!reload || !app || !app.main) return false;
        // A reload goes to _reloading, then on to the project's page shortly after.
        if (reload.navigated !== reload.started) return false;
        // The loader fades the old page out, swaps the new one in, syncs its data, and only then ends the transition.
        if (reload.before.some(el => el.isConnected) || app.main.classList.contains('transition')) return false;
        return [...app.children].every(el => el.slot || !/^(app|webui)-/.test(el.localName) || el.matches(':defined'));
    });
    return page;
}

/**
 * Switch to another project, as choosing it in the project dropdown does, and wait until it has loaded and its
 * start page has replaced the page that was showing. Pass `{ name, path }` of a project in the state's `projects`,
 * or null to close the open project. The project must not be the one already open, which reloads nothing.
 */
export async function switchProject(page, project) {
    const path = project?.path ?? null;
    const reloads = await page.evaluate(project => {
        const before = window.__projectReload.started;
        webui.setData('app-current-project', project ? { value: project.path, display: project.name } : null);
        return before;
    }, project);
    // The project's data is in place before its page reloads.
    await page.waitForFunction(({ path, reloads }) => (webui.projectData.path ?? null) === path && window.__projectReload.started > reloads, { path, reloads });
    await pageSettled(page);
    return page;
}

/** Go to another page of the app, as a link to it does, and wait until that page has replaced the one showing. */
export async function goToPage(page, path) {
    // The loader starts the transition as it navigates, so the page is settled only once the new page is in.
    await page.evaluate(path => webui.navigateTo(path), path);
    await pageSettled(page);
    return page;
}

/** Open the app on a user page, which is stored in `.taskproxy/pages/`. */
/**
 * Opens a tool on its Tools tab, as a person does: the Tools button at the top right, unless Tools is already open,
 * then the tool's tab. `id` is the tab, such as 'terminals', 'tasks', 'variables', 'alerts', 'plugins', 'icons', or
 * 'theme'. Returns the tab's content.
 */
export async function openTool(page, id) {
    const shown = await page.evaluate(() => document.querySelector('app-tools')?.isShown?.() ?? false);
    if (!shown) await page.locator('header app-tools').click();
    const tab = page.locator(`webui-drawer.shared webui-button.tools-tab-${id}`);
    await tab.click();
    const content = page.locator(`webui-drawer.shared webui-content.tools-${id}`);
    await expect(content).toBeVisible();
    return content;
}

export async function openPage(page, markdown, state = {}) {
    const id = state.pageId || 'abc';
    await openApp(page, {
        currentPage: `/${id}`,
        ...state,
        files: { [`.taskproxy/pages/${id}.md`]: markdown, ...(state.files || {}) },
    }, `/${id}`);
    await page.waitForSelector('app-page-handler > webui-reorder > app-markdown-segment');
    return page;
}

/** Put HTML on the page and wait for the components in it to load. Returns a locator for the container. */
export async function mount(page, html) {
    const tags = [...new Set((html.match(/<(webui|app)-[a-z0-9-]+/g) || []).map(tag => tag.substring(1)))];
    await page.evaluate(async ({ html, tags }) => {
        let root = document.getElementById('test-root');
        if (!root) {
            root = document.createElement('div');
            root.id = 'test-root';
            // Above the app's layout, which fills the window, and below its dialogs.
            root.style.cssText = 'position:fixed;inset:0;z-index:1;overflow:auto;background:#fff;';
            document.body.appendChild(root);
        }
        root.innerHTML = html;
        await Promise.all(tags.map(tag => customElements.whenDefined(tag)));
    }, { html, tags });
    return page.locator('#test-root');
}

/**
 * Answers the addresses the file preview loads, as the backend's file_server.rs does, from the state's files and
 * binaryFiles. Records each request's path and range in `page.__fileRequests`.
 */
function serveProjectFiles(page, state) {
    page.__fileRequests = [];
    return page.route('http://files.localhost/token/**', route => {
        const request = route.request();
        // A saved project that isn't open has its images at ~project/<project>/<file>, as file_server.rs serves them.
        // The mock's files stand for every project's.
        const raw = new URL(request.url()).pathname.replace('/token/', '');
        const other = raw.match(/^~project\/[^/]+\/(.+)$/);
        const path = decodeURIComponent(other ? other[1] : raw);
        const range = request.headers().range;
        page.__fileRequests.push({ path, range });
        const binary = state.binaryFiles?.[path];
        const text = state.files?.[path];
        if (binary === undefined && text === undefined) return route.fulfill({ status: 404, body: 'File not found' });
        const body = binary !== undefined ? Buffer.from(binary, 'base64') : Buffer.from(text);
        const headers = { 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' };
        const match = /^bytes=(\d*)-(\d*)$/.exec(range || '');
        if (match) {
            const start = match[1] ? parseInt(match[1]) : Math.max(0, body.length - parseInt(match[2]));
            const end = match[1] && match[2] ? Math.min(parseInt(match[2]), body.length - 1) : body.length - 1;
            return route.fulfill({ status: 206, body: body.subarray(start, end + 1), headers: { ...headers, 'content-range': `bytes ${start}-${end}/${body.length}` } });
        }
        return route.fulfill({ status: 200, body, headers });
    });
}

/**
 * The open dialog, with its content. A webui.dialog shows its content in a slot of webui-dialogs, outside the
 * shadow dialog element, so it is matched by its webui-dialogs element.
 */
export function openDialog(page) {
    // Only open dialogs, since a page's help bubble keeps its own closed dialog on the page.
    return page.locator('webui-dialogs:has(dialog[open]), dialog[open]:not(webui-dialogs dialog)').last();
}

/** A button in the open dialog. */
export function dialogButton(page, text) {
    return openDialog(page).getByText(text, { exact: true }).last();
}

/** Every call the app made to a backend command, oldest first. Each is that call's arguments. */
export function calls(page, command) {
    return page.evaluate(command => window.__backend.calls.filter(call => call.command === command).map(call => call.args), command);
}

/**
 * Calls to the listed commands in the order the app made them, each as `{ command, args }`. Use this to check what
 * came before what, rather than which call came last, since other parts of the app can call the same command at any time.
 */
export function callOrder(page, ...commands) {
    return page.evaluate(commands => window.__backend.calls.filter(call => commands.includes(call.command)).map(({ command, args }) => ({ command, args })), commands);
}

/** Answer a backend command differently from now on. `handler` runs in the page, with the call's arguments. */
export function onCommand(page, command, handler) {
    return page.evaluate(({ command, source }) => {
        window.__backend.handlers[command] = (0, eval)(`(${source})`);
    }, { command, source: handler.toString() });
}

/** A script the backend runs writes output: `{ projectId, terminalId, data }`, with projectId the open project's by default. */
export function runOutput(page, payload) {
    return page.evaluate(payload => window.__backend.runs.write(payload), payload);
}

/** A script the backend runs ends: `{ projectId, terminalId, code }`, and the next queued one starts. */
export function runEnds(page, payload) {
    return page.evaluate(payload => window.__backend.runs.end(payload), payload);
}

/** Send an event from the backend to the app. */
export function emit(page, name, payload) {
    return page.evaluate(({ name, payload }) => window.__backend.emit(name, payload), { name, payload });
}
