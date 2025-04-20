/* Display navigation links from a list */
"use strict"
webui.define('app-nav', {
    preload: 'fa paper nav-group nav-link',
    attr: ['routes', 'nav-routes'],
    attrChanged: (t, property, value) => {
        switch (property) {
            case 'routes':
                t.loadRoutes(value);
                break;
            case 'navRoutes':
                t.buildNav(value);
                break;
        }
    },
    connected: (t) => {
        t.userRole = 0;
        t.addDataset('subscribe', 'session-user-role:setUserRole');
        t._buildNav();
    },
    setUserRole: function (userRole) {
        let t = this;
        t.userRole = userRole || 0;
        t._buildNav();
    },
    setNavRoutes: function (data) {
        this.buildNav(data);
    },
    loadRoutes: async function (url) {
        if (!url) return;
        let loaded = await fetch(url);
        if (!loaded.ok) return;
        let data = await loaded.text();
        this.buildNav(data);
    },
    buildLink: function (parent, link) {
        let t = this;
        let el = null;
        if (link.role && link.role > 0 && link.role & t.userRole === 0) {
            return;
        }
        if (link.url) {
            el = document.createElement('webui-nav-link');
            el.setAttribute('url', link.url);
        } else if (link.children) {
            el = document.createElement('webui-nav-group');
            link.children.forEach(child => {
                t.buildLink(el, child);
            });
        } else {
            console.error('Invalid nav item', link);
            return;
        }
        if (link.icon) {
            el.setAttribute('icon', link.icon);
            if (link.iconFamily) {
                el.setAttribute('family', link.iconFamily);
            }
        }
        el.setAttribute('name', link.name);
        parent.appendChild(el);
    },
    buildNav: function (navJson) {
        if (!navJson) return;
        let nav = typeof navJson === 'string' ? JSON.parse(navJson) : typeof navJson.forEach === 'function' ? navJson : [];
        let t = this;
        t._navData = nav;
        t._buildNav();
    },
    _buildNav: function () {
        let t = this;
        let nav = t._navData;
        if (!nav) return;
        t.innerHTML = '';
        nav.forEach(link => {
            this.buildLink(t, link);
        });
    }
});
