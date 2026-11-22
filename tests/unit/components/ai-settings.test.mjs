import { test, expect, openApp, mount, calls, switchProject } from '../support/app.mjs';
import { alertPopup } from '../../support/wait.mjs';

// Settings' AI tab (wc/ai-settings.js), in tabs: Providers, each in a tab of its own and set up from a choice of what
// to use, with switches and choices in place of commands; Use AI For; Default Models; and Instructions. The backend
// keeps providers and their keys (services/ai.rs); the window only learns keySet.
const OLLAMA = { id: 'ollama', name: 'Ollama', kind: 'openAi', baseUrl: 'http://localhost:11434/v1', models: [{ id: 'qwen2.5-coder', name: '' }], hidden: [] };
const CLAUDE_COMMAND = 'claude -p --setting-sources user --strict-mcp-config --permission-mode default --model {model} --tools "Read,Grep,Glob"';
const CLAUDE_NO_READING = 'claude -p --setting-sources user --strict-mcp-config --permission-mode default --model {model} --tools ""';
const CLAUDE = { id: 'claude', name: 'Claude (subscription)', kind: 'command', command: CLAUDE_COMMAND, models: [{ id: 'opus', name: 'Claude Opus' }, { id: 'sonnet', name: 'Claude Sonnet' }], hidden: [] };

async function settings(page, state = {}) {
    await openApp(page, state);
    const root = await mount(page, '<app-ai-settings id="s"></app-ai-settings>');
    const el = root.locator('#s');
    await expect(el.locator('.ai-privacy')).toBeVisible();
    return el;
}
const appData = (page, key) => page.evaluate(key => window.__backend.appData.data[key], key);
const pickerOptions = picker => picker.locator('option').allTextContents();
const openTab = (el, name) => el.locator('.ai-settings-tabs > webui-button[slot="tabs"]', { hasText: name }).click();
const providerTabs = el => el.locator('.ai-provider-tabs > webui-button[slot="tabs"]');
const provider = (el, index) => el.locator('.ai-provider-tabs > .ai-provider-content').nth(index).locator('.ai-provider');
const choose = (card, preset) => card.locator(`.ai-choice-${preset} input[type="radio"]`).check();
const setSwitch = (node, option) => node.locator('[role="radio"]', { hasText: option }).click();
const note = el => el.locator('webui-alert.ai-save-note');
const save = async el => {
    await el.locator('webui-button.ai-save').click();
    await expect(note(el)).toHaveText('Your providers are saved.');
    await expect(note(el)).toHaveAttribute('variant', 'success');
};
const saved = async page => (await calls(page, 'ai_save_settings')).at(-1).settings.providers;

test('Settings has an AI tab, with its own tabs for providers, what AI is used for, models, and instructions', async ({ page }) => {
    await openApp(page);
    await page.locator('webui-button.settings-tab-ai').click();
    const ai = page.locator('.settings-ai app-ai-settings');
    await expect(ai).toBeVisible();
    await expect(ai.locator('.ai-settings-tabs > webui-button[slot="tabs"]')).toHaveText(['Providers', 'Use AI For', 'Default Models', 'Instructions']);
    // With nothing set up, it says how to start.
    await expect(ai.locator('.ai-none li').first()).toContainText('Add Provider');
});

test('adding a provider adds a tab for it, starting with a choice of what to use and how to set it up', async ({ page }) => {
    const el = await settings(page, { aiModels: { 'provider-1': [{ id: 'llama3', name: '' }, { id: 'qwen2.5-coder', name: '' }] } });
    await el.locator('webui-button.ai-add-provider').click();
    await expect(providerTabs(el)).toHaveText(['New Provider']);
    const ollama = provider(el, 0);
    await expect(ollama.locator('.ai-choice strong')).toHaveText([
        'Claude Code, with a Claude subscription', 'Ollama, free models on your computer', 'LM Studio, free models on your computer',
        'OpenAI API key (GPT models)', 'Anthropic API key (Claude models)', 'OpenRouter API key (many models)',
        'Another OpenAI-compatible server (advanced)', 'Another command (advanced)',
    ]);
    await choose(ollama, 'ollama');
    await expect(providerTabs(el)).toHaveText(['Ollama']);
    await expect(ollama.locator('input.ai-name')).toHaveValue('Ollama');
    // Its steps show the command they run, and Run runs it in the Terminal Manager, with the model typed in.
    const script = ollama.locator('.ai-step-script');
    await expect(script).toHaveText(["ollama pull 'qwen2.5-coder'"]);
    // What is typed is a PowerShell string, so nothing in it runs.
    await ollama.locator('input.ai-step-input').fill("x'; Remove-Item ~ ‘");
    await expect(script).toHaveText(["ollama pull 'x''; Remove-Item ~ ‘‘'"]);
    await ollama.locator('input.ai-step-input').fill('llama3.2');
    await expect(script).toHaveText(["ollama pull 'llama3.2'"]);
    await ollama.locator('webui-button.ai-run-command').click();
    await expect.poll(() => calls(page, 'run_script').then(list => list.map(call => [call.terminalId, call.scriptContent]))).toEqual([['Download an Ollama model', "ollama pull 'llama3.2'"]]);
    // The Terminal Manager opens on running scripts, showing it.
    await expect.poll(() => page.evaluate(() => document.querySelector('app-terminals')?.filter())).toBe('Running');
    await expect.poll(() => page.evaluate(() => webui.proxy.terminalHelpers.getState().activeId)).toBe('Download an Ollama model');
    // On this computer, there is no address to type.
    await expect(ollama.locator('input.ai-host')).toBeHidden();
    await expect(ollama.locator('input.ai-port')).toHaveValue('11434');
    // Changes not saved yet are plain: a warning says so, and Save and Discard are ready.
    await expect(note(el)).toHaveAttribute('variant', 'warning');
    await expect(note(el)).toContainText('You have changes that aren\'t saved.');
    await expect(el.locator('webui-button.ai-discard')).toBeVisible();
    await save(el);
    await expect(el.locator('webui-button.ai-save')).toHaveAttribute('disabled', /.*/);
    await expect(el.locator('webui-button.ai-discard')).toBeHidden();
    expect((await saved(page)).map(p => [p.name, p.kind, p.baseUrl])).toEqual([['Ollama', 'openAi', 'http://localhost:11434/v1']]);
    // A server added just now lists its models without being asked.
    await expect(provider(el, 0).locator('.ai-model')).toHaveText(['llama3', 'qwen2.5-coder']);
    await openTab(el, 'Default Models');
    const picker = el.locator('tr.ai-default-default app-ai-model-picker[scope="global"] select');
    await expect.poll(() => pickerOptions(picker)).toEqual(['Not set', 'Ollama · llama3', 'Ollama · qwen2.5-coder']);
});

