/*
 * Settings' page import: turns a folder of the open project's markdown files into Task Proxy pages, nested in the
 * navigation as the files are nested in its subfolders (services/page_import.rs). The files themselves are only read.
 * Drawn in the page rather than a shadow root, so the page's heading styles apply.
 */
"use strict"
{
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
            const actions = webui.create('webui-flex', { justify: 'right' });
            actions.append(t._import);
            t._form.append(t._folder, t._place, t._name, actions);
            t.append(intro, t._form, t._empty);
            t._folder.addEventListener('change', () => t.suggestName());
            t._place.addEventListener('change', () => t.showName());
            t._import.addEventListener('click', () => t.importFolder());
        },
        async setProject(project) {
            const t = this;
            t.hidden = !project?.value;
            if (!project?.value) return;
            await whenProxyReady();
            webui.proxy.projects.runWhenLoaded(async () => {
                await customElements.whenDefined('webui-select');
                const options = folderOptions(webui.projectData?.docs || []);
                const hasFiles = options[0] && (webui.projectData?.docs || []).length > 0;
                t._form.hidden = !hasFiles;
                t._empty.hidden = !!hasFiles;
                if (!hasFiles) return;
                t._folder.setOptions(options);
                t.suggestName();
                t.showName();
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
        async importFolder() {
            const t = this;
            if (t._importing) return;
            const inFolder = t._place.value === NEW_FOLDER;
            const parent = inFolder ? `${t._name.value || ''}`.trim() : '';
            if (inFolder && !parent) {
                webui.alert('Name the folder the pages go in.', 'warning');
                return;
            }
            t._importing = true;
            t._import.setAttribute('disabled', '');
            try {
                const result = await webui.proxy.importPageFolder(`${t._folder.value ?? ''}`, parent || null);
                if (!result) return;
                const pages = `${result.pages} ${result.pages === 1 ? 'page' : 'pages'}`;
                webui.alert(inFolder ? `Imported ${pages} into ${parent}.` : `Imported ${pages}.`, 'success');
                if (result.skipped?.length) {
                    webui.alert(`These files could not be read as text, so they were left out: ${result.skipped.join(', ')}`, 'warning');
                }
            } finally {
                t._importing = false;
                t._import.removeAttribute('disabled');
            }
        },
    });
}
