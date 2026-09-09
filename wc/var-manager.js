
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
                    // Route value updates to the correct storage based on scope
                    if (scope === 'Global') {
                        webui.taskProxyData.data[v.key] = ev.target.value;
                        webui.proxy.saveAppData(); // Persist encrypted global secrets
                    } else if (scope === 'Project') {
                        webui.projectData.data[v.key] = ev.target.value;
                        webui.setData(`session-${v.key}`, ev.target.value);
                        webui.proxy.syncProjectData();
                    } else if (scope === 'Page') {
                        webui.setData(v.key, ev.target.value);
                    }
                });
            }
            wrap.appendChild(input);
            container.appendChild(wrap);
        });
    }

    function getBodyContent() {
        const container = webui.create('section');
        container.style.padding = 'var(--padding)';
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
            value: webui.getData(k) || ''
        }));
        container.innerHTML = `
            <webui-flex column gap="var(--padding)">
                <div class="scope-section">
                    <h3>Page Scope</h3>
                    <webui-toggle-icon label="Null Page Variables (Use Higher Scope)" theme-on="primary"></webui-toggle-icon>
                    <div id="var-page-list"></div>
                </div>
                <webui-line></webui-line>
                <div class="scope-section">
                    <h3>Project Scope</h3>
                    <div id="var-project-list"></div>
                </div>
                <webui-line></webui-line>
                <div class="scope-section">
                    <h3>Global Scope (Secrets)</h3>
                    <div id="var-global-list"></div>
                </div>
            </webui-flex>
        `;
        setTimeout(() => {
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
        el.appendChild(getBodyContent());
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