test('Claude Code is set up by choosing its models and whether it can look at the project, with no command to type', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [OLLAMA] } });
    await el.locator('webui-button.ai-add-provider').click();
    await expect(providerTabs(el)).toHaveText(['Ollama', 'New Provider']);
    const claude = provider(el, 1);
    await choose(claude, 'claude');
    await expect(providerTabs(el)).toHaveText(['Ollama', 'Claude Code']);
    await expect(claude.locator('input.ai-command')).toHaveCount(0);
    // Its steps install Claude Code, on any Linux or macOS here, and start it to sign in, finding it where it installs.
    await expect(claude.locator('.ai-step-script')).toHaveText([
        "bash -c 'curl -fsSL https://claude.ai/install.sh | bash'",
        "$env:PATH += [IO.Path]::PathSeparator + (Join-Path $HOME '.local' 'bin')\nclaude",
    ]);
    await claude.locator('.ai-claude-models input[data-model="haiku"]').uncheck();
    await setSwitch(claude.locator('webui-switch.ai-claude-reads'), 'No');
    await claude.locator('input.ai-name').fill('Claude (subscription)');
    await expect(providerTabs(el)).toHaveText(['Ollama', 'Claude (subscription)']);
    await save(el);
    const added = (await saved(page))[1];
    expect([added.name, added.kind, added.models]).toEqual(['Claude (subscription)', 'command', [{ id: 'sonnet', name: 'Claude Sonnet' }, { id: 'opus', name: 'Claude Opus' }]]);
    // It loads only the user's own Claude settings and no MCP servers, so a project can't add hooks or servers that run,
    // in the default permission mode, with no tools at all, so the user's own settings can't let it change anything.
    expect(added.command).toBe(CLAUDE_NO_READING);
    // Read back, it is Claude Code again, with what was chosen, and the tab shown is still its own.
    const shown = provider(el, 1);
    await expect(shown.locator('.ai-preset-head h4')).toHaveText('Claude Code, with a Claude subscription');
    await expect(shown.locator('webui-switch.ai-claude-reads [aria-checked="true"]')).toHaveText('No');
    await expect(shown.locator('.ai-claude-models input[data-model="haiku"]')).not.toBeChecked();
    await expect(providerTabs(el).nth(1)).toHaveAttribute('aria-current', 'true');
});

test('Claude Code\'s command reads back as Claude Code, able to look at the project', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [CLAUDE] } });
    const claude = provider(el, 0);
    await expect(claude.locator('.ai-preset-head h4')).toHaveText('Claude Code, with a Claude subscription');
    await expect(claude.locator('webui-switch.ai-claude-reads [aria-checked="true"]')).toHaveText('Yes');
    await expect(claude.locator('.ai-claude-models input[data-model="opus"]')).toBeChecked();
    await expect(claude.locator('.ai-claude-models input[data-model="haiku"]')).not.toBeChecked();
    // A saved provider can't be changed into another kind.
    await expect(claude.locator('webui-button.ai-change-preset')).toHaveCount(0);
    // It is as it should be, so there is nothing to save.
    await expect(el.locator('webui-button.ai-save')).toHaveAttribute('disabled', /.*/);
    await expect(note(el)).not.toHaveAttribute('show');
});

