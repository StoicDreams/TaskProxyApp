import { test, expect, openApp, mount, switchProject } from '../support/app.mjs';

// The model picker (wc/ai-model-picker.js): every provider's models as "Provider · Model", starting on the default
// for its integration, with a choice in it kept for that one place.
const PROVIDERS = [
    { id: 'ollama', name: 'Ollama', kind: 'openAi', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'qwen', name: '' }, { id: 'llama', name: '' }], hidden: ['llama'] },
    { id: 'claude', name: 'Claude', kind: 'command', command: 'claude -p --model {model}', models: [{ id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }], hidden: [] },
];
const model = (provider, id) => ({ provider, model: id });

async function picker(page, state = {}, html = '<app-ai-model-picker id="p" integration="git"></app-ai-model-picker>') {
    await openApp(page, { ai: { providers: PROVIDERS }, ...state });
    const root = await mount(page, html);
    const el = root.locator('#p');
    await expect(el.locator('select option').first()).not.toHaveText('Loading models');
    return el;
}
const chosen = el => el.locator('option:checked');
const value = el => el.evaluate(node => node.value);

test('every provider\'s models are listed together, leaving out hidden ones', async ({ page }) => {
    const el = await picker(page);
    await expect(el.locator('option')).toHaveText(['Ollama · qwen', 'Claude · Opus', 'Claude · Sonnet']);
    // With no default set, the first is used.
    await expect.poll(() => value(el)).toEqual(model('ollama', 'qwen'));
});

test('it starts on the project\'s model for the integration, then the project\'s default, then the global ones', async ({ page }) => {
    const globalModels = { 'app-ai-models': { default: model('claude', 'opus'), git: model('claude', 'sonnet') } };
    const el = await picker(page, { appData: globalModels });
    await expect(chosen(el)).toHaveText('Claude · Sonnet');
    const fresh = async integration => {
        const root = await mount(page, `<app-ai-model-picker id="q" integration="${integration}"></app-ai-model-picker>`);
        const next = root.locator('#q');
        await expect(next.locator('option').first()).not.toHaveText('Loading models');
        return next;
    };
    await page.evaluate(() => webui.proxy.ai.setScope('project', 'models', 'default', { provider: 'ollama', model: 'qwen' }));
    await expect(chosen(await fresh('git'))).toHaveText('Ollama · qwen');
    await page.evaluate(() => webui.proxy.ai.setScope('project', 'models', 'git', { provider: 'claude', model: 'opus' }));
    await expect(chosen(await fresh('git'))).toHaveText('Claude · Opus');
    // Another integration with nothing of its own uses the project's default.
    await expect(chosen(await fresh('pages'))).toHaveText('Ollama · qwen');
});

test('a choice made in a picker is for that request only, and the defaults stay as they were', async ({ page }) => {
    const el = await picker(page, { appData: { 'app-ai-models': { default: model('claude', 'opus') } } });
    await el.locator('select').selectOption({ label: 'Ollama · qwen' });
    await expect.poll(() => value(el)).toEqual(model('ollama', 'qwen'));
    expect(await page.evaluate(() => webui.taskProxyData.data['app-ai-models'])).toEqual({ default: model('claude', 'opus') });
    expect(await page.evaluate(() => webui.projectData.data._ai)).toBeUndefined();
});

test('a default whose provider is gone shows as not available, and nothing is sent with it', async ({ page }) => {
    const el = await picker(page, { appData: { 'app-ai-models': { default: model('removed', 'gpt') } } });
    await expect(chosen(el)).toHaveText('gpt (not available)');
    await expect.poll(() => value(el)).toBeNull();
});

test('with no providers set up, it says to set AI up in Settings', async ({ page }) => {
    await openApp(page);
    const root = await mount(page, '<app-ai-model-picker id="p" integration="git"></app-ai-model-picker>');
    await expect(root.locator('#p option')).toHaveText(['Set up AI in Settings']);
    await expect.poll(() => root.locator('#p').evaluate(node => node.value)).toBeNull();
});

