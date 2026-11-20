// The unit test harness: Task Proxy's minified app (index.html, app.min.js, wc/*.min.js, app.min.css) with the Web UI
// framework, running in jsdom, a simulated browser with no layout, against the mock backend in ../../support/backend.mjs.
// Each test gets a fresh window through the `page` fixture, so nothing a test does can reach another test.
//
// The helpers are those of tests/support/app.mjs (openApp, mount, calls, emit, ...), so a test reads as it did in
// Playwright, with locators, actions and retrying matchers from ./page.mjs. page.mjs and stand-ins.mjs are copies of
// MyFiCDN's tests/unit/support files: change them in both repos at once.
//
// Requests:
// - The app's own files come from this repo, always the minified ones the app loads.
// - Framework files (https://cdn.myfi.ws) come from the live CDN, as in the app, so a breaking deploy fails these
//   tests. Each is downloaded once per test worker. Set WEBUI_CDN_ROOT to a MyFiCDN checkout's cdn folder to test
//   against unreleased framework files instead.
// - Project files (http://files.localhost) are answered from the state's files, as file_server.rs serves them.
// - Anything else fails, as page.route() does nothing to stop a test answering it first.
//
// What jsdom lacks is in ./stand-ins.mjs. There is no layout: nothing has a size, and stylesheets in shadow roots do
// not reach getComputedStyle. Tests that need either are in tests/browser.
import jsdom from 'jsdom';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from 'vitest';
import { setup as backendSetup } from '../../support/backend.mjs';
import { Locator, Page, pageExpect as expect } from './page.mjs';
import { installStandIns, mediaMatcher, pageResponse } from './stand-ins.mjs';

export { expect };

const { JSDOM, VirtualConsole, requestInterceptor } = jsdom;
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CDN_ROOT = process.env.WEBUI_CDN_ROOT;
export const ORIGIN = 'http://127.0.0.1:1426';
const TYPES = {
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.md': 'text/plain', '.wasm': 'application/wasm',
    '.webui': 'text/plain', '.txt': 'text/plain',
};
// The window size the browser tests use, which the app reads for its wide layout.
const VIEWPORT = { width: 1500, height: 1000 };
// Messages that are expected in jsdom and say nothing about the code under test.
const EXPECTED_CONSOLE = [/Failed to load markdown parser/, /Not implemented: /];

// What Trunk does to index.html, without needing a build.
function buildIndex() {
    return readFileSync(join(ROOT, 'index.html'), 'utf8')
        .replace(/<link data-trunk [^>]*rel="copy-dir"[^>]*>/g, '')
        .replace(/<link data-trunk href="css\/app\.min\.css" rel="css" \/>/, '<link href="/css/app.min.css" rel="stylesheet" />')
        .replace(/<script data-trunk src="root_files\/app\.min\.js" data-no-minify><\/script>/, '<script src="/app.min.js"></script>');
}

/** The app's file for an address, from root_files (served at the root) or the repo. Only the minified files are tested. */
function appFile(pathname) {
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
    for (const folder of ['root_files', '']) {
        const file = normalize(join(ROOT, folder, relative));
        if (!file.startsWith(ROOT.replace(/[\\/]+$/, '') + sep)) continue;
        if (existsSync(file) && statSync(file).isFile()) return file;
    }
    return null;
}