// Saved by an earlier release, which loaded the project's own Claude settings or turned off a list of tools rather than
// allowing only some, the backend brings it up to date as it reads it (services/ai.rs), so it is never run as it was:
// it reads as Claude Code, as it is now, with nothing to save.
async function upToDate(page, command, reads) {
    const el = await settings(page, { ai: { providers: [{ ...CLAUDE, command }] } });
    const claude = provider(el, 0);
    await expect(claude.locator('.ai-preset-head h4')).toHaveText('Claude Code, with a Claude subscription');
    await expect(claude.locator('webui-switch.ai-claude-reads [aria-checked="true"]')).toHaveText(reads ? 'Yes' : 'No');
    await expect(el.locator('webui-button.ai-save')).toHaveAttribute('disabled', /.*/);
    await expect(note(el)).not.toHaveAttribute('show');
    // Test runs it straight away, as it is saved now.
    await claude.locator('webui-button.ai-test').click();
    await expect(claude.locator('webui-alert.ai-status')).toContainText('answered:');
    await expect.poll(async () => (await page.evaluate(() => webui.proxy.ai.settings())).providers[0].command).toBe(reads ? CLAUDE_COMMAND : CLAUDE_NO_READING);
}

test('Claude Code saved by an earlier release, able to look at the project, is read without the project\'s Claude settings', async ({ page }) => {
    await upToDate(page, 'claude -p --model {model}', true);
});

test('Claude Code saved by an earlier release, kept from the project, is read without the project\'s Claude settings', async ({ page }) => {
    await upToDate(page, 'claude -p --model {model} --disallowedTools "Edit,Write,NotebookEdit,Bash,Read,Grep,Glob"', false);
});

test('Claude Code saved with a list of tools turned off is read allowing only the tools that read', async ({ page }) => {
    await upToDate(page, 'claude -p --setting-sources user --strict-mcp-config --model {model} --disallowedTools "Edit,Write,NotebookEdit,Bash"', true);
});

test('the privacy note and Look at the project say Claude Code can read and send any file in the project', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [CLAUDE] } });
    await expect(el.locator('.ai-privacy')).toContainText('Task Proxy\'s variables and their values, secrets included, are never sent, but with Look at the project on, Claude Code can read any file in the project');
    await expect(el.locator('.ai-privacy')).not.toContainText('Variables and secrets are never sent.');
    await expect(provider(el, 0)).toContainText('It can read any file in the project, including a .env file, keys, or local settings kept there, and what it reads is sent to Anthropic.');
});

test('Claude Code\'s install step is the one for the system Task Proxy runs on, not the browser\'s', async ({ page }) => {
    const el = await settings(page, { aiOs: 'windows' });
    await el.locator('webui-button.ai-add-provider').click();
    await choose(provider(el, 0), 'claude');
    await expect(provider(el, 0).locator('.ai-step-script').first()).toHaveText('irm https://claude.ai/install.ps1 | iex');
});

test('a command saved with no models says it needs one, and nothing is saved', async ({ page }) => {
    const el = await settings(page);
    await el.locator('webui-button.ai-add-provider').click();
    const claude = provider(el, 0);
    await choose(claude, 'claude');
    for (const model of ['sonnet', 'opus', 'haiku']) await claude.locator(`.ai-claude-models input[data-model="${model}"]`).uncheck();
    await el.locator('webui-button.ai-save').click();
    await expect(note(el)).toHaveText('Your providers weren\'t saved: Claude Code needs at least one model.');
    await expect.poll(() => page.evaluate(() => window.__backend.handlers.ai_settings().providers.length)).toBe(0);
});

test('a provider saved unchanged keeps its key and what failed last, whatever its fixture left out', async ({ page }) => {
    const anthropic = { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', apiKey: 'sk-saved', models: [{ id: 'claude-x', name: '' }], lastError: 'Rate limited.' };
    const el = await settings(page, { ai: { providers: [anthropic, { id: 'claude', name: 'Claude Code', kind: 'command', command: CLAUDE_COMMAND, models: [{ id: 'sonnet', name: 'Claude Sonnet' }], lastError: 'Not signed in.' }] } });
    await provider(el, 0).locator('input.ai-name').fill('Anthropic Work');
    await save(el);
    const view = () => page.evaluate(() => webui.proxy.ai.settings());
    await expect.poll(async () => (await view()).providers.map(p => [p.keySet, p.lastError])).toEqual([[true, 'Rate limited.'], [false, 'Not signed in.']]);
    // Still set up the same way, Test still fails as it did.
    await providerTabs(el).nth(1).click();
    await provider(el, 1).locator('webui-button.ai-test').click();
    await expect(provider(el, 1).locator('webui-alert.ai-status')).toContainText('Not signed in.');
});

test('models that can\'t be listed tell every screen why', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [OLLAMA] }, aiModels: { ollama: 'Ollama isn\'t running.' } });
    await page.evaluate(() => {
        window.__errors = [];
        webui.proxy.ai.onSettingsChanged(view => window.__errors.push(view.providers[0].lastError));
    });
    await provider(el, 0).locator('webui-button.ai-refresh').click();
    await expect.poll(() => page.evaluate(() => window.__errors)).toEqual(['Ollama isn\'t running.']);
});

test('limits changed elsewhere are shown, and saved again as they are, when this screen has no changes', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [OLLAMA] } });
    await expect(el.locator('input.ai-timeout')).toHaveValue('120');
    await page.evaluate(view => window.__backend.emit('ai-settings-changed', view), { providers: [OLLAMA], timeoutSecs: 300, maxChars: 60000, defaults: {} });
    await expect(el.locator('input.ai-timeout')).toHaveValue('300');
    await expect(el.locator('input.ai-max-chars')).toHaveValue('60000');
    await provider(el, 0).locator('input.ai-name').fill('Ollama Here');
    await save(el);
    const sent = (await calls(page, 'ai_save_settings')).at(-1).settings;
    expect([sent.timeoutSecs, sent.maxChars]).toEqual([300, 60000]);
});

