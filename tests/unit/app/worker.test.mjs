import { test, expect, openApp } from '../support/app.mjs';

const diff = (page, data) => page.evaluate(data => webui.proxy.worker.send('processFileDiff', data), data);

test.describe('webui.proxy.worker', () => {
    test.beforeEach(async ({ page }) => { await openApp(page, { project: null }); });
    test('rebuilds the old file from a diff', async ({ page }) => {
        const fileDiff = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n';
        const result = await diff(page, { change: 'Modify', fileDiff, fileContent: 'one\nTWO\nthree' });
        expect(result.old.map(item => item.line)).toEqual(['one', 'two', 'three']);
        expect(result.new.map(item => item.line)).toEqual(['one', 'TWO', 'three']);
    });
    test('changed lines that look like file headers are kept', async ({ page }) => {
        const fileDiff = '--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n one\n---two\n+++TWO\n';
        const result = await diff(page, { change: 'Modify', fileDiff, fileContent: 'one\n++TWO' });
        expect(result.old.map(item => item.line)).toEqual(['one', '--two']);
    });
    test('added files only have new lines, deleted files only old lines', async ({ page }) => {
        expect(await diff(page, { change: 'Add', fileDiff: '', fileContent: 'a\nb' })).toEqual({ old: [], new: [{ lineNumber: 1, line: 'a' }, { lineNumber: 2, line: 'b' }] });
        expect(await diff(page, { change: 'Delete', fileDiff: '', fileContent: 'a' })).toEqual({ old: [{ lineNumber: 1, line: 'a' }], new: [] });
    });
    test('windows line endings match', async ({ page }) => {
        const result = await diff(page, { change: 'Add', fileDiff: '', fileContent: 'a\r\nb' });
        expect(result.new.map(item => item.line)).toEqual(['a', 'b']);
    });
    test('an unknown request is rejected', async ({ page }) => {
        await expect(page.evaluate(() => webui.proxy.worker.send('missing', {}))).rejects.toThrow(/Unknown error/);
    });
});
