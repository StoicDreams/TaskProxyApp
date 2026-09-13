"use strict"
{
    const globalIgnorePrefixes = ['app-', 'page-'];
    const globalIgnoreKeys = ['webui-version', 'home-source'];
    function getHeaderContent() {
        const container = webui.create('header');
        container.style.padding = 'var(--padding)';
        container.setAttribute('slot', 'header');
        container.innerHTML = 'Variable Manager';
        return container;
    }
    function renderVariableList(container, scope, variables, isReadOnly) {
        container.innerHTML = '';
        if (!variables || variables.length === 0) {
            container.appendChild(webui.create('webui-alert', { theme: 'info', html: `No ${scope} variables defined.` }));
            return;
        }
        variables.forEach(v => {
            const wrap = webui.create('webui-grid', { columns: '1fr 2fr', gap: 'var(--padding)', style: 'margin-bottom: 0.5rem; align-items: center;' });
            wrap.appendChild(webui.create('span', { html: v.key }));
            const input = webui.create('webui-input-text', {
                value: v.value || '',
                disabled: isReadOnly
            });
            if (!isReadOnly) {
                input.addEventListener('input', (ev) => {
                    if (scope === 'Global') {
                        webui.taskProxyData.data[v.key] = ev.target.value;
                        webui.proxy.saveAppData();
                    } else if (scope === 'Project') {
                        webui.projectData.data[v.key] = ev.target.value;
                        webui.setData(`session-${v.key}`, ev.target.value);
                        webui.proxy.syncProjectData();
                    } else if (scope === 'Page') {
                        webui.setData(v.key, ev.target.value);
                        const activeEnvName = webui.projectData?.activeEnvironment;
                        if (activeEnvName && webui.projectData.environments) {
                            const activeEnv = webui.projectData.environments.find(e => e.name === activeEnvName);
                            if (activeEnv) {
                                const currentPage = webui.projectData.currentPage || '';
                                if (!activeEnv.pageVariables) activeEnv.pageVariables = {};
                                if (!activeEnv.pageVariables[currentPage]) activeEnv.pageVariables[currentPage] = {};
                                activeEnv.pageVariables[currentPage][v.key] = ev.target.value;
                                webui.proxy.syncProjectData();
                            }
                        }
                    }
                });
            }
            wrap.appendChild(input);
            container.appendChild(wrap);
        });
    }
    function getBodyContent(drawer) {
        const container = webui.create('section');
        container.style.padding = 'var(--padding)';
        if (!webui.projectData.environments || webui.projectData.environments.length === 0) {
            webui.projectData.environments = [{ name: 'dev', pageVariables: {} }];
            webui.projectData.activeEnvironment = 'dev';
            webui.proxy.syncProjectData();
        }
        const environments = webui.projectData.environments;
        let activeEnvName = webui.projectData.activeEnvironment || 'dev';
        if (!environments.some(e => e.name === activeEnvName)) {
            activeEnvName = environments[0].name;
            webui.projectData.activeEnvironment = activeEnvName;
        }
        const activeEnv = environments.find(e => e.name === activeEnvName);
        const currentPage = webui.projectData?.currentPage || '';
        const activePageVars = activeEnv?.pageVariables?.[currentPage] || {};
        const projectDefinitions = (webui.projectData?.variables || []).map(variableString => {
            let parts = variableString.split('|');
            return { key: parts[0] || '', type: parts[1] || 'text', defaultValue: parts[2] || '' };
        });
        const projectVars = projectDefinitions.map(d => ({
            ...d,
            value: webui.getData(`session-${d.key}`) || d.defaultValue
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
            value: activePageVars[k] !== undefined ? activePageVars[k] : (webui.getData(k) || '')
        }));
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
        <webui-flex align="center" justify="start" gap="var(--padding)" style="margin-bottom: 1rem;">
            <label>Environment:</label>
            <webui-dropdown id="env-selector" style="flex-grow: 1; padding: 0.25rem;"></webui-dropdown>
            <webui-button id="btn-new-env" label="New" theme="primary"></webui-button>
        </webui-flex>
        <div id="var-page-list"></div>
    </webui-content>
    <webui-button slot="tabs">Project</webui-button>
    <webui-content slot="content" nodetach>
        <webui-flex justify="center">
            <webui-input-text data-bind="proj-var-name" label="Key"></webui-input-text>
            <webui-button label="Add" theme="success"></webui-button>
        </webui-flex>
        <div id="var-project-list"></div>
    </webui-content>
    <webui-button slot="tabs">Global</webui-button>
    <webui-content slot="content" nodetach>
        <webui-flex justify="center">
            <webui-input-text data-bind="glob-var-name" label="Key"></webui-input-text>
            <webui-button label="Add" theme="success"></webui-button>
        </webui-flex>
        <div id="var-global-list"></div>
    </webui-content>
</webui-tabs>
`;
        setTimeout(() => {
            const envSelector = container.querySelector('#env-selector');
            if (envSelector) {
                envSelector.setOptions(environments.map(x => x.name));
                envSelector.value = activeEnv;
                envSelector.addEventListener('change', (ev) => {
                    webui.projectData.activeEnvironment = ev.target.value;
                    if (webui.proxy && webui.proxy.syncProjectData) webui.proxy.syncProjectData();
                    openDrawer(drawer);
                });
            }
            const newEnvBtn = container.querySelector('#btn-new-env');
            if (newEnvBtn) {
                newEnvBtn.addEventListener('click', async () => {
                    try {
                        await webui.dialog({
                            title: 'New Environment',
                            content: `
                                <webui-flex column gap="var(--padding)">
                                    <webui-input-text id="new-env-input" name="envName" maxlength="20" label="Environment Name"></webui-input-text>
                                </webui-flex>
                            `,
                            confirm: 'Create',
                            cancel: 'Cancel',
                            onconfirm: (data, content) => {
                                const inputNode = content.querySelector('webui-input-text');
                                data = Object.fromEntries(data);
                                let envName = data.envName.trim();
                                if (!envName.length) {
                                    content.alert('Environment name cannot be empty.');
                                    return false;
                                }
                                if (envName.length > 20) {
                                    content.alert('Environment name cannot be more than 20 characters.');
                                    return false;
                                }
                                if (!/^[a-zA-Z]/.test(envName)) {
                                    content.alert('Environment name must start with a letter.');
                                    return false;
                                }
                                if (!/^[a-zA-Z0-9 _-]+$/.test(envName)) {
                                    content.alert('Environment name can only contain letters, numbers, spaces, hyphens, and underscores.');
                                    return false;
                                }
                                if (webui.projectData.environments.some(e => e.name.toLowerCase() === envName.toLowerCase())) {
                                    content.alert('Environment already exists.');
                                    return false;
                                }
                                webui.projectData.environments.push({ name: envName, pageVariables: {} });
                                webui.projectData.activeEnvironment = envName;
                                if (webui.proxy && webui.proxy.syncProjectData) {
                                    webui.proxy.syncProjectData();
                                }
                                openDrawer(drawer);
                                return true;
                            }
                        });
                    } catch {}
                });
            }
            renderVariableList(container.querySelector('#var-page-list'), 'Page', pageVars, false);
            renderVariableList(container.querySelector('#var-project-list'), 'Project', projectVars, false);
            renderVariableList(container.querySelector('#var-global-list'), 'Global', globalVars, false);
        }, 0);
        return container;
    }
    function getBodyContentOld() {
        const container = webui.create('section');
        container.style.padding = 'var(--padding)';
        container.innerHTML = `<webui-alert variant="info" show>Coming Soon!</webui-alert>`;
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