test('Discard Changes leaves nothing to save even when the saved providers can\'t be read again', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [OLLAMA] } });
    await provider(el, 0).locator('input.ai-name').fill('Ollama Here');
    await expect(note(el)).toHaveAttribute('variant', 'warning');
    await page.evaluate(() => {
        window.__aiSettings = window.__backend.handlers.ai_settings;
        window.__backend.handlers.ai_settings = () => { throw 'The settings file is unreadable.'; };
    });
    await el.locator('webui-button.ai-discard').click();
    await expect(note(el)).toHaveText('Your AI providers couldn\'t be loaded: The settings file is unreadable.');
    await expect(el.locator('webui-button.ai-save')).toHaveAttribute('disabled', /.*/);
    await expect(el.locator('webui-button.ai-discard')).toBeHidden();
    await expect(providerTabs(el)).toHaveText(['Ollama']);
    // Leaving keeps nothing to bring back.
    await el.evaluate(node => node.remove());
    await page.evaluate(() => { window.__backend.handlers.ai_settings = window.__aiSettings; });
    const back = (await mount(page, '<app-ai-settings id="s2"></app-ai-settings>')).locator('#s2');
    await expect(providerTabs(back)).toHaveText(['Ollama']);
    await expect(back.locator('webui-button.ai-save')).toHaveAttribute('disabled', /.*/);
});

test('Ollama on another computer is set by choosing it and typing its address', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [OLLAMA] } });
    const ollama = provider(el, 0);
    await setSwitch(ollama.locator('webui-switch.ai-where'), 'Another computer');
    await ollama.locator('input.ai-host').fill('192.168.1.20');
    await save(el);
    expect((await saved(page))[0].baseUrl).toBe('http://192.168.1.20:11434/v1');
    await expect(provider(el, 0).locator('input.ai-host')).toHaveValue('192.168.1.20');
    await expect(provider(el, 0).locator('webui-switch.ai-where [aria-checked="true"]')).toHaveText('Another computer');
});

test('Ollama on another computer needs an address, and an address typed with a scheme, a port, or as IPv6 still works', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [OLLAMA] } });
    const ollama = provider(el, 0);
    await setSwitch(ollama.locator('webui-switch.ai-where'), 'Another computer');
    // With no address, nothing is saved, and the provider says why.
    await el.locator('webui-button.ai-save').click();
    await expect(ollama.locator('webui-alert.ai-status')).toHaveText('Type the other computer\'s name or IP address, or choose This computer.');
    await expect(note(el)).toHaveText('Nothing was saved. Fix what is said on Ollama first.');
    await ollama.locator('input.ai-host').fill('my pc');
    await el.locator('webui-button.ai-save').click();
    await expect(ollama.locator('webui-alert.ai-status')).toContainText('"my pc" isn\'t an address.');
    expect(await calls(page, 'ai_save_settings')).toEqual([]);
    await ollama.locator('input.ai-host').fill('http://my-pc.local:11434/v1');
    await save(el);
    expect((await saved(page))[0].baseUrl).toBe('http://my-pc.local:11434/v1');
    await expect(provider(el, 0).locator('input.ai-host')).toHaveValue('my-pc.local');
    await provider(el, 0).locator('input.ai-host').fill('fe80::1');
    await save(el);
    expect((await saved(page))[0].baseUrl).toBe('http://[fe80::1]:11434/v1');
});

test('Ollama or LM Studio on a port of its own is still read back as itself', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [{ ...OLLAMA, baseUrl: 'http://localhost:8080/v1' }, { ...OLLAMA, id: 'lm', name: 'LM Studio', baseUrl: 'http://192.168.1.20:9000/v1' }] } });
    await expect(provider(el, 0).locator('.ai-preset-head h4')).toHaveText('Ollama, free models on your computer');
    await expect(provider(el, 0).locator('input.ai-port')).toHaveValue('8080');
    await providerTabs(el).nth(1).click();
    const lm = provider(el, 1);
    await expect(lm.locator('.ai-preset-head h4')).toHaveText('LM Studio, free models on your computer');
    await expect(lm.locator('input.ai-host')).toHaveValue('192.168.1.20');
    await expect(lm.locator('input.ai-port')).toHaveValue('9000');
    // Nothing reads differently, so there is nothing to save.
    await expect(el.locator('webui-button.ai-save')).toHaveAttribute('disabled', /.*/);
});

test('a port that isn\'t one, or one in the address that differs from Port, is said and nothing is saved', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [OLLAMA] } });
    const ollama = provider(el, 0);
    const status = ollama.locator('webui-alert.ai-status');
    await ollama.locator('input.ai-port').fill('70000');
    await el.locator('webui-button.ai-save').click();
    await expect(status).toHaveText('"70000" isn\'t a port. A port is a whole number from 1 to 65535, such as 11434.');
    await expect(note(el)).toHaveText('Nothing was saved. Fix what is said on Ollama first.');
    await ollama.locator('input.ai-port').fill('11434');
    await setSwitch(ollama.locator('webui-switch.ai-where'), 'Another computer');
    await ollama.locator('input.ai-host').fill('my-pc.local:8080');
    await el.locator('webui-button.ai-save').click();
    await expect(status).toHaveText('The address says port 8080, but Port says 11434. Take the port off the address, or set Port to 8080.');
    expect(await calls(page, 'ai_save_settings')).toEqual([]);
    await ollama.locator('input.ai-port').fill('8080');
    await save(el);
    expect((await saved(page))[0].baseUrl).toBe('http://my-pc.local:8080/v1');
});

