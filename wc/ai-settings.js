/*
 * The AI tab of Settings, in tabs of its own: Providers, Use AI For, Default Models, and Instructions.
 *
 * Providers are the AI services drafts are written with, each in a tab of its own, with a tab added for each one the
 * user adds. Someone setting one up may not know how, so a new provider starts with a choice of what to use, such as
 * Claude Code with a Claude subscription, Ollama or LM Studio on this computer, or an API key, and each choice has its
 * own steps to set it up, with switches and choices in place of commands and addresses wherever they can be. Only the
 * advanced choices, another server or another command, are typed in.
 *
 * What is saved is one of the three kinds services/ai.rs knows: an OpenAI-compatible server, the Anthropic API, or a
 * command. Which choice a provider was made with is read back from its kind, address, and command (presetOf), so the
 * backend keeps nothing extra. API keys are kept by the backend, and this page only learns whether one is set.
 */
"use strict"
{
    const CLAUDE_MODELS = [
        { id: 'sonnet', name: 'Claude Sonnet', help: 'Fast and capable. A good choice for most drafts.' },
        { id: 'opus', name: 'Claude Opus', help: 'The most capable, for reviews and harder work. Slower, and uses more of your plan\'s limits.' },
        { id: 'haiku', name: 'Claude Haiku', help: 'The fastest and lightest, for short drafts such as commit messages.' },
    ];
    /**
     * Claude Code may read the project, never change it. Its tools are an allow-list, so only these can run, whatever
     * the user's own settings allow and whatever tools a later Claude Code adds: these when it may look at the project,
     * and none when it may not. Its permission mode is the default, so a user's acceptEdits or bypassPermissions
     * doesn't reach it either.
     */
    const CLAUDE_READ_TOOLS = 'Read,Grep,Glob';
    /**
     * Claude Code runs in the project's folder, where a repo's own .claude settings could add hooks that run commands,
     * and its .mcp.json servers that start programs. Only the user's own settings are loaded, and no MCP servers.
     */
    const CLAUDE_ISOLATED = '--setting-sources user --strict-mcp-config --permission-mode default';
    /**
     * Whether the computer Task Proxy runs on, where steps run, is Windows. The backend says, since a browser on another
     * computer, reaching this one through Remote Connections, may be on another system.
     */
    let hostIsWindows = /Windows/i.test(navigator.userAgent || '');
    const YES = 'Yes';
    const NO = 'No';
    const HERE = 'This computer';
    const ELSEWHERE = 'Another computer';
    /**
     * What a provider can be set up as. Each has a kind the backend knows, what the user is asked for, and the steps to
     * get it ready. A step is `[text, command, url, options]`: a command is shown and run with Run in the Terminal
     * Manager, never copied to paste somewhere, and can be a function of `options.input`, a value the user can change
     * first, such as which model to download. `options.name` names its terminal. A url is a site to open.
     */
    const PRESETS = {
        claude: {
            title: 'Claude Code, with a Claude subscription',
            name: 'Claude Code',
            about: 'Uses the Claude Pro or Max plan you already have, through Claude Code on this computer. No API key, and nothing extra to pay.',
            kind: 'command',
            steps: [
                ['Install Claude Code, the command-line tool your Claude plan works with. Run installs it, on any Linux, macOS, or Windows, and you can watch it in the Terminal Manager.', () => (hostIsWindows ? 'irm https://claude.ai/install.ps1 | iex' : "bash -c 'curl -fsSL https://claude.ai/install.sh | bash'"), 'https://code.claude.com/docs/en/setup', { name: 'Install Claude Code' }],
                ['Sign in once. Run starts Claude Code in the Terminal Manager: answer what it asks there, sign in with your Claude account in the browser it opens, then type /exit.', `$env:PATH += [IO.Path]::PathSeparator + (Join-Path $HOME '.local' 'bin')\nclaude`, null, { name: 'Sign in to Claude Code' }],
                ['Choose the models you want below, then Save and Test.'],
            ],
        },
        ollama: {
            title: 'Ollama, free models on your computer',
            name: 'Ollama',
            about: 'Runs open models such as Llama, Qwen, and Gemma on your own computer, so nothing you send leaves it. Free, but slower than the paid services unless you have a strong graphics card.',
            kind: 'openAi',
            port: 11434,
            steps: [
                ['Install Ollama.', null, 'https://ollama.com/download'],
                ['Download a model. qwen2.5-coder is good with code, or type the name of any model in Ollama\'s library. Run downloads it in the Terminal Manager.', model => `ollama pull ${quotePowerShell(model)}`, 'https://ollama.com/library', { name: 'Download an Ollama model', input: { label: 'Model', value: 'qwen2.5-coder' } }],
                ['Save, and the models you have downloaded are listed below. Then Test.'],
            ],
        },
        lmstudio: {
            title: 'LM Studio, free models on your computer',
            name: 'LM Studio',
            about: 'An app for finding, downloading, and running open models on your own computer, so nothing you send leaves it. Free.',
            kind: 'openAi',
            port: 1234,
            steps: [
                ['Install LM Studio, open it, and download a model from its Discover tab.', null, 'https://lmstudio.ai'],
                ['In its Developer tab, turn on Start Server (its Status shows Running).'],
                ['Save, and the models you have downloaded are listed below. Then Test.'],
            ],
        },
        openai: {
            title: 'OpenAI API key (GPT models)',
            name: 'OpenAI',
            about: 'OpenAI\'s models through an API key. You pay OpenAI for what you use, separately from a ChatGPT subscription.',
            kind: 'openAi',
            url: 'https://api.openai.com/v1',
            key: true,
            steps: [
                ['Sign in to OpenAI\'s platform, add a payment method, and create an API key.', null, 'https://platform.openai.com/api-keys'],
                ['Paste the key below, then Save. Its models are listed, and you can Test.'],
            ],
        },
        anthropic: {
            title: 'Anthropic API key (Claude models)',
            name: 'Claude API',
            about: 'Claude through an API key. You pay Anthropic for what you use, separately from a Claude subscription. With a Claude subscription, choose Claude Code instead.',
            kind: 'anthropic',
            key: true,
            steps: [
                ['Sign in to the Claude Console, add credits, and create an API key.', null, 'https://console.anthropic.com/settings/keys'],
                ['Paste the key below, then Save. Its models are listed, and you can Test.'],
            ],
        },
        openrouter: {
            title: 'OpenRouter API key (many models)',
            name: 'OpenRouter',
            about: 'One API key for models from many companies, some of them free. You pay OpenRouter for what you use.',
            kind: 'openAi',
            url: 'https://openrouter.ai/api/v1',
            key: true,
            steps: [
                ['Sign in to OpenRouter and create an API key.', null, 'https://openrouter.ai/settings/keys'],
                ['Paste the key below, then Save. Its models are listed, and you can Test.'],
            ],
        },
        server: {
            title: 'Another OpenAI-compatible server (advanced)',
            name: '',
            about: 'Any server that answers like OpenAI\'s chat completions, such as vLLM, llama.cpp\'s server, Groq, or one at your work.',
            kind: 'openAi',
            steps: [
                ['Type the server\'s address, ending where /chat/completions would go on, such as https://example.com/v1, and its API key if it needs one.'],
                ['Save, and its models are listed below. Then Test.'],
            ],
        },
        command: {
            title: 'Another command (advanced)',
            name: '',
            about: 'Any program that reads a request and prints its answer, such as another AI tool\'s command line or your own script.',
            kind: 'command',
            steps: [
                ['Type the command. It runs in PowerShell in the project\'s folder, with the request on its input, and what it prints is the draft. {model} is replaced by the model chosen.'],
                ['Add each model with the name to show and the value that replaces {model}. Then Save and Test.'],
            ],
        },
    };
    /**
     * Provider changes not saved yet when the screen was left, kept until they are saved or discarded, or Task Proxy
     * closes, so leaving Settings doesn't lose them. API keys typed in are kept here only, never written anywhere.
     */
    let draft = null;
    const INTEGRATIONS = [
        ['git', 'Git commit messages', 'Writes the commit message from the files you include.'],
        ['review', 'Code reviews', 'A Review tab in the Git Controller reviews the changes or the whole project.'],
        ['pages', 'Pages', 'Writes or rewrites a part of a page as you edit it.'],
        ['scripts', 'Scripts', 'Writes or changes a script in the Script Manager.'],
        ['markdown', 'Importing markdown files', 'Suggests titles, descriptions, and navigation for imported pages.'],
    ];
    const el = (tag, attrs = {}, text) => {
        const node = webui.create(tag, attrs);
        if (text !== undefined) node.textContent = `${text}`;
        return node;
    };
    const button = (cls, label, onClick, icon, theme = 'secondary') => {
        const node = webui.create('webui-button', { class: cls, label, theme, ...(icon ? { 'start-icon': icon } : {}) });
        node.addEventListener('click', onClick);
        return node;
    };
    const switchOf = (cls, label, options, value) => webui.create('webui-switch', { class: cls, label, options: options.join('|'), value });
    /** A switch's choice, which is its value attribute until it is drawn. */
    const chosen = node => node.value || node.getAttribute('value');
    /** The address of a server on this computer or another, at a port. */
    const serverUrl = (host, port) => `http://${host || 'localhost'}:${port}/v1`;
    const isLocalHost = host => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
    /**
     * The address of a server on another computer from what was typed for it: a name or IP address, which may come with
     * a scheme, a port, or a path, as when an address is pasted. A bare IPv6 address is bracketed. `{url}` or `{problem}`.
     */
    function otherServer(typed, port) {
        const text = `${typed || ''}`.trim();
        let host = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
        if (!host) return { problem: 'Type the other computer\'s name or IP address, or choose This computer.' };
        if (!host.startsWith('[') && (host.match(/:/g) || []).length > 1) host = `[${host}]`;
        let url = null;
        try { url = new URL(`http://${host}`); } catch { /* Said below. */ }
        if (!url || url.username || url.password || !url.hostname) {
            return { problem: `"${text}" isn't an address. Type the other computer's name, such as my-pc.local, or its IP address, such as 192.168.1.20.` };
        }
        // A port typed with the address must agree with the Port field, so neither is silently ignored. URL leaves out
        // port 80, so it is read from what was typed.
        const typedPort = host.match(/^(?:\[[^\]]*\]|[^:]*):(\d+)$/)?.[1];
        if (typedPort !== undefined && Number(typedPort) !== Number(port)) {
            return { problem: `The address says port ${typedPort}, but Port says ${port}. Take the port off the address, or set Port to ${typedPort}.` };
        }
        return { url: serverUrl(url.hostname, port) };
    }
    /** A port typed in the Port field, or why it isn't one. Empty is the usual port. `{port}` or `{problem}`. */
    function portOf(typed, usual) {
        const text = `${typed ?? ''}`.trim();
        if (!text) return { port: usual };
        const port = Number(text);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return { problem: `"${text}" isn't a port. A port is a whole number from 1 to 65535, such as ${usual}.` };
        return { port };
    }
    /**
     * The parts of Claude Code's command this page writes, or null when the command was typed some other way. Commands
     * written by earlier releases are brought up to date by the backend as it reads them (claude_command in
     * services/ai.rs, which writes the same command as claudeCommandFor), so they read as Claude Code too.
     */
    function claudeCommand(command) {
        const text = `${command || ''}`.trim();
        const now = text.match(/^claude\s+-p\s+--setting-sources\s+user\s+--strict-mcp-config\s+--permission-mode\s+default\s+--model\s+\{model\}\s+--tools\s+"(Read,Grep,Glob|)"$/);
        return now ? { reads: !!now[1] } : null;
    }
    /**
     * The tools go last: a PowerShell that drops an empty argument leaves --tools with no value, which Claude Code
     * refuses, rather than running with every tool.
     */
    function claudeCommandFor(reads) {
        return `claude -p ${CLAUDE_ISOLATED} --model {model} --tools "${reads ? CLAUDE_READ_TOOLS : ''}"`;
    }
    /** Which choice a saved provider was set up with, read from what was saved. */
    function presetOf(provider) {
        if (provider.preset) return provider.preset;
        if (provider.kind === 'anthropic') return 'anthropic';
        if (provider.kind === 'command') return claudeCommand(provider.command) ? 'claude' : 'command';
        let url = null;
        try { url = new URL(provider.baseUrl); } catch { /* An address that isn't one is shown as typed. */ }
        if (!url) return 'server';
        if (url.hostname === 'api.openai.com') return 'openai';
        if (url.hostname === 'openrouter.ai') return 'openrouter';
        // Ollama and LM Studio are saved as a plain address, http://host:port/v1. Each is known by its usual port, or
        // on another port by keeping its name, since another server on a port of its own is just as likely.
        if (url.protocol === 'http:' && url.pathname.replace(/\/$/, '') === '/v1' && !url.search && !url.hash) {
            const named = name => `${provider.name || ''}`.trim().toLowerCase() === name.toLowerCase();
            for (const key of ['ollama', 'lmstudio']) {
                if (url.port === `${PRESETS[key].port}` || named(PRESETS[key].name)) return key;
            }
        }
        return 'server';
    }

    webui.define('app-ai-settings', {
        connected() {
            const t = this;
            t.build();
            // Integrations turned on or off elsewhere, such as on another screen, show here.
            t.dataset.subscribe = 'app-ai-integrations:refreshIntegrations';
            t._onDefaults = () => t.refreshDefaults();
            t.reconnected();
        },
        reconnected() {
            const t = this;
            // Opening another project changes the This Project column, which is drawn for the project open.
            document.addEventListener('app-ai-defaults-changed', t._onDefaults);
            t.refreshIntegrations();
            t.refreshDefaults();
            // The app can still be starting, before it can reach the backend.
            whenProxyReady().then(() => {
                if (!t.isConnected) return;
                t.listen();
                t.load();
            });
        },
        /** Shows providers changed elsewhere, such as by a model refresh, while this screen is shown. */
        listen() {
            const t = this;
            if (t._unlisten) return;
            t._unlisten = Promise.resolve(webui.proxy.ai.onSettingsChanged(view => {
                if (!t.isConnected) return;
                t._view = view;
                t.useView(view);
                // Shown unless this screen has unsaved edits.
                if (t._dirty) return;
                t.renderProviders();
                t._timeout.value = view.timeoutSecs;
                t._maxChars.value = view.maxChars;
            }));
        },
        /** What the settings say about the computer Task Proxy runs on. */
        useView(view) {
            if (view?.os) hostIsWindows = view.os === 'windows';
        },
        /** Stops listening, so a Settings screen that was left isn't kept by the listener. */
        unlisten() {
            const t = this;
            const unlisten = t._unlisten;
            t._unlisten = null;
            unlisten?.then(stop => typeof stop === 'function' && stop()).catch(() => { });
        },
        disconnected() {
            const t = this;
            t.unlisten();
            document.removeEventListener('app-ai-defaults-changed', t._onDefaults);
            if (!t._dirty) return;
            draft = t.snapshot();
            // This screen has closed, so nothing by its Save button is left to say it by.
            appAlert('Your AI provider changes aren\'t saved yet. They are kept until you close Task Proxy: go back to Settings, AI, Providers, and choose Save Providers to keep them.', 'warning');
        },
        /** The saved settings, or the changes left unsaved last time, shown as they were. */
        async load({ discarding = false } = {}) {
            const t = this;
            let failed = null;
            const view = await webui.proxy.ai.settings(err => {
                failed = err;
                return null;
            });
            if (!t.isConnected) return;
            if (!view) {
                // Discarded, the changes are gone even when the saved settings couldn't be read, so they aren't kept
                // or saved: what is shown is redrawn from the settings last read.
                if (discarding) {
                    t.markClean();
                    t.renderProviders();
                }
                setNote(t._saveNote, `Your AI providers couldn't be loaded: ${failed}`, 'danger');
                return;
            }
            t._view = view;
            t.useView(view);
            const kept = draft;
            draft = null;
            if (kept) {
                t.renderProviders(kept.providers, kept.shown);
                t._timeout.value = kept.timeoutSecs;
                t._maxChars.value = kept.maxChars;
                t.markDirty();
                return;
            }
            t.markClean();
            t.renderProviders();
            t._timeout.value = view.timeoutSecs;
            t._maxChars.value = view.maxChars;
        },
        /** Everything on the Providers tab as it is now, to be shown again as it was. */
        snapshot() {
            const t = this;
            return {
                providers: [...t._providers.querySelectorAll('.ai-provider')].map(card => card._draft()),
                shown: t._providerTabs?.currentTab?.() || 0,
                timeoutSecs: t._timeout.value,
                maxChars: t._maxChars.value,
            };
        },
        build() {
            const t = this;
            const privacy = el('p', { class: 'ai-privacy' }, 'AI drafts send what you are working on to the provider you choose: the files you include in a commit or review, the page or script you are editing, or the files you import. Ollama and LM Studio keep it on this computer. Claude Code and the API providers send it to their servers. Task Proxy\'s variables and their values, secrets included, are never sent, but with Look at the project on, Claude Code can read any file in the project, such as a .env file or a key kept there, and send it too. Every draft lands where you can change it before anything is saved or committed.');
            const tabs = webui.create('webui-tabs', { class: 'ai-settings-tabs' });
            const tab = (cls, label, icon, ...content) => {
                tabs.appendChild(webui.create('webui-button', { slot: 'tabs', class: `ai-tab-${cls}`, 'start-icon': icon, text: label }));
                const holder = webui.create('webui-content', { slot: 'content', nodetach: '', class: `ai-tab-content ai-tab-content-${cls}` });
                holder.append(...content);
                tabs.appendChild(holder);
            };
            tab('providers', 'Providers', 'plug', ...t.buildProviders());
            tab('integrations', 'Use AI For', 'toggle-on', ...t.buildIntegrations());
            tab('models', 'Default Models', 'robot', ...t.buildDefaults());
            const instructionsNote = el('p', { class: 'ai-help' }, 'Sent with each request after the built-in instructions: the shared ones, then those for what is being written. For each, a project that has its own uses them in place of the global ones; one without uses the global ones.');
            tab('instructions', 'Instructions', 'book', instructionsNote, webui.create('app-ai-instructions'));
            t.replaceChildren(privacy, tabs);
        },
        buildProviders() {
            const t = this;
            const intro = el('p', { class: 'ai-help' }, 'Add the AI you want drafts written with. You can add more than one, such as a free model on this computer for commit messages and Claude for reviews, and choose between their models wherever you write with AI.');
            t._providers = el('div', { class: 'ai-providers' });
            const add = webui.create('webui-button', { theme: 'success', 'start-icon': 'plus', label: 'Add Provider', class: 'ai-add-provider' });
            add.addEventListener('click', () => {
                if (!t._saving) t.addProvider();
            });
            t._add = add;
            const general = el('details', { class: 'ai-general' });
            general.appendChild(el('summary', {}, 'Limits for every provider'));
            t._timeout = el('input', { type: 'number', min: '10', max: '3600', class: 'ai-timeout', 'aria-label': 'Seconds to wait for an answer' });
            t._maxChars = el('input', { type: 'number', min: '2000', step: '1000', class: 'ai-max-chars', 'aria-label': 'Most characters sent' });
            [t._timeout, t._maxChars].forEach(input => input.addEventListener('input', () => t.markDirty()));
            const timeoutLabel = el('label', { class: 'ai-field' });
            timeoutLabel.append(el('span', {}, 'Seconds to wait for an answer'), t._timeout);
            const maxLabel = el('label', { class: 'ai-field' });
            maxLabel.append(el('span', {}, 'Most characters of changes or files sent at once'), t._maxChars);
            general.append(timeoutLabel, el('p', { class: 'ai-help' }, 'Models on your own computer can be slow, so give them longer.'), maxLabel, el('p', { class: 'ai-help' }, 'Larger changes are cut down to fit, and larger reviews are done in parts. A smaller model may need less.'));
            t._save = webui.create('webui-button', { theme: 'primary', 'start-icon': 'save', label: 'Save Providers', class: 'ai-save' });
            t._save.addEventListener('click', () => t.save());
            t._discard = webui.create('webui-button', { theme: 'secondary', 'start-icon': 'undo', label: 'Discard Changes', class: 'ai-discard' });
            t._discard.addEventListener('click', () => {
                // What is being saved can't be discarded: it is saved, or says why not, first.
                if (t._saving) return;
                draft = null;
                t.load({ discarding: true });
            });
            // What happened when saving, and while there are changes, that they aren't saved, under the buttons.
            t._saveNote = webui.create('webui-alert', { class: 'ai-save-note' });
            const saveRow = el('div', { class: 'ai-save-row' });
            saveRow.append(add, t._save, t._discard);
            return [intro, saveRow, t._saveNote, t._providers, general];
        },
        buildIntegrations() {
            const t = this;
            const intro = el('p', { class: 'ai-help' }, 'Turn on the places you want a Write with AI button. Nothing is sent until you choose it there.');
            const integrations = el('div', { class: 'ai-integrations' });
            t._integrations = integrations;
            INTEGRATIONS.forEach(([key, label, help]) => {
                const row = el('label', { class: `ai-integration ai-integration-${key}` });
                const box = el('input', { type: 'checkbox', 'data-integration': key });
                box.addEventListener('change', () => {
                    const next = { ...(webui.getData('app-ai-integrations') || {}) };
                    next[key] = box.checked;
                    webui.setData('app-ai-integrations', next);
                });
                row.append(box, el('strong', {}, label), el('span', { class: 'ai-help' }, help));
                integrations.appendChild(row);
            });
            t.refreshIntegrations();
            return [intro, integrations];
        },
        /** Each integration's box as it is set now. */
        refreshIntegrations() {
            const on = webui.getData('app-ai-integrations') || {};
            this._integrations?.querySelectorAll('input[data-integration]').forEach(box => { box.checked = !!on[box.dataset.integration]; });
        },
        buildDefaults() {
            const t = this;
            const note = el('p', { class: 'ai-help' }, 'Each place you write with AI starts on the project\'s model for it, then the project\'s default, then the global model for it, then the global default. You can pick another there for one request.');
            t._defaults = el('div', { class: 'ai-defaults-wrap' });
            t.refreshDefaults();
            return [note, t._defaults];
        },
        /** The models table, with a This Project column while a project is open, drawn again when another one is. */
        refreshDefaults() {
            const t = this;
            const project = webui.projectData?.id || null;
            if (!t._defaults || (t._defaults.firstChild && t._defaultsFor === project)) return;
            t._defaultsFor = project;
            const table = el('table', { class: 'ai-defaults' });
            const hasProject = !!project;
            const head = el('tr');
            head.append(el('th', {}, ''), el('th', {}, 'Global'), ...(hasProject ? [el('th', {}, 'This Project')] : []));
            table.appendChild(head);
            [['default', 'Default'], ...INTEGRATIONS.map(([key, label]) => [key, label])].forEach(([key, label]) => {
                const row = el('tr', { class: `ai-default-${key}` });
                const cell = scope => {
                    const td = el('td');
                    td.appendChild(webui.create('app-ai-model-picker', { scope, key, 'aria-label': `${label}, ${scope === 'global' ? 'global' : 'this project'}` }));
                    return td;
                };
                row.append(el('th', { scope: 'row' }, label), cell('global'), ...(hasProject ? [cell('project')] : []));
                table.appendChild(row);
            });
            t._defaults.replaceChildren(table);
        },
        /** There are changes to save: Save and Discard are ready, and a warning says they aren't saved. */
        markDirty() {
            const t = this;
            t._dirty = true;
            // Counted, so a save can tell changes made while it ran, which it didn't send.
            t._edits = (t._edits || 0) + 1;
            if (!t._saving) t._save.removeAttribute('disabled');
            t._discard.hidden = false;
            setNote(t._saveNote, 'You have changes that aren\'t saved. Choose Save Providers to keep them. Until then they are lost when Task Proxy closes.', 'warning');
        },
        markClean(message) {
            const t = this;
            t._dirty = false;
            t._save.setAttribute('disabled', '');
            t._discard.hidden = true;
            setNote(t._saveNote, message, 'success');
        },
        /** Each provider in a tab of its own, keeping the tab that was shown. */
        renderProviders(providers, shown) {
            const t = this;
            providers ??= t._view?.providers || [];
            shown ??= t._providerTabs?.currentTab?.() || 0;
            t._providerTabs = null;
            if (!providers.length) {
                t._providers.replaceChildren(t.noProviders());
                return;
            }
            const tabs = webui.create('webui-tabs', { class: 'ai-provider-tabs', theme: 'secondary', index: `${Math.min(shown, providers.length - 1)}` });
            const cards = providers.map(provider => t.providerCard(provider));
            cards.forEach(card => t.appendProvider(tabs, card));
            t._providerTabs = tabs;
            t._providers.replaceChildren(tabs);
        },
        noProviders() {
            const none = el('div', { class: 'ai-none' });
            none.append(
                el('p', {}, 'No providers yet. To get started:'),
                (() => {
                    const list = el('ol');
                    ['Choose Add Provider, and choose what you want to use. Each choice shows what to do to set it up.', 'Save it, and Test that it answers.', 'In Use AI For, turn on where you want to write with AI.'].forEach(step => list.appendChild(el('li', {}, step)));
                    return list;
                })(),
            );
            return none;
        },
        appendProvider(tabs, card) {
            const label = webui.create('webui-button', { slot: 'tabs', class: 'ai-provider-tab' });
            label.textContent = card._title();
            card._tab = label;
            const content = webui.create('webui-content', { slot: 'content', nodetach: '', class: 'ai-provider-content' });
            content.appendChild(card);
            card._content = content;
            tabs.append(label, content);
        },
        /** Adds a tab for a new provider and shows it. */
        addProvider() {
            const t = this;
            const card = t.providerCard({ id: '', name: '', kind: 'openAi', baseUrl: '', command: '', models: [], hidden: [], keySet: false, preset: null });
            if (!t._providerTabs) {
                t._providerTabs = webui.create('webui-tabs', { class: 'ai-provider-tabs', theme: 'secondary' });
                t._providers.replaceChildren(t._providerTabs);
            }
            const tabs = t._providerTabs;
            t.appendProvider(tabs, card);
            customElements.whenDefined('webui-tabs').then(() => {
                if (typeof tabs.render !== 'function') return;
                tabs.render();
                tabs.setTab(tabs.tabButtons().indexOf(card._tab));
            });
            t.markDirty();
        },
        removeProvider(card) {
            const t = this;
            const tabs = t._providerTabs;
            card._tab?.remove();
            card._content?.remove();
            if (!tabs?.querySelector('.ai-provider')) {
                t._providerTabs = null;
                t._providers.replaceChildren(t.noProviders());
            } else if (typeof tabs.render === 'function') {
                // The tab at that place may be another now, which setTab shows in its place.
                tabs.render();
                tabs.setTab(Math.min(tabs.currentTab(), tabs.tabButtons().length - 1));
            }
            t.markDirty();
        },
        /** One provider's settings, which are saved with the others. */
        providerCard(provider) {
            const t = this;
            const card = el('div', { class: 'ai-provider', 'data-id': provider.id || '' });
            card._provider = provider;
            card._preset = provider.id || provider.kind !== 'openAi' || provider.baseUrl ? presetOf(provider) : provider.preset;
            card._title = () => card._name?.value.trim() || PRESETS[card._preset]?.name || 'New Provider';
            t.drawCard(card);
            return card;
        },
        /** A new provider's choice of what to use, then the setup for what was chosen. */
        drawCard(card) {
            const t = this;
            const provider = card._provider;
            if (!card._preset) {
                const list = el('div', { class: 'ai-choices', role: 'radiogroup', 'aria-label': 'What do you want to use?' });
                const group = `ai-preset-${Math.random().toString(36).slice(2, 7)}`;
                Object.entries(PRESETS).forEach(([key, preset]) => {
                    const row = el('label', { class: `ai-choice ai-choice-${key}` });
                    const radio = el('input', { type: 'radio', name: group, value: key });
                    radio.addEventListener('change', () => {
                        card._preset = key;
                        t.drawCard(card);
                        t.markDirty();
                    });
                    const text = el('span', { class: 'ai-choice-text' });
                    text.append(el('strong', {}, preset.title), el('span', { class: 'ai-help' }, preset.about));
                    row.append(radio, text);
                    list.appendChild(row);
                });
                const remove = webui.create('webui-button', { theme: 'danger', 'start-icon': 'trash', label: 'Remove', class: 'ai-remove' });
                remove.addEventListener('click', () => t.removeProvider(card));
                card._read = () => null;
                card._draft = () => ({ id: '', name: '', kind: 'openAi', baseUrl: '', command: '', models: [], hidden: [], keySet: false, preset: null });
                card.replaceChildren(el('h4', {}, 'What do you want to use?'), list, remove);
                return;
            }
            const preset = PRESETS[card._preset];
            const field = (label, input, help, cls = '') => {
                const row = el('div', { class: `ai-field ${cls}` });
                const caption = el('label', {}, label);
                if (input.id) caption.setAttribute('for', input.id);
                const holder = el('div', { class: 'ai-field-input' });
                holder.append(input, ...(help ? [el('span', { class: 'ai-help' }, help)] : []));
                row.append(caption, holder);
                return row;
            };
            const id = part => `ai-${part}-${Math.random().toString(36).slice(2, 7)}`;
            const parts = [];
            const head = el('div', { class: 'ai-preset-head' });
            head.append(el('h4', {}, preset.title), el('p', { class: 'ai-help' }, preset.about));
            if (!provider.id) {
                head.appendChild(button('ai-change-preset', 'Choose something else', () => {
                    card._preset = null;
                    // The name typed for the old choice goes with it, from the tab too.
                    card._name = null;
                    t.drawCard(card);
                    if (card._tab) card._tab.textContent = card._title();
                }, 'arrows-left-right'));
            }
            parts.push(head, t.steps(preset.steps));

            const name = el('input', { type: 'text', id: id('name'), class: 'ai-name', placeholder: preset.name || 'Such as Work Server' });
            name.value = provider.name || preset.name || '';
            name.addEventListener('input', () => {
                if (card._tab) card._tab.textContent = card._title();
                t.markDirty();
            });
            card._name = name;
            parts.push(field('Name', name, 'Shown before each of its models when you choose one, as in "Ollama · llama3".'));

            const read = { kind: preset.kind, baseUrl: () => '', command: () => '', models: null, problem: () => null };
            const dirty = () => t.markDirty();
            if (card._preset === 'claude') {
                const parsed = claudeCommand(provider.command) || { reads: true };
                const reads = switchOf('ai-claude-reads', 'Can Claude Code look at other files in the project?', [YES, NO], parsed.reads ? YES : NO);
                reads.addEventListener('change', dirty);
                parts.push(field('Look at the project', reads, 'Yes lets Claude Code read other files in the project to understand what changed, for better reviews and messages. It can read any file in the project, including a .env file, keys, or local settings kept there, and what it reads is sent to Anthropic. Choose No for a project with secrets in its files. It can never change files or run commands from here.'));
                const known = provider.id || provider.restored ? (provider.models || []) : CLAUDE_MODELS;
                const models = el('div', { class: 'ai-claude-models' });
                CLAUDE_MODELS.forEach(model => {
                    const row = el('label', { class: 'ai-model' });
                    const box = el('input', { type: 'checkbox', 'data-model': model.id });
                    box.checked = known.some(item => item.id === model.id);
                    box.addEventListener('change', dirty);
                    const text = el('span', {});
                    text.append(el('strong', {}, model.name), ' ', el('span', { class: 'ai-help' }, model.help));
                    row.append(box, text);
                    models.appendChild(row);
                });
                parts.push(field('Models', models, 'Each is always Claude Code\'s newest of its kind.'));
                // Models added some other way are kept.
                const others = (provider.models || []).filter(item => !CLAUDE_MODELS.some(model => model.id === item.id));
                read.command = () => claudeCommandFor(chosen(reads) !== NO);
                read.models = () => [
                    ...CLAUDE_MODELS.filter(model => models.querySelector(`input[data-model="${model.id}"]`).checked).map(({ id, name }) => ({ id, name })),
                    ...others,
                ];
            } else if (card._preset === 'ollama' || card._preset === 'lmstudio') {
                let url = null;
                try { url = new URL(provider.baseUrl); } catch { /* A new one starts on this computer. */ }
                const host = url?.hostname || 'localhost';
                const where = switchOf('ai-where', `Where is ${preset.name} running?`, [HERE, ELSEWHERE], isLocalHost(host) ? HERE : ELSEWHERE);
                const address = el('input', { type: 'text', id: id('host'), class: 'ai-host', placeholder: 'Such as 192.168.1.20 or my-pc.local' });
                address.value = isLocalHost(host) ? '' : host;
                const port = el('input', { type: 'number', id: id('port'), class: 'ai-port', min: '1', max: '65535' });
                // URL leaves out port 80, which a saved address can have.
                port.value = url ? (url.port || '80') : preset.port;
                parts.push(field('Running on', where, `Usually this computer. Another computer must let ${preset.name} take requests from others on your network.`));
                const addressRow = field('Its address', address, 'The other computer\'s name or IP address.', 'ai-host-field');
                parts.push(addressRow, field('Port', port, `${preset.name} uses ${preset.port} unless you changed it.`, 'ai-port-field'));
                const showWhere = () => { addressRow.hidden = chosen(where) !== ELSEWHERE; };
                where.addEventListener('change', () => { showWhere(); dirty(); });
                showWhere();
                [address, port].forEach(input => input.addEventListener('input', dirty));
                const portNow = () => portOf(port.value, preset.port);
                const other = () => otherServer(address.value, portNow().port ?? preset.port);
                read.baseUrl = () => chosen(where) === ELSEWHERE ? (other().url || address.value.trim()) : serverUrl('localhost', portNow().port ?? preset.port);
                read.problem = () => portNow().problem || (chosen(where) === ELSEWHERE ? other().problem : null) || null;
            } else if (preset.url) {
                read.baseUrl = () => preset.url;
            } else if (card._preset === 'server') {
                const address = el('input', { type: 'url', id: id('url'), class: 'ai-base-url', placeholder: 'https://example.com/v1' });
                address.value = provider.baseUrl || '';
                address.addEventListener('input', dirty);
                parts.push(field('Server address', address, 'Where its API starts, usually ending in /v1.'));
                read.baseUrl = () => address.value.trim();
            } else if (card._preset === 'command') {
                const command = el('input', { type: 'text', id: id('command'), class: 'ai-command', placeholder: 'my-ai --model {model}' });
                command.value = provider.command || '';
                command.addEventListener('input', dirty);
                parts.push(field('Command', command, 'Runs in PowerShell in the project\'s folder. The request is sent to its input, and what it prints is the draft.'));
                const rows = el('div', { class: 'ai-command-models' });
                const addRow = (model = { name: '', id: '' }) => {
                    const row = el('div', { class: 'ai-command-model' });
                    const shown = el('input', { type: 'text', class: 'ai-command-model-name', placeholder: 'Name to show', 'aria-label': 'Name to show' });
                    shown.value = model.name || '';
                    const value = el('input', { type: 'text', class: 'ai-command-model-value', placeholder: 'Value for {model}', 'aria-label': 'Value for {model}' });
                    value.value = model.id || '';
                    [shown, value].forEach(input => input.addEventListener('input', dirty));
                    row.append(shown, value, button('ai-command-model-remove', 'Remove', () => { row.remove(); dirty(); }, 'trash', 'danger'));
                    rows.appendChild(row);
                };
                (provider.models || []).forEach(addRow);
                if (!rows.children.length) addRow();
                const more = button('ai-command-model-add', 'Add Model', () => { addRow(); dirty(); }, 'plus', 'success');
                const holder = el('div', {});
                holder.append(rows, more);
                parts.push(field('Models', holder, 'Leave the value empty to use the name.'));
                read.command = () => command.value;
                read.models = () => [...rows.querySelectorAll('.ai-command-model')].map(row => {
                    const shown = row.querySelector('.ai-command-model-name').value.trim();
                    const value = row.querySelector('.ai-command-model-value').value.trim() || shown;
                    return { name: shown === value ? '' : shown, id: value };
                }).filter(model => model.id);
            }

            let clearKey = false;
            let key = null;
            if (preset.kind !== 'command') {
                key = el('input', { type: 'password', id: id('key'), class: 'ai-key', autocomplete: 'off', placeholder: provider.keySet ? 'Saved. Type a new key to replace it.' : 'Not set' });
                key.value = provider.draftKey || '';
                key.addEventListener('input', dirty);
                const remove = button('ai-clear-key', 'Remove Key', () => {
                    clearKey = true;
                    key.value = '';
                    key.placeholder = 'Removed when saved';
                    remove.hidden = true;
                    dirty();
                }, 'trash', 'danger');
                remove.hidden = !provider.keySet;
                if (provider.clearKey) {
                    clearKey = true;
                    key.placeholder = 'Removed when saved';
                    remove.hidden = true;
                }
                const holder = el('div', { class: 'ai-key-row' });
                holder.append(key, remove);
                if (preset.key || card._preset === 'server') {
                    parts.push(field(preset.key ? 'API key' : 'API key (if it needs one)', holder, 'Kept encrypted on this computer, and only sent to this provider.', 'ai-key-field'));
                }
            }

            const serverModels = el('div', { class: 'ai-server-models' });
            /** Lists models to check, keeping what was unchecked here, saved or not, as it was. */
            const listModels = models => {
                const boxes = [...serverModels.querySelectorAll('input[data-model]')];
                const hidden = boxes.length ? boxes.filter(box => !box.checked).map(box => box.dataset.model) : (card._provider.hidden || []);
                serverModels.replaceChildren();
                if (!models.length) {
                    serverModels.appendChild(el('span', { class: 'ai-help' }, card._provider.id ? 'None listed yet. Choose Refresh Models.' : 'Listed once you Save.'));
                    return;
                }
                models.forEach(model => {
                    const row = el('label', { class: 'ai-model' });
                    const shown = el('input', { type: 'checkbox', 'data-model': model.id });
                    shown.checked = !hidden.includes(model.id);
                    shown.addEventListener('change', dirty);
                    row.append(shown, el('span', {}, model.name || model.id));
                    serverModels.appendChild(row);
                });
            };
            // How the last call went, Test's answer included, as an alert under the buttons.
            const status = webui.create('webui-alert', { class: 'ai-status' });
            const say = (variant, text) => setNote(status, text, variant);
            const showError = err => say('danger', `Last call failed: ${err}`);
            card._showError = showError;
            card._say = say;
            card._problem = () => read.problem();
            if (provider.lastError) showError(provider.lastError);
            const buttons = el('div', { class: 'ai-provider-buttons' });
            const refresh = webui.create('webui-button', { theme: 'info', 'start-icon': 'refresh', label: 'Refresh Models', class: 'ai-refresh' });
            if (preset.kind !== 'command') {
                listModels(provider.models || []);
                parts.push(field('Models to show', serverModels, 'Uncheck any you don\'t want to choose from.'));
                refresh.addEventListener('click', async () => {
                    const id = card._provider.id;
                    if (!id) return say('info', 'Save the provider first, then refresh its models.');
                    refresh.setAttribute('disabled', '');
                    try {
                        const view = await webui.proxy.ai.refreshModels(id);
                        const updated = view?.providers?.find(p => p.id === id);
                        if (updated) {
                            card._provider = updated;
                            listModels(updated.models);
                            say();
                        }
                    } catch (err) {
                        showError(err);
                    } finally {
                        refresh.removeAttribute('disabled');
                    }
                });
            } else {
                refresh.hidden = true;
            }
            const test = webui.create('webui-button', { theme: 'secondary', 'start-icon': 'plug', label: 'Test', class: 'ai-test' });
            test.addEventListener('click', async () => {
                // Only this provider's own changes need saving first: Test uses what is saved for it.
                if (!card._provider.id || card._changed()) return say('warning', 'Save your changes first, then test.');
                const models = (card._provider.models || []).filter(model => !(card._provider.hidden || []).includes(model.id));
                if (!models.length) return say('warning', 'This provider has no models to test with yet.');
                test.setAttribute('disabled', '');
                const model = models[0].name || models[0].id;
                say('info', `Asking ${model} to answer. ${card._provider.kind === 'command' ? 'A command such as Claude Code can take several seconds to start.' : 'A model on this computer can take a while to load the first time.'}`);
                try {
                    const reply = await webui.proxy.ai.test({ provider: card._provider.id, model: models[0].id });
                    say('success', `${model} answered: ${reply}`);
                } catch (err) {
                    showError(err);
                } finally {
                    test.removeAttribute('disabled');
                }
            });
            const remove = webui.create('webui-button', { theme: 'danger', 'start-icon': 'trash', label: 'Remove', class: 'ai-remove' });
            remove.addEventListener('click', () => t.removeProvider(card));
            buttons.append(refresh, test, remove);
            parts.push(buttons, status);
            card.replaceChildren(...parts);
            if (card._tab) card._tab.textContent = card._title();
            card._read = () => {
                const update = {
                    id: card._provider.id || '', name: name.value.trim() || preset.name, kind: read.kind,
                    baseUrl: read.baseUrl(), command: read.command(),
                    hidden: [...serverModels.querySelectorAll('input[data-model]')].filter(box => !box.checked).map(box => box.dataset.model),
                };
                if (read.models) update.models = read.models();
                if (key?.value.trim()) update.apiKey = key.value.trim();
                else if (clearKey) update.apiKey = '';
                return update;
            };
            card._draft = () => {
                const { apiKey, ...update } = card._read();
                return {
                    ...card._provider, ...update, models: update.models ?? card._provider.models, preset: card._preset, restored: true,
                    draftKey: key?.value || '', clearKey,
                };
            };
            // What a saved provider reads as before any change, to tell whether it has changes to save. A provider
            // brought back from changes left unsaved has them.
            const saved = card._provider.id && !card._provider.restored ? JSON.stringify(card._read()) : null;
            card._changed = () => saved === null || JSON.stringify(card._read()) !== saved;
        },
        /** A choice's setup steps, with its commands to run and its sites to open. */
        steps(steps) {
            const t = this;
            const list = el('ol', { class: 'ai-steps' });
            steps.forEach(([text, step, url, options = {}]) => {
                const item = el('li', {}, text);
                if (step) {
                    const box = el('div', { class: 'ai-step-command' });
                    const shown = el('pre', { class: 'ai-step-script' });
                    let input = null;
                    const command = () => typeof step === 'function' ? step(input ? (input.value.trim() || options.input.value) : undefined) : step;
                    const draw = () => { shown.textContent = command(); };
                    if (options.input) {
                        input = el('input', { type: 'text', class: 'ai-step-input', 'aria-label': options.input.label, placeholder: options.input.value });
                        input.value = options.input.value;
                        input.addEventListener('input', draw);
                        const label = el('label', { class: 'ai-step-input-label' });
                        label.append(el('span', {}, options.input.label), input);
                        box.appendChild(label);
                    }
                    draw();
                    // Why it couldn't run, by its Run button.
                    const problem = webui.create('webui-alert', { class: 'ai-run-problem', variant: 'warning' });
                    box.append(shown, button('ai-run-command', 'Run', () => t.runStep(options.name || 'AI Setup', command(), problem), 'play', 'success'), problem);
                    item.appendChild(box);
                }
                if (url) {
                    const label = url.includes('/docs/') ? 'Open the setup guide' : url.includes('/library') ? 'See the models' : `Open ${new URL(url).hostname.replace(/^www\./, '')}`;
                    item.append(' ', button('ai-open-site', label, () => webui.proxy.openUrl(url), 'globe', 'info'));
                }
                list.appendChild(item);
            });
            return list;
        },
        /** Runs a setup step's command in the Terminal Manager, where it can be watched, and answered when it asks. */
        async runStep(name, command, problem) {
            const say = text => setNote(problem, text, 'warning');
            say();
            if (!webui.projectData?.id) {
                say('Open a project first. Its commands run in the Terminal Manager.');
                return;
            }
            const helpers = webui.proxy.terminalHelpers;
            helpers.ensureListeners();
            try {
                await helpers.runScript(name, command);
                // Shown once it started, so a step that couldn't start doesn't take the place of the terminal shown.
                helpers.getState().activeId = name;
                document.querySelector('app-terminals')?.openDrawer({ run: true, terminalId: name });
            } catch (err) {
                say(`${err}`);
            }
        },
        async save() {
            const t = this;
            if (t._saving) return;
            const cards = [...t._providers.querySelectorAll('.ai-provider')];
            if (cards.some(card => !card._preset)) {
                setNote(t._saveNote, 'Choose what each new provider uses first, or remove it, then save.', 'warning');
                return;
            }
            const problems = cards.filter(card => card._problem?.());
            if (problems.length) {
                problems.forEach(card => card._say('warning', card._problem()));
                setNote(t._saveNote, `Nothing was saved. Fix what is said on ${problems.map(card => card._title()).join(', ')} first.`, 'warning');
                return;
            }
            const settings = {
                providers: cards.map(card => card._read()),
                timeoutSecs: Number(t._timeout.value) || undefined,
                maxChars: Number(t._maxChars.value) || undefined,
            };
            // Read before saving, as saving also sends the new settings to every screen, this one included.
            const before = new Set((t._view?.providers || []).map(provider => provider.id));
            // Adding, discarding, and saving again wait for this save, which is of what was there when it began.
            t._saving = true;
            const edits = t._edits || 0;
            [t._save, t._discard, t._add].forEach(node => node.setAttribute('disabled', ''));
            let done = false;
            try {
                const view = await webui.proxy.ai.saveSettings(settings, err => {
                    setNote(t._saveNote, `Your providers weren't saved: ${err}`, 'danger');
                    return null;
                });
                if (!view) return;
                t._view = view;
                draft = null;
                done = true;
                if ((t._edits || 0) !== edits) {
                    // Changed while it saved: what was typed is kept, not drawn over, and each provider knows what it
                    // was saved as, so saving again updates it rather than adding another. Sent in order, they came
                    // back in order.
                    cards.forEach((card, index) => {
                        const savedAs = view.providers[index];
                        if (savedAs) card._provider = { ...savedAs, restored: true };
                    });
                    setNote(t._saveNote, 'Your providers are saved, but not the changes made while they were being saved. Choose Save Providers to keep those too.', 'warning');
                } else {
                    t.markClean('Your providers are saved.');
                    t.renderProviders();
                }
                // A server added just now lists its models, so they are ready to choose.
                view.providers.filter(provider => !before.has(provider.id) && provider.kind !== 'command' && !provider.models?.length)
                    .forEach(provider => webui.proxy.ai.refreshModels(provider.id).catch(err => {
                        // Drawing the providers again shows why, but would throw away changes made since saving.
                        if (!t._dirty) return t.load();
                        [...t._providers.querySelectorAll('.ai-provider')].find(card => card._provider.id === provider.id)?._showError?.(err);
                    }));
            } finally {
                t._saving = false;
                [t._discard, t._add].forEach(node => node.removeAttribute('disabled'));
                // Ready to try again after a save that failed, or to save what changed meanwhile.
                if (t._dirty || !done) t._save.removeAttribute('disabled');
            }
        },
    });
}