// Framework files from the live CDN, each downloaded once per test worker and kept. A failed download is retried.
const liveCdn = new Map();
async function downloadLiveCdn(url) {
    for (let attempt = 1; ; attempt++) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (response.status < 500 || attempt === 4) {
                return { status: response.status, type: response.headers.get('content-type'), body: Buffer.from(await response.arrayBuffer()) };
            }
        } catch (error) {
            if (attempt === 4) throw new Error(`Could not download ${url}: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
}

/** A framework file: { status, type, body }. */
export async function cdnFile(pathname) {
    if (CDN_ROOT) {
        const file = normalize(join(CDN_ROOT, decodeURIComponent(pathname)));
        if (!existsSync(file) || !statSync(file).isFile()) return { status: 404, type: 'text/plain', body: Buffer.from('Not Found') };
        return { status: 200, type: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) };
    }
    const url = `https://cdn.myfi.ws${pathname}`;
    if (!liveCdn.has(url)) liveCdn.set(url, downloadLiveCdn(url).catch(error => { liveCdn.delete(url); throw error; }));
    return liveCdn.get(url);
}

// The loader imports Web UI's markdown parser with import(), which a jsdom script cannot do. The harness loads the same
// file in Node and gives the page its parser at the moment the loader reports the import failed, before anything renders.
let markdownParser;
function loadMarkdownParser() {
    markdownParser ??= cdnFile('/js/mdparse.min.js')
        .then(file => import(`data:text/javascript;base64,${file.body.toString('base64')}`))
        .then(module => module.MarkdownParser);
    return markdownParser;
}

async function defaultResponse(url) {
    const parsed = new URL(url);
    if (parsed.hostname === 'cdn.myfi.ws') {
        const file = await cdnFile(parsed.pathname);
        return new Response(file.body, { status: file.status, headers: { 'content-type': file.type || 'application/octet-stream', 'access-control-allow-origin': '*' } });
    }
    if (parsed.origin !== ORIGIN) return Response.error();
    const file = parsed.pathname === '/' ? null : appFile(parsed.pathname);
    if (file) return new Response(readFileSync(file), { headers: { 'content-type': TYPES[extname(file)] || 'application/octet-stream' } });
    if (extname(parsed.pathname)) return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
    // Page routes fall back to the app shell, the same as the deployed app.
    return new Response(buildIndex(), { headers: { 'content-type': 'text/html' } });
}

function globMatches(pattern, url) {
    if (typeof pattern === 'function') return pattern(new URL(url));
    if (pattern instanceof RegExp) return pattern.test(url);
    const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
    return regex.test(url);
}

/** A request as page.route handlers and page.on('request') listeners see it. */
class RouteRequest {
    constructor(url, method = 'GET', body = null, headers = {}) {
        this._url = url;
        this._method = method.toUpperCase();
        this._body = body;
        this._headers = headers;
    }
    url() { return this._url; }
    method() { return this._method; }
    headers() { return { ...this._headers }; }
    allHeaders() { return Promise.resolve(this.headers()); }
    headerValue(name) { return Promise.resolve(this._headers[name.toLowerCase()] ?? null); }
    postData() { return this._body; }
    postDataJSON() { return this._body == null ? null : JSON.parse(this._body); }
}

/** The headers of a fetch, as a plain object with lower-case names. */
function headerObject(headers) {
    const result = {};
    if (!headers) return result;
    const entries = typeof headers.forEach === 'function' && !Array.isArray(headers)
        ? (() => { const list = []; headers.forEach((value, key) => list.push([key, value])); return list; })()
        : Array.isArray(headers) ? headers : Object.entries(headers);
    for (const [key, value] of entries) result[key.toLowerCase()] = `${value}`;
    return result;
}

/** A fetch body as the text a server would receive, adding the content type a browser would for it. */
async function serializeBody(window, body, headers) {
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (body instanceof window.URLSearchParams) {
        headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8';
        return body.toString();
    }
    if (body instanceof window.Blob) {
        if (body.type) headers['content-type'] ??= body.type;
        return Buffer.from(await body.arrayBuffer()).toString('latin1');
    }
    if (body instanceof window.ArrayBuffer || ArrayBuffer.isView(body)) return Buffer.from(body.buffer ?? body).toString('latin1');
    return `${body}`;
}

/** Answers a request through the test's routes, newest first, as Playwright does, then as the app's server would. */
async function answer(env, request) {
    env.emit('request', request);
    for (const route of [...env.routes].reverse()) {
        if (!globMatches(route.pattern, request.url())) continue;
        let result = null;
        await route.handler({
            request: () => request,
            fulfill: async ({ status = 200, contentType, body = '', json, headers = {} } = {}) => {
                const content = json !== undefined ? JSON.stringify(json) : body;
                result = new Response(status === 204 || status === 304 ? null : content, { status, headers: { 'content-type': contentType || (json !== undefined ? 'application/json' : 'text/plain'), ...headers } });
            },
            abort: async () => { result = Response.error(); },
            continue: async () => { result = 'continue'; },
            fallback: async () => { result = 'fallback'; },
        });
        if (result === 'fallback' || result === null) continue;
        if (result === 'continue') break;
        return result;
    }
    return defaultResponse(request.url());
}

/** A copy of a window's local and session storage, to carry into the page loaded after it on the same origin. */
function storageOf(window) {
    const copy = store => Object.fromEntries(Array.from({ length: store.length }, (_, i) => store.key(i)).map(key => [key, store.getItem(key)]));
    return { local: copy(window.localStorage), session: copy(window.sessionStorage) };
}

function restoreStorage(window, storage) {
    for (const [key, value] of Object.entries(storage.local)) window.localStorage.setItem(key, value);
    for (const [key, value] of Object.entries(storage.session)) window.sessionStorage.setItem(key, value);
}

/** Lets the page act on what just happened: queued work, then two animation frames. */
export async function settle(window) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
}