test('providers that can\'t be loaded say so by Save', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => { window.__backend.handlers.ai_settings = () => { throw 'The settings file is unreadable.'; }; });
    const el = (await mount(page, '<app-ai-settings id="s"></app-ai-settings>')).locator('#s');
    await expect(note(el)).toHaveAttribute('variant', 'danger');
    await expect(note(el)).toHaveText('Your AI providers couldn\'t be loaded: The settings file is unreadable.');
});

test('Settings drawn again and again stops listening for provider changes each time it is left', async ({ page }) => {
    await openApp(page);
    // Each listener that stops is counted. The app's own Settings, and the model pickers, keep theirs.
    await page.evaluate(() => {
        const listen = webui.proxy.ai.onSettingsChanged;
        window.__stopped = 0;
        webui.proxy.ai.onSettingsChanged = callback => listen(callback).then(stop => () => { window.__stopped++; stop(); });
    });
    for (const id of ['s', 't', 'u', 'v']) {
        const el = await mount(page, `<app-ai-settings id="${id}"></app-ai-settings>`);
        await expect(el.locator(`#${id} .ai-privacy`)).toBeVisible();
    }
    await expect.poll(() => page.evaluate(() => window.__stopped)).toBe(3);
    await mount(page, '<p id="none"></p>');
    await expect.poll(() => page.evaluate(() => window.__stopped)).toBe(4);
    // A change made elsewhere is still shown on one drawn now.
    const el = (await mount(page, '<app-ai-settings id="w"></app-ai-settings>')).locator('#w');
    await expect(el.locator('.ai-none')).toBeVisible();
    await page.evaluate(view => window.__backend.emit('ai-settings-changed', view), { providers: [OLLAMA], timeoutSecs: 120, maxChars: 60000, defaults: {} });
    await expect(providerTabs(el)).toHaveText(['Ollama']);
});

test('Use AI For and Default Models follow changes made elsewhere and the project opened', async ({ page }) => {
    const el = await settings(page, { project: null });
    await openTab(el, 'Use AI For');
    const box = key => el.locator(`input[data-integration="${key}"]`);
    await expect(box('pages')).not.toBeChecked();
    await page.evaluate(() => window.__backend.otherScreen('app', { set: { 'app-ai-integrations': { pages: true } } }));
    await expect(box('pages')).toBeChecked();
    await openTab(el, 'Default Models');
    await expect(el.locator('table.ai-defaults tr').first().locator('th')).toHaveText(['', 'Global']);
    await switchProject(page, { name: 'Other', path: '/other' });
    await expect(el.locator('table.ai-defaults tr').first().locator('th')).toHaveText(['', 'Global', 'This Project']);
    await expect(el.locator('tr.ai-default-git app-ai-model-picker[scope="project"]')).toHaveCount(1);
});

test('another command is set up with a row for each model', async ({ page }) => {
    const el = await settings(page);
    await el.locator('webui-button.ai-add-provider').click();
    const card = provider(el, 0);
    await choose(card, 'command');
    await card.locator('input.ai-name').fill('My Tool');
    await card.locator('input.ai-command').fill('my-ai --model {model}');
    await card.locator('.ai-command-model input.ai-command-model-name').fill('Big Model');
    await card.locator('.ai-command-model input.ai-command-model-value').fill('big');
    await card.locator('webui-button.ai-command-model-add').click();
    await card.locator('.ai-command-model').nth(1).locator('input.ai-command-model-name').fill('small');
    await save(el);
    const added = (await saved(page))[0];
    expect([added.kind, added.command, added.models]).toEqual(['command', 'my-ai --model {model}', [{ name: 'Big Model', id: 'big' }, { name: '', id: 'small' }]]);
});

test('a command with {model} in single quotes, even inside $( ) in double quotes, is refused, and others are not', async ({ page }) => {
    const el = await settings(page);
    await el.locator('webui-button.ai-add-provider').click();
    const card = provider(el, 0);
    await choose(card, 'command');
    await card.locator('input.ai-name').fill('My Tool');
    await card.locator('.ai-command-model input.ai-command-model-value').fill('big');
    const refused = 'Your providers weren\'t saved: My Tool\'s command has {model} in single quotes. Leave the quotes out, or use double quotes: the model is always passed as one word.';
    await card.locator('input.ai-command').fill(`my-ai "$(Write-Output '{model}')"`);
    await el.locator('webui-button.ai-save').click();
    await expect(note(el)).toHaveText(refused);
    await card.locator('input.ai-command').fill(`my-ai "it's $(Get-Date)" --model {model}`);
    await save(el);
    expect((await saved(page))[0].command).toBe(`my-ai "it's $(Get-Date)" --model {model}`);
});