test('a default naming a model its provider no longer offers, or one unchecked, shows as not available, and nothing is sent with it', async ({ page }) => {
    const el = await picker(page, { appData: { 'app-ai-models': { git: model('claude', 'haiku'), pages: model('ollama', 'llama') } } },
        '<app-ai-model-picker id="p" integration="git"></app-ai-model-picker><app-ai-model-picker id="h" integration="pages"></app-ai-model-picker>');
    await expect(chosen(el)).toHaveText('Claude · haiku (not available)');
    await expect.poll(() => value(el)).toBeNull();
    const hidden = page.locator('#h');
    await expect(chosen(hidden)).toHaveText('Ollama · llama (not available)');
    await expect.poll(() => value(hidden)).toBeNull();
});

test('a project default set elsewhere, and opening another project, move pickers already shown', async ({ page }) => {
    const el = await picker(page, { appData: { 'app-ai-models': { default: model('claude', 'opus') } } });
    await expect(chosen(el)).toHaveText('Claude · Opus');
    await page.evaluate(() => webui.proxy.ai.setScope('project', 'models', 'git', { provider: 'claude', model: 'sonnet' }));
    await expect(chosen(el)).toHaveText('Claude · Sonnet');
    // Another project has none of its own, so the global default applies there.
    await switchProject(page, { name: 'Other', path: '/other' });
    await expect(chosen(el)).toHaveText('Claude · Opus');
});

test('each choice says it changed once', async ({ page }) => {
    const el = await picker(page);
    await el.evaluate(node => {
        window.__changes = [];
        node.parentElement.addEventListener('change', ev => window.__changes.push(ev.target.localName));
    });
    await el.locator('select').selectOption({ label: 'Claude · Opus' });
    await expect.poll(() => value(el)).toEqual(model('claude', 'opus'));
    await expect.poll(() => page.evaluate(() => window.__changes)).toEqual(['app-ai-model-picker']);
    await el.locator('select').selectOption({ label: 'Claude · Sonnet' });
    await expect.poll(() => page.evaluate(() => window.__changes)).toEqual(['app-ai-model-picker', 'app-ai-model-picker']);
});

test('while models load, a default isn\'t said to be not available, and a default\'s picker says they are loading', async ({ page }) => {
    // Held from the start, before anything on the app's pages loads the models.
    await page.addInitScript(() => {
        Object.defineProperty(window, '__backend', {
            configurable: true,
            get() { return window.__mockBackend; },
            set(backend) {
                const original = backend.handlers.ai_settings;
                const held = [];
                let loaded = false;
                window.__loaded = () => { loaded = true; held.splice(0).forEach(release => release()); };
                backend.handlers.ai_settings = args => loaded ? original(args) : new Promise(resolve => held.push(() => resolve(original(args))));
                window.__mockBackend = backend;
            },
        });
    });
    await openApp(page, { ai: { providers: PROVIDERS }, appData: { 'app-ai-models': { default: model('claude', 'opus') } } });
    const root = await mount(page, '<app-ai-model-picker id="p" integration="git"></app-ai-model-picker><app-ai-model-picker id="s" scope="global" key="git"></app-ai-model-picker>');
    await expect(root.locator('#p option')).toHaveText(['Loading models']);
    await expect(root.locator('#s option')).toHaveText(['Loading models']);
    await page.evaluate(() => window.__loaded());
    await expect(chosen(root.locator('#p'))).toHaveText('Claude · Opus');
    await expect(root.locator('#s option')).toHaveText(['Not set', 'Ollama · qwen', 'Claude · Opus', 'Claude · Sonnet']);
});

