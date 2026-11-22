/*
 * Favorite scripts, in the bottom drawer: one row of icons that each run a script, with the pencil on the left to
 * manage them, and an ellipsis on the right when there are more than fit, which shows them all. Hovering an icon shows
 * its script's first line, clicking runs it, and dragging, or Alt+arrows, puts the icons in order.
 *
 * Managing them opens the drawer over most of the page: the favorites on one side and the one chosen on the other,
 * with its name, its icon (a Web UI icon or emoji, or an image from its project), its parameters, each fixed or from
 * data, the scopes its data may come from, and the projects it shows in. A favorite is made from a script on the page
 * shown or one of the open project's script files, and always runs in the project it came from
 * (services/favorites.rs). The list is app data, `app-favorite-scripts`, so it is kept across projects.
 */
"use strict"
{
    const KEY = 'app-favorite-scripts';
    const DEFAULT_ICON = 'play|theme:success|fill|backing';
    const normalize = path => `${path || ''}`.replace(/\\/g, '/').toLowerCase();

    function el(tag, attrs, text) {
        const node = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([name, value]) => {
            if (value === undefined || value === null || value === false) return;
            node.setAttribute(name, value === true ? '' : `${value}`);
        });
        if (text !== undefined) node.textContent = `${text}`;
        return node;
    }
    function button(label, theme, icon, attrs = {}) {
        const btn = el('webui-button', { theme, 'start-icon': icon || null, ...attrs });
        btn.appendChild(el('span', {}, label));
        return btn;
    }
    /** Every favorite, in order. */
    function allFavorites() {
        const list = webui.getData(KEY);
        return Array.isArray(list) ? list : [];
    }
    /** Saves the list as a new array, so the change is seen and saved with the app's data. */
    function saveFavorites(list) {
        webui.setData(KEY, list.map(item => ({ ...item })));
    }
    function openProject() {
        return webui.getData('app-current-project')?.value || null;
    }
    function projectName(path) {
        const known = (webui.getData('app-projects') || []).find(project => normalize(project.path) === normalize(path));
        return known?.name || path;
    }
    /** A favorite shows in every project, or only in those it lists. */
    function isShown(favorite, project) {
        if (!favorite.projects?.length) return true;
        return !!project && favorite.projects.some(path => normalize(path) === normalize(project));
    }
    /** The id of the user page shown, when one is. */
    function shownPageId() {
        if (!document.querySelector('app-page-handler')) return null;
        const id = decodeURIComponent(location.pathname.substring(1));
        return id && !id.includes('/') ? id : null;
    }
    /** A script's first line that does something, for its tooltip. */
    function firstLine(text) {
        const line = `${text || ''}`.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#') && !/^param\s*\(/i.test(line));
        if (!line) return '';
        return line.length > 120 ? `${line.substring(0, 117)}...` : line;
    }
    /** What a favorite runs, in a few words. */
    function describe(favorite) {
        const source = favorite.source || {};
        const where = source.kind === 'file' ? source.path : `a script on a page${source.label ? `: ${source.label}` : ''}`;
        return `${where}, in ${projectName(favorite.project)}`;
    }
    /** A favorite's parameters for its script: the ones it has set, and any new ones the script now takes. */
    function paramsFor(favorite, text) {
        const found = favorite.source?.kind === 'file' ? parseScriptParams(text) : pageScriptParams(text);
        return found.map(param => {
            const saved = (favorite.params || []).find(item => item.name === param.name);
            return saved
                ? { ...saved, switch: param.isSwitch }
                : { name: param.name, fromData: !param.isSwitch, value: param.isSwitch ? false : '', key: '', switch: param.isSwitch };
        });
    }
    /** The icon or image a favorite shows. */
    function iconFor(favorite) {
        const icon = favorite.icon || {};
        if (icon.image) {
            const img = el('img', { alt: '', 'aria-hidden': 'true', class: 'fav-image' });
            // The bar draws as the app starts, which can be before the backend is ready.
            whenProxyReady().then(proxy => proxy.projectImageUrl(favorite.project, icon.image, () => { })).then(url => {
                if (url) img.src = url;
            });
            return img;
        }
        return el('webui-icon', { icon: icon.name || DEFAULT_ICON, 'aria-hidden': 'true' });
    }

    webui.define('app-favorites', {
        preload: 'reorder split-panes input-text button switch icon icon-search select',
        connected() {
            const t = this;
            if (!t._bar) t.build();
            t.dataset.subscribe = `${KEY}:render|app-current-project:render|app-projects:render`;
            if (!t.getAttribute('mode')) t.setAttribute('mode', 'bar');
            t._resize ??= new ResizeObserver(() => t.checkOverflow());
            t._resize.observe(t._icons);
            t.render();
        },
        disconnected() {
            this._resize?.disconnect();
        },
        build() {
            const t = this;
            // What running an icon said goes on a line of its own after the bar, by the icon that ran it.
            t._bar = el('div', { class: 'fav-bar', 'data-action-row': '' });
            t._edit = el('button', { type: 'button', class: 'fav-edit', title: 'Manage favorite scripts', 'aria-label': 'Manage favorite scripts' });
            t._edit.appendChild(el('webui-icon', { icon: 'pencil', 'aria-hidden': 'true' }));
            t._edit.addEventListener('click', () => t.setMode(t.getAttribute('mode') === 'manage' ? 'bar' : 'manage'));
            t._icons = el('webui-reorder', { class: 'fav-icons', role: 'toolbar', 'aria-label': 'Favorite scripts. Click one to run it, or press Alt+Left or Alt+Right to move it.', items: ':scope > .fav-icon', handle: '.fav-icon' });
            t._icons.addEventListener('reorder', () => t.saveOrder([...t._icons.querySelectorAll(':scope > .fav-icon')].map(icon => icon.dataset.id)));
            t._empty = el('span', { class: 'fav-empty' }, 'Favorite scripts show here. Add one with the pencil.');
            t._more = el('button', { type: 'button', class: 'fav-more', title: 'Show every favorite', 'aria-label': 'Show every favorite' });
            t._more.appendChild(el('webui-icon', { icon: 'ellipsis', 'aria-hidden': 'true' }));
            t._more.addEventListener('click', () => t.setMode(t.getAttribute('mode') === 'all' ? 'bar' : 'all'));
            t._bar.append(t._edit, t._icons, t._empty, t._more);
            t._manage = el('section', { class: 'fav-manage', 'aria-label': 'Manage favorite scripts' });
            t._manage.hidden = true;
            t.append(t._bar, t._manage);
        },
        /** `bar` is one row, `all` shows every icon, and `manage` opens over most of the page to change them. */
        setMode(mode) {
            const t = this;
            t.setAttribute('mode', mode);
            // What was said in another mode is about what was on screen then.
            clearActionNote(t._head);
            t.clearBarNote();
            t._edit.setAttribute('aria-pressed', mode === 'manage' ? 'true' : 'false');
            t._more.setAttribute('aria-expanded', mode === 'all' ? 'true' : 'false');
            t._more.title = mode === 'all' ? 'Show one row' : 'Show every favorite';
            if (mode === 'manage' && !t._chosen) t._chosen = allFavorites()[0]?.id || null;
            t.render();
        },
        /** Clears what running an icon on the bar said. */
        clearBarNote() {
            clearActionNote(this._edit);
        },
        render() {
            const t = this;
            if (!t._bar) return;
            const mode = t.getAttribute('mode') || 'bar';
            const project = openProject();
            // What an icon said is about the project it ran from.
            if (t._project !== undefined && normalize(t._project) !== normalize(project)) t.clearBarNote();
            t._project = project;
            const shown = allFavorites().filter(favorite => isShown(favorite, project));
            t._icons.replaceChildren(...shown.map(favorite => t.iconButton(favorite)));
            t._empty.hidden = shown.length > 0;
            t._manage.hidden = mode !== 'manage';
            if (mode === 'manage') t.renderManage();
            t.checkOverflow();
        },
        iconButton(favorite) {
            const t = this;
            const name = favorite.name || 'Favorite script';
            // Web UI shows an element's aria-label as its tooltip, so its name and first line are both.
            const tip = favorite.preview ? `${name}: ${favorite.preview}` : name;
            const btn = el('button', { type: 'button', class: 'fav-icon', 'data-id': favorite.id, 'aria-label': tip });
            btn.appendChild(iconFor(favorite));
            btn.addEventListener('click', () => t.run(favorite.id, btn));
            // The script may have changed since it was added, so its tooltip is read again as the pointer reaches it.
            btn.addEventListener('mouseenter', async () => {
                const text = await webui.proxy.favorites.script(favorite.project, favorite.source);
                if (typeof text !== 'string') return;
                const line = firstLine(text);
                btn.setAttribute('aria-label', line ? `${name}: ${line}` : name);
            });
            return btn;
        },
        /** With more icons than fit in one row, the ellipsis shows them all. */
        checkOverflow() {
            const t = this;
            if (!t._icons) return;
            const mode = t.getAttribute('mode');
            const overflows = t._icons.scrollWidth > t._icons.clientWidth + 1;
            t._more.hidden = !(mode === 'all' || (mode !== 'manage' && overflows));
        },
        /** Puts the favorites in the order of those listed, keeping where the others are. */
        saveOrder(ids) {
            const list = allFavorites();
            const moving = new Set(ids);
            const slots = list.map((favorite, index) => moving.has(favorite.id) ? index : -1).filter(index => index >= 0);
            const next = [...list];
            ids.forEach((id, place) => {
                const favorite = list.find(item => item.id === id);
                if (favorite && slots[place] !== undefined) next[slots[place]] = favorite;
            });
            saveFavorites(next);
        },
        update(id, changes) {
            const list = allFavorites().map(favorite => favorite.id === id ? { ...favorite, ...changes } : favorite);
            saveFavorites(list);
        },
        /**
         * Runs a favorite in its project, asking first when it is the open project and it is not trusted yet. Why it
         * couldn't run is said by `trigger`, the Run button or the bar's icon pressed, or in the app's alerts when
         * that is no longer on screen.
         */
        async run(id, trigger = null) {
            const favorite = allFavorites().find(item => item.id === id);
            if (!favorite) return;
            clearActionNote(trigger);
            // actionNote says it in the app's alerts when the button is gone, as after the bar is drawn again.
            const problem = err => actionNote(trigger, `${err}`, 'warning');
            const text = await webui.proxy.favorites.script(favorite.project, favorite.source, problem);
            if (typeof text !== 'string') return;
            if (normalize(favorite.project) === normalize(openProject()) && !await webui.proxy.confirmProjectScript(text)) return;
            // The page's values for what the script uses, when the favorite may use the page's data. Rust adds the
            // project's and global values itself, so secrets never pass through this window.
            const pageValues = {};
            if (favorite.scopes?.page !== false) {
                const names = new Set([...text.matchAll(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g)].map(found => found[1]));
                (favorite.params || []).forEach(param => names.add(param.key || param.name));
                names.forEach(name => {
                    const value = webui.getNestedData(name, window.appData);
                    if (value !== undefined) pageValues[name] = value;
                });
            }
            const run = await webui.proxy.favorites.run({
                id: favorite.id, name: favorite.name || '', project: favorite.project, source: favorite.source,
                params: favorite.params || [], scopes: favorite.scopes || {}, pageValues,
            }, problem);
            if (!run) return;
            webui.proxy.terminalHelpers.applyRun(run);
            document.querySelector('app-terminals')?.openDrawer({ run: true, terminalId: run.id, projectId: run.projectId });
        },
        renderManage() {
            const t = this;
            const list = allFavorites();
            if (t._chosen && t._chosen !== 'add' && !list.some(favorite => favorite.id === t._chosen)) t._chosen = list[0]?.id || null;
            if (!t._split) {
                const head = el('div', { class: 'fav-manage-head' });
                head.appendChild(el('h3', {}, 'Favorite Scripts'));
                const add = button('Add Script', 'primary', 'plus', { class: 'fav-add' });
                add.addEventListener('click', () => {
                    // What adding the last favorite said is about the one shown before.
                    clearActionNote(t._head);
                    t._chosen = 'add';
                    t.renderManage();
                    t._split.showPane?.('end');
                });
                const done = button('Done', 'secondary', 'check', { class: 'fav-done' });
                done.addEventListener('click', () => t.setMode('bar'));
                head.append(add, done);
                // What adding a favorite did is said under these buttons, since the panes below are drawn again.
                head.setAttribute('data-action-row', '');
                t._head = head;
                t._split = el('webui-split-panes', { class: 'fav-split', min: '240', ratio: '0.3', show: 'end', 'start-label': 'Favorites', 'end-label': 'Details' });
                t._list = el('webui-reorder', { slot: 'start', class: 'fav-list', role: 'listbox', 'aria-label': 'Favorite scripts', items: ':scope > .fav-row', handle: '.fav-row' });
                t._list.addEventListener('reorder', () => t.saveOrder([...t._list.querySelectorAll(':scope > .fav-row')].map(row => row.dataset.id)));
                t._detail = el('div', { slot: 'end', class: 'fav-detail' });
                t._split.append(t._list, t._detail);
                t._manage.append(head, t._split);
            }
            t._list.replaceChildren(...list.map(favorite => {
                const row = el('button', { type: 'button', role: 'option', class: 'fav-row', 'data-id': favorite.id, 'aria-selected': favorite.id === t._chosen ? 'true' : 'false' });
                row.appendChild(iconFor(favorite));
                const text = el('span', { class: 'fav-row-text' });
                text.appendChild(el('strong', {}, favorite.name || 'Favorite script'));
                text.appendChild(el('span', { class: 'fav-muted' }, favorite.projects?.length ? `In ${favorite.projects.map(projectName).join(', ')}` : 'In every project'));
                row.appendChild(text);
                row.addEventListener('click', () => {
                    clearActionNote(t._head);
                    t._chosen = favorite.id;
                    t.renderManage();
                    t._split.showPane?.('end');
                });
                return row;
            }));
            if (!list.length) t._list.appendChild(el('p', { class: 'fav-empty' }, 'No favorites yet. Add one from this page or this project.'));
            if (t._chosen === 'add') t.renderAdd();
            else if (t._chosen) t.renderEditor(list.find(favorite => favorite.id === t._chosen));
            else t._detail.replaceChildren(el('p', { class: 'fav-muted' }, 'Add a script to run it from here with one click.'));
        },
        /** The scripts to choose a new favorite from: this page's, then this project's files. */
        async renderAdd() {
            const t = this;
            const round = t._addRound = (t._addRound || 0) + 1;
            t._detail.replaceChildren(el('h4', {}, 'Add a Favorite'), el('p', { class: 'fav-muted' }, 'Loading scripts...'));
            const page = shownPageId();
            const found = await webui.proxy.favorites.candidates(page, err => {
                if (round === t._addRound) t._detail.replaceChildren(el('h4', {}, 'Add a Favorite'), el('p', { class: 'fav-empty' }, `${err}`));
            });
            if (!found || round !== t._addRound || t._chosen !== 'add') return;
            const box = el('div', { class: 'fav-add-choices' });
            box.appendChild(el('h4', {}, 'Add a Favorite'));
            box.appendChild(el('p', { class: 'fav-muted' }, `Choose a script on this page, or one of ${projectName(found.project)}'s script files.`));
            const choice = (label, detail, onPick, attrs) => {
                const row = el('button', { type: 'button', class: 'fav-choice', ...attrs });
                row.appendChild(el('strong', {}, label));
                if (detail) row.appendChild(el('code', { class: 'fav-muted' }, detail));
                row.addEventListener('click', onPick);
                return row;
            };
            box.appendChild(el('h5', {}, 'On this page'));
            if (!found.page || !found.blocks.length) box.appendChild(el('p', { class: 'fav-muted' }, found.page ? 'This page has no PowerShell scripts.' : 'Open one of the project\'s pages to add its scripts.'));
            found.blocks.forEach((block, index) => box.appendChild(choice(block.label || `Script ${index + 1}`, firstLine(block.text), () => t.addFavorite(found.project, {
                kind: 'page', page: found.page, index, text: block.text, count: found.blocks.length, label: block.label,
            }, block.label || `Script ${index + 1}`, block.text), { 'data-block': index })));
            box.appendChild(el('h5', {}, 'Script files'));
            if (!found.files.length) box.appendChild(el('p', { class: 'fav-muted' }, 'This project has no .ps1 files.'));
            // Why a file couldn't be added is said under the files, not under the whole list.
            const files = el('div', { class: 'fav-file-choices', 'data-action-row': '' });
            box.appendChild(files);
            found.files.forEach(path => files.appendChild(choice(path, '', async ev => {
                const picked = ev.currentTarget;
                const text = await webui.proxy.favorites.script(found.project, { kind: 'file', path }, err => actionNote(picked, `${err}`, 'warning'));
                if (typeof text === 'string') t.addFavorite(found.project, { kind: 'file', path }, path.split('/').pop().replace(/\.ps1$/i, ''), text);
            }, { 'data-file': path })));
            t._detail.replaceChildren(box);
        },
        /** Makes a favorite from a script, shown in the project it came from, and opens it to set its parameters. */
        addFavorite(project, source, name, text) {
            const t = this;
            const favorite = {
                id: webui.uuid(), name, icon: null, project, source,
                params: [], scopes: { page: true, project: true, global: true }, projects: [project], preview: firstLine(text),
            };
            favorite.params = paramsFor(favorite, text);
            saveFavorites([...allFavorites(), favorite]);
            t._chosen = favorite.id;
            t.renderManage();
            actionNote(t._head, `Added ${name} to your favorites.`, 'success');
        },
        async renderEditor(favorite) {
            const t = this;
            if (!favorite) return;
            const round = t._editRound = (t._editRound || 0) + 1;
            const form = el('div', { class: 'fav-editor', 'data-id': favorite.id });
            // Name
            const name = el('webui-input-text', { label: 'Name', class: 'fav-name', value: favorite.name || '' });
            name.addEventListener('change', ev => {
                const value = `${ev.composedPath()[0]?.value ?? name.value ?? ''}`.trim();
                if (value && value !== favorite.name) t.update(favorite.id, { name: value });
            });
            form.appendChild(name);
            // Icon
            const iconRow = el('div', { class: 'fav-icon-row' });
            const preview = el('span', { class: 'fav-icon-preview' });
            preview.appendChild(iconFor(favorite));
            const pick = button('Icon or Emoji', 'secondary', 'icons', { class: 'fav-pick-icon' });
            pick.addEventListener('click', () => t.pickIcon(favorite));
            const image = button('Project Image', 'secondary', 'image', { class: 'fav-pick-image' });
            image.addEventListener('click', () => t.pickImage(favorite, image));
            iconRow.append(el('strong', {}, 'Icon'), preview, pick, image);
            if (favorite.icon) {
                const clear = button('Default', 'secondary', 'xmark', { class: 'fav-clear-icon' });
                clear.addEventListener('click', () => t.update(favorite.id, { icon: null }));
                iconRow.appendChild(clear);
            }
            form.appendChild(iconRow);
            // Script
            form.appendChild(el('p', { class: 'fav-source' }, `Runs ${describe(favorite)}.`));
            const code = el('pre', { class: 'fav-script' }, 'Loading...');
            form.appendChild(code);
            // Parameters, once the script is read
            const paramsBox = el('div', { class: 'fav-params' });
            form.appendChild(paramsBox);
            // Scopes
            const scopes = { page: true, project: true, global: true, ...(favorite.scopes || {}) };
            const scopeBox = el('fieldset', { class: 'fav-scopes' });
            scopeBox.appendChild(el('legend', {}, 'Data may come from'));
            ['page', 'project', 'global'].forEach(scope => {
                const label = el('label', { class: 'fav-check' });
                const box = el('input', { type: 'checkbox', 'data-scope': scope, checked: scopes[scope] });
                box.addEventListener('change', () => t.update(favorite.id, { scopes: { ...scopes, [scope]: box.checked } }));
                label.append(box, document.createTextNode(` ${scope[0].toUpperCase()}${scope.substring(1)}`));
                scopeBox.appendChild(label);
            });
            form.appendChild(scopeBox);
            // Projects it shows in
            const showBox = el('fieldset', { class: 'fav-projects' });
            showBox.appendChild(el('legend', {}, 'Show in'));
            const everyLabel = el('label', { class: 'fav-check' });
            const every = el('input', { type: 'radio', name: `fav-show-${favorite.id}`, 'data-show': 'all', checked: !favorite.projects?.length });
            every.addEventListener('change', () => every.checked && t.update(favorite.id, { projects: [] }));
            everyLabel.append(every, document.createTextNode(' Every project'));
            const someLabel = el('label', { class: 'fav-check' });
            const some = el('input', { type: 'radio', name: `fav-show-${favorite.id}`, 'data-show': 'some', checked: !!favorite.projects?.length });
            some.addEventListener('change', () => some.checked && t.update(favorite.id, { projects: [favorite.project] }));
            someLabel.append(some, document.createTextNode(' Only these projects'));
            showBox.append(everyLabel, someLabel);
            if (favorite.projects?.length) {
                (webui.getData('app-projects') || []).forEach(project => {
                    const label = el('label', { class: 'fav-check fav-project' });
                    const listed = favorite.projects.some(path => normalize(path) === normalize(project.path));
                    const box = el('input', { type: 'checkbox', 'data-project': project.path, checked: listed });
                    box.addEventListener('change', () => {
                        const others = favorite.projects.filter(path => normalize(path) !== normalize(project.path));
                        const next = box.checked ? [...others, project.path] : others;
                        // With none chosen it would never show, so the last one stays.
                        if (!next.length) {
                            box.checked = true;
                            return;
                        }
                        t.update(favorite.id, { projects: next });
                    });
                    label.append(box, document.createTextNode(` ${project.name}`));
                    showBox.appendChild(label);
                });
            }
            form.appendChild(showBox);
            // Actions
            const actions = el('div', { class: 'fav-actions' });
            const run = button('Run', 'success', 'play', { class: 'fav-run' });
            run.addEventListener('click', () => t.run(favorite.id, run));
            const remove = button('Remove', 'danger', 'trash', { class: 'fav-remove' });
            remove.addEventListener('click', () => {
                webui.dialog.confirm(`Remove ${webui.escapeForHTML(favorite.name || 'this favorite')} from your favorites? The script itself stays as it is.`, () => {
                    saveFavorites(allFavorites().filter(item => item.id !== favorite.id));
                    t._chosen = null;
                    // What it said on the bar may be about the favorite now gone.
                    t.clearBarNote();
                    return true;
                });
            });
            actions.append(run, remove);
            form.appendChild(actions);
            t._detail.replaceChildren(form);
            const text = await webui.proxy.favorites.script(favorite.project, favorite.source, err => {
                if (round === t._editRound) code.textContent = `${err}`;
            });
            if (round !== t._editRound || typeof text !== 'string') return;
            code.textContent = text;
            t.renderParams(paramsBox, favorite, paramsFor(favorite, text));
            const line = firstLine(text);
            if (line !== favorite.preview) t.update(favorite.id, { preview: line });
        },
        /** Each parameter, fixed or from data, by its own name or another key. */
        renderParams(box, favorite, params) {
            const t = this;
            box.replaceChildren(el('h5', {}, 'Parameters'));
            if (!params.length) {
                box.appendChild(el('p', { class: 'fav-muted' }, 'This script takes no parameters.'));
                return;
            }
            const save = () => t.update(favorite.id, { params: params.map(param => ({ ...param })) });
            params.forEach(param => {
                const row = el('div', { class: 'fav-param', 'data-param': param.name });
                row.appendChild(el('code', {}, `$${param.name}`));
                const mode = el('select', { class: 'fav-param-mode', 'aria-label': `Where $${param.name} comes from` });
                mode.append(el('option', { value: 'data' }, 'From data'), el('option', { value: 'fixed' }, 'Fixed'));
                mode.value = param.fromData ? 'data' : 'fixed';
                const input = el('input', { class: 'fav-param-value' });
                const showInput = () => {
                    if (param.switch && !param.fromData) {
                        input.type = 'checkbox';
                        input.checked = param.value === true || param.value === 'true';
                        input.setAttribute('aria-label', `$${param.name} is on`);
                    } else {
                        input.type = 'text';
                        input.value = param.fromData ? (param.key || '') : `${param.value ?? ''}`;
                        input.placeholder = param.fromData ? `${param.name} (or another key)` : 'Value';
                        input.setAttribute('aria-label', param.fromData ? `Data key for $${param.name}` : `Value of $${param.name}`);
                    }
                };
                mode.addEventListener('change', () => {
                    param.fromData = mode.value === 'data';
                    showInput();
                    save();
                });
                input.addEventListener('change', () => {
                    if (param.switch && !param.fromData) param.value = input.checked;
                    else if (param.fromData) param.key = input.value.trim();
                    else param.value = input.value;
                    save();
                });
                showInput();
                row.append(mode, input);
                box.appendChild(row);
            });
        },
        /** A Web UI icon or emoji, chosen with the icon search. */
        pickIcon(favorite) {
            const t = this;
            let chosen = favorite.icon?.name || '';
            const search = el('webui-icon-search');
            search.addEventListener('icon-update', ev => { chosen = ev.detail; });
            webui.dialog({
                title: 'Choose an Icon or Emoji',
                content: search,
                confirm: 'Use This Icon',
                cancel: 'Cancel',
                onconfirm: () => {
                    if (chosen) t.update(favorite.id, { icon: { name: chosen } });
                    return true;
                },
            }).catch(() => { });
        },
        /** One of the project's images, or SVGs, chosen as a project's icon is (services/project_icons.rs). */
        async pickImage(favorite, trigger) {
            const t = this;
            clearActionNote(trigger);
            const found = await webui.proxy.projectIcons.images(err => actionNote(trigger, `${err}`, 'warning'), favorite.project);
            if (!found) return;
            const images = found.images || [];
            if (!images.length) {
                actionNote(trigger, `${projectName(favorite.project)} has no images small enough to use as an icon.`, 'info');
                return;
            }
            const grid = el('div', { class: 'fav-image-grid' });
            let chosen = favorite.icon?.image || '';
            images.forEach(path => {
                const tile = el('button', { type: 'button', class: 'fav-image-tile', title: path, 'aria-pressed': path === chosen ? 'true' : 'false', 'data-image': path });
                const img = el('img', { alt: path.split('/').pop() });
                webui.proxy.projectImageUrl(favorite.project, path, () => { }).then(url => { if (url) img.src = url; });
                tile.appendChild(img);
                tile.addEventListener('click', () => {
                    chosen = path;
                    grid.querySelectorAll('.fav-image-tile').forEach(other => other.setAttribute('aria-pressed', other === tile ? 'true' : 'false'));
                });
                grid.appendChild(tile);
            });
            webui.dialog({
                title: 'Choose a Project Image',
                content: grid,
                confirm: 'Use This Image',
                cancel: 'Cancel',
                onconfirm: () => {
                    if (chosen) t.update(favorite.id, { icon: { image: chosen } });
                    return true;
                },
            }).catch(() => { });
        },
    });
}
