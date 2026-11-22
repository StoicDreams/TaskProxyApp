import { test, expect, openApp } from '../../tests/support/app.mjs';
import { demoState } from './demo.mjs';
import { prepare, openToolTab } from './helpers.mjs';
const SHOT = '/tmp/claude-1000/-home-erik--claude-spares-spare-cqFrQg/4c80bb7e-ded3-4887-b678-0e6f01a86d01/scratchpad/';
test('explore', async ({ page }) => {
    await prepare(page);
    await openApp(page, demoState({ currentPage: '/' }), '/');
    await page.waitForTimeout(1500);
    await openToolTab(page, 'theme', { after: 2500 });
    console.log(await page.evaluate(() => {
        const sel = document.querySelector('webui-drawer.shared webui-theme-selector[panel]');
        return sel ? sel.outerHTML.replace(/data:image[^"']*/g, 'DATA').slice(0, 4000) + '\nSHADOW:' + (sel.shadowRoot?.innerHTML || '').slice(0, 3000) : 'none';
    }));
    await page.screenshot({ path: SHOT + 'theme.png' });
    // project dropdown
    await page.locator('app-project-dropdown').click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: SHOT + 'dropdown.png' });
    console.log(await page.evaluate(() => document.querySelector('app-project-dropdown').shadowRoot.innerHTML.slice(0, 3000)));
});
