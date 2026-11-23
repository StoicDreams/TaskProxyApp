/**
 * Stands in for the Rust backend, by providing window.__TAURI__ before the app starts.
 *
 * `state` can set:
 * - project: { name, path } to open, or null for none. Defaults to /repo.
 * - projects: the saved project list.
 * - files: { 'relative/path': 'contents' }, which get_project_file reads and save_project_file writes.
 * - binaryFiles: { 'relative/path': 'base64' }, files that are not text, which get_project_file cannot read.
 *   files and binaryFiles are also served at the file server addresses the file preview loads (see openApp).
 * - data, variables, navigation, docs, currentPage: fields of the open project.
 * - appData, appVariables: saved global values and their definitions.
 * - scripts: what get_scripts returns, and the open project's script files to make favorites from.
 * - otherProjectFiles: { projectPath: { file: contents } }, the files of saved projects that aren't open, which favorite
 *   scripts from those projects read.
 * - git.repoStatus: { repo: { changes, ahead, behind } } for the open project, which get_git_repo_status returns.
 *   Missing numbers are 0.
 * - gitStatus: { path: { changes, ahead, behind } } for each project, which get_project_git_status returns.
 *   Missing numbers are 0.
 * - ciStatus: { path: { state, service, url } } for each project, which get_project_ci_status returns.
 * - git.ciStatus: { repo: { state, service, url } } for the open project, which get_git_repo_ci_status returns.
 * - folderImport: the pages import_page_folder makes, as [{ name, content }] (default one page), and importSkipped
 *   the files it reports leaving out. fileImports: { path: segments } for what import_page_file returns.
 * - projectImagesByPath: { path: [images] } for saved projects that aren't open, as get_project_images lists them.
 * - projectFiles: what search_project_files returns. With holdSearch set, each search waits until the test calls
 *   window.__backend.releaseSearch(), so a test decides when a slow search arrives.
 * - git: { repos, changes, lineStats, branches, currentBranch, status, diffs }.
 * - hasKey: whether a security key exists. Defaults to true.
 * - pickedFolder, pickedFolders: what the folder dialog picks when adding projects. Default '/picked' and ['/one'].
 * - newInstall: leave out the saved settings an existing install has.
 * - interactive: whether scripts start in a terminal that takes input. Defaults to true.
 *   Script runs are kept as services/runs.rs keeps them, with the queue and output. Each script that starts is
 *   recorded as a `spawn_script` call, and spawn_script's handler says how it starts, or throws when it cannot.
 *   Tests play a script with window.__backend.runs.write({ projectId, terminalId, data }) and .end({ projectId,
 *   terminalId, code }). Stopping only marks a run stopped, so a test ends it as the script would.
 * - Commits are run as services/commit_queue.rs runs them: the script through the runs above, then the commit, then
 *   a sync when asked. Each git step is recorded as the call the window made before Rust ran commits: get_git_changes,
 *   git_commit, and git_sync, naming `project` only when it is not the open project, and their handlers answer it.
 * - runs: runs the backend already has when the window loads, as after a reload, as [{ terminalId, project (a path),
 *   output: [batches], code }]. A run with a code has ended.
 * - catalog: what plugin_catalog returns, or leave it out for a catalog that cannot be reached.
 *   catalogManifests: { id: manifest } for what plugin_install_catalog installs.
 * - plugins: what plugin_list returns, as [{ id, version, enabled, signed, manifest }].
 * - pluginPages: { 'plugin/page': node } for plugin_render. A missing page fails, as an unknown page does.
 * - pluginActions: { 'plugin/action': result } for plugin_action. A missing action fails.
 * - pluginSettings: { plugin: view } for plugin_settings, where view is { hasProject, signIn, settings, signIns }, or
 *   just the open project's settings, [{ key, label, help, secret, isSet, value }], with a sign-in when any is set.
 *   plugin_list's `configured` and `signIns` come from the plugin entry, so tests say how a plugin is set up; a
 *   plugin that does not say counts as set up for the open project. plugin_use_in_project sets both `used` and it.
 * - pickedFolder: the folder the folder picker returns, or null for none. pluginFolder: { manifest } it holds.
 * - branchCards: what plugin_branch_info returns, as [{ id, name, card }].
 * - pluginNotifications: what plugin_notifications returns, as [{ id, name, items }].
 * - processes: what list_processes lists, as [{ pid, parent, name, command, exe, folder, started, cpu, memory, status,
 *   ports, terminal, orphan, taskProxy, project }]. stop_process removes a process, and its children when asked,
 *   unless stopErrors: { pid: message } names it.
 * - myfi: { account } for the MyFi account the app is signed in to, as { id, displayName, offline }, or leave
 *   it out for signed out. myfi_sign_in_wait waits until a test calls window.__backend.myfi.approve(account) or
 *   .end(reason), or the app cancels. myfiStartError: why myfi_sign_in_start fails, when it should.
 * - remote: Remote Connections as remote/service.rs keeps it: { enabled, name, approved: [{ key, name, code, added,
 *   level, connected, route }], waiting: [{ key, name, code, asked }], refused, log, reachability, enableError,
 *   keepAwake, awakeError, current }. Turning it on needs a MyFi account. current is the key of the browser asking,
 *   for a test that runs the app as a remote browser. window.__backend.remote.ask(browser) adds a waiting browser, as
 *   one asking to connect would, and .changed(notice) sends remote-changed.
 *
 * - ai: AI providers as services/ai.rs keeps them: { providers: [{ id, name, kind, baseUrl, command, apiKey, models:
 *   [{ id, name }], hidden, limits: { modelId: { timeoutSecs, maxChars } }, lastError }] }. The window only ever
 *   gets keySet, never apiKey. ai_settings also sends some of services/ai.rs's suggested limits (aiSuggestions).
 *   aiOs: the operating system ai_settings says Task Proxy runs on, as Rust names it (default linux).
 *   aiReplies: { integration: text } for what ai_write and ai_review answer (default "Draft for {integration}").
 *   aiErrors: { integration: message } to fail one, with 'test' for ai_test, noted as the provider's lastError as
 *   services/ai.rs notes it. A provider that starts with a lastError keeps failing ai_test with it until it is saved
 *   set up another way. aiModels: { providerId: [models] } for ai_models, or a string
 *   to fail it. aiReviewBatches: how many ai-progress events a review sends before answering (default 1).
 *   importPlan: what plan_page_folder returns, as [{ file, title, subtitle, navPath, excerpt }].
 *
 * Page scripts are filled as services/page_scripts.rs fills them, from the page values the window sends, then the
 * backend's copies of the project's and global values. run_page_script refuses a project that appData does not trust.
 *
 * App and project data change through patches, as services/shared_data.rs applies them: window.__backend.appData
 * is the backend's copy of app data, and savedProjects[path] its copy of each project. Each patch is sent to every
 * screen as data-changed. window.__backend.otherScreen(scope, patch) sends one as if another screen made it.
 *
 * Other projects in `projects` start with empty data. Saved and synced project data is kept by path,
 * as the backend does, so switching projects and back returns what was saved.
 */
export function installBackend(page, state) {
    return page.addInitScript(setup, state);
}