test('models that couldn\'t be loaded say so, and the next picker drawn tries again', async ({ page }) => {
    // Failing from the start, before anything on the app's pages loads the models.
    await page.addInitScript(() => {
        Object.defineProperty(window, '__backend', {
            configurable: true,
            get() { return window.__mockBackend; },
            set(backend) {
                window.__original = backend.handlers.ai_settings;
                backend.handlers.ai_settings = () => { throw 'Not ready.'; };
                window.__mockBackend = backend;
            },
        });
    });
    await openApp(page, { ai: { providers: PROVIDERS }, appData: { 'app-ai-models': { default: model('claude', 'opus') } } });
    const root = await mount(page, '<app-ai-model-picker id="p" integration="git"></app-ai-model-picker><app-ai-model-picker id="s" scope="global" key="git"></app-ai-model-picker>');
    await expect(root.locator('#p option')).toHaveText(['Couldn\'t load models']);
    await expect(root.locator('#s option')).toHaveText(['Couldn\'t load models']);
    await page.evaluate(() => { window.__backend.handlers.ai_settings = window.__original; });
    const again = await mount(page, '<app-ai-model-picker id="q" integration="git"></app-ai-model-picker>');
    await expect(again.locator('#q option')).toHaveText(['Ollama · qwen', 'Claude · Opus', 'Claude · Sonnet']);
    await expect(chosen(again.locator('#q'))).toHaveText('Claude · Opus');
});

test('a choice made for one integration isn\'t kept when the picker is for another', async ({ page }) => {
    const el = await picker(page, { appData: { 'app-ai-models': { pages: model('claude', 'sonnet') } } });
    await el.locator('select').selectOption({ label: 'Claude · Opus' });
    await expect.poll(() => value(el)).toEqual(model('claude', 'opus'));
    await el.evaluate(node => node.setAttribute('integration', 'pages'));
    await expect(chosen(el)).toHaveText('Claude · Sonnet');
    await expect.poll(() => value(el)).toEqual(model('claude', 'sonnet'));
});

test('a project\'s default can\'t be chosen with no project open, as there is nowhere to keep it', async ({ page }) => {
    const el = await picker(page, { project: null }, '<app-ai-model-picker id="p" scope="project" key="git"></app-ai-model-picker>');
    await expect(el.locator('select')).toBeDisabled();
    // Opened, it can be, and closed again it can't.
    await switchProject(page, { name: 'Other', path: '/other' });
    await expect(el.locator('select')).toBeEnabled();
    await switchProject(page, null);
    await expect(el.locator('select')).toBeDisabled();
});

test('a project\'s default chosen after the project closed shows that nothing was kept', async ({ page }) => {
    const el = await picker(page, {}, '<app-ai-model-picker id="p" scope="project" key="git"></app-ai-model-picker>');
    // Closed in a way that tells no picker, so the choice is made in one still ready for it.
    await page.evaluate(() => { webui.projectData.id = null; });
    await el.locator('select').selectOption({ label: 'Claude · Opus' });
    await expect(chosen(el)).toHaveText('Not set');
    await expect(el.locator('select')).toBeDisabled();
});

test('a picker drawn while the app is still starting lists the models once it can, and keeps them current', async ({ page }) => {
    // With no project open, nothing on the page has drawn a picker yet.
    await openApp(page, { project: null, ai: { providers: PROVIDERS } });
    expect(await page.evaluate(() => !!customElements.get('app-ai-model-picker'))).toBe(false);
    // As when the app has not set up its backend yet.
    await page.evaluate(() => { window.__proxy = webui.proxy; webui.proxy = undefined; });
    const root = await mount(page, '<app-ai-model-picker id="p" integration="git"></app-ai-model-picker>');
    const el = root.locator('#p');
    await expect(el.locator('option')).toHaveText(['Loading models']);
    await page.evaluate(() => { webui.proxy = window.__proxy; });
    await expect(el.locator('option')).toHaveText(['Ollama · qwen', 'Claude · Opus', 'Claude · Sonnet']);
    // Providers changed elsewhere reach it too.
    await page.evaluate(providers => window.__backend.emit('ai-settings-changed', { providers: [providers[1]] }), PROVIDERS);
    await expect(el.locator('option')).toHaveText(['Claude · Opus', 'Claude · Sonnet']);
});
