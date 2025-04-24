"use strict"
{
    function createNewPage() {
        return {
            name: '',
            icon: 'star',
            url: `/${webui.uuid()}`
        };
    }
    function createNewFolder() {
        return {
            name: '',
            icon: 'diamond',
            children: []
        };
    }
    webui.define("app-nav-manager", {
        linkCss: true,
        watchVisibility: false,
        isInput: false,
        preload: '',
        nav: [],
        constructor: (t) => {
            let link = {
                name: '',
                icon: '',
                url: '',
                children: [],
            };
            t._navDetail = t.template.querySelector('span.detail');
            t._navPreview = t.template.querySelector('app-nav-preview');
            t._navName = t.template.querySelector('webui-input-text[label="Name"]');
            t._navIcon = t.template.querySelector('webui-input-text[label="Icon"]');
            t._btnAddFolder = t.template.querySelector('webui-button[label="Add Folder"]');
            t._btnAddPage = t.template.querySelector('webui-button[label="Add Page"]');
            t._btnDelete = t.template.querySelector('webui-button[label="Delete"]');
            t._btnSave = t.template.querySelector('webui-button[label="Save"]');
            t._btnCancel = t.template.querySelector('webui-button[label="Cancel"]');
            t._iconSearch = t.template.querySelector('webui-icon-search');
            t.dataset.subscribe = "app-nav-routes:setNavRoutes";
            t._iconSearch.addEventListener('icon-update', ev => {
                t._navIcon.value = ev.detail;
                link.icon = ev.detail;
            });
            t._navPreview.addEventListener('nav-preview-click', ev => {
                ev.preventDefault();
                ev.stopPropagation();
                link = ev.detail;
                t._iconSearch.setIconFromCode(ev.detail.icon);
                t._navName.value = ev.detail.name;
            });
            t._navName.addEventListener('input', ev => {
                link.name = t._navName.value;
            });
            t._btnSave.addEventListener('click', _ => {
                t.saveNavigation();
            });
            t._btnCancel.addEventListener('click', _ => {
                t.loadNavigation();
            });
            t._btnDelete.addEventListener('click', _ => {
                for (let index = 0; index < t.nav.length; ++index) {
                    if (link.id === t.nav[index].id) {
                        t.nav.splice(index, 1);
                        console.log('deleted', index, link);
                        t._navPreview.buildNav(t.nav, true);
                        return;
                    }
                }
            });
            t._btnAddFolder.addEventListener('click', _ => {
                t.nav.push(createNewFolder());
                t._navPreview.buildNav(t.nav, true);
            });
            t._btnAddPage.addEventListener('click', _ => {
                t.nav.push(createNewPage());
                t._navPreview.buildNav(t.nav, true);
            });
        },
        setNavRoutes() {
            let t = this;
            t.loadNavigation();
        },
        loadNavigation() {
            let t = this;
            if (!t._navPreview.setNavRoutes || webui.projectData.navigation === undefined) {
                console.log('nav preview not ready');
                setTimeout(() => t.loadNavigation(), 10);
                return;
            }
            console.log('Load Navigation %o', webui.projectData.navigation);
            t.nav = webui.clone(webui.projectData.navigation);
            t._navPreview.setNavRoutes(t.nav);
        },
        async saveNavigation() {
            let t = this;
            webui.projectData.navigation = webui.clone(t.nav);
            console.log('save navigation', webui.projectData.navigation);
            await webui.proxy.saveProjectData();
        },
        connected: function (t) {
            t.loadNavigation();
        },
        disconnected: function (t) { },
        shadowTemplate: `
<style type="text/css">
:host {
display:grid;
grid-template-columns:max-content 1fr;
gap:var(--padding);
}
slot {
display:none;
}
webui-flex.form:not(.page) webui-input-text[name="url"] {
display:none;
}
</style>
<webui-flex column>
<webui-grid columns="1fr 1fr">
<webui-button label="Cancel" theme="warning" title="Reset all nav changes"></webui-button>
<webui-button label="Save" theme="success" title="Save all nav changes"></webui-button>
</webui-grid>
<app-nav-preview></app-nav-preview>
<webui-grid columns="1fr 1fr">
<webui-button label="Add Folder"></webui-button>
<webui-button label="Add Page"></webui-button>
</webui-grid>
</webui-flex>
<webui-flex column class="form">
<webui-flex>
<span class="detail"></span>
<webui-flex grow></webui-flex>
<webui-button label="Delete" theme="danger" title="Delete current nav item"></webui-button>
</webui-flex>
<webui-grid columns="2fr 3fr">
<webui-input-text label="Name"></webui-input-text>
<webui-input-text label="Icon" disabled></webui-input-text>
</webui-grid>
<webui-icon-search></webui-icon-search>
</webui-flex>
<slot></slot>
`
    });
}