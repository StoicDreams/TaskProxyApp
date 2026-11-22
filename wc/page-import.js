/*
 * Settings' page import: turns a folder of the open project's markdown files into Task Proxy pages, nested in the
 * navigation as the files are nested in its subfolders (services/page_import.rs). The files themselves are only read.
 * Drawn in the page rather than a shadow root, so the page's heading styles apply.
 *
 * Suggestions with AI are kept for the project and folder they were made for, with any changes made to them, until
 * they are cleared or used to import, so they carry on and are there again after another page or project was open.
 */
"use strict"
{
    /** How many lists an answer is tried for, so a long answer full of other brackets can't hold up the window. */
    const MAX_ATTEMPTS = 50;
    /**
     * Where the list starting at `from` ends: its matching ']', skipping brackets inside JSON strings, or -1 when it
     * isn't closed.
     */
    function listEnd(answer, from) {
        let depth = 0;
        let inString = false;
        for (let at = from; at < answer.length; ++at) {
            const char = answer[at];
            if (inString) {
                if (char === '\\') ++at;
                else if (char === '"') inString = false;
            } else if (char === '"') {
                inString = true;
            } else if (char === '[' || char === '{') {
                ++depth;
            } else if (char === ']' || char === '}') {
                if (--depth === 0) return char === ']' ? at : -1;
                if (depth < 0) return -1;
            }
        }
        return -1;
    }
    /**
     * The list of pages from an AI answer: JSON, possibly with text around it, such as "See [docs] below", or in a
     * fenced block. Null when there is none.
     */
    function parseSuggestions(text) {
        const answer = `${text || ''}`;
        const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(answer);
        const tryParse = part => {
            try {
                const list = JSON.parse(part);
                return Array.isArray(list) ? list : null;
            } catch {
                return null;
            }
        };
        if (fenced) {
            const list = tryParse(fenced[1].trim());
            if (list) return list;
        }
        // Each list of objects, '[' then '{', parsed up to its own ']', so text with brackets on either side still
        // parses, and each '[' costs one pass over what follows it.
        const starts = /\[\s*\{/g;
        let attempts = 0;
        for (let found = starts.exec(answer); found && attempts < MAX_ATTEMPTS; found = starts.exec(answer)) {
            ++attempts;
            const end = listEnd(answer, found.index);
            if (end < 0) continue;
            const list = tryParse(answer.slice(found.index, end + 1));
            if (list) return list;
        }
        return null;
    }
    /** Suggested pages, by `path|folder`: `[{file, title, subtitle, navPath}]`, changed as the table is. */
    const suggestions = new Map();
    /** The imports on screen, which draw suggestions that come after they were asked for. */
    const shown = new Set();
    const NEW_FOLDER = 'In a new folder';
    const TOP = 'At the top of the navigation';
    /** The project's folders that hold markdown files, with how many each holds, the whole project first. */
    function folderOptions(docs) {
        const counts = new Map([['', docs.length]]);
        docs.forEach(file => {
            const parts = file.split('/');
            for (let depth = 1; depth < parts.length; ++depth) {
                const folder = parts.slice(0, depth).join('/');
                counts.set(folder, (counts.get(folder) || 0) + 1);
            }
        });
        const pages = count => `${count} ${count === 1 ? 'page' : 'pages'}`;
        return [...counts.keys()].sort((a, b) => a.localeCompare(b)).map(folder => ({
            value: folder,
            display: `${folder || 'The whole project'} (${pages(counts.get(folder))})`,
            icon: folder ? 'folder' : 'folder-tree',
        }));
    }
    webui.define("app-page-import", {
        preload: 'select switch input-text button',
        connected() {
            const t = this;
            if (!t._folder) t.build();
            shown.add(t);
            t.dataset.subscribe = 'app-current-project:setProject';
            t.setProject(webui.getData('app-current-project'));
        },
        build() {
            const t = this;
            const intro = webui.create('p', { class: 'page-import-intro' });
            intro.textContent = 'Turn a folder of markdown files in this project into pages, nested in the navigation as they are in its subfolders. The files themselves are left as they are.';
            t._folder = webui.create('webui-select', { label: 'Folder', 'item-size': '10em' });
            t._place = webui.create('webui-switch', { label: 'Place the pages', options: `${NEW_FOLDER}|${TOP}`, value: NEW_FOLDER });
            t._name = webui.create('webui-input-text', { label: 'Folder name' });
            t._import = webui.create('webui-button', { theme: 'primary', 'start-icon': 'download', label: 'Import Pages' });
            t._empty = webui.create('p', { class: 'page-import-empty' });
            t._empty.textContent = 'This project has no markdown files to import.';
            t._form = webui.create('webui-flex', { column: true, gap: 'var(--padding)', class: 'page-import-form' });
            const actions = webui.create('webui-flex', { justify: 'right', align: 'center', wrap: '' });
            // With AI on for importing markdown, suggestions fill a table to check before importing.
            t._ai = webui.create('app-ai-action', { integration: 'markdown', label: 'Suggest with AI', 'busy-label': 'Suggesting' });
            t._ai.action = args => t.suggest(args);
            t._ai.job = () => t.suggestionKey();
            // Import waits while suggestions for this folder are coming.
            t._ai.addEventListener('ai-busy', () => t.showImportReady());
            actions.append(t._ai, t._import);
            t._suggestions = webui.create('div', { class: 'page-import-suggestions' });
            t._suggestions.hidden = true;
            t._form.append(t._folder, t._place, t._name, t._suggestions, actions);
            t.append(intro, t._form, t._empty);
            t._folder.addEventListener('change', () => {
                t.suggestName();
                t.showSuggestions();
            });
            t._place.addEventListener('change', () => t.showName());
            t._import.addEventListener('click', () => t.importFolder());
        },
        reconnected() {
            shown.add(this);
            this.setProject(webui.getData('app-current-project'));
        },
        disconnected() {
            shown.delete(this);
        },
        /** What suggestions are for: the open project and the chosen folder. */
        suggestionKey() {
            const t = this;
            // While another project loads, the one before is still in projectData.
            if (!t._projectValue || !webui.proxy?.projects?.isLoaded || !webui.projectData?.path) return '';
            return `${webui.projectData.path}|${t._folder?.value ?? ''}`;
        },
        showImportReady() {
            const t = this;
            t._import.toggleAttribute('disabled', !!t._importing || !!t._ai.isBusy?.());
            // Suggestions asked for during an import could bring back pages it just made.
            t._ai.blocked = !!t._importing;
        },
        async setProject(project) {
            const t = this;
            t._projectValue = project?.value;
            t.hidden = !project?.value;
            // Suggestions are for the project they were made in, so another project shows its own.
            t.showSuggestions();
            if (!project?.value) return;
            await whenProxyReady();
            webui.proxy.projects.runWhenLoaded(async () => {
                await customElements.whenDefined('webui-select');
                const options = folderOptions(webui.projectData?.docs || []);
                const hasFiles = options[0] && (webui.projectData?.docs || []).length > 0;
                t._form.hidden = !hasFiles;
                t._empty.hidden = !!hasFiles;
                if (hasFiles) {
                    t._folder.setOptions(options);
                    t.suggestName();
                    t.showName();
                }
                t.showSuggestions();
            });
        },
        /** The new folder is named after the chosen one, or the project for the whole project. */
        suggestName() {
            const t = this;
            const folder = `${t._folder.value ?? ''}`;
            t._name.value = folder ? folder.split('/').pop() : `${webui.getData('app-current-project')?.display ?? ''}`;
        },
        showName() {
            const t = this;
            t._name.hidden = t._place.value !== NEW_FOLDER;
        },
        /**
         * Asks AI for each page's title, description, and navigation folders, from what an import would make, and
         * shows them to change before importing.
         */
        async suggest({ model, requestId, isCurrent }) {
            const t = this;
            const folder = `${t._folder.value ?? ''}`;
            const path = webui.projectData?.path;
            const key = t.suggestionKey();
            if (t._importing) throw 'Wait for the import to finish, then suggest again for what is left.';
            // Asked while a project loads, it has nothing to be for yet.
            if (!key) throw 'The project is still opening. Try again once it has.';
            const plan = await webui.proxy.planPageFolder(folder, err => { throw err; });
            // The plan is read from the open project, so one opened meanwhile has to be asked for again.
            if (webui.projectData?.path !== path) throw 'Another project was opened before the files were read. Suggest with AI again in that project.';
            if (!isCurrent()) return;
            if (!plan?.length) throw 'This folder has no markdown files that could be read as text.';
            const context = `The markdown files, with what an import would use now and how each one starts:\n\n${JSON.stringify(plan.map(page => ({
                file: page.file, title: page.title, subtitle: page.subtitle, navPath: page.navPath, start: page.excerpt,
            })), null, 1)}`;
            const draft = await webui.proxy.ai.write({ integration: 'markdown', model, requestId, request: 'Suggest each page\'s title, description, and navigation folders.', context });
            if (!isCurrent()) return;
            const suggested = parseSuggestions(draft);
            if (!suggested) throw 'The AI answer wasn\'t the list of pages asked for. Try again, or with another model.';
            suggestions.set(key, plan.map(page => {
                const found = suggested.find(item => item?.file === page.file) || {};
                const text = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback;
                const navPath = Array.isArray(found.navPath) ? found.navPath.filter(name => typeof name === 'string').map(name => name.trim()).filter(Boolean) : page.navPath;
                return { file: page.file, title: text(found.title, page.title), subtitle: text(found.subtitle, page.subtitle), navPath };
            }));
            shown.forEach(view => view.showSuggestions());
        },
        /** Shows the suggestions kept for the open project and chosen folder, if any. */
        showSuggestions() {
            const t = this;
            if (!t._suggestions) return;
            t._ai.refresh?.();
            t.showImportReady();
            const key = t.suggestionKey();
            const rows = suggestions.get(key);
            if (!rows) {
                t._shownKey = null;
                t._suggestions.replaceChildren();
                t._suggestions.hidden = true;
                return;
            }
            // Already drawn, with what is being typed in it.
            if (t._shownKey === key && t._shownRows === rows) return;
            t._shownKey = key;
            t._shownRows = rows;
            const table = webui.create('table', { class: 'page-import-table' });
            const head = webui.create('tr');
            ['File', 'Title', 'Description', 'Navigation folders'].forEach(text => head.appendChild(webui.create('th', { text })));
            table.appendChild(head);
            rows.forEach(row => {
                const tr = webui.create('tr', { 'data-file': row.file });
                const input = (field, value, label) => {
                    const td = webui.create('td');
                    const box = webui.create('input', { type: 'text', 'data-field': field, 'aria-label': `${label} for ${row.file}` });
                    box.value = value;
                    // Changes are kept with the suggestions, so they are still there when shown again.
                    box.addEventListener('input', () => {
                        row[field] = field === 'navPath' ? box.value.split('/').map(name => name.trim()).filter(Boolean) : box.value;
                    });
                    td.appendChild(box);
                    return td;
                };
                tr.append(webui.create('td', { text: row.file }), input('title', row.title, 'Title'), input('subtitle', row.subtitle, 'Description'),
                    input('navPath', row.navPath.join(' / '), 'Navigation folders'));
                table.appendChild(tr);
            });
            const note = webui.create('p', { class: 'page-import-suggestions-note', text: 'Suggested by AI. Change anything before importing. Separate navigation folders with /, and leave them empty for the top of the import.' });
            const clear = webui.create('webui-button', { theme: 'secondary', 'start-icon': 'xmark', label: 'Clear Suggestions', class: 'page-import-clear' });
            clear.addEventListener('click', () => t.clearSuggestions());
            t._suggestions.replaceChildren(note, table, clear);
            t._suggestions.hidden = false;
        },
        /** Removes the suggestions for the open project and chosen folder. */
        clearSuggestions(key = this.suggestionKey()) {
            suggestions.delete(key);
            shown.forEach(view => view.showSuggestions());
        },
        /** Each file's title, description, and navigation folders, as the suggestions have them now. */
        overrides(rows) {
            const overrides = {};
            rows.forEach(row => {
                overrides[row.file] = {
                    title: `${row.title ?? ''}`.trim() || null,
                    subtitle: `${row.subtitle ?? ''}`.trim(),
                    navPath: (row.navPath || []).map(name => `${name}`.trim()).filter(Boolean),
                };
            });
            return overrides;
        },
        async importFolder() {
            const t = this;
            if (t._importing || t._ai.isBusy?.()) return;
            const inFolder = t._place.value === NEW_FOLDER;
            const parent = inFolder ? `${t._name.value || ''}`.trim() : '';
            clearActionNote(t._import);
            if (inFolder && !parent) {
                actionNote(t._import, 'Name the folder the pages go in.', 'warning');
                return;
            }
            t._importing = true;
            t.showImportReady();
            try {
                const folder = `${t._folder.value ?? ''}`;
                // Only suggestions made for this folder, in this project, are used.
                const key = t.suggestionKey();
                const overrides = suggestions.has(key) ? t.overrides(suggestions.get(key)) : null;
                const result = await webui.proxy.importPageFolder(folder, parent || null, err => actionNote(t._import, err, 'danger'), overrides);
                if (result) t.clearSuggestions(key);
                if (!result) return;
                const pages = `${result.pages} ${result.pages === 1 ? 'page' : 'pages'}`;
                const done = inFolder ? `Imported ${pages} into ${parent}.` : `Imported ${pages}.`;
                // Files left out make it a warning, said with what was imported.
                if (result.skipped?.length) {
                    actionNote(t._import, `${done} These files could not be read as text, so they were left out: ${result.skipped.join(', ')}`, 'warning');
                } else {
                    actionNote(t._import, done, 'success');
                }
            } finally {
                t._importing = false;
                t.showImportReady();
            }
        },
    });
}
