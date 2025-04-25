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
        preload: 'webui-icon-search',
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
                t.updateNav();
                function checkChildren(list) {
                    for (let index = 0; index < list.length; ++index) {
                        if (link.id === list[index].id) {
                            list.splice(index, 1);
                            return;
                        }
                        if (list[index].children) {
                            checkChildren(list[index]);
                        }
                    }
                }
                checkChildren(t.nav);
                t._navPreview.buildNav(t.nav, true);
            });
            t._btnAddFolder.addEventListener('click', _ => {
                t.updateNav();
                t.nav.push(createNewFolder());
                t._navPreview.buildNav(t.nav, true);
            });
            t._btnAddPage.addEventListener('click', _ => {
                t.updateNav();
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
                setTimeout(() => t.loadNavigation(), 10);
                return;
            }
            t.nav = webui.clone(webui.projectData.navigation);
            t._navPreview.setNavRoutes(t.nav);
        },
        updateNav() {
            let t = this;
            function getChildNav(parent) {
                let nav = [];
                parent.childNodes.forEach(node => {
                    let link = node._linkData;
                    if (!link) return;
                    nav.push(link);
                    if (link.url) return;
                    link.children = getChildNav(node);
                });
                return nav;
            }
            t.nav = getChildNav(t._navPreview);
        },
        async saveNavigation() {
            let t = this;
            t.updateNav();
            webui.projectData.navigation = webui.clone(t.nav);
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