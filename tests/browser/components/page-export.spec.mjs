import { test, expect, openPage } from '../../support/app.mjs';
import { actionNote } from '../../support/wait.mjs';

// pdfmake runs in a real browser, so a PDF is made here (wc/page-export.js); the other formats are in tests/unit.
test('saves the page as a PDF with its title, and copies it as a file', async ({ page }) => {
    await openPage(page, '<webui-data data-page-title="Release Notes" data-page-subtitle=""></webui-data>\n\n# Changes\n\n- One\n- Two');
    const exporter = page.locator('app-page-handler app-page-export webui-select').first();
    await exporter.locator('button[aria-haspopup]').click();
    await exporter.locator('.tile[data-value="save:pdf"]').click();
    await expect(actionNote(page, 'Saved the page as Release Notes.pdf.')).toHaveCount(1);
    const saved = await page.evaluate(() => window.__backend.exported);
    expect(saved.kind).toBe('pdf');
    expect(saved.title).toBe('Release Notes');
    expect(saved.text.startsWith('%PDF-')).toBe(true);
    await exporter.locator('button[aria-haspopup]').click();
    await exporter.locator('.tile[data-value="copy:pdf"]').click();
    await expect(actionNote(page, 'Copied the page as a PDF file, to paste where files go.')).toHaveCount(1);
    const copied = await page.evaluate(() => window.__backend.clipboard.file);
    expect(copied.kind).toBe('pdf');
    expect(copied.text.startsWith('%PDF-')).toBe(true);
});
