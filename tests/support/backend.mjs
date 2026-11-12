/**
 * Stands in for the Rust backend, by providing window.__TAURI__ before the app starts.
 *
 * `state` can set:
 * - project: { name, path } to open, or null for none. Defaults to /repo.
 * - projects: the saved project list.
 * - files: { 'relative/path': 'contents' }, which get_project_file reads and save_project_file writes.
 * - binaryFiles: { 'relative/path': 'base64' }, files that are not text, which get_project_file cannot read.
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
 * - catalog: what plugin_catalog returns, or leave it out for a catalog that cannot be reached.
 *   catalogManifests: { id: manifest } for what plugin_install_catalog installs.
 * - plugins: what plugin_list returns, as [{ id, version, enabled, signed, manifest }].
 * - pluginPages: { 'plugin/page': node } for plugin_render. A missing page fails, as an unknown page does.
 * - pluginActions: { 'plugin/action': result } for plugin_action. A missing action fails.
 * - pluginSettings: { plugin: [{ key, label, help, secret, isSet, value }] } for plugin_settings.
 * - pickedFolder: the folder the folder picker returns, or null for none. pluginFolder: { manifest } it holds.
 * - branchCards: what plugin_branch_info returns, as [{ id, name, card }].
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
    const pluginSettings = JSON.parse(JSON.stringify(state.pluginSettings || {}));
    const listeners = {};
    const backend = {
        calls: [],
        files,
        git,
        projectData,
        savedProjects,
        emit(name, payload) { (listeners[name] || []).forEach(listener => listener({ payload })); },
        handlers: {
            get_app_data: () => ({
                isSaved: true, saveIntervalMinutes: 20, variables: state.appVariables || [],
                data: {
                    ...(state.newInstall ? {} : { 'app-env-page-enabled': true, 'app-env-project-enabled': true, 'app-env-global-enabled': true }),
                    ...(project ? { 'app-current-project': { value: project.path, display: project.name } } : {}),
                    ...(state.appData || {}),
                },
            }),
            get_version: () => '1.2.3',
            has_securitykey: () => state.hasKey !== false,
            set_securitykey: () => 'Security Key Saved!',
            delete_securitykey: () => 'Security Key Deleted!',
            sync_app_data: () => 'App Data Synced',
            save_app_data: () => 'app data saved',
            load_projects: () => state.projects || (project ? [project] : []),
            get_projects: () => state.projects || (project ? [project] : []),
            get_project_data: loadProject,
            sync_project_data: ({ data } = {}) => { storeProject(data); return 'Project data synced'; },
            save_project_data: ({ data } = {}) => { storeProject(data); return 'Project data saved'; },
            clear_current_project: () => 'Project closed',
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
            get_project_file_base64: ({ filePath }) => {
                if (filePath in binaryFiles) return binaryFiles[filePath];
                if (filePath in files) return btoa(String.fromCharCode(...new TextEncoder().encode(files[filePath])));
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
            start_script: () => ({ message: 'Script started', interactive: state.interactive !== false }),
            write_terminal_input: () => null,
            resize_terminal: () => null,
            kill_script: () => 'Process killed',
            kill_all_scripts: () => 'All processes killed',
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
            plugin_list: () => JSON.parse(JSON.stringify(plugins)),
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
            plugin_settings: ({ id }) => JSON.parse(JSON.stringify(pluginSettings[id] || [])),
            // As the backend does: a key left out keeps its value, and an empty value removes it.
            plugin_save_settings: ({ id, values }) => {
                (pluginSettings[id] || []).forEach(setting => {
                    if (!(setting.key in values)) return;
                    setting.isSet = values[setting.key] !== '';
                    if (!setting.secret) setting.value = values[setting.key] || null;
                });
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
        opener: { openUrl: async () => { } },
        dialog: { open: async () => state.pickedFolder ?? null },
    };
}