/**
 * A tab: a window that starts blank, as a new Playwright page does, and loads pages with goto and reload. Routes,
 * listeners, init scripts and exposed functions carry over every load, and so does the origin's storage.
 */
export async function openTab() {
    const errors = [];
    const listeners = {};
    const env = {
        routes: [],
        initScripts: [],
        exposed: {},
        errors,
        emit(event, value) { (listeners[event] || []).forEach(listener => listener(value)); },
        on(event, listener) { (listeners[event] ||= []).push(listener); },
        route(pattern, handler) { env.routes.push({ pattern, handler }); },
        waitForEvent(event, predicate = () => true) {
            return new Promise(resolve => env.on(event, value => { if (predicate(value)) resolve(value); }));
        },
        async reload() { await env.goto(env.window.location.href); },
        async goto(target) {
            const next = new URL(target, env.window?.location.href?.startsWith('http') ? env.window.location.href : `${ORIGIN}/`);
            const storage = env.window?.location.href?.startsWith('http') && new URL(env.window.location.href).origin === next.origin ? storageOf(env.window) : null;
            const response = await answer(env, new RouteRequest(next.href));
            await load(await response.text(), next.href, storage);
        },
    };
    const MarkdownParser = await loadMarkdownParser();
    const consoleMessage = (type, args) => ({ type: () => (type === 'warn' ? 'warning' : type), text: () => args.map(arg => arg?.stack || `${arg}`).join(' '), args: () => args });
    const report = error => {
        const text = error?.stack || `${error}`;
        if (!EXPECTED_CONSOLE.some(pattern => pattern.test(text))) errors.push(text);
    };
    const load = async (pageHtml, pageUrl, storage) => {
        env.window?.close();
        const virtualConsole = new VirtualConsole();
        for (const type of ['log', 'info', 'warn', 'debug']) virtualConsole.on(type, (...args) => env.emit('console', consoleMessage(type, args)));
        virtualConsole.on('error', (...args) => {
            const text = args.map(arg => `${arg}`).join(' ');
            // The loader failed to import the parser, and is about to say it has loaded: the real one goes in first.
            // webui is a top-level const of the loader's script, not a property of the window.
            const webui = text.startsWith('Failed to load markdown parser') && env.window?.eval('typeof webui === "object" ? webui : null');
            if (webui) webui.markdown = new MarkdownParser();
            env.emit('console', consoleMessage('error', args));
        });
        virtualConsole.on('jsdomError', error => {
            if (!EXPECTED_CONSOLE.some(pattern => pattern.test(`${error.message}`))) env.emit('pageerror', error);
        });
        const dom = new JSDOM(pageHtml, {
            url: pageUrl,
            runScripts: 'dangerously',
            pretendToBeVisual: true,
            virtualConsole,
            resources: { interceptors: [requestInterceptor(async request => {
                const response = await answer(env, new RouteRequest(request.url, request.method, null, headerObject(request.headers)));
                return response;
            })] },
            beforeParse(window) {
                env.page?.clock?._onWindow(window);
                Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width });
                Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height });
                if (storage) restoreStorage(window, storage);
                installStandIns(window);
                if (!window.crypto?.subtle) Object.defineProperty(window, 'crypto', { configurable: true, value: globalThis.crypto });
                window.matchMedia = mediaMatcher(env.media);
                window.fetch = async (input, init = {}) => {
                    // Relative to the document's base address, as a browser's fetch is, not the page's.
                    const target = new URL(typeof input === 'string' ? input : input.url ?? `${input}`, window.document.baseURI).href;
                    const headers = headerObject(init.headers ?? input?.headers);
                    const body = await serializeBody(window, init.body ?? null, headers);
                    const response = await answer(env, new RouteRequest(target, init.method || input?.method || 'GET', body, headers));
                    if (response.type === 'error') throw new window.TypeError('Failed to fetch');
                    return pageResponse(window, response);
                };
                window.Response ??= Response;
                window.Request ??= Request;
                window.Headers ??= Headers;
                const attach = window.HTMLElement.prototype.attachInternals;
                window.HTMLElement.prototype.attachInternals = function () {
                    const internals = attach.call(this);
                    const host = this;
                    internals.setFormValue ??= value => { host.__formValue = value; };
                    internals.setValidity ??= () => { };
                    const nativeForm = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(internals), 'form')?.get;
                    Object.defineProperty(internals, 'form', { configurable: true, get: () => nativeForm?.call(internals) || host.closest('form') });
                    return internals;
                };
                // The loader handles window errors itself, so they are reported from here, as in the browser harness.
                window.addEventListener('error', event => {
                    if (/ResizeObserver loop/.test(event.message)) return;
                    env.emit('pageerror', event.error || new Error(event.message));
                    report(event.error || event.message);
                });
                window.addEventListener('unhandledrejection', event => {
                    const reason = event.reason;
                    if (reason instanceof window.TypeError || reason instanceof window.ReferenceError || reason instanceof window.SyntaxError) report(reason);
                });
                for (const [name, fn] of Object.entries(env.exposed)) window[name] = async (...args) => fn(...args);
                for (const { source, arg } of env.initScripts) window.eval(`(${source})(${arg === undefined ? '' : JSON.stringify(arg)})`);
            },
        });
        const { window } = dom;
        Object.assign(env, { dom, window, document: window.document });
        env.page?._attach(env);
        await settle(window);
    };
    env.settle = () => settle(env.window);
    await load('<!DOCTYPE html><html><head></head><body></body></html>', 'about:blank', null);
    return env;
}

