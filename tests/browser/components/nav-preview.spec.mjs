import { test, expect, openApp, mount } from '../../support/app.mjs';

async function preview(page, nav) {
    await openApp(page, { project: null });
    const root = await mount(page, '<app-nav-preview id="n"></app-nav-preview>');
    const el = root.locator('#n');
    await el.evaluate((node, nav) => node.setNavRoutes(nav), nav);
    return el;
}
const nav = [{ name: 'One', icon: 'star', url: '/one' }, { name: 'Two', icon: 'star', url: null, children: [{ name: 'Three', icon: 'star', url: '/three' }] }];

test('a folder moved by dragging keeps its markers around it, and its end marker inside it', async ({ page }) => {
    const el = await preview(page, [...nav, { name: 'Four', icon: 'star', url: '/four' }]);
    const top = () => el.evaluate(node => [...node.navRoot().children].map(child => child.getAttribute('message') || child.getAttribute('name')));
    await expect.poll(top).toEqual(['One', 'Before Folder', 'Two', 'After Folder', 'Four']);
    // The folder is dragged by its heading, and dropped below the last page, as a person would.
    const folder = await el.locator('webui-nav-group[name="Two"]').boundingBox();
    const four = await el.locator('webui-nav-link[name="Four"]').boundingBox();
    await page.mouse.move(folder.x + 20, folder.y + 8);
    await page.mouse.down();
    await page.mouse.move(folder.x + 20, folder.y + 20, { steps: 3 });
    await page.mouse.move(four.x + 20, four.y + four.height - 1, { steps: 6 });
    await page.mouse.up();
    await expect.poll(top).toEqual(['One', 'Four', 'Before Folder', 'Two', 'After Folder']);
    await expect.poll(() => el.locator('webui-nav-group[name="Two"]').evaluate(group => [...group.children].filter(child => child.localName === "webui-nav-link").map(child => child.getAttribute('message') || child.getAttribute('name')))).toEqual(['Folder Start', 'Three', 'Folder End']);
});
