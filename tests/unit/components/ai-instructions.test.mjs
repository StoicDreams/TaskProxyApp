import { test, expect, openApp, mount, calls, switchProject } from '../support/app.mjs';

// The instructions editor (wc/ai-instructions.js): a tab for the instructions shared by every integration and one for
// each integration's own, each globally and for the project, sent after the built-in ones in that order.
async function editor(page, html = '<app-ai-instructions id="e"></app-ai-instructions>', state = {}) {
    await openApp(page, state);
    const root = await mount(page, html);
    return root.locator('#e');
}
const area = (el, scope, block) => el.locator(`textarea[data-scope="${scope}"][data-block="${block}"]`);

test('it has a tab for each instruction, each edited globally and for the project, saving as it is typed', async ({ page }) => {
    const el = await editor(page);
    await expect(el.locator('webui-button[slot="tabs"]')).toHaveText(['Shared', 'Commit Messages', 'Code Reviews', 'Pages', 'Scripts', 'Markdown Import']);
    await expect(el.locator('.ai-block-content-git .ai-instruction-label')).toHaveText(['Global, for every project', 'This Project, only for Repo']);
    await el.locator('webui-button[slot="tabs"]', { hasText: 'Commit Messages' }).click();
    await area(el, 'global', 'git').fill('Use Feature: and Bug: lines.');
    await expect.poll(() => page.evaluate(() => window.__backend.appData.data['app-ai-instructions'])).toEqual({ git: 'Use Feature: and Bug: lines.' });
    await el.locator('webui-button[slot="tabs"]', { hasText: 'Shared' }).click();
    await area(el, 'project', 'shared').fill('This project is a Rust app.');
    await expect.poll(() => page.evaluate(() => webui.projectData.data._ai?.instructions)).toEqual({ shared: 'This project is a Rust app.' });
    // The built-in instructions are shown apart, as always sent first, and an empty box shows an example to add.
    await expect(el.locator('.ai-built-in[data-block="git"] p').first()).toHaveText(/^Write a commit message/);
    await expect(area(el, 'global', 'git')).toHaveAttribute('placeholder', /^For example:/);
    // Task Proxy's own context is the built-in shared instructions, sent first with every request.
    await expect(el.locator('.ai-built-in[data-block="shared"] p').first()).toHaveText('You are helping a developer inside Task Proxy.');
});

test('in one integration it has the shared tab and that integration\'s, starting on its own', async ({ page }) => {
    const el = await editor(page, '<app-ai-instructions id="e" integration="review"></app-ai-instructions>');
    await expect(el.locator('webui-button[slot="tabs"]')).toHaveText(['Shared', 'Code Reviews']);
    await expect(el.locator('webui-button[slot="tabs"]', { hasText: 'Code Reviews' })).toHaveAttribute('aria-current', 'true');
});

test('a request is sent the shared instructions, then the integration\'s, the project\'s in place of the global ones when it has its own', async ({ page }) => {
    await openApp(page, {
        ai: { providers: [{ id: 'p', name: 'P', kind: 'openAi', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'm', name: '' }], hidden: [] }] },
        appData: { 'app-ai-instructions': { shared: 'Global shared', git: 'Global git', pages: 'Global pages' } },
    });
    const sent = async () => {
        await page.evaluate(() => webui.proxy.ai.write({ integration: 'git', model: { provider: 'p', model: 'm' }, repo: '', files: ['a.txt'] }));
        return (await calls(page, 'ai_write')).at(-1).request.instructions;
    };
    // A project with none of its own uses the global ones.
    expect(await sent()).toEqual(['Global shared', 'Global git']);
    // Its own git instructions are used in place of the global ones, and the global shared ones still apply.
    await page.evaluate(() => webui.proxy.ai.setScope('project', 'instructions', 'git', 'Project git'));
    expect(await sent()).toEqual(['Global shared', 'Project git']);
    await page.evaluate(() => webui.proxy.ai.setScope('project', 'instructions', 'shared', 'Project shared'));
    expect(await sent()).toEqual(['Project shared', 'Project git']);
    // Emptied, the global one is used again.
    await page.evaluate(() => webui.proxy.ai.setScope('project', 'instructions', 'git', '  '));
    expect(await page.evaluate(() => webui.proxy.ai.instructionsFor('git'))).toEqual(['Project shared', 'Global git']);
});

