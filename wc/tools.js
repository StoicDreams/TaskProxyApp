/*
 * The header's Tools button, at its right end, where the sign-in button was. It opens the shared right drawer on Task Proxy's tools, one tab
 * each: Terminals, Task Manager, Variables, Alerts, Plugins, Icons & Emojis, Theme, Accessibility, and Account. Its button counts the scripts
 * running and the alerts not yet closed, and each tab shows its own count.
 *
 * The tools' own elements, such as app-terminals, sit inside it, hidden, so they keep their state and what they
 * subscribe to. A tool asked to open, such as by the Git Controller after it starts a script, calls show() with its
 * tab, and Tools has it draw itself into that tab's content. The hidden webui-alerts is what shows alerts as popups.
 */
"use strict"
{
    const TAB_KEY = 'session-tools-tab';
    /** The order the user dragged the tabs into, by tool id, kept with the app's data. */
    const ORDER_KEY = 'app-tools-order';
    /** Each tab: its id, label, icon, and how its tool draws into the tab, given the tab's content and any options. */
    const TOOLS = [
        { id: 'terminals', label: 'Terminals', icon: 'terminal', draw: (t, target, options) => t.querySelector('app-terminals')?.openDrawer({ ...options, target }) },
        { id: 'tasks', label: 'Task Manager', icon: 'gauge', draw: (t, target) => t.querySelector('app-task-manager')?.open({ target }) },
        { id: 'variables', label: 'Variables', icon: 'dollar', draw: (t, target) => t.querySelector('app-var-manager')?.open({ target }) },
        { id: 'alerts', label: 'Alerts', icon: 'bell', draw: (t, target) => target.replaceChildren(webui.create('webui-alerts', { panel: '' })) },
        { id: 'plugins', label: 'Plugins', icon: 'cloud_puzzle-piece', draw: (t, target, options) => t.querySelector('app-plugins-drawer')?.open(options.pluginId, { target }) },
        { id: 'icons', label: 'Icons & Emojis', icon: 'icons', draw: (t, target) => t.querySelector('app-icon-drawer')?.open({ target }) },
        {
            id: 'theme', label: 'Theme', icon: 'palette', draw: (t, target) => {
                // The theme list is made from the hidden selector's options, so the themes are written in one place.
                const panel = webui.create('webui-theme-selector', { panel: '' });
                const source = t.querySelector('webui-theme-selector');
                if (source?.hasAttribute('editable')) panel.setAttribute('editable', '');
                source?.querySelectorAll(':scope > option').forEach(option => panel.appendChild(option.cloneNode(true)));
                target.replaceChildren(panel);
            },
        },
        { id: 'accessibility', label: 'Accessibility', icon: 'universal-access', draw: (t, target) => t.querySelector('app-accessibility')?.open({ target }) },
        // The sign-in at the top, and the copyright and Powered by at the bottom, where the app's footer was.
        { id: 'account', label: 'Account', icon: 'user', draw: (t, target) => target.replaceChildren(webui.create('app-account-panel', { class: 'tools-fill', since: '2016', company: 'Stoic Dreams' })) },
    ];
    /** The tools in the order the user put them, with any not placed yet at the end. */
    function orderedTools() {
        const saved = webui.getData(ORDER_KEY);
        const ids = Array.isArray(saved) ? saved : [];
        const placed = ids.map(id => TOOLS.find(tool => tool.id === id)).filter(Boolean);
        return [...placed, ...TOOLS.filter(tool => !placed.includes(tool))];
    }
    /** What the button's count adds up. */
    const COUNTED = ['terminals', 'alerts'];

    webui.define("app-tools", {
        preload: 'tabs badge icon',
        attr: ['drawer'],
        constructor() {
            const t = this;
            t._counts = {};
            t._icon = t.template.querySelector('webui-icon');
            t._panel = null;
        },
        connected() {
            const t = this;
            makeButton(t, t.getAttribute('title') || 'Tools');
            t.dataset.subscribe = `${TAB_KEY}:onTab`;
            if (t._ready) return;
            t._ready = true;
            t.addEventListener('click', ev => {
                // Clicks reach here from the hidden tools too, which open their own tab.
                if (ev.target !== t) return;
                t.toggle();
            });
            t._onAlerts = ev => t.setCount('alerts', ev.detail?.count || 0);
            document.addEventListener('webui-alerts-count', t._onAlerts);
            // The drawer's docked state is saved, so it can come back docked after a reload, before anything has
            // been drawn in it: Tools is drawn then, on the tab last shown, rather than leaving it empty.
            t._dockWatch = new MutationObserver(() => t.fillDocked());
            t.watchDock();
        },
        disconnected() {
            document.removeEventListener('webui-alerts-count', this._onAlerts);
            this._dockWatch?.disconnect();
        },
        /** Watches the drawer for docking, once it is in the page. */
        watchDock() {
            const t = this;
            const drawer = t.drawerElement();
            if (!drawer) {
                requestAnimationFrame(() => t.isConnected && t.watchDock());
                return;
            }
            t._dockWatch.disconnect();
            t._dockWatch.observe(drawer, { attributes: true, attributeFilter: ['docked'], childList: true });
            t.fillDocked();
        },
        /** Shows Tools in the drawer when it is docked with nothing of its own in it. */
        fillDocked() {
            const t = this;
            const drawer = t.drawerElement();
            if (!drawer || !drawer.hasAttribute('docked')) return;
            if (t._panel && t._panel.parentNode === drawer) return;
            if ([...drawer.children].some(child => !child.slot)) return;
            t.show();
        },
        drawerElement() {
            return document.querySelector(this.getAttribute('drawer') || '.shared');
        },
        /** Whether the drawer is open on Tools. */
        isShown() {
            const drawer = this.drawerElement();
            return !!drawer && drawer.classList.contains('open') && !!this._panel && this._panel.parentNode === drawer;
        },
        toggle() {
            const t = this;
            if (t.isShown()) {
                t.drawerElement().classList.remove('open');
                return;
            }
            t.show();
        },
        /**
         * Opens Tools on a tool's tab, `id` such as 'terminals', or on the tab last shown. `options` go to the tool,
         * such as `{ run: true }` for Terminals or `{ pluginId }` for Plugins.
         */
        show(id, options = {}) {
            const t = this;
            const drawer = t.drawerElement();
            if (!drawer) return;
            const tools = orderedTools();
            const index = id ? tools.findIndex(tool => tool.id === id) : -1;
            const current = Number(webui.getData(TAB_KEY)) || 0;
            const wanted = index >= 0 ? index : Math.min(Math.max(current, 0), tools.length - 1);
            t._options = { index: wanted, options };
            if (!t._panel || t._panel.parentNode !== drawer) {
                t.build();
                drawer.replaceChildren(t._panel);
            }
            if (!drawer.classList.contains('open')) setTimeout(() => drawer.classList.add('open'), 0);
            if (wanted !== current) {
                // The tabs and onTab follow the saved tab, which draws the tool.
                webui.setData(TAB_KEY, wanted);
                t._tabs.setTab?.(wanted);
            } else {
                t._tabs.setTab?.(wanted);
                t.drawTool(wanted);
            }
        },
        /** The drawer's header and tabs, one content for each tool, drawn when its tab is first shown. */
        build() {
            const t = this;
            t._panel = webui.create('section', { class: 'tools-panel' });
            // The tabs can be dragged into the user's own order, which is kept.
            t._tabs = webui.create('webui-tabs', { theme: 'secondary', 'transition-timing': '200', class: 'tools-tabs', sortable: '', 'data-subscribe': `${TAB_KEY}:setTab` });
            t._tabs.addEventListener('reorder', ev => {
                webui.setData(ORDER_KEY, (ev.detail?.order || []).map(button => button.dataset.tool).filter(Boolean));
            });
            // The drawer's title sits in the tabs' row, rather than taking a row of its own.
            const title = webui.create('span', { slot: 'label', role: 'heading', 'aria-level': '2', class: 'tools-title' });
            title.textContent = 'Tools';
            t._tabs.appendChild(title);
            t._contents = {};
            t._badges = {};
            orderedTools().forEach(tool => {
                // Only the icon shows, with the tool's name as its tooltip and the name screen readers say.
                const button = webui.create('webui-button', { slot: 'tabs', 'start-icon': tool.icon, class: `tools-tab tools-tab-${tool.id}`, title: tool.label, 'aria-label': tool.label, 'data-tool': tool.id });
                const badge = webui.create('webui-badge', { theme: 'info', class: 'tools-count' });
                badge.hidden = true;
                button.append(badge);
                const content = webui.create('webui-content', { slot: 'content', nodetach: '', class: `tools-content tools-${tool.id}` });
                t._tabs.append(button, content);
                t._contents[tool.id] = content;
                t._badges[tool.id] = badge;
            });
            t._panel.appendChild(t._tabs);
            Object.keys(t._counts).forEach(id => t.showCount(id));
            // Each tab's content is as tall as the room below the tabs, so a tool scrolls its own lists, as in a drawer.
            t._fit?.disconnect();
            t._fit = new ResizeObserver(() => t.fitContents());
            t._fit.observe(t._panel);
        },
        fitContents() {
            const t = this;
            if (!t._panel?.isConnected) return;
            const bottom = t._panel.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(t._panel).paddingBottom) || 0);
            Object.values(t._contents).forEach(content => {
                if (content.hasAttribute('tab-hidden')) return;
                const top = content.getBoundingClientRect().top;
                const height = Math.max(160, Math.floor(bottom - top - 2));
                if (content.style.height !== `${height}px`) content.style.height = `${height}px`;
                // A tool that scrolls its own list, such as the Task Manager, fills what is left below its title, and the
                // Account tab fills the tab to keep its footer at the bottom.
                const fill = content.querySelector(':scope > .task-manager-body, :scope > .tools-fill');
                if (fill) {
                    const padding = parseFloat(getComputedStyle(content).paddingBottom) || 0;
                    const room = Math.max(120, Math.floor(top + height - padding - fill.getBoundingClientRect().top));
                    if (fill.style.height !== `${room}px`) fill.style.height = `${room}px`;
                }
            });
        },
        /** The saved tab changed, by a click on a tab or by show(), so that tool draws itself, if Tools is open. */
        onTab(value) {
            const t = this;
            const index = Number(value) || 0;
            if (!t._panel?.isConnected) return;
            t.drawTool(index);
        },
        drawTool(index) {
            const t = this;
            // The tab at that place, which is the order the tabs are in now, however they were dragged.
            const id = t._tabs?.tabButtons?.()[index]?.dataset.tool;
            const tool = TOOLS.find(item => item.id === id) || orderedTools()[index];
            if (!tool || !t._contents) return;
            const pending = t._options && t._options.index === index ? t._options.options : {};
            t._options = null;
            tool.draw(t, t._contents[tool.id], pending || {});
            requestAnimationFrame(() => t.fitContents());
        },
        /** A tool's count, shown on its tab, with the running scripts and alerts added up on the button. */
        setCount(id, count) {
            const t = this;
            t._counts[id] = Number(count) || 0;
            t.showCount(id);
            const total = COUNTED.reduce((sum, key) => sum + (t._counts[key] || 0), 0);
            t._icon.setAttribute('count', total > 0 ? `${total}` : '');
        },
        showCount(id) {
            const t = this;
            const badge = t._badges?.[id];
            if (!badge) return;
            const count = t._counts[id] || 0;
            badge.textContent = `${count}`;
            badge.hidden = count <= 0;
        },
        shadowTemplate: `
<webui-icon class="tools-icon" icon="circle_toolbox|theme:info|fill|backing|bordered"></webui-icon>
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
