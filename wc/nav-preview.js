/* Display navigation links from a list */
"use strict"
webui.define('app-nav-preview', {
    preload: 'fa paper nav-group nav-link',
    connected: (t) => {
        t.watched = {};
    },
    setNavRoutes: function (data) {
        console.error('set nav routes', data);
        this.buildNav(data);
    },
    buildLink: function (parent, link) {
        let t = this;
        let el = null;
        if (link.url) {
            el = document.createElement('webui-nav-link');
            //el.setAttribute('url', link.url);
        } else if (link.children) {
            el = document.createElement('webui-nav-group');
            link.children.forEach(child => {
                t.buildLink(el, child);
            });
        } else {
            console.error('Invalid nav item', link);
            return;
        }
        if (!link.id) {
            link.id = webui.uuid();
        }
        let watchedData = webui.watchData(link, changes => {
            console.log("changed", changes.property, changes.newValue);
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
        el.addEventListener('click', _ => {
            let ev = new CustomEvent('nav-preview-click', { detail: watchedData, bubbles: true });
            el.dispatchEvent(ev);
        });
        parent.appendChild(el);
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
            t.dispatchEvent(ev);
        }
    }
});
