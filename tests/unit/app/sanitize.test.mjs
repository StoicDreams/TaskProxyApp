import { readFileSync } from 'node:fs';
import { test, expect, openApp } from '../support/app.mjs';

const clean = (page, html) => page.evaluate(html => sanitizeProjectHtml(html), html);

test.describe('sanitizeProjectHtml', () => {
    test.beforeEach(async ({ page }) => { await openApp(page, { project: null }); });
    for (const [name, html] of [
        ['script tags', '<script>x</script>'], ['iframes', '<iframe src="x"></iframe>'], ['objects', '<object data="x"></object>'],
        ['embeds', '<embed src="x">'], ['base tags', '<base href="https://x">'], ['style tags', '<style>*{}</style>'], ['links', '<link rel="stylesheet" href="x">'],
        ['meta tags', '<meta http-equiv="refresh" content="0">'], ['svg animation', '<svg><animate attributeName="href" to="javascript:x"/></svg>'],
    ]) {
        test(`removes ${name}`, async ({ page }) => {
            expect(await clean(page, `a${html}b`)).not.toMatch(/<(script|iframe|object|embed|base|style|link|meta|animate)/i);
        });
    }
    test('removes event handlers', async ({ page }) => {
        expect(await clean(page, '<img src="x.png" onerror="x()" ONLOAD="y()">')).toBe('<img src="x.png">');
    });
    for (const url of ['javascript:x()', 'JaVaScRiPt:x()', 'java\tscript:x()', ' javascript:x()', 'vbscript:x', 'data:text/html,x']) {
        test(`removes the url ${JSON.stringify(url)}`, async ({ page }) => {
            expect(await page.evaluate(url => {
                const a = document.createElement('a');
                a.setAttribute('href', url);
                return sanitizeProjectHtml(a.outerHTML);
            }, url)).toBe('<a></a>');
        });
    }
    test('cleans inside template content', async ({ page }) => {
        expect(await clean(page, '<p>a</p><template><img src="x" onerror="y()"><script>z</script></template>')).toBe('<p>a</p><template><img src="x"></template>');
    });
    test('removes comments and srcdoc', async ({ page }) => {
        expect(await clean(page, '<!-- x --><p srcdoc="y">a</p>')).toBe('<p>a</p>');
    });
    test('keeps components, data attributes, and safe links', async ({ page }) => {
        const html = '<webui-flex data-bind="x" class="y"><a href="https://example.com">a</a></webui-flex>';
        expect(await clean(page, html)).toBe(html);
    });
    test('keeps images and videos from websites', async ({ page }) => {
        const html = '<img src="https://example.com/a.png" alt="a"><video src="https://example.com/a.mp4" poster="https://example.com/a.png"></video>'
            + '<webui-loop-video src="https://example.com/b.mp4" poster="https://example.com/b.png"></webui-loop-video>';
        expect(await clean(page, html)).toBe(html);
    });
    test('returns nothing for values that are not text', async ({ page }) => {
        expect(await page.evaluate(() => [sanitizeProjectHtml(null), sanitizeProjectHtml(5)])).toEqual(['', '']);
    });
});

test.describe('the content security policy', () => {
    const config = JSON.parse(readFileSync(new URL('../../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    const csp = config.app.security.csp;
    const sources = name => csp[name].split(/\s+/);
    test('lets pages show images and videos from websites', () => {
        for (const name of ['img-src', 'media-src']) {
            expect(sources(name), name).toContain('https:');
            expect(sources(name), `${name} allows no unencrypted websites`).not.toContain('http:');
            expect(sources(name), name).not.toContain('*');
        }
    });
    test('still runs scripts and opens connections only to the app and its services', () => {
        for (const name of ['default-src', 'script-src', 'connect-src', 'worker-src']) {
            expect(sources(name), name).not.toContain('https:');
            expect(sources(name), name).not.toContain('*');
        }
        expect(csp['object-src']).toBe("'none'");
        expect(csp['frame-src']).toBe("'none'");
    });
});