test('Remove takes away the provider\'s tab, and a new provider must be chosen before saving', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [OLLAMA, CLAUDE] } });
    await expect(providerTabs(el)).toHaveText(['Ollama', 'Claude (subscription)']);
    await provider(el, 0).locator('webui-button.ai-remove').click();
    await expect(providerTabs(el)).toHaveText(['Claude (subscription)']);
    await expect(providerTabs(el).first()).toHaveAttribute('aria-current', 'true');
    await el.locator('webui-button.ai-add-provider').click();
    await el.locator('webui-button.ai-save').click();
    await expect(note(el)).toHaveText('Choose what each new provider uses first, or remove it, then save.');
    await provider(el, 1).locator('webui-button.ai-remove').click();
    await save(el);
    expect((await saved(page)).map(p => p.id)).toEqual(['claude']);
});

test('an API key is sent to be saved, and afterwards the page only knows that one is set', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [{ ...OLLAMA, kind: 'anthropic', name: 'Claude API', baseUrl: '' }] } });
    const card = provider(el, 0);
    await expect(card.locator('.ai-preset-head h4')).toHaveText('Anthropic API key (Claude models)');
    await expect(card.locator('input.ai-key')).toHaveAttribute('placeholder', 'Not set');
    await card.locator('input.ai-key').fill('sk-ant-secret');
    await save(el);
    expect((await saved(page))[0].apiKey).toBe('sk-ant-secret');
    const shown = provider(el, 0);
    await expect(shown.locator('input.ai-key')).toHaveValue('');
    await expect(shown.locator('input.ai-key')).toHaveAttribute('placeholder', /^Saved/);
    expect(JSON.stringify(await page.evaluate(() => webui.proxy.ai.settings()))).not.toContain('sk-ant-secret');
    // Saving again without typing a key keeps it, so nothing is sent for it.
    await shown.locator('input.ai-name').fill('Claude');
    await save(el);
    expect('apiKey' in (await saved(page))[0]).toBe(false);
    // Remove Key sends an empty key, which removes it.
    await provider(el, 0).locator('webui-button.ai-clear-key').click();
    await save(el);
    expect((await saved(page))[0].apiKey).toBe('');
});

test('Test shows that it is asking, then the model\'s reply or why the provider failed, in an alert', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [OLLAMA, { ...CLAUDE, lastError: 'claude failed (exit code 1): not signed in' }] } });
    const ollama = provider(el, 0);
    const status = card => card.locator('webui-alert.ai-status');
    await expect(status(ollama)).not.toHaveAttribute('show');
    await page.evaluate(() => {
        const original = window.__backend.handlers.ai_test;
        window.__backend.handlers.ai_test = args => new Promise((resolve, reject) => {
            window.__answer = () => { try { resolve(original(args)); } catch (err) { reject(err); } };
        });
    });
    await ollama.locator('webui-button.ai-test').click();
    await expect(status(ollama)).toHaveAttribute('show');
    await expect(status(ollama)).toHaveAttribute('variant', 'info');
    await expect(status(ollama)).toContainText('Asking qwen2.5-coder to answer.');
    await expect.poll(() => calls(page, 'ai_test').then(list => list.length)).toBe(1);
    await page.evaluate(() => window.__answer());
    await expect(status(ollama)).toHaveAttribute('variant', 'success');
    await expect(status(ollama)).toHaveText('qwen2.5-coder answered: Task Proxy can reach me.');
    expect((await calls(page, 'ai_test')).at(-1).model).toEqual({ provider: 'ollama', model: 'qwen2.5-coder' });
    await providerTabs(el).nth(1).click();
    const claude = provider(el, 1);
    await expect(status(claude)).toHaveAttribute('variant', 'danger');
    await expect(status(claude)).toHaveText('Last call failed: claude failed (exit code 1): not signed in');
    await claude.locator('webui-button.ai-test').click();
    // Answered only once the second Test is waiting for it, so the answer shown is that Test's.
    await expect.poll(() => calls(page, 'ai_test').then(list => list.length)).toBe(2);
    await expect(status(claude)).toHaveAttribute('variant', 'info');
    await page.evaluate(() => window.__answer());
    await expect(status(claude)).toHaveAttribute('variant', 'danger');
    await expect(status(claude)).toHaveText('Last call failed: claude failed (exit code 1): not signed in');
});

test('integrations are turned on and off, and are off to start', async ({ page }) => {
    const el = await settings(page);
    await openTab(el, 'Use AI For');
    const box = key => el.locator(`input[data-integration="${key}"]`);
    for (const key of ['git', 'review', 'pages', 'scripts', 'markdown']) await expect(box(key)).not.toBeChecked();
    await box('git').check();
    await box('review').check();
    await expect.poll(() => appData(page, 'app-ai-integrations')).toEqual({ git: true, review: true });
    await box('git').uncheck();
    await expect.poll(() => appData(page, 'app-ai-integrations')).toEqual({ git: false, review: true });
});

