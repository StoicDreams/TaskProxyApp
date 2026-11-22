/*
 * A model to write with, from every AI provider set up in Settings, shown as "Provider · Model".
 *
 * <app-ai-model-picker integration="git"> starts on that integration's default model (the project's for it, the
 * project's default, then the same globally) and keeps a choice made in it for this screen only. Its `value` is
 * `{provider, model}`, or null when there is nothing to choose.
 *
 * <app-ai-model-picker scope="global" key="git"> sets a default instead: `scope` is global or project, and `key` is
 * `default` or an integration. Choosing "Not set" clears it, so the next default down is used.
 */
"use strict"
{
    const pickers = new Set();
    let settings = null;
    let loading = null;
    let listening = false;
    /** Set when the providers couldn't be loaded, until they are: the next picker drawn tries again. */
    let failed = false;
    /**
     * The providers, loaded once and kept current by ai-settings-changed. A picker can be drawn while the app is still
     * starting, before it can reach the backend, so both wait for it rather than finding nothing to load.
     */
    function loadSettings() {
        loading ??= whenProxyReady().then(proxy => {
            if (!listening) {
                listening = true;
                proxy.ai.onSettingsChanged(view => {
                    settings = view;
                    failed = false;
                    pickers.forEach(picker => picker.render());
                });
            }
            return proxy.ai.settings(() => null);
        }).then(view => {
            // A failure is not kept as no providers, so the next picker drawn asks again.
            failed = !view;
            if (view) settings = view;
            return settings;
        }).finally(() => { loading = null; });
        return loading;
    }
    /** Every picker shows the defaults as they are now, as after a project's own default changes, or the project does. */
    function renderAll() {
        pickers.forEach(picker => picker.render());
    }
    document.addEventListener('app-ai-defaults-changed', renderAll);
    const same = (a, b) => !!a && !!b && a.provider === b.provider && a.model === b.model;
    const valueOf = model => JSON.stringify({ provider: model.provider, model: model.model });

    webui.define('app-ai-model-picker', {
        attr: ['integration', 'scope', 'key'],
        constructor() {
            const t = this;
            t._chosen = null;
        },
        attrChanged(property) {
            // A choice made for one integration isn't one for another.
            if (property === 'integration') this._chosen = null;
            if (this._select) this.render();
        },
        connected() {
            const t = this;
            pickers.add(t);
            if (!t._select) {
                t._select = webui.create('select', { class: 'ai-model-select', 'aria-label': t.getAttribute('aria-label') || 'Model' });
                // The picker says a choice was made itself, once, so the select's own change goes no further.
                t._select.addEventListener('change', ev => {
                    ev.stopPropagation();
                    t.chose();
                });
                t.appendChild(t._select);
                // A default changed elsewhere, such as in Settings, moves a picker nothing was chosen in. A project's
                // own defaults, and opening another project, are said by app-ai-defaults-changed.
                t.dataset.subscribe = 'app-ai-models:render';
            }
            t.render();
            if (!settings) loadSettings().then(() => t.isConnected && t.render());
        },
        reconnected() {
            const t = this;
            pickers.add(t);
            t.render();
            if (!settings) loadSettings().then(() => t.isConnected && t.render());
        },
        disconnected() {
            pickers.delete(this);
        },
        isScoped() {
            return this.hasAttribute('scope');
        },
        /** The model this picker shows now. */
        current() {
            const t = this;
            const ai = webui.proxy?.ai;
            if (!ai) return null;
            if (t.isScoped()) return ai.scope(t.getAttribute('scope')).models[t.getAttribute('key') || 'default'] || null;
            return t._chosen || ai.defaultModel(t.getAttribute('integration') || 'default');
        },
        /** `{provider, model}` to send, or null when no model can be chosen. */
        selected() {
            const t = this;
            if (!t._select?.value) return null;
            try {
                const model = JSON.parse(t._select.value);
                const provider = (settings?.providers || []).find(p => p.id === model.provider);
                // A default naming a model the provider no longer lists, or that is unchecked, can't be used.
                const listed = (provider?.models || []).some(item => item.id === model.model) && !(provider.hidden || []).includes(model.model);
                return listed ? model : null;
            } catch {
                return null;
            }
        },
        render() {
            const t = this;
            if (!t._select) return;
            const providers = settings?.providers || [];
            const current = t.current();
            const options = [];
            // Until the providers are known, a default's picker says they are loading, or couldn't be, in place of Not set.
            if (t.isScoped() && settings) options.push(webui.create('option', { value: '', text: 'Not set' }));
            let found = false;
            providers.forEach(provider => {
                const models = (provider.models || []).filter(model => !(provider.hidden || []).includes(model.id));
                if (!models.length) return;
                const group = webui.create('optgroup', { label: provider.lastError ? `${provider.name} (last call failed)` : provider.name });
                models.forEach(model => {
                    const choice = { provider: provider.id, model: model.id };
                    const option = webui.create('option', { value: valueOf(choice), text: `${provider.name} · ${model.name || model.id}` });
                    if (same(choice, current)) {
                        option.selected = true;
                        found = true;
                    }
                    group.appendChild(option);
                });
                options.push(group);
            });
            // A default naming a provider or model that is gone stays shown, so it is clear why nothing is used. Before
            // the providers are known, nothing can be said to be gone.
            if (settings && current && !found) {
                const provider = providers.find(p => p.id === current.provider);
                options.unshift(webui.create('option', {
                    value: valueOf(current), selected: true, class: 'ai-model-missing',
                    text: `${provider ? `${provider.name} · ` : ''}${current.model} (not available)`,
                }));
            }
            if (!options.length) {
                const text = settings ? 'Set up AI in Settings' : failed ? 'Couldn\'t load models' : 'Loading models';
                options.push(webui.create('option', { value: '', text, disabled: true, selected: true }));
            }
            t._select.replaceChildren(...options);
            // A project's default needs a project open: with none, there is nowhere to save a choice.
            t._select.disabled = t.isScoped() && t.getAttribute('scope') === 'project' && !webui.projectData?.id;
            if (!current && !t.isScoped()) {
                // Nothing set: the first model listed is used.
                const first = t._select.querySelector('option:not([disabled])');
                if (first) first.selected = true;
            }
            t.title = t.isScoped() ? 'The model used by default' : 'The model to write with';
            const provider = providers.find(p => p.id === (t.selected() || current)?.provider);
            t.toggleAttribute('data-failing', !!provider?.lastError);
            if (provider?.lastError) t.title = `Its last call failed: ${provider.lastError}`;
        },
        props: {
            value: { get() { return this.selected(); } },
        },
        chose() {
            const t = this;
            let model = null;
            try {
                model = t._select.value ? JSON.parse(t._select.value) : null;
            } catch { }
            if (t.isScoped()) {
                webui.proxy.ai.setScope(t.getAttribute('scope'), 'models', t.getAttribute('key') || 'default', model);
                // Shows what was saved, which is nothing when the project closed before the choice was made.
                t.render();
            } else {
                t._chosen = model;
            }
            t.dispatchEvent(new Event('change', { bubbles: true }));
        },
    });
}