/** Vitest's `test` with Playwright's `page` fixture: a fresh tab per test, which fails the test on uncaught errors. */
export const test = base.extend({
    baseURL: async ({}, use) => use(ORIGIN),
    page: async ({}, use) => {
        const env = await openTab();
        const page = new Page(env);
        env.page = page;
        await use(page);
        page.clock.uninstall();
        env.window.close();
        // Vitest keeps each test's context until the file ends, so the window is let go here or every test's stays.
        const { errors } = env;
        page.release();
        for (const key of Object.keys(env)) delete env[key];
        // Anything the closed window still says goes nowhere.
        Object.assign(env, { closed: true, errors: [], routes: [], initScripts: [], exposed: {}, emit() { }, on() { } });
        if (process.env.HEAP_DEBUG) { globalThis.gc?.(); console.log('HEAP', Math.round(process.memoryUsage().heapUsed / 1e6), 'MB'); }
        expect(errors, 'Uncaught errors happened while this test ran').toEqual([]);
    },
});

/** A project opened by default, unless a test passes its own. */
export const PROJECT = { name: 'Repo', path: '/repo' };

/** As tests/support/backend.mjs's installBackend: the mock backend, set up before the app's scripts run. */
export function installBackend(page, state) {
    return page.addInitScript(backendSetup, state);
}

/**
 * Start the app against the mock backend. See tests/support/backend.mjs for what `state` can set.
 * Pass `project: null` for an app with no project open.
 */