test('default models are set globally and for the project, and a removed one shows as not available', async ({ page }) => {
    const el = await settings(page, {
        ai: { providers: [OLLAMA, CLAUDE] },
        appData: { 'app-ai-models': { review: { provider: 'gone', model: 'old-model' } } },
    });
    await openTab(el, 'Default Models');
    const global = key => el.locator(`tr.ai-default-${key} app-ai-model-picker[scope="global"] select`);
    const project = key => el.locator(`tr.ai-default-${key} app-ai-model-picker[scope="project"] select`);
    await expect(global('review').locator('option:checked')).toHaveText('old-model (not available)');
    await global('default').selectOption({ label: 'Claude (subscription) · Claude Sonnet' });
    await expect.poll(() => appData(page, 'app-ai-models')).toEqual({
        review: { provider: 'gone', model: 'old-model' }, default: { provider: 'claude', model: 'sonnet' },
    });
    await project('git').selectOption({ label: 'Ollama · qwen2.5-coder' });
    await expect.poll(() => page.evaluate(() => webui.projectData.data._ai?.models)).toEqual({ git: { provider: 'ollama', model: 'qwen2.5-coder' } });
    // The project's own model never reaches the global settings.
    expect(await page.evaluate(() => webui.taskProxyData.data['app-ai-models'])).not.toHaveProperty('git');
    // Not set clears it, so the next default down is used.
    await project('git').selectOption({ label: 'Not set' });
    await expect.poll(() => page.evaluate(() => webui.projectData.data._ai?.models)).toEqual({});
});

test('with nothing changed there is nothing to save, and changes left unsaved are kept when Settings is left', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [{ ...OLLAMA, id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' }] } });
    await expect(el.locator('webui-button.ai-save')).toHaveAttribute('disabled', /.*/);
    await expect(note(el)).not.toHaveAttribute('show');
    await provider(el, 0).locator('input.ai-name').fill('OpenAI Work');
    await provider(el, 0).locator('input.ai-key').fill('typed-key');
    await el.locator('webui-button.ai-add-provider').click();
    await choose(provider(el, 1), 'claude');
    // Leaving says the changes aren't saved, in the alerts.
    await el.evaluate(node => node.remove());
    await expect(alertPopup(page, 'Your AI provider changes aren\'t saved yet')).toHaveCount(1);
    // Back on the AI tab, they are as they were, still to save.
    const root = await mount(page, '<app-ai-settings id="s2"></app-ai-settings>');
    const back = root.locator('#s2');
    await expect(providerTabs(back)).toHaveText(['OpenAI Work', 'Claude Code']);
    await expect(provider(back, 0).locator('input.ai-key')).toHaveValue('typed-key');
    await expect(note(back)).toHaveAttribute('variant', 'warning');
    expect(await calls(page, 'ai_save_settings')).toEqual([]);
    // Discard Changes goes back to what is saved.
    await back.locator('webui-button.ai-discard').click();
    await expect(providerTabs(back)).toHaveText(['OpenAI']);
    await expect(note(back)).not.toHaveAttribute('show');
    await expect(back.locator('webui-button.ai-save')).toHaveAttribute('disabled', /.*/);
});

test('a setup step that can\'t run says why by its Run button', async ({ page }) => {
    const el = await settings(page);
    await page.evaluate(() => { window.__backend.handlers.run_script = () => { throw 'Script is already running.'; }; });
    await el.locator('webui-button.ai-add-provider').click();
    await choose(provider(el, 0), 'ollama');
    await provider(el, 0).locator('webui-button.ai-run-command').click();
    await expect(provider(el, 0).locator('webui-alert.ai-run-problem[show]')).toHaveText('Script is already running.');
    // The terminal shown stays as it was.
    expect(await page.evaluate(() => webui.proxy.terminalHelpers.getState().activeId)).not.toBe('Download an Ollama model');
});

test('Test is only held back by changes to its own provider', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [OLLAMA, CLAUDE] } });
    await providerTabs(el).nth(1).click();
    await provider(el, 1).locator('input.ai-name').fill('Claude Work');
    await providerTabs(el).nth(0).click();
    await provider(el, 0).locator('webui-button.ai-test').click();
    await expect(provider(el, 0).locator('webui-alert.ai-status')).toHaveText('qwen2.5-coder answered: Task Proxy can reach me.');
    await providerTabs(el).nth(1).click();
    await provider(el, 1).locator('webui-button.ai-test').click();
    await expect(provider(el, 1).locator('webui-alert.ai-status')).toHaveText('Save your changes first, then test.');
    await expect.poll(() => calls(page, 'ai_test').then(list => list.map(call => call.model.provider))).toEqual(['ollama']);
});

test('Refresh Models keeps the models unchecked and not saved yet unchecked', async ({ page }) => {
    const el = await settings(page, {
        ai: { providers: [{ ...OLLAMA, models: [{ id: 'llama3', name: '' }, { id: 'qwen2.5-coder', name: '' }] }] },
        aiModels: { ollama: [{ id: 'llama3', name: '' }, { id: 'qwen2.5-coder', name: '' }, { id: 'gemma', name: '' }] },
    });
    const card = provider(el, 0);
    await card.locator('input[data-model="llama3"]').uncheck();
    await card.locator('webui-button.ai-refresh').click();
    await expect(card.locator('.ai-model')).toHaveText(['llama3', 'qwen2.5-coder', 'gemma']);
    await expect(card.locator('input[data-model="llama3"]')).not.toBeChecked();
    await expect(card.locator('input[data-model="gemma"]')).toBeChecked();
    await save(el);
    expect((await saved(page))[0].hidden).toEqual(['llama3']);
});

