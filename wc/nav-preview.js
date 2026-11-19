/* Display navigation links from a list */
"use strict"
webui.define('app-nav-preview', {
    preload: 'fa paper nav-group nav-link reorder',
    watched: {},
    constructor() {
        const t = this;
        // Links and folders move by dragging, or Alt+Up and Alt+Down. The markers around and inside each folder say
        // which side of them an item goes, so an item can be put into a folder, or out of it.
        t._list = webui.create('webui-reorder', {
            class: 'nav-preview-list', items: 'webui-nav-link, webui-nav-group', targets: 'webui-nav-link', handle: '.drag-handle',
        });
        t._list.addEventListener('reorder', ev => {
            // A folder keeps the markers before and after it.
            const folder = ev.detail.item;
            if (folder._before) folder.before(folder._before);
            if (folder._after) folder.after(folder._after);
        });
    },
    /** The element whose children are the top of the navigation, in order. */
    navRoot() {
        return this._list;
    },
    connected() {
        const t = this;
    },
    setNavRoutes(data) {
        this.buildNav(data);
    },
    buildLink(parent, link) {
        const t = this;
        let el = null;
        if (link.url) {
            el = webui.create('webui-nav-link');
            // Pages here have no address to follow, so keyboard users select them as buttons.
            makeButton(el);
        } else {
            if (!link.children) {
                link.children = [];
            }
            let beforeFolder = webui.create('webui-nav-link', { class: 'placeholder', message: 'Before Folder', place: 'above' });
            parent.appendChild(beforeFolder);
            el = webui.create('webui-nav-group', { show: true, disabled: true });
            el.appendChild(webui.create('webui-nav-link', { class: 'placeholder', message: 'Folder Start', place: 'below' }));
            link.children.forEach(child => {
                t.buildLink(el, child);
            });
            el.appendChild(webui.create('webui-nav-link', { class: 'placeholder', message: 'Folder End', place: 'above' }));
            el._before = beforeFolder;
            el._after = webui.create('webui-nav-link', { class: 'placeholder', message: 'After Folder', place: 'below' });
        }
        if (!link.id) {
            link.id = webui.uuid();
        }
        let watchedData = webui.watchData(link, changes => {
            switch (changes.property) {
                case 'name':
                    el.setAttribute('name', changes.newValue);
                    if (link.url) el.setAttribute('aria-label', `${changes.newValue}, Alt+Up or Alt+Down to move`);
                    break;
                case 'icon':
                    el.setAttribute('icon', changes.newValue);
                    break;
            }
        });
        t.watched[link.id] = watchedData;
        if (link.icon) {
            el.setAttribute('icon', link.icon);
        }
        el.setAttribute('name', link.name);
        if (link.url) el.setAttribute('aria-label', `${link.name}, Alt+Up or Alt+Down to move`);
        el.addEventListener('click', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            ev = new CustomEvent('nav-preview-click', { detail: watchedData, bubbles: true });
            el.dispatchEvent(ev);
        });
        el._linkData = link;
        el.classList.add('drag-handle');
        parent.appendChild(el);
        if (el._after) parent.appendChild(el._after);
    },
    buildNav(navJson, openLast) {
        if (!navJson) return;
        let nav = typeof navJson === 'string' ? JSON.parse(navJson) : typeof navJson.forEach === 'function' ? navJson : [];
        const t = this;
        t._navData = nav;
        t._buildNav(openLast);
    },
    _buildNav(openLast) {
        const t = this;
        let nav = t._navData;
        if (!nav) return;
        t._list.replaceChildren();
        if (t._list.parentNode !== t) t.replaceChildren(t._list);
        nav.forEach(link => {
            this.buildLink(t._list, link);
        });
        if (nav.length) {
            let openNav = openLast ? nav[nav.length - 1] : nav[0];
            let watched = t.watched[openNav.id];
            let ev = new CustomEvent('nav-preview-click', { detail: watched, bubbles: true });
            setTimeout(() => {
                t.dispatchEvent(ev);
            }, 100);
        }
    }
});
