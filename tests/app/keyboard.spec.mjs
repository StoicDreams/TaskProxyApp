import { test, expect, openApp, openPage, calls } from '../support/app.mjs';

// Everything a mouse can do, keyboard and screen reader users must be able to do too.

test('the header tools are named buttons that open their drawers with Enter', async ({ page }) => {
    await openApp(page);
    for (const name of ['Icons & Emojis', 'Manage Variables', 'Terminals', 'Save Project & App Data']) {
        await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
    }
    await page.getByRole('button', { name: 'Manage Variables', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#env-selector')).toBeAttached();
    await expect(page.getByRole('heading', { name: 'Variable Manager' })).toHaveCount(1);
});

test('a page script runs from the keyboard, and its button is named for its step', async ({ page }) => {
    await openPage(page, '# Steps\n\n<webui-page-segment>\n\nInstall the tools\n\n```pwsh\nnpm install\n```\n\n</webui-page-segment>');
    const run = page.getByRole('button', { name: 'Run script: Install the tools' });
    await expect(run).toHaveCount(1);
    await run.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Trust Project & Run')).toBeVisible();
});

test('Alt+Up and Alt+Down move a segment, and the page saves in the new order', async ({ page }) => {
    await openPage(page, '# One\n\n# Two\n\n# Three');
    const segments = page.locator('app-page-handler > app-markdown-segment');
    const order = () => segments.evaluateAll(list => list.map(el => el.getMarkdown()));
    await segments.first().locator('#btn-edit').focus();
    await page.keyboard.press('Alt+ArrowDown');
    expect(await order()).toEqual(['# Two', '# One', '# Three']);
    // Focus stays on the moved segment, so it can keep moving.
    await page.keyboard.press('Alt+ArrowDown');
    expect(await order()).toEqual(['# Two', '# Three', '# One']);
    await page.keyboard.press('Alt+ArrowUp');
    expect(await order()).toEqual(['# Two', '# One', '# Three']);
    await page.locator('app-page-handler webui-button[title="Save Page"]').first().click();
    await expect.poll(async () => (await calls(page, 'save_project_file')).at(-1)?.contents).toBe('<webui-data data-page-title="" data-page-subtitle=""></webui-data>\n\n# Two\n\n# One\n\n# Three');
});

test('pages in the Navigation Manager can be selected and moved from the keyboard, including into a folder', async ({ page }) => {
    const navigation = [
        { name: 'Alpha', icon: 'star', url: '/a', children: null },
        { name: 'Folder', icon: 'star', url: null, children: [{ name: 'Inside', icon: 'star', url: '/i', children: null }] },
    ];
    await openApp(page, { currentPage: '/nav-manager', navigation }, '/nav-manager');
    const manager = page.locator('app-nav-manager');
    const alpha = manager.getByRole('button', { name: /^Alpha,/ });
    await expect(alpha).toHaveCount(1);
    await alpha.focus();
    await page.keyboard.press('Enter');
    await expect(manager.locator('webui-input-text[label="Name"] input')).toHaveValue('Alpha');
    // Down moves past the space before the folder and into it, as dragging there does.
    await page.keyboard.press('Alt+ArrowDown');
    await expect(alpha).toBeFocused();
    await manager.locator('webui-button[label="Save"]').click();
    await expect.poll(async () => {
        const saved = (await calls(page, 'save_project_data')).at(-1)?.data?.navigation;
        return saved && saved.map(item => [item.name, (item.children || []).map(child => child.name)]);
    }).toEqual([['Folder', ['Alpha', 'Inside']]]);
});
