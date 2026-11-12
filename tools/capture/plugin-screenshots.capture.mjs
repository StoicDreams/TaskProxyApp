import { test, expect, openApp } from '../../tests/support/app.mjs';
import { readFileSync } from 'node:fs';
import { demoState } from './demo.mjs';
import { shot } from './helpers.mjs';

// Screenshots of plugins for their TaskProxy.com pages, saved as img/plugins/<plugin>/*.webp.
// The screens are the Jira plugin's own output for made-up data, written by its demo in TaskProxyPlugins:
//   cargo run -p taskproxy-jira --example demo -- ../TaskProxyApp/tools/capture/fixtures/jira
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/jira/${name}.json`, import.meta.url), 'utf8'));
const jira = fixture('plugin');
const plugins = [{ id: 'jira', version: jira.version, enabled: true, signed: true, manifest: jira }];
const settle = page => page.waitForTimeout(1200);
const dir = 'plugins/jira';

/** Opens a Jira page, drawn from the demo screen named `screen`. */
async function openJira(page, pageId, screen, path = `/plugin/jira/${pageId}`) {
    await openApp(page, demoState({ currentPage: path, plugins, pluginPages: { [`jira/${pageId}`]: fixture(screen) } }), path);
    await expect(page.locator('app-plugin-page')).not.toContainText('Loading');
    await settle(page);
}

test('jira my issues', async ({ page }) => {
    await openJira(page, 'issues', 'issues');
    await shot(page, 'my-issues', { dir });
});

test('jira issue with its parents', async ({ page }) => {
    await openJira(page, 'issue', 'issue', '/plugin/jira/issue?key=ATL-142');
    await shot(page, 'issue', { dir });
    // Close the issue's own layer to show its parent and grandparent, as a reader would after reading it.
    await page.locator('details.plugin-section').first().locator('summary').click();
    await page.locator('details.plugin-section').nth(1).scrollIntoViewIfNeeded();
    await settle(page);
    await shot(page, 'issue-parents', { dir });
});

test('jira views', async ({ page }) => {
    await openJira(page, 'views', 'views');
    await shot(page, 'views', { dir });
});

test('jira view editor', async ({ page }) => {
    await openJira(page, 'views', 'view-editor', '/plugin/jira/views?edit=1');
    await shot(page, 'view-editor', { dir });
});

test('jira create issue', async ({ page }) => {
    await openJira(page, 'create', 'create', '/plugin/jira/create?project=ATL');
    await shot(page, 'create-issue', { dir });
});

test('jira issue in the git controller', async ({ page }) => {
    const branch = 'ATL-142-show-ci-status-on-the-dashboard';
    await openApp(page, demoState({
        currentPage: '/git-controller', plugins,
        branchCards: [{ id: 'jira', name: 'Jira', card: fixture('branch-card') }],
        git: { ...demoState().git, currentBranch: branch, branches: [{ name: branch, isCurrent: true, updatedDate: '2026-11-11' }, { name: 'main', isCurrent: false, updatedDate: '2026-11-10' }] },
    }), '/git-controller');
    const card = page.locator('#plugin-branch-cards app-plugin-page');
    await expect(card).toContainText('ATL-142');
    await settle(page);
    const top = await page.locator('app-git-manager').boundingBox();
    const cardBox = await card.boundingBox();
    await shot(page, 'git-controller-card', { dir, clip: { x: top.x, y: top.y, width: top.width, height: cardBox.y + cardBox.height - top.y + 16 } });
});

test('plugins page', async ({ page }) => {
    await openApp(page, demoState({
        currentPage: '/plugins?plugin=jira', plugins,
        catalog: [{ ...jira, apiVersion: 1 }],
        pluginSettings: { jira: [
            { key: 'jira_site', label: 'Jira site', help: 'Your Jira address, such as https://your-team.atlassian.net', secret: false, isSet: true, value: 'https://atlas-team.atlassian.net' },
            { key: 'jira_email', label: 'Email', help: 'The email you sign in to Jira with', secret: false, isSet: true, value: 'sam@atlas.test' },
            { key: 'jira_api_token', label: 'API token', help: '', secret: true, isSet: true, value: null },
        ] },
    }), '/plugins?plugin=jira');
    await expect(page.locator('app-plugin-manager webui-input-text[name="jira_site"]')).toBeVisible();
    await settle(page);
    await page.evaluate(() => document.querySelector('app-plugin-manager').scrollIntoView({ block: 'start' }));
    await shot(page, 'plugins-page', { dir: 'plugins' });
});
