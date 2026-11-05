import { test as base, expect } from '@playwright/test';
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

function resolveFile(pathname, useMinified) {
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
    for (const folder of ['root_files', '']) {
        const file = normalize(join(ROOT, folder, relative));
        if (!file.startsWith(ROOT.replace(/[\\/]+$/, '') + sep)) continue;
        const candidates = !useMinified && file.endsWith('.min.js') ? [file.replace(/\.min\.js$/, '.js'), file] : [file];
        for (const candidate of candidates) {
            if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
        }
    }
    return null;
}

function serve(route, useMinified) {
    const url = new URL(route.request().url());
    // Components load from the live CDN, as they do in the app, so a breaking deploy fails these tests.
    if (url.hostname === 'cdn.myfi.ws') {
        if (!CDN_ROOT) return route.continue();
        const file = normalize(join(CDN_ROOT, decodeURIComponent(url.pathname)));
        const source = !useMinified && file.endsWith('.min.js') ? file.replace(/\.min\.js$/, '.js') : file;
        const found = [source, file].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
        if (!found) return route.fulfill({ status: 404, body: 'Not Found' });
        return route.fulfill({ contentType: MIME[extname(found)] || 'application/octet-stream', body: readFileSync(found), headers: { 'access-control-allow-origin': '*' } });
    }
    if (url.hostname !== '127.0.0.1') return route.abort();
    const file = url.pathname === '/' ? null : resolveFile(url.pathname, useMinified);
    if (file) {
        return route.fulfill({ contentType: MIME[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
    }
    if (extname(url.pathname)) {
        return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
    }
    // Page routes fall back to the app shell, the same as the deployed app.
    return route.fulfill({ contentType: 'text/html', body: buildIndex() });
}

export const test = base.extend({
    useMinified: [false, { option: true }],
    page: async ({ page, useMinified }, use) => {
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
        await page.route('**/*', route => serve(route, useMinified));
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
    await page.goto(path);
    const hasProject = state.project !== null;
    await page.waitForFunction(() => typeof webui === 'object' && webui.proxy && webui.taskProxyData && webui.getProjectData);
    if (hasProject) {
        await page.waitForFunction(() => webui.proxy.projects.isLoaded);
        // Opening a project reloads its page shortly after, which clears page level data.
        await page.waitForTimeout(450);
    }
    return page;
}

/** Open the app on a user page, which is stored in `.taskproxy/pages/`. */
export async function openPage(page, markdown, state = {}) {
    const id = state.pageId || 'abc';
    await openApp(page, {
        currentPage: `/${id}`,
        ...state,
        files: { [`.taskproxy/pages/${id}.md`]: markdown, ...(state.files || {}) },
    }, `/${id}`);
    await page.waitForSelector('app-page-handler > app-markdown-segment');
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

/** A button in the open dialog. */
export function dialogButton(page, text) {
    return page.locator('dialog').last().getByText(text, { exact: true }).last();
}

/** Every call the app made to a backend command, oldest first. Each is that call's arguments. */
export function calls(page, command) {
    return page.evaluate(command => window.__backend.calls.filter(call => call.command === command).map(call => call.args), command);
}

/** Answer a backend command differently from now on. `handler` runs in the page, with the call's arguments. */
export function onCommand(page, command, handler) {
    return page.evaluate(({ command, source }) => {
        window.__backend.handlers[command] = (0, eval)(`(${source})`);
    }, { command, source: handler.toString() });
}

/** Send an event from the backend to the app. */
export function emit(page, name, payload) {
    return page.evaluate(({ name, payload }) => window.__backend.emit(name, payload), { name, payload });
}
