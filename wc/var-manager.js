"use strict"
{
    const globalIgnorePrefixes = ['app-', 'page-'];
    const globalIgnoreKeys = ['webui-version', 'home-source'];
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
        const container = webui.create('header');
        container.style.padding = 'var(--padding)';
        container.setAttribute('slot', 'header');
        container.innerHTML = 'Variable Manager';
        return container;
    }
    function renderVariableList(container, scope, variables, isReadOnly, refreshCallback) {
        container.innerHTML = '';
        if (!variables || variables.length === 0) {
            container.appendChild(webui.create('webui-alert', { theme: 'info', html: `No ${scope} variables defined.` }));
            return;
        }
        variables.forEach(v => {
            const wrap = webui.create('webui-grid', { columns: '1fr 2fr max-content', gap: 'var(--padding)', style: 'margin-bottom: 0.5rem; align-items: center;' });
            wrap.appendChild(webui.create('span', { html: v.key }));
            const input = webui.create('webui-input-text', {
                value: v.value || '',
                disabled: isReadOnly
            });
            if (!isReadOnly) {
                input.addEventListener('input', (ev) => {
                    if (scope === 'Global') {
                        webui.setGlobalData(v.key, ev.target.value);
                        webui.setData(v.key, ev.target.value);
                        webui.proxy.saveAppData();
                    } else if (scope === 'Project') {
                        webui.setProjectData(v.key, ev.target.value);
                        webui.setData(v.key, ev.target.value);
                        const envs = getEnvironments();
                        const activeEnvName = getActiveEnvName();
                        if (activeEnvName && envs) {
                            const activeEnv = envs.find(e => e.name === activeEnvName);
                            if (activeEnv) {
                                if (!activeEnv.variables) activeEnv.variables = {};
                                activeEnv.variables[v.key] = ev.target.value;
                            }
                        }
                        webui.proxy.syncProjectData();
                    } else if (scope === 'Page') {
                        webui.setData(v.key, ev.target.value);
                    }
                });
            }
            wrap.appendChild(input);
            const actionsFlex = webui.create('webui-flex', { gap: '0.5rem', align: 'center' });
            const createIconBtn = (iconName, title, theme, onClick) => {
                let iconEl = webui.create('webui-icon', {
                    icon: `${iconName}|backing|shape:circle|theme:${theme}`,
                    title: title
                });
                iconEl.addEventListener('click', onClick);
                actionsFlex.appendChild(iconEl);
            };
            const copyToProj = () => {
                webui.setProjectData(v.key, input.value);
                webui.setData(v.key, input.value);
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
                        activeEnv.variables[v.key] = input.value;
                    }
                }
                webui.proxy.syncProjectData();
                webui.alert('Copied to Project Scope', 'success');
                if (refreshCallback) refreshCallback();
            };
            const copyToGlob = () => {
                webui.setGlobalData(v.key, input.value);
                webui.setData(v.key, input.value);
                if (!webui.taskProxyData.variables) webui.taskProxyData.variables = [];
                if (!webui.taskProxyData.variables.some(def => def.split('|')[0] === v.key)) {
                    webui.taskProxyData.variables.push(`${v.key}|text|`);
                }
                webui.proxy.saveAppData();
                webui.alert('Copied to Global Scope', 'success');
                if (refreshCallback) refreshCallback();
            };
            const clearValue = () => {
                webui.dialog({
                    title: 'Clear Variable',
                    content: `<p>Are you sure you want to clear the value of <strong>${v.key}</strong>?</p>`,
                    confirm: 'Clear',
                    cancel: 'Cancel',
                    onconfirm: () => {
                        input.value = '';
                        input.triggerChange(true);
                        return true;
                    }
                });
            };
            const deleteVar = () => {
                webui.dialog({
                    title: 'Delete Variable',
                    content: `<p>Are you sure you want to delete the variable <strong>${v.key}</strong>?</p><p style="color: var(--color-danger);">This action cannot be undone.</p>`,
                    confirm: 'Delete',
                    cancel: 'Cancel',
                    onconfirm: () => {
                        if (scope === 'Project') {
                            webui.projectData.variables = webui.projectData.variables.filter(def => def.split('|')[0] !== v.key);
                            webui.deleteProjectData(v.key);
                            webui.setData(v.key, '');
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
                            webui.setData(v.key, '');
                            webui.proxy.saveAppData();
                        }
                        if (refreshCallback) refreshCallback();
                        return true;
                    }
                });
            };
            const copyToClip = () => {
                webui.copyToClipboard(input.value);
            };
            if (scope === 'Page') {
                createIconBtn('emoji-package', 'Copy Value to Project Scope', 'info', copyToProj);
                createIconBtn('emoji-earth_americas', 'Copy Value to Global Scope', 'info', copyToGlob);
            }
            if (scope === 'Project') {
                createIconBtn('emoji-earth_americas', 'Copy Value to Global Scope', 'info', copyToGlob);
                createIconBtn('emoji-sponge', 'Clear Value', 'warning', clearValue);
                createIconBtn('emoji-wastebasket', 'Delete Variable', 'danger', deleteVar);
            }
            if (scope === 'Global') {
                createIconBtn('emoji-sponge', 'Clear Value', 'warning', clearValue);
                createIconBtn('emoji-wastebasket', 'Delete Variable', 'danger', deleteVar);
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
    <webui-toggle-icon data-bind="app-env-page-enabled" data-default="true" label="Page" theme-on="primary"></webui-toggle-icon>
    <webui-toggle-icon data-bind="app-env-project-enabled" data-default="true" label="Project" theme-on="primary"></webui-toggle-icon>
    <webui-toggle-icon data-bind="app-env-global-enabled" data-default="true" label="Global" theme-on="primary"></webui-toggle-icon>
</webui-flex>
<webui-tabs theme="secondary" index="1" transition-timing="200">
    <webui-button slot="tabs">Page</webui-button>
    <webui-content slot="content" nodetach>
        <div id="var-page-list"></div>
    </webui-content>
    <webui-button slot="tabs">Project</webui-button>
    <webui-content slot="content" nodetach>
        <webui-flex align="center" justify="start" gap="var(--padding)" style="margin-bottom: 1rem;">
            <label>Environment:</label>
            <webui-dropdown id="env-selector" style="flex-grow: 1; padding: 0.25rem;"></webui-dropdown>
            <webui-button id="btn-manage-env" label="Manage" theme="primary"></webui-button>
        </webui-flex>
        <webui-flex justify="center" gap="var(--padding)">
            <webui-input-text id="input-proj-var" data-bind="proj-var-name" label="Key"></webui-input-text>
            <webui-button id="btn-add-proj" label="Add" theme="success"></webui-button>
        </webui-flex>
        <div id="var-project-list" style="margin-top: 1rem;"></div>
    </webui-content>
    <webui-button slot="tabs">Global</webui-button>
    <webui-content slot="content" nodetach>
        <webui-flex justify="center" gap="var(--padding)">
            <webui-input-text id="input-glob-var" data-bind="glob-var-name" label="Key"></webui-input-text>
            <webui-button id="btn-add-glob" label="Add" theme="success"></webui-button>
        </webui-flex>
        <div id="var-global-list" style="margin-top: 1rem;"></div>
    </webui-content>
</webui-tabs>
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
            (webui.currentPageVariables || []).forEach(k => {
                if (!webui.projectData.variables) webui.projectData.variables = [];
                if (!webui.projectData.variables.some(v => v.split('|')[0] === k)) {
                    webui.projectData.variables.push(`${k}|text|`);
                    needsProjectSync = true;
                }
            });
            if (needsProjectSync) webui.proxy.syncProjectData();
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
            const pageVars = (webui.currentPageVariables || []).map(k => ({
                key: k,
                type: 'text',
                value: webui.getData(k) || ''
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
                    let newEnv = envs.find(e => e.name === newName);
                    if (webui.projectData.variables) {
                        webui.projectData.variables.forEach(def => {
                            let k = def.split('|')[0];
                            webui.deleteProjectData(k);
                            webui.setData(k, '');
                        });
                    }
                    setActiveEnvName(newName);
                    if (newEnv && newEnv.variables) {
                        Object.keys(newEnv.variables).forEach(k => {
                            webui.setProjectData(k, newEnv.variables[k]);
                            webui.setData(k, newEnv.variables[k]);
                        });
                    }
                    if (webui.proxy && webui.proxy.syncProjectData) webui.proxy.syncProjectData();
                    renderAllLists();
                });
            }
            const manageEnvBtn = container.querySelector('#btn-manage-env');
            if (manageEnvBtn) {
                manageEnvBtn.addEventListener('click', () => {
                    const dialogId = webui.uuid();
                    let envsHtml = getEnvironments().map(e => `
                        <webui-grid columns="1fr max-content max-content" gap="var(--padding)" align="center" style="margin-bottom: 0.5rem;">
                            <webui-input-text value="${e.name}"></webui-input-text>
                            <webui-button theme="success" class="env-save-btn" data-env="${e.name}">Save</webui-button>
                            <webui-button theme="danger" class="env-del-btn" data-env="${e.name}">Delete</webui-button>
                        </webui-grid>
                    `).join('');
                    let content = `
                        <div id="manage-envs-${dialogId}">
                            <webui-flex column gap="var(--padding)" style="margin-bottom: 1rem;">
                                ${envsHtml}
                            </webui-flex>
                            <webui-line></webui-line>
                            <webui-grid columns="1fr max-content" gap="var(--padding)" align="center" style="margin-top: 1rem;">
                                <webui-input-text id="new-env-input-${dialogId}" placeholder="New Environment Name"></webui-input-text>
                                <webui-button id="btn-add-env-${dialogId}" theme="primary">Add New</webui-button>
                            </webui-grid>
                        </div>
                    `;
                    webui.dialog({
                        title: 'Manage Environments',
                        content: content,
                        cancel: 'Done'
                    });
                    setTimeout(() => {
                        let manageContainer = webui.querySelector(`#manage-envs-${dialogId}`);
                        if(!manageContainer) return;
                        manageContainer.addEventListener('click', (ev) => {
                            let saveBtn = webui.closest(ev.target, '.env-save-btn');
                            if (saveBtn) {
                                let oldName = saveBtn.getAttribute('data-env');
                                let grid = webui.closest(saveBtn, 'webui-grid');
                                let input = grid.querySelector('webui-input-text');
                                if (!input) return;
                                let newName = input.value.trim();
                                if (!newName || newName === oldName) return;
                                let envs = getEnvironments();
                                if (envs.some(e => e.name.toLowerCase() === newName.toLowerCase())) {
                                    webui.dialog.alert('Environment name already exists', 'warning');
                                    return;
                                }
                                let env = envs.find(e => e.name === oldName);
                                if (env) {
                                    env.name = newName;
                                    if (getActiveEnvName() === oldName) {
                                        setActiveEnvName(newName);
                                    }
                                    webui.proxy.syncProjectData();
                                    webui.alert('Environment renamed', 'success');
                                    saveBtn.setAttribute('data-env', newName);
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
                                    webui.dialog.alert('You must have at least one environment.', 'warning');
                                    return;
                                }
                                webui.projectData.data._environments = envs.filter(e => e.name !== envName);
                                if (getActiveEnvName() === envName) {
                                    setActiveEnvName(webui.projectData.data._environments[0].name);
                                }
                                webui.proxy.syncProjectData();
                                let grid = webui.closest(delBtn, 'webui-grid');
                                if (grid) grid.remove();
                                webui.dialog.alert('Environment deleted', 'success');
                                renderAllLists();
                                return;
                            }
                            let addBtn = webui.closest(ev.target, `#btn-add-env-${dialogId}`);
                            if (addBtn) {
                                let input = webui.querySelector(`#new-env-input-${dialogId}`);
                                if (!input) return;
                                let envName = input.value.trim();
                                if (!envName) return;
                                let envs = getEnvironments();
                                if (envs.some(e => e.name.toLowerCase() === envName.toLowerCase())) {
                                    webui.dialog.alert('Environment already exists', 'warning');
                                    return;
                                }
                                envs.push({ name: envName, variables: {} });
                                webui.proxy.syncProjectData();
                                input.value = '';
                                webui.dialog.alert('Environment added', 'success');
                                let newGrid = webui.createFromHTML(`
                                    <webui-grid columns="1fr max-content max-content" gap="var(--padding)" align="center" style="margin-bottom: 0.5rem;">
                                        <webui-input-text value="${envName}"></webui-input-text>
                                        <webui-button theme="success" class="env-save-btn" data-env="${envName}">Save</webui-button>
                                        <webui-button theme="danger" class="env-del-btn" data-env="${envName}">Delete</webui-button>
                                    </webui-grid>
                                `);
                                let flex = manageContainer.querySelector('webui-flex');
                                if (flex) flex.appendChild(newGrid);
                                renderAllLists();
                                return;
                            }
                        });
                    }, 100);
                });
            }
            container.addEventListener('click', (ev) => {
                const btnAddProj = webui.closest(ev.target, '#btn-add-proj');
                if (btnAddProj) {
                    let input = container.querySelector('#input-proj-var');
                    let key = webui.getData('proj-var-name') || (input ? input.value : '');
                    key = key.trim();
                    if (!key) return;
                    if (!webui.projectData.variables) webui.projectData.variables = [];
                    if (!webui.projectData.variables.some(v => v.split('|')[0] === key)) {
                        webui.projectData.variables.push(`${key}|text|`);
                        webui.proxy.syncProjectData();
                        webui.setData('proj-var-name', '');
                        if (input) input.value = '';
                        renderAllLists();
                    } else {
                        webui.alert('Project variable already exists', 'warning');
                    }
                    return;
                }
                const btnAddGlob = webui.closest(ev.target, '#btn-add-glob');
                if (btnAddGlob) {
                    let input = container.querySelector('#input-glob-var');
                    let key = webui.getData('glob-var-name') || (input ? input.value : '');
                    key = key.trim();
                    if (!key) return;
                    if (!webui.taskProxyData.variables) webui.taskProxyData.variables = [];
                    if (!webui.taskProxyData.variables.some(v => v.split('|')[0] === key)) {
                        webui.taskProxyData.variables.push(`${key}|text|`);
                        webui.proxy.saveAppData();
                        webui.setData('glob-var-name', '');
                        if (input) input.value = '';
                        renderAllLists();
                    } else {
                        webui.alert('Global variable already exists', 'warning');
                    }
                    return;
                }
            });
            renderAllLists();
        }, 0);
        return container;
    }
    function openDrawer(drawer) {
        let el = document.querySelector(drawer);
        if (!el) {
            webui.alert('Drawer not found!');
            return;
        }
        if (el.classList.contains('open')) {
            el.classList.remove('open');
            setTimeout(() => openDrawer(drawer), 500);
            return;
        }
        el.innerHTML = '';
        el.appendChild(getHeaderContent());
        el.appendChild(getBodyContent(drawer));
        setTimeout(() => {
            el.classList.add('open');
        }, 100);
    }
    webui.define("app-var-manager", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: '',
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
            t.addEventListener('click', _ev => {
                openDrawer(t.drawer);
                return true;
            });
        },
        disconnected() { },
        shadowTemplate: `
<webui-icon icon="dollar|theme:tertiary"></webui-icon>
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
