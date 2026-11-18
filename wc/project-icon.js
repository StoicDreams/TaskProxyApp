/*
 * The open project's icon, in Settings' Current project heading: an image from the project's files, chosen from a grid
 * with webui-select and saved in its .taskproxy/Project.json, so it is shared with the project
 * (services/project_icons.rs). The field shows only the icon; the grid names each image.
 */
"use strict"
{
    /** A file's name, or its path when another image has the same name. */
    function namesFor(paths) {
        const name = path => path.split('/').pop();
        const counts = new Map();
        paths.forEach(path => counts.set(name(path), (counts.get(name(path)) || 0) + 1));
        return paths.map(path => counts.get(name(path)) > 1 ? path : name(path));
    }

    webui.define("app-project-icon", {
        preload: 'select',
        constructor() {
            const t = this;
            t._load = 0;
        },
        connected() {
            const t = this;
            if (!t._select) {
                t._select = webui.create('webui-select', { 'icon-only': '', title: "Choose the project's icon", 'aria-label': "The project's icon" });
                t.append(t._select);
                t._select.addEventListener('change', () => t.choose(t._select.value));
            }
            t.load();
        },
        disconnected() {
            this._load++;
        },
        /** Lists the project's images, with the one it uses chosen. */
        async load() {
            const t = this;
            const load = ++t._load;
            const proxy = await whenProxyReady();
            // With no project open there is nothing to choose from, and nothing to say.
            const found = await proxy.projectIcons.images(() => undefined);
            if (load !== t._load) return;
            if (!found) {
                t.hidden = true;
                return;
            }
            t.hidden = false;
            const images = found.images || [];
            const names = namesFor(images);
            const urls = await Promise.all(images.map(path => proxy.projectFileUrl(path, () => undefined)));
            if (load !== t._load) return;
            t._icon = found.icon || '';
            await customElements.whenDefined('webui-select');
            t._select.setOptions([
                { id: '', display: 'No icon', icon: 'xmark' },
                ...images.map((path, index) => ({ id: path, display: names[index], image: urls[index] || '' })),
            ]);
            t._select.value = t._icon;
            // What the icon is for, as the field's tip, since the heading has no room for a note.
            t._select.title = images.length
                ? "Choose the project's icon from its images. It shows beside its name, and is saved in .taskproxy/Project.json, so everyone working on the project sees it."
                : 'Add an image file, such as an SVG or PNG, to the project to use it as its icon.';
        },
        /** Saves the chosen icon, or puts the field back when it is refused. */
        async choose(icon) {
            const t = this;
            if (icon === t._icon) return;
            const saved = await webui.proxy.projectIcons.set(icon);
            if (saved === false) {
                t._select.value = t._icon;
                return;
            }
            t._icon = icon;
        },
    });
}
