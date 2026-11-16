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
 * - scripts: what get_scripts returns.
 * - git.repoStatus: { repo: { changes, ahead, behind } } for the open project, which get_git_repo_status returns.
 *   Missing numbers are 0.
 * - gitStatus: { path: { changes, ahead, behind } } for each project, which get_project_git_status returns.
 *   Missing numbers are 0.
 * - ciStatus: { path: { state, service, url } } for each project, which get_project_ci_status returns.
 * - git.ciStatus: { repo: { state, service, url } } for the open project, which get_git_repo_ci_status returns.
 * - projectFiles: what search_project_files returns, after searchDelay milliseconds when set.
 * - git: { repos, changes, lineStats, branches, currentBranch, status, diffs }.
 * - hasKey: whether a security key exists. Defaults to true.
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

/* Runs in the page, so it can use nothing from this module. */
function setup(state) {
    const project = state.project === null ? null : (state.project || { name: 'Repo', path: '/repo' });
    const files = { ...(state.files || {}) };
    const binaryFiles = { ...(state.binaryFiles || {}) };
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
    const emitEvent = (name, payload) => (listeners[name] || []).forEach(listener => listener({ payload }));
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
            let before = null;
            if (job.script) {
                this.set(job, { state: 'script', note: { text: `Running ${job.script.path} before committing...`, theme: 'info' } });
                before = await this.changes(job).catch(() => null);
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
            const files = changed.filter(name => !job.ignored.includes(`${job.repo}/${name}`) && !job.excluded.includes(name))
                .filter(name => job.files.includes(name) || (before && !before.includes(name)));
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
    const backend = {
        calls: [],
        get appData() { return appData; },
        /** Another screen changes app or project data: `patch` is { set, remove, fields }. */
        otherScreen(scope, patch) {
            if (scope === 'app') applyDataPatch(appData, patch);
            else applyDataPatch(savedProjects[openProject.path], patch);
            emitEvent('data-changed', { scope, id: scope === 'app' ? '' : openProject.id, rev: ++dataRev, screen: 'other-screen', set: {}, remove: [], fields: {}, ...patch });
        },
        myfi,
        runs,
        commits,
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
            set_securitykey: () => 'Security Key Saved!',
            delete_securitykey: () => 'Security Key Deleted!',
            save_app_data: ({ data } = {}) => { if (data) appData = copy(data); return 'app data saved'; },
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
            remove_project: () => 'Project Successfully Removed',
            add_project: () => 'Project Successfully Added',
            add_projects_multi: () => ['Added \'one\''],
            get_project_file: ({ filePath }) => {
                if (filePath in binaryFiles) throw 'Failed to load file: stream did not contain valid UTF-8';
                if (filePath in files) return files[filePath];
                throw 'Get Project File: File not found';
            },
            // openApp serves this address from files and binaryFiles, as the backend's file server does.
            get_file_server_base: () => 'http://files.localhost/token',
            get_project_file_size: ({ filePath }) => {
                if (filePath in binaryFiles) return atob(binaryFiles[filePath]).length;
                if (filePath in files) return new TextEncoder().encode(files[filePath]).length;
                throw 'Get Project File: File not found';
            },
            save_project_file: ({ filePath, contents }) => {
                files[filePath] = contents;
                return 'File saved';
            },
            search_project_files: async () => {
                if (state.searchDelay) await new Promise(resolve => setTimeout(resolve, state.searchDelay));
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
                return { code: 'M7A-JQF', url: 'https://www.stoicdreams.com/signin?app=taskproxy&request=3160d8e4-e8dd-43c7-a397-43b17ef46cbc' };
            },
            myfi_sign_in_wait: () => new Promise((resolve, reject) => { myfi.waiting = { resolve, reject }; }),
            myfi_sign_in_cancel: () => {
                myfi.waiting?.resolve(null);
                myfi.waiting = null;
                return null;
            },
            myfi_sign_out: () => {
                myfi.account = null;
                return null;
            },
            plugin_host_action: ({ action }) => action.type === 'git.createBranch' ? `Branch '${action.name}' created.` : '',
        },
    };
    window.__backend = backend;
    window.__TAURI__ = {
        core: {
            invoke: async (command, args) => {
                backend.calls.push({ command, args: JSON.parse(JSON.stringify(args ?? {})) });
                const handler = backend.handlers[command];
                if (!handler) throw `The mock backend has no command named ${command}`;
                return handler(args);
            },
        },
        event: { listen: async (name, listener) => { (listeners[name] ??= []).push(listener); } },
        // Recorded as calls, so tests can check what the app opened in the browser.
        opener: { openUrl: async url => { backend.calls.push({ command: 'openUrl', args: { url } }); } },
        dialog: { open: async () => state.pickedFolder ?? null },
    };
}
