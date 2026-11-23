"use strict"
{
    const globalIgnorePrefixes = ['app-', 'page-'];
    const globalIgnoreKeys = ['webui-version', 'app-home-source'];
    // Tokens belong to the project, not to one of its environments.
    const patKeys = ['git_pat', 'github_pat'];
    const appDataSaveDelay = 500;
    let appDataSaveTimer = null;
    /** Disk writes are saved for a pause in typing. Closing the app saves the backend's copy. */
    function saveAppDataSoon() {
        webui.proxy.syncAppData();
        clearTimeout(appDataSaveTimer);
        appDataSaveTimer = setTimeout(() => webui.proxy.saveAppData(), appDataSaveDelay);
    }
    function definedProjectKeys() {
        return (webui.projectData.variables || []).map(def => def.split('|')[0]).filter(key => !patKeys.includes(key));
    }
    /** Keep values not yet stored with the active environment, such as ones set before environments existed. */
    function captureEnvironmentValues(env) {
        if (!env) return;
        env.variables ??= {};
        definedProjectKeys().forEach(key => {
            let value = webui.getProjectData(key);
            if (value !== undefined && value !== '') env.variables[key] = value;
        });
    }
    function loadEnvironmentValues(env) {
        definedProjectKeys().forEach(key => {
            webui.deleteProjectData(key);
            // Clearing with undefined lets a global value of the same name show through.
            webui.setData(key, undefined);
        });
        Object.entries(env?.variables || {}).forEach(([key, value]) => {
            if (patKeys.includes(key)) return;
            webui.setProjectData(key, value);
            webui.setData(key, value);
        });
    }
    function getEnvironments() {
        if (!webui.projectData) webui.projectData = {};
        if (!webui.projectData.data) webui.projectData.data = {};
        if (webui.projectData.environments) {
            webui.projectData.data._environments = webui.projectData.environments;
            delete webui.projectData.environments;
        }
        if (webui.projectData.activeEnvironment) {
            webui.projectData.data._activeEnvironment = webui.projectData.activeEnvironment;
            delete webui.projectData.activeEnvironment;
        }
        if (!webui.projectData.data._environments || !webui.projectData.data._environments.length) {
            webui.projectData.data._environments = [{ name: 'dev', variables: {} }];
            webui.projectData.data._activeEnvironment = 'dev';
            if (webui.proxy && webui.proxy.syncProjectData) webui.proxy.syncProjectData();
        } else {
            let didMigrate = false;
            webui.projectData.data._environments.forEach(e => {
                if (!e.variables) {
                    e.variables = {};
                    didMigrate = true;
                }
            });
            if (didMigrate && webui.proxy && webui.proxy.syncProjectData) webui.proxy.syncProjectData();
        }
        return webui.projectData.data._environments;
    }
    function getActiveEnvName() {
        if (!webui.projectData) webui.projectData = {};
        if (!webui.projectData.data) webui.projectData.data = {};
        return webui.projectData.data._activeEnvironment || 'dev';
    }
    function setActiveEnvName(name) {
        if (!webui.projectData) webui.projectData = {};
        if (!webui.projectData.data) webui.projectData.data = {};
        webui.projectData.data._activeEnvironment = name;
    }
    function getHeaderContent() {
        const container = webui.create('div');
        container.style.padding = 'var(--padding)';
        container.setAttribute('slot', 'header');
        // A drawer's title, not a second banner for the page.
        container.setAttribute('role', 'heading');
        container.setAttribute('aria-level', '2');
        container.innerHTML = 'Variable Manager';
        return container;
    }
    /**
     * Whether a value is set but kept on the desktop. A remote device is sent `{ $secret: true }` in place of each
     * secret, so it can set one but never read it back.
     */
    const isKeptSecret = value => !!value && typeof value === 'object' && value.$secret === true;
    /**
     * A value as page scripts show it (services/page_scripts.rs): longer than 6 characters, only its first and last 3,
     * as `abc***xyz`, so a glance or a screen share doesn't give it away.
     */
    function maskValue(value) {
        const chars = [...`${value ?? ''}`];
        if (chars.length <= 6) return chars.join('');
        return `${chars.slice(0, 3).join('')}***${chars.slice(-3).join('')}`;
    }
    function renderVariableList(container, scope, variables, isReadOnly, refreshCallback) {
        // What was said under the list was about the rows drawn before. Each row's own notes go with it.
        clearActionNote(container);
        container.innerHTML = '';
        if (!variables || variables.length === 0) {
            container.appendChild(webui.create('webui-alert', { theme: 'info', html: `No ${scope} variables defined.` }));
            return;
        }
        variables.forEach(v => {
            const wrap = webui.create('webui-grid', { columns: '1fr 2fr max-content', gap: 'var(--padding)', style: 'margin-bottom: 0.5rem; align-items: center;' });
            // What a row's icons say without drawing the list again goes under that row.
            wrap.setAttribute('data-action-row', '');
            wrap.appendChild(webui.create('span', { text: v.key }));
            // The key beside it is plain text, so the input is named for screen readers.
            // A value kept on the desktop stays kept until it is cleared, which empties it there too.
            let kept = isKeptSecret(v.value);
            // The field shows the value masked, and the value itself while it is being edited.
            let actual = kept ? '' : `${v.value ?? ''}`;
            const input = webui.create('webui-input-text', { value: maskValue(actual), 'aria-label': `${scope} value of ${v.key}` });
            input.dataset.masked = 'true';
            input.addEventListener('focusin', () => {
                if (input.dataset.masked !== 'true') return;
                input.dataset.masked = 'false';
                input.value = actual;
            });
            input.addEventListener('focusout', () => {
                if (!isReadOnly) replaceKept();
                input.dataset.masked = 'true';
                input.value = maskValue(actual);
            });
            if (kept) {
                // Typing replaces the value. Leaving the field empty keeps it.
                input.setAttribute('placeholder', 'Set. Type to replace it.');
                input.setAttribute('title', 'This value is kept on the desktop. Type to replace it.');
                input.dataset.kept = 'true';
            }
            // Setting this attribute to false would still disable the input.
            if (isReadOnly) input.setAttribute('disabled', 'true');
            /** Writes a value for this variable to its scope, as it is: text, or the marker of a value kept on the desktop. */
            const writeScopeValue = value => {
                if (scope === 'Global') {
                    webui.setGlobalData(v.key, value);
                    webui.setData(v.key, value);
                    saveAppDataSoon();
                } else if (scope === 'Project') {
                    webui.setProjectData(v.key, value);
                    webui.setData(v.key, value);
                    const envs = getEnvironments();
                    const activeEnvName = getActiveEnvName();
                    if (activeEnvName && envs) {
                        const activeEnv = envs.find(e => e.name === activeEnvName);
                        if (activeEnv) {
                            if (!activeEnv.variables) activeEnv.variables = {};
                            activeEnv.variables[v.key] = value;
                        }
                    }
                    webui.proxy.syncProjectData();
                } else if (scope === 'Page') {
                    webui.setData(v.key, value);
                }
            };
            /** Saves a new value for this variable in its scope, which replaces one kept on the desktop. */
            const saveValue = value => {
                actual = `${value ?? ''}`;
                if (kept) {
                    // Replaced or cleared, so nothing is kept on the desktop any more.
                    kept = false;
                    // Emptied, not removed: Web UI's loader throws removing an attribute a component defines a property for.
                    input.setAttribute('placeholder', '');
                    input.removeAttribute('title');
                    delete input.dataset.kept;
                }
                writeScopeValue(actual);
            };
            /**
             * A value kept on the desktop is replaced only once its field is left with text in it, or Enter is pressed.
             * Saved as it was typed, its first character would replace the secret on the desktop at once, and erasing
             * the text could not bring it back.
             */
            const replaceKept = () => {
                if (!kept || input.dataset.masked === 'true') return;
                const typed = `${input.value ?? ''}`;
                if (typed !== '') saveValue(typed);
            };
            if (!isReadOnly) {
                input.addEventListener('input', () => {
                    // Only what is typed is a value. The masked copy is never saved.
                    if (input.dataset.masked === 'true') return;
                    // What is typed over a kept value is saved when the field is left.
                    if (kept) return;
                    saveValue(input.value);
                });
                input.addEventListener('keydown', ev => {
                    if (ev.key === 'Enter') replaceKept();
                });
            }
            wrap.appendChild(input);
            const actionsFlex = webui.create('webui-flex', { gap: '0.5rem', align: 'center' });
            const createIconBtn = (iconName, title, theme, onClick) => {
                let iconEl = webui.create('webui-icon', {
                    icon: `circle_${iconName}|backing|theme:${theme}`,
                    title: title
                });
                iconEl.addEventListener('click', () => onClick(iconEl));
                makeButton(iconEl, `${title}: ${v.key}`);
                actionsFlex.appendChild(iconEl);
            };
            // A value kept on the desktop can only be copied there.
            const keptHere = icon => {
                if (!kept || actual) return false;
                // Said under this row, by the icon clicked.
                actionNote(icon, `${v.key} is kept on the desktop, so copy it there.`, 'info');
                return true;
            };
            /** Clears what an earlier action said, under the list and under this row. */
            const clearNotes = icon => {
                clearActionNote(container);
                clearActionNote(icon);
            };
            const copyToProj = icon => {
                clearNotes(icon);
                if (keptHere(icon)) return;
                // The field shows the value masked once it loses focus, so the value itself is copied.
                webui.setProjectData(v.key, actual);
                webui.setData(v.key, actual);
                if (!webui.projectData.variables) webui.projectData.variables = [];
                if (!webui.projectData.variables.some(def => def.split('|')[0] === v.key)) {
                    webui.projectData.variables.push(`${v.key}|text|`);
                }
                const envs = getEnvironments();
                const activeEnvName = getActiveEnvName();
                if (activeEnvName && envs) {
                    const activeEnv = envs.find(e => e.name === activeEnvName);
                    if (activeEnv) {
                        if (!activeEnv.variables) activeEnv.variables = {};
                        activeEnv.variables[v.key] = actual;
                    }
                }
                webui.projectData.variables.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                webui.proxy.syncProjectData();
                if (refreshCallback) refreshCallback();
                actionNote(container, `Copied ${v.key} to the project's variables.`, 'success');
            };
            const copyToGlob = icon => {
                clearNotes(icon);
                if (keptHere(icon)) return;
                webui.setGlobalData(v.key, actual);
                webui.setData(v.key, actual);
                if (!webui.taskProxyData.variables) webui.taskProxyData.variables = [];
                if (!webui.taskProxyData.variables.some(def => def.split('|')[0] === v.key)) {
                    webui.taskProxyData.variables.push(`${v.key}|text|`);
                }
                webui.taskProxyData.variables.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                webui.proxy.saveAppData();
                if (refreshCallback) refreshCallback();
                actionNote(container, `Copied ${v.key} to the global variables.`, 'success');
            };
            const clearValue = icon => {
                clearNotes(icon);
                webui.dialog({
                    title: 'Clear Variable',
                    content: `<p>Are you sure you want to clear the value of <strong>${webui.escapeForHTML(v.key)}</strong>?</p>`,
                    confirm: 'Clear',
                    cancel: 'Cancel',
                    onconfirm: () => {
                        // The field is masked once the dialog has its focus, so the value is saved here, not by its input.
                        saveValue('');
                        input.value = '';
                        return true;
                    }
                });
            };
            const deleteVar = icon => {
                clearNotes(icon);
                webui.dialog({
                    title: 'Delete Variable',
                    content: `<p>Are you sure you want to delete the variable <strong>${webui.escapeForHTML(v.key)}</strong>?</p><p style="background: var(--color-danger); color: var(--color-danger-offset); padding: 0.25em 0.5em; border-radius: var(--corners);">This action cannot be undone.</p>`,
                    confirm: 'Delete',
                    cancel: 'Cancel',
                    onconfirm: () => {
                        if (scope === 'Project') {
                            webui.projectData.variables = webui.projectData.variables.filter(def => def.split('|')[0] !== v.key);
                            webui.deleteProjectData(v.key);
                            webui.setData(v.key, undefined);
                            const envs = getEnvironments();
                            envs.forEach(e => {
                                if (e.variables && e.variables[v.key] !== undefined) {
                                    delete e.variables[v.key];
                                }
                            });
                            webui.proxy.syncProjectData();
                        } else if (scope === 'Global') {
                            webui.taskProxyData.variables = webui.taskProxyData.variables.filter(def => def.split('|')[0] !== v.key);
                            webui.deleteGlobalData(v.key);
                            webui.setData(v.key, undefined);
                            webui.proxy.saveAppData();
                        }
                        if (refreshCallback) refreshCallback();
                        return true;
                    }
                });
            };
            const copyToClip = icon => {
                clearNotes(icon);
                if (keptHere(icon)) return;
                webui.copyToClipboard(actual);
            };
            if (scope === 'Page') {
                createIconBtn('folder', 'Copy Value to Project Scope', 'info', copyToProj);
                createIconBtn('globe', 'Copy Value to Global Scope', 'info', copyToGlob);
            }
            if (scope === 'Project') {
                createIconBtn('globe', 'Copy Value to Global Scope', 'info', copyToGlob);
                createIconBtn('eraser', 'Clear Value', 'warning', clearValue);
                createIconBtn('trash', 'Delete Variable', 'danger', deleteVar);
            }
            if (scope === 'Global') {
                createIconBtn('eraser', 'Clear Value', 'warning', clearValue);
                createIconBtn('trash', 'Delete Variable', 'danger', deleteVar);
            }
            createIconBtn('copy', 'Copy Value to Clipboard', 'info', copyToClip);
            wrap.appendChild(actionsFlex);
            container.appendChild(wrap);
        });
    }
    function getBodyContent(drawer) {
        const container = webui.create('section');
        container.style.padding = 'var(--padding)';
        getEnvironments();
        container.innerHTML = `
<webui-flex align="center" justify="start">
    <label>Enabled</label>
    <webui-toggle-icon data-bind="app-env-page-enabled" label="Page" theme-on="primary"></webui-toggle-icon>
    <webui-toggle-icon data-bind="app-env-project-enabled" label="Project" theme-on="primary"></webui-toggle-icon>
    <webui-toggle-icon data-bind="app-env-global-enabled" label="Global" theme-on="primary"></webui-toggle-icon>
</webui-flex>
<webui-tabs theme="secondary" index="1" transition-timing="200">
    <webui-button slot="tabs">Page</webui-button>
    <webui-content slot="content" nodetach>
        <div id="var-page-list" data-action-row></div>
    </webui-content>
    <webui-button slot="tabs">Project</webui-button>
    <webui-content slot="content" nodetach>
        <webui-flex align="center" justify="start" gap="var(--padding)" style="margin-bottom: 1rem;">
            <label>Environment:</label>
            <webui-select id="env-selector" aria-label="Environment" title="Environments" style="flex-grow: 1; padding: 0.25rem;"></webui-select>
            <webui-button id="btn-manage-env" label="Manage" theme="primary"></webui-button>
        </webui-flex>
        <webui-flex justify="center" gap="var(--padding)">
            <webui-input-text id="input-proj-var" data-bind="proj-var-name" label="Key"></webui-input-text>
            <webui-button id="btn-add-proj" label="Add" theme="success" title="Type a key to add" disabled></webui-button>
        </webui-flex>
        <div id="var-project-list" data-action-row style="margin-top: 1rem;"></div>
    </webui-content>
    <webui-button slot="tabs">Global</webui-button>
    <webui-content slot="content" nodetach>
        <webui-flex justify="center" gap="var(--padding)">
            <webui-input-text id="input-glob-var" data-bind="glob-var-name" label="Key"></webui-input-text>
            <webui-button id="btn-add-glob" label="Add" theme="success" title="Type a key to add" disabled></webui-button>
        </webui-flex>
        <div id="var-global-list" data-action-row style="margin-top: 1rem;"></div>
    </webui-content>
</webui-tabs>
<webui-content src="d/help/variable_management.md" style="margin-top: var(--padding);"></webui-content>
`;
        const renderAllLists = () => {
            const environments = getEnvironments();
            let activeEnvName = getActiveEnvName();
            if (!environments.some(e => e.name === activeEnvName)) {
                activeEnvName = environments[0].name;
                setActiveEnvName(activeEnvName);
            }
            let envSelector = container.querySelector('#env-selector');
            if (envSelector) {
                envSelector.setOptions(environments.map(x => x.name));
                envSelector.value = activeEnvName;
            }
            let needsProjectSync = false;
            if (!webui.projectData.variables) webui.projectData.variables = [];
            (webui.currentPageVariables || []).forEach(k => {
                if (!webui.projectData.variables.some(v => v.split('|')[0] === k)) {
                    webui.projectData.variables.push(`${k}|text|`);
                    needsProjectSync = true;
                }
            });
            let origProjStr = JSON.stringify(webui.projectData.variables);
            webui.projectData.variables.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            if (origProjStr !== JSON.stringify(webui.projectData.variables)) {
                needsProjectSync = true;
            }
            if (needsProjectSync) webui.proxy.syncProjectData();
            if (webui.taskProxyData && webui.taskProxyData.variables) {
                let origGlobStr = JSON.stringify(webui.taskProxyData.variables);
                webui.taskProxyData.variables.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                if (origGlobStr !== JSON.stringify(webui.taskProxyData.variables)) {
                    webui.proxy.saveAppData();
                }
            }
            const activeEnv = environments.find(e => e.name === activeEnvName) || environments[0];
            const activeProjectVars = activeEnv?.variables || {};
            const projectDefinitions = (webui.projectData?.variables || []).map(variableString => {
                let parts = variableString.split('|');
                return { key: parts[0] || '', type: parts[1] || 'text', defaultValue: parts[2] || '' };
            });
            const projectVars = projectDefinitions.map(d => ({
                ...d,
                value: activeProjectVars[d.key] !== undefined ? activeProjectVars[d.key] : (webui.getProjectData(d.key) || d.defaultValue)
            }));
            const globalDefinitions = (webui.taskProxyData?.variables || []).map(variableString => {
                let parts = variableString.split('|');
                return { key: parts[0] || '', type: parts[1] || 'text', defaultValue: parts[2] || '' };
            });
            const globalVars = globalDefinitions
                .filter(d => !globalIgnorePrefixes.some(prefix => d.key.startsWith(prefix)) && !globalIgnoreKeys.includes(d.key))
                .map(d => ({
                    ...d,
                    type: 'secret',
                    value: webui.taskProxyData?.data[d.key] || d.defaultValue
                }));
            const pageVars = (webui.currentPageVariables || []).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map(k => ({
                key: k,
                type: 'text',
                value: webui.getVariable(k) || ''
            }));
            renderVariableList(container.querySelector('#var-page-list'), 'Page', pageVars, false, renderAllLists);
            renderVariableList(container.querySelector('#var-project-list'), 'Project', projectVars, false, renderAllLists);
            renderVariableList(container.querySelector('#var-global-list'), 'Global', globalVars, false, renderAllLists);
        };
        setTimeout(() => {
            const envSelector = container.querySelector('#env-selector');
            if (envSelector) {
                envSelector.addEventListener('change', (ev) => {
                    let newName = ev.target.value;
                    if (newName === getActiveEnvName()) return;
                    let envs = getEnvironments();
                    captureEnvironmentValues(envs.find(e => e.name === getActiveEnvName()));
                    setActiveEnvName(newName);
                    loadEnvironmentValues(envs.find(e => e.name === newName));
                    if (webui.proxy && webui.proxy.syncProjectData) webui.proxy.syncProjectData();
                    renderAllLists();
                });
            }
            const manageEnvBtn = container.querySelector('#btn-manage-env');
            if (manageEnvBtn) {
                manageEnvBtn.addEventListener('click', () => {
                    const dialogId = webui.uuid();
                    // Save renames, so it waits for a new name. Delete waits for another environment to be left.
                    const envRowHtml = name => {
                        const escaped = webui.escapeForHTML(name);
                        const onlyOne = getEnvironments().length <= 1;
                        return `
                        <webui-grid columns="1fr max-content max-content" gap="var(--padding)" align="center" style="margin-bottom: 0.5rem;">
                            <webui-input-text value="${escaped}"></webui-input-text>
                            <webui-button theme="success" class="env-save-btn" data-env="${escaped}" title="Type a new name to rename it" disabled>Save</webui-button>
                            <webui-button theme="danger" class="env-del-btn" data-env="${escaped}" ${onlyOne ? 'title="You must have at least one environment." disabled' : 'title="Delete this environment"'}>Delete</webui-button>
                        </webui-grid>
                    `;
                    };
                    /** Save is on while its row's name is new and not empty. */
                    const refreshSave = saveBtn => {
                        const input = webui.closest(saveBtn, 'webui-grid')?.querySelector('webui-input-text');
                        const name = `${input?.value ?? ''}`.trim();
                        const can = !!name && name !== saveBtn.getAttribute('data-env');
                        saveBtn.toggleAttribute('disabled', !can);
                        saveBtn.setAttribute('title', can ? 'Rename this environment' : 'Type a new name to rename it');
                    };
                    /** Delete is on while there is another environment to keep. */
                    const refreshDeletes = manageContainer => {
                        const onlyOne = getEnvironments().length <= 1;
                        manageContainer.querySelectorAll('.env-del-btn').forEach(btn => {
                            btn.toggleAttribute('disabled', onlyOne);
                            btn.setAttribute('title', onlyOne ? 'You must have at least one environment.' : 'Delete this environment');
                        });
                    };
                    /** Add New is on while its field has a name. */
                    const refreshAdd = manageContainer => {
                        const addBtn = manageContainer.querySelector(`#btn-add-env-${dialogId}`);
                        // Its id moves to the input in its shadow root.
                        const input = manageContainer.querySelector('webui-input-text.new-env-input');
                        if (!addBtn) return;
                        const can = !!`${input?.value ?? ''}`.trim();
                        addBtn.toggleAttribute('disabled', !can);
                        addBtn.setAttribute('title', can ? 'Add this environment' : 'Type a name to add an environment');
                    };
                    let envsHtml = getEnvironments().map(e => envRowHtml(e.name)).join('');
                    let content = `
                        <div id="manage-envs-${dialogId}">
                            <webui-flex column gap="var(--padding)" style="margin-bottom: 1rem;">
                                ${envsHtml}
                            </webui-flex>
                            <webui-line></webui-line>
                            <webui-grid columns="1fr max-content" gap="var(--padding)" align="center" style="margin-top: 1rem;">
                                <webui-input-text id="new-env-input-${dialogId}" class="new-env-input" placeholder="New Environment Name"></webui-input-text>
                                <webui-button id="btn-add-env-${dialogId}" theme="primary" title="Type a name to add an environment" disabled>Add New</webui-button>
                            </webui-grid>
                        </div>
                    `;
                    // Clicks are handled from the document until the dialog closes, so its buttons work as soon as they
                    // show. A listener put on the dialog's content once it had been drawn missed a click made before then.
                    const onManageClick = (ev) => {
                        let manageContainer = webui.querySelector(`#manage-envs-${dialogId}`);
                        if (!manageContainer || !ev.composedPath().includes(manageContainer)) return;
                        let saveBtn = webui.closest(ev.target, '.env-save-btn');
                        if (saveBtn) {
                            let oldName = saveBtn.getAttribute('data-env');
                            let grid = webui.closest(saveBtn, 'webui-grid');
                            let input = grid.querySelector('webui-input-text');
                            if (!input) return;
                            let newName = input.value.trim();
                            // Nothing to rename, so what was said about an earlier try goes.
                            if (!newName || newName === oldName) {
                                clearActionNote(saveBtn);
                                return;
                            }
                            let envs = getEnvironments();
                            if (envs.some(e => e.name.toLowerCase() === newName.toLowerCase())) {
                                actionNote(saveBtn, 'Environment name already exists', 'warning');
                                return;
                            }
                            let env = envs.find(e => e.name === oldName);
                            if (env) {
                                env.name = newName;
                                if (getActiveEnvName() === oldName) {
                                    setActiveEnvName(newName);
                                }
                                webui.proxy.syncProjectData();
                                actionNote(saveBtn, 'Environment renamed', 'success');
                                saveBtn.setAttribute('data-env', newName);
                                refreshSave(saveBtn);
                                let delBtn = grid.querySelector('.env-del-btn');
                                if (delBtn) delBtn.setAttribute('data-env', newName);
                                renderAllLists();
                            }
                            return;
                        }
                        let delBtn = webui.closest(ev.target, '.env-del-btn');
                        if (delBtn) {
                            let envName = delBtn.getAttribute('data-env');
                            let envs = getEnvironments();
                            if (envs.length <= 1) {
                                actionNote(delBtn, 'You must have at least one environment.', 'warning');
                                return;
                            }
                            webui.projectData.data._environments = envs.filter(e => e.name !== envName);
                            if (getActiveEnvName() === envName) {
                                const nextEnv = webui.projectData.data._environments[0];
                                setActiveEnvName(nextEnv.name);
                                loadEnvironmentValues(nextEnv);
                            }
                            webui.proxy.syncProjectData();
                            let grid = webui.closest(delBtn, 'webui-grid');
                            // What was said by its buttons goes with it.
                            grid?._actionNote?.remove();
                            grid?.remove();
                            refreshDeletes(manageContainer);
                            // Its row is gone, so this is said by Add New.
                            actionNote(manageContainer.querySelector(`#btn-add-env-${dialogId}`), `Environment ${envName} deleted`, 'success');
                            renderAllLists();
                            return;
                        }
                        let addBtn = webui.closest(ev.target, `#btn-add-env-${dialogId}`);
                        if (addBtn) {
                            let input = webui.querySelector(`#new-env-input-${dialogId}`);
                            if (!input) return;
                            let envName = input.value.trim();
                            if (!envName) {
                                clearActionNote(addBtn);
                                return;
                            }
                            let envs = getEnvironments();
                            if (envs.some(e => e.name.toLowerCase() === envName.toLowerCase())) {
                                actionNote(addBtn, 'Environment already exists', 'warning');
                                return;
                            }
                            envs.push({ name: envName, variables: {} });
                            webui.proxy.syncProjectData();
                            input.value = '';
                            actionNote(addBtn, 'Environment added', 'success');
                            let newGrid = webui.createFromHTML(envRowHtml(envName).trim());
                            let flex = manageContainer.querySelector('webui-flex');
                            if (flex) flex.appendChild(newGrid);
                            refreshAdd(manageContainer);
                            refreshDeletes(manageContainer);
                            renderAllLists();
                            return;
                        }
                    };
                    // What is typed turns the buttons that use it on or off.
                    const onManageInput = (ev) => {
                        let manageContainer = webui.querySelector(`#manage-envs-${dialogId}`);
                        if (!manageContainer || !ev.composedPath().includes(manageContainer)) return;
                        // webui-input-text moves its id to its own input.
                        const path = ev.composedPath();
                        const field = path.find(node => node.localName === 'webui-input-text');
                        if (!field) return;
                        // With nothing to add or rename, what was said about an earlier try goes.
                        if (path.some(node => node.id === `new-env-input-${dialogId}`)) {
                            refreshAdd(manageContainer);
                            const addBtn = manageContainer.querySelector(`#btn-add-env-${dialogId}`);
                            if (addBtn?.hasAttribute('disabled')) clearActionNote(addBtn);
                            return;
                        }
                        const saveBtn = webui.closest(field, 'webui-grid')?.querySelector('.env-save-btn');
                        if (!saveBtn) return;
                        refreshSave(saveBtn);
                        if (saveBtn.hasAttribute('disabled')) clearActionNote(saveBtn);
                    };
                    document.addEventListener('click', onManageClick);
                    document.addEventListener('input', onManageInput);
                    const stopManaging = () => {
                        document.removeEventListener('click', onManageClick);
                        document.removeEventListener('input', onManageInput);
                    };
                    Promise.resolve(webui.dialog({
                        title: 'Manage Environments',
                        content: content,
                        cancel: 'Done'
                    })).then(stopManaging, stopManaging);
                });
            }
            // Add waits for a key to be typed.
            // Each key's id moves to the input in its shadow root, so the field is found by what it binds.
            const refreshAddKey = (bind, buttonId) => {
                const input = container.querySelector(`webui-input-text[data-bind="${bind}"]`);
                const button = container.querySelector(buttonId);
                if (!button) return;
                const can = !!`${input?.value ?? ''}`.trim();
                button.toggleAttribute('disabled', !can);
                button.setAttribute('title', can ? 'Add this variable' : 'Type a key to add');
            };
            const refreshAddKeys = () => {
                refreshAddKey('proj-var-name', '#btn-add-proj');
                refreshAddKey('glob-var-name', '#btn-add-glob');
            };
            // With no key, what was said about an earlier one goes.
            // webui-input-text moves its id to its own input, so typing is found by the id in the event's path.
            container.addEventListener('input', ev => {
                const path = ev.composedPath();
                [['input-proj-var', '#btn-add-proj'], ['input-glob-var', '#btn-add-glob']].forEach(([inputId, buttonId]) => {
                    if (!path.some(node => node.id === inputId)) return;
                    refreshAddKeys();
                    const button = container.querySelector(buttonId);
                    if (button?.hasAttribute('disabled')) clearActionNote(button);
                });
            });
            container.addEventListener('click', (ev) => {
                const btnAddProj = webui.closest(ev.target, '#btn-add-proj');
                if (btnAddProj) {
                    let input = container.querySelector('#input-proj-var');
                    let key = webui.getData('proj-var-name') || (input ? input.value : '');
                    key = key.trim();
                    // What was said about an earlier name goes, whatever happens with this one.
                    clearActionNote(btnAddProj);
                    if (!key) return;
                    if (!webui.projectData.variables) webui.projectData.variables = [];
                    if (!webui.projectData.variables.some(v => v.split('|')[0] === key)) {
                        webui.projectData.variables.push(`${key}|text|`);
                        webui.projectData.variables.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                        webui.proxy.syncProjectData();
                        webui.setData('proj-var-name', '');
                        if (input) input.value = '';
                        // Its id is on the input in its shadow root, so the field itself is emptied too.
                        const field = container.querySelector('webui-input-text[data-bind="proj-var-name"]');
                        if (field) field.value = '';
                        refreshAddKeys();
                        renderAllLists();
                    } else {
                        actionNote(btnAddProj, 'Project variable already exists', 'warning');
                    }
                    return;
                }
                const btnAddGlob = webui.closest(ev.target, '#btn-add-glob');
                if (btnAddGlob) {
                    let input = container.querySelector('#input-glob-var');
                    let key = webui.getData('glob-var-name') || (input ? input.value : '');
                    key = key.trim();
                    clearActionNote(btnAddGlob);
                    if (!key) return;
                    if (!webui.taskProxyData.variables) webui.taskProxyData.variables = [];
                    if (!webui.taskProxyData.variables.some(v => v.split('|')[0] === key)) {
                        webui.taskProxyData.variables.push(`${key}|text|`);
                        webui.taskProxyData.variables.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                        webui.proxy.saveAppData();
                        webui.setData('glob-var-name', '');
                        if (input) input.value = '';
                        // Its id is on the input in its shadow root, so the field itself is emptied too.
                        const field = container.querySelector('webui-input-text[data-bind="glob-var-name"]');
                        if (field) field.value = '';
                        refreshAddKeys();
                        renderAllLists();
                    } else {
                        actionNote(btnAddGlob, 'Global variable already exists', 'warning');
                    }
                    return;
                }
            });
            renderAllLists();
            // Tabs disable named inputs in tabs that are not shown. Web UI versions before the
            // index attribute worked left the starting tab's inputs disabled, so select it again.
            const tabs = container.querySelector('webui-tabs');
            webui.wait(() => typeof tabs.setTab === 'function').then(() => webui.wait(50)).then(() => {
                tabs.setTab(Number(tabs.getAttribute('index')) || 0);
                // A key kept from before shows in its field once the field is drawn.
                refreshAddKeys();
            });
        }, 0);
        return container;
    }
    /** Shows the Variable Manager in `target`, a Tools tab or a drawer. */
    function openDrawer(target) {
        const el = typeof target === 'string' ? document.querySelector(target) : target;
        if (!el) {
            // The app's own setup is wrong, and nothing on screen is near enough to say it by.
            appAlert('Drawer not found!');
            return;
        }
        showTool(el, getHeaderContent(), getBodyContent(el));
    }
    webui.define("app-var-manager", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: 'select',
        constructor() {
            const t = this;
            t.icon = t.template.querySelector('webui-icon');
        },
        attr: ['data-toggleclass'],
        flags: [],
        attrChanged(property, value) {
            const t = this;
            switch (property) {
                case 'dataToggleclass':
                    t.drawer = value.split('|')[0];
                    break;
            }
        },
        connected() {
            const t = this;
            makeButton(t);
            t.addEventListener('click', _ev => {
                t.open();
                return true;
            });
            // The number of variables on the page shown, set by the page handler as each page loads.
            const showCount = count => {
                t.icon.setAttribute('count', count > 0 ? count : '');
                toolsPanelOf(t)?.setCount('variables', count);
            };
            t._onPageVariables = ev => showCount(ev.detail);
            window.addEventListener('app-page-variables', t._onPageVariables);
            showCount((webui.currentPageVariables || []).length);
        },
        /** Opens the Variable Manager, as the Variables tab of Tools when it is one. `target` is where Tools has it draw. */
        open({ target = null } = {}) {
            const t = this;
            const tools = toolsPanelOf(t);
            if (tools && !target) {
                tools.show('variables');
                return;
            }
            openDrawer(target || t.drawer);
        },
        disconnected() {
            window.removeEventListener('app-page-variables', this._onPageVariables);
        },
        shadowTemplate: `
<webui-icon icon="circle_dollar|theme:tertiary|fill|backing|bordered"></webui-icon>
<style type="text/css">
:host {
    display:inline-flex;
    cursor:pointer;
    padding:1px;
    align-items:center;
    justify-content:center;
}
</style>
`
    });
}
