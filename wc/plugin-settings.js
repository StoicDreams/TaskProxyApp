/*
 * A plugin's settings for the open project, such as the Jira site, email, and token it signs in with.
 * <app-plugin-settings plugin="jira"></app-plugin-settings>
 *
 * Settings belong to projects: each project uses one sign-in or none, so switching projects never shows another
 * project's account. A project that has none can use a sign-in another project uses, or have its own. Secret
 * values are saved encrypted and never come back to this window. Fires `plugin-settings-changed` after a change.
 */
"use strict"
{
    const escape = text => webui.escapeForHTML(`${text ?? ''}`);

    function el(tag, attrs, text) {
        const node = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([name, value]) => {
            if (value === undefined || value === null || value === false) return;
            node.setAttribute(name, value === true ? '' : `${value}`);
        });
        if (text !== undefined) node.textContent = `${text}`;
        return node;
    }

    function button(label, theme, icon) {
        const btn = el('webui-button', { theme, 'start-icon': icon || null });
        btn.appendChild(el('span', {}, label));
        return btn;
    }

    webui.define("app-plugin-settings", {
        preload: 'input-text button dropdown',
        constructor() {
            this._load = 0;
        },
        attr: ['plugin'],
        attrChanged(property) {
            if (property === 'plugin' && this.isConnected) this.load();
        },
        connected() {
            this.classList.add('plugin-ui', 'plugin-settings');
            this.load();
        },
        disconnected() {
            this._load++;
        },
        async load() {
            const t = this;
            const id = t.getAttribute('plugin');
            if (!id) return;
            const load = ++t._load;
            await webui.wait(() => webui.proxy?.plugins);
            const view = await webui.proxy.plugins.settings(id);
            if (load !== t._load || !view) return;
            t.render(id, view);
        },
        /** Tells the app the settings changed, so the nav, notifications, and plugin pages catch up. */
        async changed() {
            await webui.proxy.plugins.refreshNav();
            this.dispatchEvent(new CustomEvent('plugin-settings-changed', { bubbles: true }));
            this.load();
        },
        render(id, view) {
            const t = this;
            const box = el('webui-flex', { column: true, gap: 'var(--padding)' });
            const project = webui.getData('app-current-project')?.display || 'this project';
            if (!view.hasProject) {
                box.appendChild(el('p', { class: 'plugin-empty' }, 'Settings belong to a project. Open one to set this plugin up for it.'));
                t.replaceChildren(box);
                return;
            }
            const settings = Array.isArray(view.settings) ? view.settings : [];
            const signIns = Array.isArray(view.signIns) ? view.signIns : [];
            if (!settings.length) {
                // A plugin with nothing to set up is turned on for each project that uses it.
                box.appendChild(el('p', { class: 'plugin-muted' }, view.used
                    ? `This plugin is on for ${project}.`
                    : `This plugin is off for ${project}, so it stays out of its menu. Turn it on to use it here.`));
                const turn = button(view.used ? 'Stop using it in this project' : 'Use in this project', view.used ? 'secondary' : 'primary', view.used ? 'xmark' : 'link');
                turn.dataset.role = 'use-in-project';
                turn.addEventListener('click', async () => {
                    if (await webui.proxy.plugins.useInProject(id, !view.used)) t.changed();
                });
                box.appendChild(turn);
                t.replaceChildren(box);
                return;
            }
            if (view.signIn) {
                const current = signIns.find(choice => choice.id === view.signIn);
                const others = Math.max((current?.projects || 1) - 1, 0);
                box.appendChild(el('p', { class: 'plugin-muted' }, others
                    ? `${project} uses these settings, as ${others === 1 ? 'one other project does' : `${others} other projects do`}. Changes here change them there too.`
                    : `These settings are for ${project} only.`));
                t.fields(box, id, settings, 'Save settings');
                const stop = button('Stop using them in this project', 'secondary', 'xmark');
                stop.dataset.role = 'stop-using';
                stop.addEventListener('click', () => {
                    webui.dialog.confirm(`Stop using these settings in ${escape(project)}? ${others ? 'The other projects keep them.' : 'They are forgotten, since no other project uses them.'}`, async () => {
                        if (await webui.proxy.plugins.useSignIn(id, null)) t.changed();
                        return true;
                    });
                });
                box.appendChild(stop);
            } else {
                if (signIns.length) {
                    box.appendChild(el('strong', {}, 'Use settings from another project'));
                    const row = el('webui-flex', { wrap: true, gap: 'var(--padding)', align: 'center', 'data-role': 'sign-in-choice' });
                    const choose = el('webui-dropdown', { label: 'Settings', style: 'flex: 1 1 16em;' });
                    choose.setAttribute('options', JSON.stringify(signIns.map(choice => ({
                        id: choice.id, value: choice.id,
                        // The dropdown shows display as text, so it is not escaped here.
                        display: `${choice.label} (${choice.projects === 1 ? '1 project' : `${choice.projects} projects`})`,
                    }))));
                    choose.setAttribute('value', signIns[0].id);
                    const use = button('Use these', 'primary', 'link');
                    use.addEventListener('click', async () => {
                        const chosen = choose.value || signIns[0].id;
                        if (await webui.proxy.plugins.useSignIn(id, chosen)) {
                            webui.alert(`${escape(project)} now uses those settings.`, 'success');
                            t.changed();
                        }
                    });
                    row.append(choose, use);
                    box.appendChild(row);
                    box.appendChild(el('strong', {}, 'Or enter new settings for this project'));
                } else {
                    box.appendChild(el('p', { class: 'plugin-muted' }, `Enter the settings for ${project}. Other projects keep their own.`));
                }
                t.fields(box, id, settings, 'Save for this project');
            }
            box.appendChild(el('small', { class: 'plugin-muted' },
                'Saved encrypted, for this plugin only. A project variable with the same name takes its place.'));
            t.replaceChildren(box);
        },
        /** The settings' inputs, and buttons to save them and to clear saved secrets. */
        fields(box, id, settings, saveLabel) {
            const t = this;
            const inputs = settings.map(setting => {
                const input = webui.create('webui-input-text', {
                    label: escape(setting.label),
                    name: setting.key,
                    type: setting.secret ? 'password' : null,
                    placeholder: setting.secret && setting.isSet ? 'Saved. Type a new value to replace it.' : null,
                });
                if (!setting.secret && setting.value) input.setAttribute('value', setting.value);
                box.appendChild(input);
                if (setting.help) box.appendChild(el('small', { class: 'plugin-muted' }, setting.help));
                return { setting, input };
            });
            const row = el('webui-flex', { wrap: true, gap: 'var(--padding)' });
            const save = button(saveLabel, 'primary', 'save');
            save.addEventListener('click', async () => {
                const values = {};
                inputs.forEach(({ setting, input }) => {
                    const value = `${input.value ?? ''}`;
                    // A secret left blank keeps its saved value.
                    if (setting.secret && !value) return;
                    values[setting.key] = value;
                });
                if (await webui.proxy.plugins.saveSettings(id, values)) {
                    webui.alert('Settings saved.', 'success');
                    t.changed();
                }
            });
            row.appendChild(save);
            inputs.filter(({ setting }) => setting.secret && setting.isSet).forEach(({ setting }) => {
                const clear = button(`Clear ${setting.label}`, 'secondary', 'eraser');
                clear.addEventListener('click', () => {
                    webui.dialog.confirm(`Clear the saved ${escape(setting.label)}?`, async () => {
                        if (await webui.proxy.plugins.saveSettings(id, { [setting.key]: '' })) t.changed();
                        return true;
                    });
                });
                row.appendChild(clear);
            });
            box.appendChild(row);
        },
    });
}
