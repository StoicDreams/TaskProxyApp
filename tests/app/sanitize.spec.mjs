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
    test('returns nothing for values that are not text', async ({ page }) => {
        expect(await page.evaluate(() => [sanitizeProjectHtml(null), sanitizeProjectHtml(5)])).toEqual(['', '']);
    });
});
