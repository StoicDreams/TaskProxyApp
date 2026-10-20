"use strict";
{
    webui.define("app-files", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: '',
        constructor() {
            const t = this;
            t._filter = t.getAttribute('filter') || '';
            t._display = t.getAttribute('display') || '';
            t._triggerKey = t.getAttribute('data-trigger') || t.getAttribute('data-bind') || '';
        },
        attr: ['filter', 'display', 'data-trigger', 'data-bind'],
        attrChanged(property, value) {
            const t = this;
            if (property === 'filter') t._filter = value;
            if (property === 'display') t._display = value;
            if (property === 'dataTrigger' || property === 'dataBind') t._triggerKey = value;
        },
        async connected() {
            const t = this;
            await webui.wait(() => !!webui.proxy);
            webui.proxy.projects.runWhenLoaded(async () => {
                await t.fetchData();
            });
        },
        async fetchData() {
            const t = this;
            if (!t._filter || !t._triggerKey) return;
            try {
                let options = await webui.proxy.searchProjectFiles(t._filter, t._display);
                if (options) {
                    t._triggerKey.split('|').forEach(k => {
                        let key = k.split(':')[0].trim();
                        if (key) {
                            webui.setData(key, options);
                        }
                    });
                }
            } catch (ex) {
                webui.log.error('app-data search failed', ex);
            }
        },
        disconnected() {}
    });
}
