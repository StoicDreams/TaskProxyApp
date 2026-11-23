"use strict"
{
    function createNewPage() {
        return {
            name: '',
            icon: 'star',
            url: `/${webui.uuid()}`
        };
    }
    /** A navigation list as it is saved, without the ids the preview gives each item, to tell whether it changed. */
    function savedForm(list) {
        return (list || []).map(item => ({
            name: item.name || '',
            icon: item.icon || '',
            url: item.url || null,
            children: item.url ? null : savedForm(item.children),
        }));
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
        preload: 'icon-search',
        nav: [],
        constructor() {
            const t = this;
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
                if (t._isBinding) return;
                t._navIcon.value = ev.detail;
                link.icon = ev.detail;
                t.refreshActions();
            });
            t._navPreview.addEventListener('nav-preview-click', async ev => {
                ev.preventDefault();
                ev.stopPropagation();
                t._isBinding = true;
                link = ev.detail;
                t._selected = link;
                t.refreshActions();
                t._navName.value = ev.detail.name || '';
                t._iconSearch.setAttribute('value', link.icon || '');
                t._iconSearch.value = link.icon || '';
                await customElements.whenDefined('webui-icon-search');
                const applyIconSettings = (attempts = 0) => {
                    if (t._iconSearch && typeof t._iconSearch.setIconFromCode === 'function') {
                        setTimeout(() => {
                            t._iconSearch.setIconFromCode(link.icon || '');
                            setTimeout(() => { t._isBinding = false; }, 300);
                        }, attempts === 0 ? 150 : 0);
                    } else if (attempts < 20) {
                        setTimeout(() => applyIconSettings(attempts + 1), 50);
                    } else {
                        t._isBinding = false;
                    }
                };
                applyIconSettings();
            });
            t._navName.addEventListener('input', ev => {
                link.name = t._navName.value;
                t.refreshActions();
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
                            checkChildren(list[index].children);
                        }
                    }
                }
                checkChildren(t.nav);
                // The preview selects its last item once it is built, and with none left nothing is selected.
                t._selected = null;
                t._navPreview.buildNav(t.nav, true);
                t.refreshActions();
            });
            t._btnAddFolder.addEventListener('click', _ => {
                t.updateNav();
                t.nav.push(createNewFolder());
                t._navPreview.buildNav(t.nav, true);
                t.refreshActions();
            });
            t._btnAddPage.addEventListener('click', _ => {
                t.updateNav();
                t.nav.push(createNewPage());
                t._navPreview.buildNav(t.nav, true);
                t.refreshActions();
            });
        },
        setNavRoutes() {
            const t = this;
            t.loadNavigation();
        },
        async loadNavigation() {
            const t = this;
            await customElements.whenDefined('app-nav-preview');
            await whenProxyReady();
            webui.proxy.projects.runWhenLoaded(() => {
                if (webui.projectData.navigation === undefined) return;
                // A manager removed from the page while it waited, as on a reload, has a preview that is never upgraded.
                if (!t.isConnected) return;
                customElements.upgrade(t._navPreview);
                if (typeof t._navPreview.setNavRoutes !== 'function') return;
                t.nav = webui.clone(webui.projectData.navigation);
                // Moving items, by dragging or from the keyboard, changes the navigation too.
                const root = t._navPreview.navRoot?.();
                if (root && root !== t._reorderRoot) {
                    t._reorderRoot = root;
                    root.addEventListener('reorder', () => t.refreshActions());
                }
                // The preview selects its first item once it is built.
                t._selected = null;
                t._loaded = true;
                t._navPreview.setNavRoutes(t.nav);
                t.refreshActions();
            });
        },
        /** The navigation as the preview shows it now, in the form it is saved, without changing `nav`. */
        shownNav() {
            const t = this;
            function walk(parent) {
                const list = [];
                parent.childNodes.forEach(node => {
                    const link = node._linkData;
                    if (!link) return;
                    list.push({ ...link, children: link.url ? null : walk(node) });
                });
                return list;
            }
            const root = t._navPreview.navRoot?.();
            return root ? savedForm(walk(root)) : [];
        },
        /** Whether the navigation shown differs from the project's saved navigation. */
        navChanged() {
            const t = this;
            if (!t._loaded || !webui.projectData?.navigation) return false;
            return JSON.stringify(t.shownNav()) !== JSON.stringify(savedForm(webui.projectData.navigation));
        },
        /** Save and Cancel act only on changes, and Delete only on a selected item. */
        refreshActions() {
            const t = this;
            const pending = t.navChanged();
            t._btnSave.toggleAttribute('disabled', !pending);
            t._btnSave.setAttribute('title', pending ? 'Save all nav changes' : 'No navigation changes to save');
            t._btnCancel.toggleAttribute('disabled', !pending);
            t._btnCancel.setAttribute('title', pending ? 'Reset all nav changes' : 'No navigation changes to reset');
            const selected = !!t._selected;
            t._btnDelete.toggleAttribute('disabled', !selected);
            t._btnDelete.setAttribute('title', selected ? 'Delete current nav item' : 'Select a nav item to delete');
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
            t.nav = getChildNav(t._navPreview.navRoot());
        },
        async saveNavigation() {
            let t = this;
            t.updateNav();
            webui.projectData.navigation = webui.clone(t.nav);
            t.refreshActions();
            await webui.proxy.saveProjectData();
            t.refreshActions();
        },
        connected() {
            const t = this;
            t.loadNavigation();
        },
        disconnected() { },
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
<webui-button label="Cancel" theme="warning" title="No navigation changes to reset" disabled></webui-button>
<webui-button label="Save" theme="success" title="No navigation changes to save" disabled></webui-button>
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
<webui-button label="Delete" theme="danger" title="Select a nav item to delete" disabled></webui-button>
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