test('a new provider\'s models that can\'t be listed after saving say why on it, keeping changes made since', async ({ page }) => {
    const el = await settings(page, { aiModels: { 'provider-1': 'Ollama isn\'t running.' } });
    await page.evaluate(() => {
        const original = window.__backend.handlers.ai_models;
        window.__backend.handlers.ai_models = args => new Promise((resolve, reject) => {
            window.__answer = () => { try { resolve(original(args)); } catch (err) { reject(err); } };
        });
    });
    await el.locator('webui-button.ai-add-provider').click();
    await choose(provider(el, 0), 'ollama');
    await save(el);
    await expect.poll(() => calls(page, 'ai_models').then(list => list.length)).toBe(1);
    // A change made while its models are being read.
    await provider(el, 0).locator('input.ai-name').fill('Ollama Here');
    await page.evaluate(() => window.__answer());
    await expect(provider(el, 0).locator('webui-alert.ai-status')).toHaveText('Last call failed: Ollama isn\'t running.');
    await expect(provider(el, 0).locator('input.ai-name')).toHaveValue('Ollama Here');
    await expect(note(el)).toHaveAttribute('variant', 'warning');
});

/** Holds Save Providers until the test calls window.__saved(). */
const holdSave = page => page.evaluate(() => {
    const original = window.__backend.handlers.ai_save_settings;
    window.__backend.handlers.ai_save_settings = args => new Promise((resolve, reject) => {
        window.__saved = () => { try { resolve(original(args)); } catch (err) { reject(err); } };
    });
});

test('a change made while Save Providers runs is kept and said to need saving, and saving it again updates the provider', async ({ page }) => {
    const el = await settings(page);
    await holdSave(page);
    await el.locator('webui-button.ai-add-provider').click();
    await choose(provider(el, 0), 'lmstudio');
    await el.locator('webui-button.ai-save').click();
    await expect.poll(() => page.evaluate(() => typeof window.__saved)).toBe('function');
    await provider(el, 0).locator('input.ai-name').fill('LM Studio Here');
    await page.evaluate(() => window.__saved());
    await expect(note(el)).toHaveText('Your providers are saved, but not the changes made while they were being saved. Choose Save Providers to keep those too.');
    await expect(note(el)).toHaveAttribute('variant', 'warning');
    await expect(provider(el, 0).locator('input.ai-name')).toHaveValue('LM Studio Here');
    await expect(providerTabs(el)).toHaveText(['LM Studio Here']);
    await expect(el.locator('webui-button.ai-save')).not.toHaveAttribute('disabled', /.*/);
    expect((await saved(page)).map(p => [p.id, p.name])).toEqual([['', 'LM Studio']]);
    await page.evaluate(() => { delete window.__saved; });
    await el.locator('webui-button.ai-save').click();
    await expect.poll(() => page.evaluate(() => typeof window.__saved)).toBe('function');
    await page.evaluate(() => window.__saved());
    await expect(note(el)).toHaveText('Your providers are saved.');
    // Saved again as the provider it was saved as, not as another one.
    const ids = await calls(page, 'ai_save_settings').then(list => list.map(call => call.settings.providers.map(p => p.id)));
    expect(ids).toHaveLength(2);
    expect(ids[1]).toEqual([expect.stringMatching(/.+/)]);
    await expect(providerTabs(el)).toHaveText(['LM Studio Here']);
});

test('while Save Providers runs, Discard Changes and Add Provider wait for it', async ({ page }) => {
    const el = await settings(page, { ai: { providers: [OLLAMA] } });
    await provider(el, 0).locator('input.ai-name').fill('Ollama Here');
    await holdSave(page);
    await el.locator('webui-button.ai-save').click();
    await expect.poll(() => page.evaluate(() => typeof window.__saved)).toBe('function');
    await expect(el.locator('webui-button.ai-discard')).toHaveAttribute('disabled', /.*/);
    await expect(el.locator('webui-button.ai-add-provider')).toHaveAttribute('disabled', /.*/);
    // Even reached some other way, Discard does nothing while it saves: the saved providers aren't read again.
    const reads = await calls(page, 'ai_settings').then(list => list.length);
    await el.locator('webui-button.ai-discard').evaluate(node => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.evaluate(() => window.__saved());
    await expect(note(el)).toHaveText('Your providers are saved.');
    await expect(provider(el, 0).locator('input.ai-name')).toHaveValue('Ollama Here');
    await expect(el.locator('webui-button.ai-add-provider')).not.toHaveAttribute('disabled', /.*/);
    expect(await calls(page, 'ai_settings').then(list => list.length)).toBe(reads);
});

test('Choose something else takes the name typed for the old choice off its tab', async ({ page }) => {
    const el = await settings(page);
    await el.locator('webui-button.ai-add-provider').click();
    await choose(provider(el, 0), 'server');
    await provider(el, 0).locator('input.ai-name').fill('Work Server');
    await expect(providerTabs(el)).toHaveText(['Work Server']);
    await provider(el, 0).locator('webui-button.ai-change-preset').click();
    await expect(providerTabs(el)).toHaveText(['New Provider']);
    await choose(provider(el, 0), 'ollama');
    await expect(providerTabs(el)).toHaveText(['Ollama']);
    await expect(provider(el, 0).locator('input.ai-name')).toHaveValue('Ollama');
});
