/* Display navigation links from a list */
"use strict"
webui.define('app-nav-preview', {
    preload: 'fa paper nav-group nav-link',
    watched: {},
    constructor(t) {
        t.dragNDrop = getDragNDropSetup(t.getSegments);
    },
    connected: (t) => {
    },
    setNavRoutes: function (data) {
        this.buildNav(data);
    },
    buildLink: function (parent, link) {
        let t = this;
        let el = null;
        if (link.url) {
            el = webui.create('webui-nav-link');
            t.dragNDrop(el);
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
            let afterFolder = webui.create('webui-nav-link', { class: 'placeholder', message: 'Folder End', place: 'above' });
            el.appendChild(afterFolder);
            t.dragNDrop(el, () => {
                el.before(beforeFolder);
                el.after(afterFolder);
            });
        }
        if (!link.id) {
            link.id = webui.uuid();
        }
        let watchedData = webui.watchData(link, changes => {
            switch (changes.property) {
                case 'name':
                    el.setAttribute('name', changes.newValue);
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
        el.addEventListener('click', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            ev = new CustomEvent('nav-preview-click', { detail: watchedData, bubbles: true });
            el.dispatchEvent(ev);
        });
        el._linkData = link;
        el.classList.add('drag-handle');
        parent.appendChild(el);
        if (!link.url) {
            parent.appendChild(webui.create('webui-nav-link', { class: 'placeholder', message: 'After Folder', place: 'below' }));
        }
    },
    getSegments: function (el) {
        let t = el.closest('app-nav-preview');
        let segments = [];
        segments = Array.from(t.querySelectorAll('webui-nav-link'));
        return segments;
    },
    buildNav: function (navJson, openLast) {
        if (!navJson) return;
        let nav = typeof navJson === 'string' ? JSON.parse(navJson) : typeof navJson.forEach === 'function' ? navJson : [];
        let t = this;
        t._navData = nav;
        t._buildNav(openLast);
    },
    _buildNav: function (openLast) {
        let t = this;
        let nav = t._navData;
        if (!nav) return;
        t.innerHTML = '';
        nav.forEach(link => {
            this.buildLink(t, link);
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