export async function openApp(page, state = {}, path = '/') {
    await installBackend(page, state);
    serveProjectFiles(page, state);
    // Opening, switching, or closing a project reloads its page by going to _reloading and back. Count each
    // reload, so pageSettled can tell when the last one has finished.
    await page.addInitScript(() => {
        const reload = window.__projectReload = { started: 0, navigated: 0, before: [] };
        const pushState = history.pushState;
        history.pushState = function (...args) {
            const result = pushState.apply(this, args);
            if (`${args[2]}`.includes('_reloading')) {
                reload.started++;
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
        await page.waitForFunction(() => window.__projectReload.started > 0);
        await pageSettled(page);
    }
    return page;
}

/** As tests/support/app.mjs's pageSettled: the page shown is the one that stays, with its components defined. */
export async function pageSettled(page) {
    try {
        await page.waitForFunction(() => {
            const reload = window.__projectReload;
            const app = document.querySelector('webui-app');
            if (!reload || !app || !app.main) return false;
            if (reload.navigated !== reload.started) return false;
            if (reload.before.some(el => el.isConnected) || app.main.classList.contains('transition')) return false;
            return [...app.children].every(el => el.slot || !/^(app|webui)-/.test(el.localName) || el.matches(':defined'));
        });
    } catch (error) {
        // Say which part never finished.
        const state = await page.evaluate(() => {
            const reload = window.__projectReload;
            const app = document.querySelector('webui-app');
            return JSON.stringify({
                url: location.pathname, reload: reload && { started: reload.started, navigated: reload.navigated, oldPageStillShown: reload.before.filter(el => el.isConnected).map(el => el.localName) },
                transition: app?.main?.className, undefinedComponents: app ? [...app.children].filter(el => !el.slot && /^(app|webui)-/.test(el.localName) && !el.matches(':defined')).map(el => el.localName) : 'no webui-app',
            });
        }).catch(() => 'unknown');
        throw new Error(`The page never settled: ${state}`);
    }
    return page;
}

/** As tests/support/app.mjs's switchProject. */
export async function switchProject(page, project) {
    const path = project?.path ?? null;
    const reloads = await page.evaluate(project => {
        const before = window.__projectReload.started;
        webui.setData('app-current-project', project ? { value: project.path, display: project.name } : null);
        return before;
    }, project);
    await page.waitForFunction(({ path, reloads }) => (webui.projectData.path ?? null) === path && window.__projectReload.started > reloads, { path, reloads });
    await pageSettled(page);
    return page;
}

/** Go to another page of the app, as a link to it does, and wait until that page has replaced the one showing. */
export async function goToPage(page, path) {
    await page.evaluate(path => webui.navigateTo(path), path);
    await pageSettled(page);
    return page;
}

/** As tests/support/app.mjs's openTool: opens a tool's tab in the Tools drawer and returns the tab's content. */
export async function openTool(page, id) {
    const shown = await page.evaluate(() => document.querySelector('app-tools')?.isShown?.() ?? false);
    if (!shown) await page.locator('header app-tools').click();
    const tab = page.locator(`webui-drawer.shared webui-button.tools-tab-${id}`);
    await tab.click();
    const content = page.locator(`webui-drawer.shared webui-content.tools-${id}`);
    await expect(content).toBeVisible();
    return content;
}

/** Open the app on a user page, which is stored in `.taskproxy/pages/`. */
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
    const { window, document } = page;
    let root = document.getElementById('test-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'test-root';
        root.style.cssText = 'position:fixed;inset:0;z-index:1;overflow:auto;background:#fff;';
        document.body.appendChild(root);
    }
    root.innerHTML = html;
    const tags = [...new Set((html.match(/<(webui|app)-[a-z0-9-]+/g) || []).map(tag => tag.substring(1)))];
    await Promise.all(tags.map(tag => window.customElements.whenDefined(tag)));
    await page.settle();
    return new Locator(page, () => [document.getElementById('test-root')].filter(Boolean), '#test-root');
}

/** As tests/support/app.mjs's serveProjectFiles: the file preview's addresses, answered from the state's files. */
function serveProjectFiles(page, state) {
    page.__fileRequests = [];
    page.route('http://files.localhost/token/**', route => {
        const request = route.request();
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

/** The open dialog, with its content, as tests/support/app.mjs finds it. */
export function openDialog(page) {
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

/** Calls to the listed commands in the order the app made them, each as `{ command, args }`. */
export function callOrder(page, ...commands) {
    return page.evaluate(commands => window.__backend.calls.filter(call => commands.includes(call.command)).map(({ command, args }) => ({ command, args })), commands);
}

/** Answer a backend command differently from now on. `handler` runs in the page, with the call's arguments. */
export function onCommand(page, command, handler) {
    return page.evaluate(({ command, source }) => {
        window.__backend.handlers[command] = (0, eval)(`(${source})`);
    }, { command, source: handler.toString() });
}

/** A script the backend runs writes output: `{ projectId, terminalId, data }`. */
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