test('the global box says when this project\'s own is used in its place', async ({ page }) => {
    const el = await editor(page, '<app-ai-instructions id="e" integration="git"></app-ai-instructions>');
    const replaced = el.locator('.ai-replaced-note[data-block="git"]');
    await expect(replaced).toBeHidden();
    await area(el, 'project', 'git').fill('Use Feature: lines.');
    await expect(replaced).toBeVisible();
    await expect(replaced).toHaveText('Not used in Repo, which has its own below.');
    await area(el, 'project', 'git').fill('');
    await expect(replaced).toBeHidden();
});

test('a project\'s instructions typed just before switching projects are saved into it, never the project opened', async ({ page }) => {
    const el = await editor(page);
    // Typed, and not yet saved, as when the project changes within the moment before it saves.
    await page.evaluate(() => {
        const box = document.querySelector('#e textarea[data-scope="project"][data-block="shared"]');
        box.value = 'Only for Repo.';
        box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const repo = await page.evaluate(() => webui.projectData.path);
    await switchProject(page, { name: 'Other', path: '/other' });
    await expect.poll(() => page.evaluate(path => window.__backend.savedProjects[path].data._ai?.instructions, repo)).toEqual({ shared: 'Only for Repo.' });
    // The editor is drawn again for the project open, and saves into it.
    await expect(el.locator('.ai-block-content-shared .ai-instruction-label')).toHaveText(['Global, for every project', 'This Project, only for Other']);
    await expect(area(el, 'project', 'shared')).toHaveValue('');
    expect(await page.evaluate(() => [webui.projectData.path, webui.projectData.data._ai ?? null])).toEqual(['/other', null]);
    await area(el, 'project', 'shared').fill('Only for Other.');
    await expect.poll(() => page.evaluate(() => webui.projectData.data._ai?.instructions)).toEqual({ shared: 'Only for Other.' });
    await expect(el.locator('webui-alert.ai-instructions-note')).not.toHaveAttribute('show');
});

test('opening a project adds its boxes to an editor drawn without one', async ({ page }) => {
    const el = await editor(page, undefined, { project: null });
    await expect(el.locator('.ai-block-content-git .ai-instruction-label')).toHaveText(['Global, for every project']);
    await switchProject(page, { name: 'Other', path: '/other' });
    await expect(el.locator('.ai-block-content-git .ai-instruction-label')).toHaveText(['Global, for every project', 'This Project, only for Other']);
});

test('text that couldn\'t be saved, as its project was no longer open, is said above the boxes', async ({ page }) => {
    await editor(page);
    // A box changed without being typed in, so nothing was waiting to save when the project changed.
    await page.evaluate(() => {
        window.__box = document.querySelector('#e textarea[data-scope="project"][data-block="shared"]');
        window.__box.value = 'Only for Repo.';
    });
    await switchProject(page, { name: 'Other', path: '/other' });
    await page.evaluate(() => window.__box.dispatchEvent(new Event('change', { bubbles: true })));
    const note = page.locator('#e webui-alert.ai-instructions-note');
    await expect(note).toHaveAttribute('variant', 'warning');
    await expect(note).toHaveText('What you typed for Repo wasn\'t saved, as another project was opened first. Open Repo again to type it there.');
    expect(await page.evaluate(() => webui.projectData.data._ai ?? null)).toBeNull();
    // Opening Repo again, where it can be typed, ends the warning.
    await switchProject(page, { name: 'Repo', path: '/repo' });
    await expect(page.locator('#e .ai-block-content-shared .ai-instruction-label')).toHaveText(['Global, for every project', 'This Project, only for Repo']);
    await expect(note).not.toHaveAttribute('show');
});

test('what was typed is kept when the editor is drawn for another integration before it saved', async ({ page }) => {
    await page.clock.install();
    const el = await editor(page, '<app-ai-instructions id="e" integration="git"></app-ai-instructions>');
    await expect(area(el, 'global', 'shared')).toBeAttached();
    // The page's clock stops, so the pause before typing is saved is as long as the test makes it: it never ends here.
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
    await el.locator('webui-button[slot="tabs"]', { hasText: 'Shared' }).click();
    await area(el, 'global', 'shared').fill('Keep it short.');
    await el.evaluate(node => node.setAttribute('integration', 'review'));
    await expect(el.locator('webui-button[slot="tabs"]')).toHaveText(['Shared', 'Code Reviews']);
    await expect(area(el, 'global', 'shared')).toHaveValue('Keep it short.');
    await expect.poll(() => page.evaluate(() => window.__backend.appData.data['app-ai-instructions'])).toEqual({ shared: 'Keep it short.' });
});