/* Runs in the page, so it can use nothing from this module. The unit tests (tests/unit/support/app.mjs) run it too. */
export function setup(state) {
    const project = state.project === null ? null : (state.project || { name: 'Repo', path: '/repo' });
    const files = { ...(state.files || {}) };
    const binaryFiles = { ...(state.binaryFiles || {}) };
    const exportedFile = (bytes, options) => {
        const headers = options?.headers || {};
        const kind = headers['x-export-kind'];
        const text = kind === 'pdf' ? Array.from(bytes, byte => String.fromCharCode(byte)).join('') : new TextDecoder().decode(bytes);
        return { title: decodeURIComponent(headers['x-export-title'] || ''), kind, text };
    };
    let processes = JSON.parse(JSON.stringify(state.processes || []));
    const git = {
        repos: [''], changes: [], lineStats: [], branches: [{ name: 'main', isCurrent: true, updatedDate: '2026-01-01' }], currentBranch: 'main',
        status: { hasUpstream: true, upstreamName: 'origin/main', ahead: 0, behind: 0, remoteUrl: 'https://example.com/repo.git' },
        diffs: {}, ...(state.git || {}),
    };
    const projectData = project && {
        id: 'project-id', path: project.path, currentPage: state.currentPage || '/', docs: state.docs || [],
        navigation: state.navigation || [], variables: state.variables || [], data: state.data || {},
    };
    // Copies, as the backend keeps its own copy of what the app sends.
    const savedProjects = {};
    if (projectData) savedProjects[projectData.path] = projectData;
    const storeProject = data => {
        if (data && data.path) savedProjects[data.path] = JSON.parse(JSON.stringify(data));
    };
    const loadProject = ({ project: wanted } = {}) => {
        const path = wanted && wanted.path;
        if (!path) return projectData;
        savedProjects[path] ??= { id: `id-${path}`, path, currentPage: '/', docs: [], navigation: [], variables: [], data: {} };
        return JSON.parse(JSON.stringify(savedProjects[path]));
    };
    let plugins = JSON.parse(JSON.stringify(state.plugins || []));
    const pluginSettings = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(state.pluginSettings || {}))).map(([id, view]) => {
        if (!Array.isArray(view)) return [id, view];
        const used = view.some(setting => setting.isSet);
        return [id, { hasProject: true, signIn: used ? 'sign-in-1' : null, settings: view, signIns: used ? [{ id: 'sign-in-1', label: 'Saved sign-in', projects: 1 }] : [] }];
    }));
    const listeners = {};
    const copy = value => JSON.parse(JSON.stringify(value));
    // The open project, as the backend's CurrentProject, which get_project_data changes.
    let openProject = projectData;
    const projectIcons = { ...(state.projectIcons || {}) };
    const iconUri = path => path ? `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" data-path="${path}"/>`)}` : null;
    // As services/ai.rs refuses: a command provider runs in the project's folder, so only in a trusted project.
    const aiTrusted = model => {
        const provider = ai.providers.find(p => p.id === model?.provider);
        if (provider?.kind !== 'command' || !openProject?.path) return;
        if (!(appData?.data?.['app-trusted-projects'] || []).includes(openProject.path)) {
            throw `${provider.name} runs in the project's folder, and this project is not trusted to run its scripts yet.`;
        }
    };
    const emitEvent = (name, payload) => (listeners[name] || []).forEach(listener => listener({ payload }));
    // AI providers, as services/ai.rs keeps them. The window gets each provider's keySet, never its key.
    const ai = { next: 0, providers: [], ...JSON.parse(JSON.stringify(state.ai || {})) };
    // Some of the limits services/ai.rs suggests (SUGGESTIONS there), in its order, and its fallback.
    const aiSuggestions = [
        { matches: ['opus'], name: 'Claude Opus (1M tokens)', timeoutSecs: 420, maxChars: 300000 },
        { matches: ['sonnet'], name: 'Claude Sonnet (1M tokens)', timeoutSecs: 300, maxChars: 300000 },
        { matches: ['haiku'], name: 'Claude Haiku (1M tokens)', timeoutSecs: 180, maxChars: 200000 },
        { matches: ['qwen2.5', 'qwen2'], name: 'Qwen2.5 (32K tokens, on your computer)', timeoutSecs: 300, maxChars: 32000 },
        { matches: ['llama3.1', 'llama3.2', 'llama3.3'], name: 'Llama 3.1 and later (128K tokens, on your computer)', timeoutSecs: 300, maxChars: 32000 },
        { matches: ['llama3', 'llama-3'], name: 'Llama 3 (8K tokens, on your computer)', timeoutSecs: 300, maxChars: 12000 },
    ];
    const aiFallback = { matches: [], name: 'Other models', timeoutSecs: 120, maxChars: 40000 };
    // Each limit within what can be set, and models without any left out, as services/ai.rs saves them.
    const aiLimits = limits => Object.fromEntries(Object.entries(limits || {}).map(([model, set]) => {
        const kept = {};
        if (set?.timeoutSecs != null) kept.timeoutSecs = Math.min(3600, Math.max(10, set.timeoutSecs));
        if (set?.maxChars != null) kept.maxChars = Math.min(2000000, Math.max(2000, set.maxChars));
        return [model.trim(), kept];
    }).filter(([model, kept]) => model && Object.keys(kept).length));
    // Claude Code's command as services/ai.rs's claude_command writes it, and the one earlier releases wrote, which it
    // brings up to date as it reads the settings.
    const aiClaudeCommand = reads => `claude -p --setting-sources user --strict-mcp-config --permission-mode default --model {model} --tools "${reads ? 'Read,Grep,Glob' : ''}"`;
    const aiUpgradedCommand = command => {
        const old = `${command}`.trim().match(/^claude\s+-p(?:\s+--setting-sources\s+user\s+--strict-mcp-config)?\s+--model\s+\{model\}(?:\s+--disallowedTools\s+"([^"]*)")?$/);
        return old ? aiClaudeCommand(!`${old[1] || ''}`.split(',').some(tool => tool.trim() === 'Read')) : null;
    };
    // Providers as services/ai.rs stores them, whatever a test's fixture leaves out.
    ai.providers = ai.providers.map(provider => {
        const command = `${provider.command ?? ''}`.trim();
        return {
            ...provider,
            baseUrl: `${provider.baseUrl ?? ''}`.trim().replace(/\/+$/, ''),
            command: (provider.kind === 'command' && aiUpgradedCommand(command)) || command,
            apiKey: provider.apiKey ?? null,
            models: provider.models ?? [],
            hidden: provider.hidden ?? [],
            limits: provider.limits ?? {},
            lastError: provider.lastError ?? null,
        };
    });
    const aiDefaults = { shared: 'You are helping a developer inside Task Proxy.', git: 'Write a commit message.', review: 'Review the code.', pages: 'Write the page part.', scripts: 'Write the script.', markdown: 'Suggest pages.' };
    // Providers set up in a way that fails: those that start with a lastError, until saved set up another way.
    const aiFailing = Object.fromEntries(ai.providers.filter(p => p.lastError).map(p => [p.id, p.lastError]));
    // What a call to a provider did, noted as services/ai.rs's note_result notes it: its error, or none.
    const aiNote = (providerId, error) => {
        const provider = ai.providers.find(p => p.id === providerId);
        if (!provider || (provider.lastError ?? null) === (error ?? null)) return;
        provider.lastError = error ?? null;
        emitEvent('ai-settings-changed', aiView());
    };
    // Whether a PowerShell command has {model} inside single quotes, as model_in_single_quotes in services/ai.rs.
    const aiModelInSingleQuotes = command => {
        const single = c => /^['\u2018\u2019\u201a\u201b]$/.test(c ?? '');
        const double = c => /^["\u201c\u201d\u201e]$/.test(c ?? '');
        const chars = [...command];
        // As in Rust: a stack of quotes, where '' is outside quotes or inside $( ) or ( ), which ) ends.
        const stack = [''];
        for (let i = 0; i < chars.length; i++) {
            const c = chars[i];
            const quote = stack[stack.length - 1];
            if (quote === "'") {
                if (single(c)) {
                    if (single(chars[i + 1])) i++;
                    else stack.pop();
                } else if (chars.slice(i, i + 7).join('') === '{model}') return true;
            } else if (quote === '"') {
                if (c === '`') i++;
                else if (c === '$' && chars[i + 1] === '(') {
                    stack.push('');
                    i++;
                } else if (double(c)) {
                    if (double(chars[i + 1])) i++;
                    else stack.pop();
                }
            } else if (c === '`') {
                i++;
            } else if (c === '(') {
                stack.push('');
            } else if (c === ')' && stack.length > 1) {
                stack.pop();
            } else if (single(c)) {
                stack.push("'");
            } else if (double(c)) {
                stack.push('"');
            }
        }
        return false;
    };
    const aiView = () => ({
        providers: ai.providers.map(({ apiKey, ...provider }) => ({ ...copy(provider), keySet: !!apiKey })),
        suggestions: copy(aiSuggestions), fallback: copy(aiFallback), defaults: aiDefaults, os: state.aiOs || 'linux',
    });
    // Script runs, as services/runs.rs keeps them.
    const runs = {
        rev: 0,
        next: 0,
        projects: {},
        // Batch numbers for output to a terminal the backend never ran, which tests still send.
        unknownSeq: {},
        project(id) { return this.projects[id] ??= { terminals: {}, queue: [] }; },
        target(path) {
            if (!path || path === openProject?.path) {
                if (!openProject) throw 'Project not loaded.';
                const saved = (state.projects || (project ? [project] : [])).find(item => item.path === openProject.path);
                return { projectId: openProject.id, projectPath: openProject.path, projectName: saved?.name || openProject.path };
            }
            const saved = (state.projects || []).find(item => item.path === path);
            if (!saved) throw `${path} is not one of your projects.`;
            return { projectId: `id-${path}`, projectPath: path, projectName: saved.name || path };
        },
        id(projectId) { return projectId || openProject?.id || ''; },
        changed(entry) { emitEvent('run-changed', { projectId: entry.info.projectId, terminalId: entry.info.id, run: copy(entry.info) }); },
        update(entry, fields) {
            Object.assign(entry.info, fields, { rev: ++this.rev });
            this.changed(entry);
            return copy(entry.info);
        },
        running(projectId) { return Object.values(this.project(projectId).terminals).filter(entry => entry.info.status === 'Running'); },
        begin(target, args) {
            const id = args.terminalId;
            const cleared = this.project(target.projectId).terminals[id]?.info.cleared ?? 0;
            const entry = {
                info: {
                    id, name: id === 'live' ? 'Live Command' : id, ...target, status: 'Running', exitCode: null, stopped: false,
                    startedAt: Date.now(), endedAt: null, isPageScript: !!args.isPageScript, isLive: id === 'live',
                    script: args.displayScript ?? args.scriptContent, args: args.args || [], interactive: false,
                    run: ++this.next, rev: ++this.rev, cleared,
                },
                output: [],
                seq: 0,
            };
            this.project(target.projectId).terminals[id] = entry;
            this.changed(entry);
            return entry;
        },
        async launch(target, args, entry) {
            backend.calls.push({ command: 'spawn_script', args: copy({ ...args, project: args.project }) });
            let started;
            try {
                started = await backend.handlers.spawn_script(args);
            } catch (err) {
                this.write({ projectId: target.projectId, terminalId: entry.info.id, data: `\x1b[31m${err}\x1b[0m\r\n` });
                this.end({ projectId: target.projectId, terminalId: entry.info.id, code: null });
                throw err;
            }
            if (args.inSeparateWindow) {
                this.end({ projectId: target.projectId, terminalId: entry.info.id, code: null });
                return copy(entry.info);
            }
            return this.update(entry, { interactive: !!started?.interactive });
        },
        /** A script writes output. */
        write({ projectId, terminalId, data }) {
            projectId = this.id(projectId);
            const entry = this.project(projectId).terminals[terminalId];
            if (!entry) {
                const key = `${projectId}\0${terminalId}`;
                this.unknownSeq[key] = (this.unknownSeq[key] || 0) + 1;
                emitEvent('terminal-data', { projectId, terminalId, run: 0, seq: this.unknownSeq[key], data });
                return;
            }
            entry.output.push([++entry.seq, data]);
            emitEvent('terminal-data', { projectId, terminalId, run: entry.info.run, seq: entry.seq, data });
        },
        /** A script ends, with its exit code or null, and the next queued script in its project starts. */
        end({ projectId, terminalId, code }) {
            projectId = this.id(projectId);
            const entry = this.project(projectId).terminals[terminalId];
            if (entry?.info.status === 'Running') {
                const info = this.update(entry, { status: 'Finished', exitCode: Number.isInteger(code) ? code : null, endedAt: Date.now() });
                (this.waiters[info.run] || []).forEach(resolve => resolve(info));
                delete this.waiters[info.run];
            }
            this.runQueued(projectId);
        },
        runQueued(projectId) {
            const projectRuns = this.project(projectId);
            if (this.running(projectId).length) return;
            const next = projectRuns.queue.shift();
            if (!next) return;
            const entry = this.begin(next.target, next.args);
            this.launch(next.target, next.args, entry).catch(() => { });
        },
        stop(projectId, terminalId) {
            const entry = this.project(projectId).terminals[terminalId];
            if (entry?.info.status === 'Running') this.update(entry, { stopped: true });
        },
        waiters: {},
        /** Runs a script now and resolves with its run once it ends, as run_and_wait does. */
        async runAndWait(target, args) {
            if (this.project(target.projectId).terminals[args.terminalId]?.info.status === 'Running') {
                throw 'Script is already running. You can manage it in the Terminal Manager.';
            }
            const entry = this.begin(target, args);
            const ended = new Promise(resolve => (this.waiters[entry.info.run] ??= []).push(resolve));
            await this.launch(target, args, entry);
            return ended;
        },
    };
    // Searches wait on this when the state sets holdSearch, until a test calls backend.releaseSearch().
    let releaseSearch;
    const searchHeld = new Promise(resolve => { releaseSearch = resolve; });
    // Commit jobs, as services/commit_queue.rs runs them.
    const commits = {
        rev: 0,
        next: 0,
        jobs: [],
        queue: [],
        busy: false,
        finished: [],
        shown(job) {
            const shown = copy(job);
            if (shown.script) delete shown.script.content;
            return shown;
        },
        snapshot() {
            const active = this.jobs.filter(job => !this.queue.includes(job.id)).map(job => this.shown(job));
            this.queue.forEach((id, index) => {
                const job = this.jobs.find(item => item.id === id);
                if (job) active.push({ ...this.shown(job), place: index + 1, ahead: index + (this.busy ? 1 : 0) });
            });
            return { rev: this.rev, active, finished: this.finished.map(job => this.shown(job)) };
        },
        emit() {
            this.rev++;
            emitEvent('commit-jobs-changed', this.snapshot());
        },
        set(job, fields) {
            Object.assign(job, fields);
            this.emit();
        },
        step(command, args) {
            backend.calls.push({ command, args: copy(args) });
            return backend.handlers[command](args);
        },
        projectArg(job) { return job.projectPath !== openProject?.path ? { project: job.projectPath } : {}; },
        changeName(line) {
            if (!line || line.length < 3) return null;
            const name = line.substring(3).trim();
            return line.substring(0, 2).includes('R') && name.includes(' -> ') ? name.split(' -> ')[1] : name;
        },
        async changes(job) {
            const lines = await this.step('get_git_changes', { path: job.repo, ...this.projectArg(job) });
            return (lines || []).map(line => this.changeName(line)).filter(Boolean);
        },
        outcome: (state, text, theme) => ({ state, text, theme }),
        async run(job) {
            if (job.script) {
                this.set(job, { state: 'script', note: { text: `Running ${job.script.path} before committing...`, theme: 'info' } });
                const target = runs.target(job.projectPath);
                let ended;
                try {
                    ended = await runs.runAndWait(target, { terminalId: 'Before Commit', scriptContent: job.script.content, args: [], inSeparateWindow: false, ...this.projectArg(job) });
                } catch (err) {
                    return [this.outcome('Failed', `${job.script.path} could not run, so nothing was committed: ${err}`, 'danger'), false];
                }
                if (ended.stopped || ended.exitCode !== 0) {
                    const how = !ended.stopped && Number.isInteger(ended.exitCode) ? `failed with exit code ${ended.exitCode}` : 'was stopped';
                    return [this.outcome('Failed', `${job.script.path} ${how}, so nothing was committed. Its output is in the Terminals panel.`, 'danger'), false];
                }
            }
            this.set(job, { state: 'committing' });
            let changed;
            try {
                changed = await this.changes(job);
            } catch (err) {
                return [this.outcome('Failed', `${err} Nothing was committed.`, 'danger'), false];
            }
            // As commit_queue.rs: every changed file but the excluded and ignored ones, listed or not.
            const files = changed.filter(name => !job.ignored.includes(`${job.repo}/${name}`) && !job.excluded.includes(name));
            if (!files.length) return [this.outcome('Failed', 'No files are left to commit.', 'warning'), false];
            let result;
            try {
                result = await this.step('git_commit', { repo: job.repo, files, message: job.message, ...this.projectArg(job) });
            } catch (err) {
                return [this.outcome('Failed', `${err}`, 'danger'), false];
            }
            if (!job.syncAfter) return [this.outcome('Committed', result, 'success'), true];
            this.set(job, { note: { text: 'Commit successful. Syncing with remote...', theme: 'info' } });
            try {
                await this.step('git_sync', { repo: job.repo, ...this.projectArg(job) });
                return [this.outcome('Committed', 'Commit and Sync successful!', 'success'), true];
            } catch (err) {
                return [this.outcome('Committed, not synced', `${result} Syncing failed, so sync it from the Git Controller: ${err}`, 'danger'), true];
            }
        },
        finish(job, outcome, committed) {
            this.jobs = this.jobs.filter(item => item !== job);
            this.queue = this.queue.filter(id => id !== job.id);
            Object.assign(job, { state: 'finished', outcome, committed, endedAt: Date.now(), place: null, ahead: null });
            this.finished.unshift(job);
            this.finished.length = Math.min(this.finished.length, 20);
            this.emit();
        },
        async process(job) {
            const [outcome, committed] = await this.run(job);
            this.finish(job, outcome, committed);
        },
        async work() {
            while (!this.busy && this.queue.length) {
                this.busy = true;
                const job = this.jobs.find(item => item.id === this.queue.shift());
                this.emit();
                if (job) await this.process(job);
                this.busy = false;
            }
        },
    };
    for (const run of state.runs || []) {
        const target = runs.target(run.project);
        const entry = runs.begin(target, { terminalId: run.terminalId, scriptContent: run.script || '', args: [] });
        (run.output || []).forEach(data => entry.output.push([++entry.seq, data]));
        entry.info.interactive = true;
        if ('code' in run) Object.assign(entry.info, { status: 'Finished', exitCode: run.code, endedAt: Date.now() });
    }
    const remote = {
        enabled: !!state.remote?.enabled,
        name: state.remote?.name ?? 'Desk PC',
        approved: (state.remote?.approved || []).map(browser => ({ added: 1, level: 'view', connected: false, route: null, ...browser })),
        waiting: (state.remote?.waiting || []).map(browser => ({ asked: 1, ...browser })),
        refused: state.remote?.refused || [],
        log: state.remote?.log || [],
        keepAwake: state.remote?.keepAwake ?? true,
        awakeError: state.remote?.awakeError ?? null,
        reachability: state.remote?.reachability || { reachable: !!state.remote?.enabled, error: null },
        status() {
            return {
                enabled: this.enabled,
                name: this.name,
                desktopId: this.enabled ? 'b1c2d3e4-0000-4000-8000-000000000001' : null,
                reachability: this.reachability,
                approved: this.approved.map(browser => ({ ...browser })),
                waiting: this.waiting.map(browser => ({ ...browser })),
                refused: this.refused.map(browser => ({ ...browser })),
                keepAwake: this.keepAwake,
                awake: this.enabled && this.keepAwake && !this.awakeError,
                awakeError: this.enabled && this.keepAwake ? this.awakeError : null,
            };
        },
        /** The lists as remote_browsers gives them. */
        lists() {
            return {
                approved: this.approved.map(({ key, name, code, added }) => ({ key, name, code, added, current: key === state.remote?.current })),
                waiting: this.waiting.map(({ key, name, code, asked }) => ({ key, name, code, asked })),
            };
        },
        changed(notice) {
            emitEvent('remote-changed', { notice: notice || null });
        },
        /** A browser asks to connect, as one would through api.myfi.ws. */
        ask(browser) {
            this.waiting.push({ asked: Date.now(), ...browser });
            this.changed({ text: `${browser.name} is asking to connect to this computer. Check its code in Settings, under Remote Connections.`, severity: 'info' });
        },
        approved_one(key) {
            const browser = this.approved.find(browser => browser.key === key);
            if (!browser) throw 'No such browser.';
            return browser;
        },
    };
    const myfi = {
        account: state.myfi?.account ? { offline: false, ...state.myfi.account } : null,
        waiting: null,
        approve(account) {
            this.account = { offline: false, ...account };
            this.waiting?.resolve(this.account);
            this.waiting = null;
        },
        end(reason) {
            this.waiting?.reject(reason);
            this.waiting = null;
        },
    };
    // The backend's copy of app data, made when the app first reads it.
    let appData = null;
    let dataRev = 0;
    const applyDataPatch = (target, patch) => {
        target.data ??= {};
        (patch.remove || []).forEach(key => delete target.data[key]);
        Object.entries(patch.set || {}).forEach(([key, value]) => { target.data[key] = copy(value); });
        Object.entries(patch.fields || {}).forEach(([key, value]) => { if (!['data', 'id', 'path'].includes(key)) target[key] = copy(value); });
    };
    /** A page's PowerShell blocks, each named by the last line of text above it, as services/favorites.rs finds them. */
    const favoriteBlocks = markdown => {
        const blocks = [];
        let last = 0;
        for (const found of markdown.matchAll(/```(?:powershell|pwsh|ps1)\b[^\n]*\n([\s\S]*?)```/gi)) {
            const before = markdown.substring(last, found.index).replace(/<[^>]+>/g, '').replace(/[#*`_>]/g, '');
            const lines = before.split('\n').map(line => line.trim()).filter(Boolean);
            blocks.push({ text: found[1], label: lines.at(-1) || '' });
            last = found.index + found[0].length;
        }
        return blocks;
    };
    /** A favorite's script, from the open project's files or, for another saved project, `otherProjectFiles`. */
    const favoriteSource = (path, source) => {
        const own = openProject && path.toLowerCase() === openProject.path.toLowerCase() ? files : (state.otherProjectFiles?.[path] || {});
        if (source.kind === 'file') {
            if (!(source.path in own)) throw 'Get Project File: File not found';
            return own[source.path];
        }
        const markdown = own[`.taskproxy/pages/${source.page}.md`];
        if (markdown === undefined) throw "This favorite's page is gone. Choose the script again from another page.";
        const blocks = favoriteBlocks(markdown);
        const same = blocks.filter(block => block.text === source.text);
        const block = blocks[source.index]?.text === source.text ? blocks[source.index]
            : same.length === 1 ? same[0]
                : (source.count == null || source.count === blocks.length) ? blocks[source.index] : undefined;
        if (!block) throw "This favorite's script is no longer on its page. Open the page, and choose the script again.";
        return block.text;
    };
    // Filling page scripts, as services/page_scripts.rs does. Rust's tests hold the cases.
    const pageScripts = {
        toSnake: (text, sep) => text.trim().replace(/[A-Z]/g, c => `${sep}${c.toLowerCase()}`).replace(/[-_ ]+/g, sep),
        neverFilled(name) {
            return ['git_pat', 'github_pat'].includes(name) || /^(app|session|page)-/.test(this.toSnake(name, '-'));
        },
        enabled: (global, key) => !(key in global) || !!global[key],
        lookup(name, page, project, global) {
            if (this.neverFilled(name)) return undefined;
            const isMarker = value => !!value && typeof value === 'object' && value.$secret === true;
            if (this.enabled(global, 'app-env-page-enabled') && name in page && !isMarker(page[name])) return page[name];
            if (this.enabled(global, 'app-env-project-enabled') && name in project) return project[name];
            return this.enabled(global, 'app-env-global-enabled') ? global[name] : undefined;
        },
        variables(script) {
            const names = [];
            for (const match of script.matchAll(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
                if (['null', 'true', 'false', '_'].includes(match[1].toLowerCase()) || names.includes(match[1])) continue;
                names.push(match[1]);
            }
            return names;
        },
        fill(script, pageValues, masked) {
            const project = savedProjects[openProject?.path]?.data || {};
            const global = appData?.data || {};
            let filled = script;
            this.variables(script).forEach(name => {
                const raw = this.lookup(name, pageValues || {}, project, global);
                if (raw === undefined || raw === null || raw === '' || typeof raw === 'object') return;
                const val = String(raw);
                const quoted = new RegExp(`(\\$${name}\\s*=\\s*)('(?:[^']|'')*'|"(?:[^"\`]|\`[\\s\\S]|"")*")`, 'gi');
                const unquoted = new RegExp(`(\\$${name}\\s*=\\s*)([^'"\\s][^\\n\\r]*)`, 'gi');
                filled = filled.replace(quoted, (match, prefix, old) => {
                    const quote = old[0];
                    let text = val;
                    if (masked) {
                        if (text.length > 6) text = `${text.substring(0, 3)}***${text.substring(text.length - 3)}`;
                    } else if (quote === "'") {
                        text = text.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&');
                    } else {
                        text = text.replace(/[`$"\u201C\u201D\u201E]/g, '`$&');
                    }
                    return `${prefix}${quote}${text}${quote}`;
                });
                filled = filled.replace(unquoted, (match, prefix) => {
                    if (val.trim() !== '' && Number.isFinite(Number(val))) return `${prefix}${Number(val)}`;
                    if (val.toLowerCase() === 'true' || val.toLowerCase() === 'false') return `${prefix}$${val.toLowerCase()}`;
                    return masked ? `${prefix}[INVALID TYPE]` : match;
                });
            });
            return filled;
        },
    };
    const backend = {
        calls: [],
        get appData() { return appData; },
        /** How many listeners the window has for an event. */
        listening: name => (listeners[name] || []).length,
        /** Another screen changes app or project data: `patch` is { set, remove, fields }. */
        otherScreen(scope, patch) {
            if (scope === 'app') applyDataPatch(appData, patch);
            else applyDataPatch(savedProjects[openProject.path], patch);
            emitEvent('data-changed', { scope, id: scope === 'app' ? '' : openProject.id, rev: ++dataRev, screen: 'other-screen', set: {}, remove: [], fields: {}, ...patch });
        },
        myfi,
        remote,
        runs,
        commits,
        /** Lets searches held by the state's holdSearch answer, now and from now on. */
        releaseSearch: () => releaseSearch(),
        files,
        git,
        projectData,
        savedProjects,
        emit: emitEvent,
        handlers: {
            get_app_data: () => appData ? copy(appData) : copy(appData = {
                isSaved: true, saveIntervalMinutes: 20, variables: state.appVariables || [],
                data: {
                    ...(state.newInstall ? {} : { 'app-env-page-enabled': true, 'app-env-project-enabled': true, 'app-env-global-enabled': true }),
                    ...(project ? { 'app-current-project': { value: project.path, display: project.name } } : {}),
                    ...(state.appData || {}),
                },
            }),
            patch_app_data: ({ patch, screen }) => {
                applyDataPatch(appData, patch);
                emitEvent('data-changed', { scope: 'app', id: '', rev: ++dataRev, screen, set: {}, remove: [], fields: {}, ...copy(patch) });
                return dataRev;
            },
            patch_project_data: ({ id, patch, screen }) => {
                const saved = openProject && savedProjects[openProject.path];
                if (!saved || saved.id !== id) return 0;
                applyDataPatch(saved, patch);
                emitEvent('data-changed', { scope: 'project', id, rev: ++dataRev, screen, set: {}, remove: [], fields: {}, ...copy(patch) });
                return dataRev;
            },
            get_version: () => '1.2.3',
            has_securitykey: () => state.hasKey !== false,
            set_securitykey: () => { state.hasKey = true; return 'Security Key Saved!'; },
            delete_securitykey: () => { state.hasKey = false; return 'Security Key Deleted!'; },
            save_app_data: ({ data } = {}) => { if (data) appData = copy(data); return 'app data saved'; },
            // Project icons (services/project_icons.rs). projectIcons: { [path]: icon path }, projectImages: the open
            // project's images. An icon is sent back as a data URI made from its path.
            get_project_icons: () => (state.projects || (project ? [project] : [])).map(item => ({ path: item.path, icon: iconUri(projectIcons[item.path]) })),
            // A saved project named by `project` has its images in projectImagesByPath; the open project's are projectImages.
            get_project_images: ({ project: path } = {}) => {
                const target = path ?? openProject?.path;
                const images = path ? (state.projectImagesByPath?.[path] || []) : (state.projectImages || []);
                return { images, icon: projectIcons[target] ?? null };
            },
            set_project_icon: ({ icon, project: path }) => {
                const target = path ?? openProject.path;
                const images = path ? (state.projectImagesByPath?.[path] || []) : (state.projectImages || []);
                if (icon && !images.includes(icon)) throw `The project has no file '${icon}'.`;
                if (icon) projectIcons[target] = icon;
                else delete projectIcons[target];
                return iconUri(icon);
            },
            load_projects: () => state.projects || (project ? [project] : []),
            get_projects: () => state.projects || (project ? [project] : []),
            get_project_data: args => {
                // A copy, as the window's changes reach the backend only through patches and saves.
                const found = loadProject(args);
                const loaded = found ? copy(found) : found;
                openProject = loaded;
                return loaded;
            },
            save_project_data: ({ data } = {}) => { storeProject(data); return 'Project data saved'; },
            clear_current_project: () => { openProject = null; return 'Project closed'; },
            reload_project_files: () => projectData,
            rename_project: () => 'Project Successfully Renamed',
            remove_project: ({ path }) => {
                const known = state.projects || (project ? [project] : []);
                const kept = known.filter(item => item.path.toLowerCase() !== `${path}`.replace(/\\/g, '/').toLowerCase());
                if (kept.length === known.length) throw 'Project not found.';
                state.projects = kept;
                return 'Project Successfully Removed';
            },
            // The folder dialog picks pickedFolder ('/picked' unless set), or pickedFolders for several.
            add_project: ({ name }) => {
                const path = state.pickedFolder || '/picked';
                const known = state.projects || (project ? [project] : []);
                const named = `${name || ''}`.trim() || path.split('/').filter(Boolean).pop();
                if (!named) throw 'Could not determine project name from folder.';
                if (known.some(item => item.path.toLowerCase() === path.toLowerCase())) throw 'The selected folder is already used by an existing project.';
                if (known.some(item => item.name.toLowerCase() === named.toLowerCase())) throw 'A project with this name already exists. Please choose a different name or folder.';
                state.projects = [...known, { name: named, path }].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
                return 'Project Successfully Added';
            },
            add_projects_multi: () => {
                const known = state.projects || (project ? [project] : []);
                const results = [];
                (state.pickedFolders || ['/one']).forEach(path => {
                    const named = path.split('/').filter(Boolean).pop();
                    if (known.some(item => item.path.toLowerCase() === path.toLowerCase())) results.push(`Skipped '${named}': Folder already used.`);
                    else { known.push({ name: named, path }); results.push(`Added '${named}'`); }
                });
                state.projects = [...known].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
                return results;
            },
            get_project_file: ({ filePath }) => {
                if (filePath in binaryFiles) throw 'Failed to load file: stream did not contain valid UTF-8';
                if (filePath in files) return files[filePath];
                throw 'Get Project File: File not found';
            },
            // openApp serves this address from files and binaryFiles, as the backend's file server does.
            get_file_server_base: () => 'http://files.localhost/token',
            // The system clipboard, as Rust's copy commands leave it: the last image's bytes, or the address downloaded.
            // Recorded as openUrl too, as the opener plugin's calls were, so tests check what was opened either way.
            open_url: ({ url }) => { backend.calls.push({ command: 'openUrl', args: { url } }); },
            copy_image: bytes => { backend.clipboard = { bytes: [...bytes] }; },
            copy_image_url: ({ url }) => { backend.clipboard = { url }; },
            copy_text: ({ text }) => { backend.clipboard = { text }; },
            copy_html: ({ html, text }) => { backend.clipboard = { html, text }; },
            // An exported page, as services/page_export.rs gets it: its text (a PDF's too, as Latin-1), title, and kind.
            // Saving answers with the file's name, or with exportSaveAnswer, such as null for a save dialog cancelled.
            export_save: (bytes, options) => {
                backend.exported = exportedFile(bytes, options);
                return 'exportSaveAnswer' in backend ? backend.exportSaveAnswer : `${backend.exported.title || 'Page'}.${backend.exported.kind}`;
            },
            export_copy_file: (bytes, options) => { backend.clipboard = { file: exportedFile(bytes, options) }; },
            get_project_file_size: ({ filePath }) => {
                if (filePath in binaryFiles) return atob(binaryFiles[filePath]).length;
                if (filePath in files) return new TextEncoder().encode(files[filePath]).length;
                throw 'Get Project File: File not found';
            },
            // Folder imports add one page per entry of state.folderImport (default one page), as page_import.rs would.
            import_page_folder: ({ folder, parent, navigation }) => {
                const pages = (state.folderImport || [{ name: 'Imported', content: '# Imported' }]).map((page, index) => {
                    const url = `/imported-${index}`;
                    files[`.taskproxy/pages/imported-${index}.md`] = page.content;
                    return { name: page.name, icon: 'file', url, children: null };
                });
                const items = parent ? [{ name: parent, icon: 'folder', url: null, children: pages }] : pages;
                return { navigation: [...(navigation || []), ...items], pages: pages.length, skipped: state.importSkipped || [] };
            },
            plan_page_folder: () => copy(state.importPlan || []),
            ai_settings: () => aiView(),
            ai_save_settings: ({ settings }) => {
                // Checked before anything is built, so a refused save uses up no ids, as in services/ai.rs.
                const items = settings.providers || [];
                const ids = new Set();
                for (const item of items) {
                    const name = item.name?.trim();
                    if (!name) throw 'Each AI provider needs a name.';
                    if (item.id) {
                        if (ids.has(item.id)) throw `The AI provider ${name} is listed twice.`;
                        ids.add(item.id);
                    }
                    const command = (item.command || '').trim();
                    if (item.kind === 'openAi' && !(item.baseUrl || '').trim()) throw `${name} needs its server's address.`;
                    if (item.kind === 'command' && !command) throw `${name} needs the command to run.`;
                    if (item.kind === 'command' && aiModelInSingleQuotes(command)) {
                        throw `${name}'s command has {model} in single quotes. Leave the quotes out, or use double quotes: the model is always passed as one word.`;
                    }
                    if (item.kind === 'command') {
                        const saved = ai.providers.find(p => item.id && p.id === item.id);
                        const models = (item.models ?? saved?.models ?? []).filter(model => `${model.id ?? ''}`.trim());
                        if (!models.length) throw `${name} needs at least one model.`;
                    }
                }
                ai.providers = items.map(item => {
                    const saved = ai.providers.find(p => item.id && p.id === item.id);
                    const baseUrl = (item.baseUrl || '').trim().replace(/\/+$/, '');
                    const typed = (item.command || '').trim();
                    const command = (item.kind === 'command' && aiUpgradedCommand(typed)) || typed;
                    const sameServer = saved && saved.kind === item.kind && saved.baseUrl === baseUrl;
                    const apiKey = item.apiKey === undefined ? (sameServer ? saved.apiKey : null) : (item.apiKey?.trim() || null);
                    // What failed last is kept while the provider is set up the same way.
                    const sameSetup = sameServer && saved.command === command && (saved.apiKey ?? null) === (apiKey ?? null);
                    if (!sameSetup && saved) delete aiFailing[saved.id];
                    return {
                        id: item.id || `provider-${++ai.next}`, name: item.name.trim(), kind: item.kind, baseUrl,
                        command, apiKey, models: item.models ?? saved?.models ?? [], hidden: item.hidden || [],
                        limits: aiLimits(item.limits ?? saved?.limits),
                        lastError: sameSetup ? saved.lastError ?? null : null,
                    };
                });
                emitEvent('ai-settings-changed', aiView());
                return aiView();
            },
            ai_models: ({ providerId }) => {
                const provider = ai.providers.find(p => p.id === providerId);
                if (!provider) throw 'That AI provider was removed.';
                const listed = (state.aiModels || {})[providerId];
                if (typeof listed === 'string') {
                    aiNote(provider.id, listed);
                    throw listed;
                }
                provider.models = copy(listed || provider.models);
                // As services/ai.rs, which sends the settings whether or not its error changed.
                provider.lastError = null;
                emitEvent('ai-settings-changed', aiView());
                return aiView();
            },
            ai_test: ({ model }) => {
                const provider = ai.providers.find(p => p.id === model.provider);
                if (!provider) throw "That AI provider isn't set up any more. Choose another model.";
                const error = (state.aiErrors || {}).test ?? aiFailing[provider.id];
                aiNote(provider.id, error);
                if (error) throw error;
                return 'Task Proxy can reach me.';
            },
            ai_write: ({ request }) => {
                if (!ai.providers.some(p => p.id === request.model?.provider)) throw "That AI provider isn't set up any more. Choose another model.";
                aiTrusted(request.model);
                if (request.integration === 'git' && !request.files?.length) throw 'Include at least one file to write a commit message for.';
                const error = (state.aiErrors || {})[request.integration];
                aiNote(request.model.provider, error);
                if (error) throw error;
                return (state.aiReplies || {})[request.integration] ?? `Draft for ${request.integration}`;
            },
            ai_review: async ({ request }) => {
                if (!ai.providers.some(p => p.id === request.model?.provider)) throw "That AI provider isn't set up any more. Choose another model.";
                aiTrusted(request.model);
                const error = (state.aiErrors || {}).review;
                aiNote(request.model.provider, error);
                if (error) throw error;
                const total = state.aiReviewBatches || 1;
                for (let done = 0; done < total; done++) emitEvent('ai-progress', { requestId: request.requestId, done, total });
                return (state.aiReplies || {}).review ?? 'Draft for review';
            },
            ai_cancel: () => true,
            // The page segments page_import.rs would make of a file, from state.fileImports.
            import_page_file: ({ file }) => {
                if (state.fileImports && file in state.fileImports) return state.fileImports[file];
                throw `Import Failed: The project has no file '${file}'.`;
            },
            save_project_file: ({ filePath, contents }) => {
                files[filePath] = contents;
                return 'File saved';
            },
            search_project_files: async () => {
                if (state.holdSearch) await searchHeld;
                return state.projectFiles || [];
            },
            get_scripts: () => state.scripts || [],
            commit_enqueue: args => {
                const target = runs.target(args.project);
                if (commits.jobs.some(job => job.projectPath === target.projectPath && job.repo === args.repo)) {
                    throw 'This repo already has a commit waiting or running.';
                }
                const job = {
                    id: `job-${++commits.next}`, ...target, repo: args.repo, message: `${args.message}`.trim(), files: args.files,
                    excluded: args.excluded || [], ignored: args.ignored || [], syncAfter: !!args.syncAfter, script: args.script ? copy(args.script) : null,
                    state: 'queued', queued: !!args.queue, place: null, ahead: null, note: null, outcome: null, committed: false,
                    createdAt: Date.now(), endedAt: null,
                };
                commits.jobs.push(job);
                if (args.queue) commits.queue.push(job.id);
                commits.emit();
                if (args.queue) commits.work();
                else commits.process(job);
                return commits.shown(job);
            },
            commit_jobs: () => commits.snapshot(),
            page_script_preview: ({ script, pageValues }) => pageScripts.fill(script, pageValues, true),
            // Favorite scripts, as services/favorites.rs finds and runs them. Rust's tests hold how values are filled.
            // What this computer offers for limiting scripts (services/performance.rs). performance overrides it.
            script_performance_info: () => ({ threads: 12, canLimitThreads: true, hasIdlePriority: true, ...(state.performance || {}) }),
            favorite_candidates: ({ page }) => {
                if (!openProject) throw 'Open a project to add its scripts.';
                const markdown = page ? files[`.taskproxy/pages/${page}.md`] : undefined;
                return { project: openProject.path, page: page || null, blocks: markdown === undefined ? [] : favoriteBlocks(markdown), files: [...(state.scripts || [])].sort() };
            },
            favorite_script: ({ project, source }) => favoriteSource(project, source),
            run_favorite: async ({ favorite }) => {
                const saved = (state.projects || (project ? [project] : [])).find(item => item.path.toLowerCase() === `${favorite.project}`.toLowerCase());
                if (!saved) throw `${favorite.project} is not one of your projects any more.`;
                if (!(appData?.data?.['app-trusted-projects'] || []).includes(saved.path)) {
                    throw `${saved.name} is not trusted to run its scripts yet. Open it and run one of its scripts to trust it.`;
                }
                const script = favoriteSource(saved.path, favorite.source);
                const target = runs.target(saved.path);
                const isFile = favorite.source.kind === 'file';
                const args = {
                    terminalId: isFile ? favorite.source.path : `Favorite: ${favorite.name}`, scriptContent: script, args: [],
                    inSeparateWindow: false, isPageScript: !isFile, displayScript: isFile ? null : script,
                };
                const entry = runs.begin(target, args);
                return runs.launch(target, args, entry);
            },
            run_page_script: async ({ terminalId, script, pageValues }) => {
                if (!openProject) throw 'Project not loaded.';
                if (!(appData?.data?.['app-trusted-projects'] || []).includes(openProject.path)) {
                    throw 'This project is not trusted to run its scripts yet.';
                }
                const target = runs.target();
                if (runs.project(target.projectId).terminals[terminalId]?.info.status === 'Running') {
                    throw 'Script is already running. You can manage it in the Terminal Manager.';
                }
                const args = {
                    terminalId, scriptContent: pageScripts.fill(script, pageValues, false), args: [], inSeparateWindow: false,
                    isPageScript: true, displayScript: pageScripts.fill(script, pageValues, true),
                };
                const entry = runs.begin(target, args);
                return runs.launch(target, args, entry);
            },
            commit_cancel: ({ id }) => {
                const job = commits.jobs.find(item => item.id === id);
                if (!job) return false;
                if (job.state === 'script') {
                    runs.stop(job.projectId, 'Before Commit');
                    return true;
                }
                if (job.state !== 'queued' || !commits.queue.includes(id)) return false;
                commits.finish(job, commits.outcome('Cancelled', 'Taken out of the queue.', 'info'), false);
                return true;
            },
            // Not a command: how the backend starts a script for run_script. Throw for a script that cannot start.
            spawn_script: () => ({ message: 'Script started', interactive: state.interactive !== false }),
            run_script: async args => {
                const target = runs.target(args.project);
                const projectRuns = runs.project(target.projectId);
                if (projectRuns.terminals[args.terminalId]?.info.status === 'Running') {
                    throw 'Script is already running. You can manage it in the Terminal Manager.';
                }
                if (args.queue && runs.running(target.projectId).length) {
                    projectRuns.queue.push({ target, args: copy(args) });
                    return { result: 'Queued', run: null };
                }
                const entry = runs.begin(target, args);
                return { result: 'Started', run: await runs.launch(target, args, entry) };
            },
            get_runs: () => Object.values(runs.projects).flatMap(item => Object.values(item.terminals).map(entry => copy(entry.info))),
            get_run_output: ({ terminalId, projectId, run, since }) => {
                const entry = runs.project(runs.id(projectId)).terminals[terminalId];
                if (!entry) return null;
                const from = run === entry.info.run && Number.isInteger(since) ? since : null;
                const first = entry.output[0]?.[0] ?? entry.seq + 1;
                const reset = from === null || from + 1 < first;
                const data = entry.output.filter(([seq]) => reset || seq > from).map(([, text]) => text).join('');
                return { run: entry.info.run, seq: entry.seq, data, reset };
            },
            stop_run: ({ terminalId, projectId }) => { runs.stop(runs.id(projectId), terminalId); return null; },
            write_terminal_input: ({ terminalId, data, projectId }) => {
                if (`${data}`.includes('\x03')) runs.stop(runs.id(projectId), terminalId);
                return null;
            },
            resize_terminal: () => null,
            kill_all_scripts: () => {
                const projectId = runs.id();
                runs.project(projectId).queue = [];
                runs.running(projectId).forEach(entry => runs.stop(projectId, entry.info.id));
                return 'All processes killed';
            },
            clear_run_output: ({ terminalId, projectId }) => {
                const entry = runs.project(runs.id(projectId)).terminals[terminalId];
                if (!entry) return null;
                entry.output = [];
                runs.update(entry, { cleared: entry.info.cleared + 1 });
                return null;
            },
            remove_run: ({ terminalId, projectId }) => {
                projectId = runs.id(projectId);
                const entry = runs.project(projectId).terminals[terminalId];
                if (!entry || terminalId === 'live' || entry.info.status === 'Running') return false;
                delete runs.project(projectId).terminals[terminalId];
                emitEvent('run-changed', { projectId, terminalId, run: null });
                return true;
            },
            remove_finished_page_scripts: () => {
                const projectId = runs.id();
                const terminals = runs.project(projectId).terminals;
                const ids = Object.keys(terminals).filter(id => terminals[id].info.isPageScript && terminals[id].info.status !== 'Running');
                ids.forEach(id => {
                    delete terminals[id];
                    emitEvent('run-changed', { projectId, terminalId: id, run: null });
                });
                return ids.length;
            },
            list_processes: ({ ports }) => ({
                processes: processes.map(process => ({ ...process, ports: ports ? process.ports || [] : [] })),
                cpuCount: 8, cpu: 12.5, memoryTotal: 16 * 1024 ** 3, memoryUsed: 6 * 1024 ** 3, portsRead: !!ports,
            }),
            stop_process: ({ pid, children }) => {
                const error = (state.stopErrors || {})[pid];
                if (error) throw error;
                const gone = new Set([pid]);
                for (let grew = children; grew;) {
                    grew = false;
                    processes.forEach(process => {
                        if (!gone.has(process.pid) && gone.has(process.parent)) { gone.add(process.pid); grew = true; }
                    });
                }
                processes = processes.filter(process => !gone.has(process.pid));
                return `Asked to stop ${pid}.`;
            },
            close_task_manager: () => null,
            get_powershell_status: () => state.powershell || { installed: true, executable: 'pwsh', canAutoInstall: false, installCommand: '', instructions: '' },
            auto_install_powershell: () => 'PowerShell installed successfully.',
            init_emoji_search: () => 'Initialized',
            search_emojis: () => [],
            check_update: () => false,
            install_update: () => 'App is up to date.',
            get_git_repos: () => git.repos,
            get_git_repo_status: () => Object.fromEntries(Object.entries(git.repoStatus || {})
                .map(([repo, status]) => [repo, { changes: 0, ahead: 0, behind: 0, ...status }])),
            get_git_changes: () => git.changes,
            get_project_git_status: () => Object.fromEntries(Object.entries(state.gitStatus || {})
                .map(([path, status]) => [path, { changes: 0, ahead: 0, behind: 0, ...status }])),
            fetch_project_remotes: () => 0,
            get_project_ci_status: () => state.ciStatus || {},
            get_git_repo_ci_status: () => git.ciStatus || {},
            get_git_change_stats: () => git.lineStats,
            get_git_file_diff: ({ file }) => git.diffs[file] || '',
            get_git_branches: () => ({ branches: git.branches, currentBranch: git.currentBranch }),
            get_git_remote_status: () => git.status,
            git_fetch: () => 'Fetch successful. Remote data is up to date.',
            git_commit: () => 'Commit successful.',
            git_pull: () => 'Already up to date.',
            git_pull_overwrite: () => 'Successfully pulled and overwrote local branch',
            git_push: () => 'Push Successful',
            git_sync: () => 'Already up to date.\nPush Successful',
            git_switch_branch: () => 'Branch switched successfully.',
            git_create_branch: () => 'Branch created.',
            git_delete_branch: () => 'Branch deleted.',
            git_merge_branch: () => 'Merge successful.',
            git_stash: () => 'Changes stashed successfully.',
            git_stash_pop: () => 'Stash popped successfully.',
            git_restore_file: () => 'Successfully reverted',
            git_restore_all: () => 'All changes have been successfully reverted.',
            git_delete_file: () => 'Successfully deleted',
            plugin_list: () => JSON.parse(JSON.stringify(plugins.map(plugin => ({ configured: true, signIns: 0, ...plugin })))),
            plugin_catalog: () => {
                if (state.catalog === undefined) throw 'Could not reach the plugin catalog';
                return state.catalog;
            },
            plugin_install_catalog: ({ id }) => {
                const entry = state.catalog.find(item => item.id === id);
                const manifest = (state.catalogManifests || {})[id];
                const info = { id, version: entry.version, enabled: true, signed: true, manifest };
                plugins = plugins.filter(plugin => plugin.id !== id).concat(info);
                return info;
            },
            plugin_inspect_folder: () => {
                if (!state.pluginFolder) throw 'The folder has no plugin.json.';
                return state.pluginFolder.manifest;
            },
            plugin_install_folder: () => {
                const manifest = state.pluginFolder.manifest;
                const info = { id: manifest.id, version: manifest.version, enabled: true, signed: false, manifest };
                plugins = plugins.filter(plugin => plugin.id !== manifest.id).concat(info);
                return info;
            },
            plugin_remove: ({ id }) => { plugins = plugins.filter(plugin => plugin.id !== id); return null; },
            plugin_set_enabled: ({ id, enabled }) => {
                plugins.forEach(plugin => { if (plugin.id === id) plugin.enabled = enabled; });
                return null;
            },
            plugin_settings: ({ id }) => JSON.parse(JSON.stringify(pluginSettings[id] || { hasProject: true, signIn: null, settings: [], signIns: [] })),
            // As the backend does: a key left out keeps its value, an empty value removes it, and a project with
            // no sign-in gets a new one.
            plugin_save_settings: ({ id, values }) => {
                const view = pluginSettings[id] ??= { hasProject: true, signIn: null, settings: [], signIns: [] };
                if (!view.hasProject) throw 'Open a project to set it up for it.';
                view.settings.forEach(setting => {
                    if (!(setting.key in values)) return;
                    setting.isSet = values[setting.key] !== '';
                    if (!setting.secret) setting.value = values[setting.key] || null;
                });
                if (!view.signIn) {
                    view.signIn = `sign-in-${view.signIns.length + 1}`;
                    view.signIns.push({ id: view.signIn, label: 'New sign-in', projects: 1 });
                }
                return null;
            },
            plugin_use_sign_in: ({ id, signIn }) => {
                const view = pluginSettings[id];
                if (!view) throw 'Not installed';
                if (signIn && !view.signIns.some(choice => choice.id === signIn)) throw 'That sign-in no longer exists.';
                view.signIn = signIn || null;
                view.settings.forEach(setting => {
                    setting.isSet = !!signIn;
                    if (!setting.secret) setting.value = signIn ? `${setting.key} of ${signIn}` : null;
                });
                return null;
            },
            plugin_use_in_project: ({ id, used }) => {
                const view = pluginSettings[id] ??= { hasProject: true, signIn: null, settings: [], signIns: [] };
                if (!view.hasProject) throw 'Open a project to use it in it.';
                view.used = used;
                plugins.forEach(plugin => { if (plugin.id === id) plugin.configured = used; });
                return null;
            },
            plugin_render: ({ id, page }) => {
                const node = (state.pluginPages || {})[`${id}/${page}`];
                if (node === undefined) throw `${id} has no page named ${page}.`;
                return node;
            },
            plugin_action: ({ id, request }) => {
                const result = (state.pluginActions || {})[`${id}/${request.action}`];
                if (result === undefined) throw `${id} does not know the action ${request.action}.`;
                return result;
            },
            plugin_branch_info: () => state.branchCards || [],
            plugin_notifications: () => state.pluginNotifications || [],
            plugin_notification_read: () => null,
            myfi_account: () => myfi.account,
            myfi_sign_in_start: () => {
                if (state.myfiStartError) throw state.myfiStartError;
                // myfiOpened: false when the browser didn't open the page.
                return { code: 'M7A-JQF', url: 'https://www.stoicdreams.com/signin?app=taskproxy&request=3160d8e4-e8dd-43c7-a397-43b17ef46cbc', opened: state.myfiOpened ?? true };
            },
            myfi_sign_in_wait: () => new Promise((resolve, reject) => { myfi.waiting = { resolve, reject }; }),
            myfi_sign_in_cancel: () => {
                myfi.waiting?.resolve(null);
                myfi.waiting = null;
                return null;
            },
            myfi_sign_out: () => {
                myfi.account = null;
                Object.assign(remote, { enabled: false, waiting: [] });
                remote.approved.forEach(browser => browser.connected = false);
                return null;
            },
            remote_status: () => remote.status(),
            remote_set_enabled: ({ enabled, name }) => {
                if (enabled && !myfi.account) throw 'Sign in to your Stoic Dreams account first, from the account button at the top.';
                if (enabled && !`${name ?? ''}`.trim()) throw 'Name this computer in 1 to 100 characters.';
                if (enabled && state.remote?.enableError) throw state.remote.enableError;
                remote.enabled = enabled;
                if (enabled) remote.name = name.trim();
                remote.reachability = { reachable: enabled, error: null };
                if (!enabled) {
                    remote.waiting = [];
                    remote.approved.forEach(browser => browser.connected = false);
                }
                return remote.status();
            },
            remote_browsers: () => remote.lists(),
            remote_browser_approve: ({ key }) => {
                const browser = remote.waiting.find(browser => browser.key === key);
                if (!browser) throw 'That browser is no longer waiting. Ask it to connect again.';
                remote.waiting = remote.waiting.filter(browser => browser.key !== key);
                remote.approved.push({ key, name: browser.name, code: browser.code, added: Date.now(), level: 'view', connected: false, route: null });
                return remote.lists();
            },
            remote_browser_remove: ({ key }) => {
                const waiting = remote.waiting.find(browser => browser.key === key);
                if (waiting) {
                    remote.waiting = remote.waiting.filter(browser => browser.key !== key);
                    remote.refused.push({ key, name: waiting.name, code: waiting.code, refused: Date.now() });
                } else {
                    remote.approved_one(key);
                    remote.approved = remote.approved.filter(browser => browser.key !== key);
                }
                return remote.lists();
            },
            remote_browser_allow: ({ key }) => {
                if (!remote.refused.some(browser => browser.key === key)) throw 'No such browser.';
                remote.refused = remote.refused.filter(browser => browser.key !== key);
                return remote.status();
            },
            remote_browser_level: ({ key, level }) => {
                remote.approved_one(key).level = level;
                return remote.status();
            },
            remote_browser_disconnect: ({ key }) => {
                remote.approved_one(key).connected = false;
                return remote.status();
            },
            remote_log: () => remote.log,
            remote_settings: ({ settings }) => {
                remote.keepAwake = settings.keepAwake;
                return remote.status();
            },
            plugin_host_action: ({ action }) => action.type === 'git.createBranch' ? `Branch '${action.name}' created.` : '',
        },
    };
    window.__backend = backend;
    window.__TAURI__ = {
        core: {
            invoke: async (command, args, options) => {
                // Raw bytes, as copy_image sends, are recorded by their length.
                backend.calls.push({ command, args: args instanceof Uint8Array ? { bytes: args.length } : JSON.parse(JSON.stringify(args ?? {})) });
                const handler = backend.handlers[command];
                if (!handler) throw `The mock backend has no command named ${command}`;
                return handler(args, options);
            },
        },
        // Resolves to a function that stops listening, as Tauri's does.
        event: {
            listen: async (name, listener) => {
                (listeners[name] ??= []).push(listener);
                return () => { listeners[name] = (listeners[name] || []).filter(item => item !== listener); };
            },
        },
        // Recorded as calls, so tests can check what the app opened in the browser.
        opener: { openUrl: async url => { backend.calls.push({ command: 'openUrl', args: { url } }); } },
        dialog: { open: async () => state.pickedFolder ?? null },
    };
}
