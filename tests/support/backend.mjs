/**
 * Stands in for the Rust backend, by providing window.__TAURI__ before the app starts.
 *
 * `state` can set:
 * - project: { name, path } to open, or null for none. Defaults to /repo.
 * - projects: the saved project list.
 * - files: { 'relative/path': 'contents' }, which get_project_file reads and save_project_file writes.
 * - data, variables, navigation, docs, currentPage: fields of the open project.
 * - appData, appVariables: saved global values and their definitions.
 * - scripts: what get_scripts returns.
 * - git: { repos, changes, lineStats, branches, currentBranch, status, diffs }.
 * - hasKey: whether a security key exists. Defaults to true.
 * - newInstall: leave out the saved settings an existing install has.
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
                if (filePath in files) return files[filePath];
                throw 'Get Project File: File not found';
            },
            save_project_file: ({ filePath, contents }) => {
                files[filePath] = contents;
                return 'File saved';
            },
            search_project_files: () => [],
            get_scripts: () => state.scripts || [],
            start_script: () => 'Script started',
            kill_script: () => 'Process killed',
            kill_all_scripts: () => 'All processes killed',
            get_powershell_status: () => state.powershell || { installed: true, executable: 'pwsh', canAutoInstall: false, installCommand: '', instructions: '' },
            auto_install_powershell: () => 'PowerShell installed successfully.',
            init_emoji_search: () => 'Initialized',
            search_emojis: () => [],
            check_update: () => false,
            install_update: () => 'App is up to date.',
            get_git_repos: () => git.repos,
            get_git_changes: () => git.changes,
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
    };
}
