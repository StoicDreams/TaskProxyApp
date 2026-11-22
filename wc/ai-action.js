/*
 * A Write with AI button, with the model to write with beside it, for one integration. It shows only while that
 * integration is turned on in Settings under AI.
 *
 * <app-ai-action integration="pages" label="Write with AI" ask="What should this part of the page say?">
 *
 * The page using it sets `action`, an async function given `{model, requestId, asked, isCurrent}`: `asked` is what the
 * user typed when `ask` is set, and `isCurrent()` says whether its answer is still wanted, since Cancel or a newer
 * request makes it stale. `askValue` prefills what is asked. While it runs the button is busy and Cancel shows, and a
 * review's progress shows beside it. Why it couldn't write shows in an alert under it. Instructions opens the
 * integration's instructions.
 *
 * A page can set `job`, a function naming what the request is for, such as the project and repo a review is of. A
 * request is kept by that name, not by the button, so it carries on when the page is left or another project is
 * opened, and every button drawn for the same name, now or later, shows it running, its progress, and Cancel, or why
 * it failed. The page calls `refresh()` when what `job` names changes. Without `job`, a request belongs to its button.
 * An `ai-busy` event says when it starts or stops showing a request running.
 */
"use strict"
{
    const STYLE = `
app-ai-action { display:flex; flex-wrap:wrap; align-items:center; gap:calc(0.5 * var(--padding, 8px)); }
app-ai-action[hidden], app-ai-action [hidden] { display:none !important; }
app-ai-action select.ai-model-select { max-width:22em; font:inherit; padding:0.2em 0.3em; border-radius:var(--corners); }
app-ai-action .ai-status { font-size:0.9em; opacity:0.85; }
app-ai-action .ai-problem { flex-basis:100%; }
app-ai-model-picker[data-failing] select { outline:2px solid var(--color-warning); }
`;
    /** The documents and shadow roots given the style, which each needs once. */
    const styled = new WeakSet();
    /** Styled where it is drawn, since inside other components' shadow roots the app's CSS doesn't reach it. */
    function addStyle(node) {
        const root = node.getRootNode?.();
        // A document, or a shadow root, which is a fragment with a host. A node not in either has nowhere to put it yet.
        const isDocument = root?.nodeType === Node.DOCUMENT_NODE;
        if (!root || styled.has(root) || !(isDocument || (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && root.host))) return;
        styled.add(root);
        (isDocument ? root.head : root).appendChild(webui.create('style', { class: 'ai-action-style', text: STYLE }));
    }
    /** Requests still running, by job: `{requestId, progress}`. */
    const running = new Map();
    /** Why each job's last request failed, shown until it is run again. */
    const problems = new Map();
    /** The buttons on screen, which show the job they are for. */
    const shown = new Set();
    const refreshAll = () => shown.forEach(action => action.refresh());
    /** Whether a button can be seen, so something said under it would be. */
    const seen = action => typeof action.checkVisibility !== 'function' || action.checkVisibility();
    let listening = false;
    /** A review's progress, kept with its job so a button drawn later shows it too. One listener serves every button. */
    function listenForProgress() {
        if (listening || !webui.proxy?.ai?.onProgress) return;
        listening = true;
        webui.proxy.ai.onProgress(progress => {
            const job = [...running.values()].find(item => item.requestId === progress?.requestId);
            if (!job || !progress.total) return;
            job.progress = progress;
            refreshAll();
        });
    }
    webui.define('app-ai-action', {
        preload: 'alert',
        attr: ['integration', 'label', 'ask', 'icon', 'busy-label'],
        constructor() {
            const t = this;
            // A page can set these before this element is upgraded, which they must survive.
            t.action ??= null;
            t.askValue ??= '';
            t.job ??= null;
            // While blocked, as Suggest with AI is during an import, the button stays disabled even when it isn't busy.
            let blocked = !!t.blocked;
            delete t.blocked;
            Object.defineProperty(t, 'blocked', {
                configurable: true,
                get: () => blocked,
                set(value) {
                    if (blocked === !!value) return;
                    blocked = !!value;
                    t.refresh();
                },
            });
            t._ownJob = `button-${Math.random().toString(36).slice(2)}`;
        },
        /** Its label, icon, and integration can change after it is drawn, such as when a page reuses it. */
        attrChanged(property) {
            const t = this;
            if (!t._button) return;
            if (property === 'integration') {
                t._picker.setAttribute('integration', t.getAttribute('integration') || '');
                t.showIfOn();
                // Its job is named by the integration, so whether it is busy follows the new one.
                t.refresh();
            }
            // A busy button keeps saying it is busy, and shows these once it is done.
            if (property === 'label' || property === 'icon' || property === 'busyLabel') t.refresh();
        },
        connected() {
            const t = this;
            if (!t._button) {
                const integration = t.getAttribute('integration') || '';
                t._picker = webui.create('app-ai-model-picker', { integration, 'aria-label': 'AI model' });
                t._button = webui.create('webui-button', { theme: 'tertiary', class: 'ai-run', 'start-icon': t.getAttribute('icon') || 'sparkles', label: t.getAttribute('label') || 'Write with AI' });
                t._cancel = webui.create('webui-button', { theme: 'warning', class: 'ai-cancel', 'start-icon': 'xmark', label: 'Cancel', hidden: '' });
                t._instructions = webui.create('webui-button', { theme: 'secondary', class: 'ai-instructions', 'start-icon': 'book', title: 'Instructions for AI', 'aria-label': 'Instructions for AI' });
                t._status = webui.create('span', { class: 'ai-status', role: 'status' });
                t._problem = webui.create('webui-alert', { class: 'ai-problem', variant: 'warning' });
                t._button.addEventListener('click', ev => {
                    ev.stopPropagation();
                    t.run();
                });
                t._cancel.addEventListener('click', ev => {
                    ev.stopPropagation();
                    t.cancel();
                });
                t._instructions.addEventListener('click', ev => {
                    ev.stopPropagation();
                    t.openInstructions();
                });
                t.append(t._picker, t._button, t._cancel, t._instructions, t._status, t._problem);
                t.dataset.subscribe = 'app-ai-integrations:showIfOn';
            }
            addStyle(t);
            shown.add(t);
            listenForProgress();
            t.showIfOn();
            t.refresh();
        },
        reconnected() {
            addStyle(this);
            shown.add(this);
            this.showIfOn();
            this.refresh();
        },
        disconnected() {
            shown.delete(this);
        },
        /** What its request is for: the page's `job`, or this button alone. */
        jobKey() {
            const key = typeof this.job === 'function' ? this.job() : '';
            return key ? `${this.getAttribute('integration') || ''}|${key}` : this._ownJob;
        },
        /** Shows whether its job is running, with its progress, or why it last failed. */
        refresh() {
            const t = this;
            if (!t._button) return;
            const key = t.jobKey();
            const job = running.get(key);
            t.setBusy(!!job);
            const progress = job?.progress;
            t._status.textContent = progress?.total > 1 ? `Working on ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : '';
            setNote(t._problem, problems.get(key), 'warning');
        },
        /** Shown only while its integration is on. */
        showIfOn() {
            const t = this;
            t.hidden = !webui.proxy?.ai?.isOn(t.getAttribute('integration'));
        },
        isBusy() {
            return running.has(this.jobKey());
        },
        setBusy(busy) {
            const t = this;
            const changed = t.classList.contains('ai-busy') !== busy;
            t.classList.toggle('ai-busy', busy);
            // The page using it can wait for it, such as Import waiting for suggestions.
            if (changed) t.dispatchEvent(new CustomEvent('ai-busy', { detail: { busy } }));
            t._button.toggleAttribute('disabled', busy || t.blocked);
            t._button.setAttribute('label', busy ? (t.getAttribute('busy-label') || 'Writing') : (t.getAttribute('label') || 'Write with AI'));
            t._button.setAttribute('start-icon', busy ? 'hourglass' : (t.getAttribute('icon') || 'sparkles'));
            t._cancel.hidden = !busy;
        },
        /** Asks what to write, when `ask` is set. Resolves to the text, or null when the user cancels. */
        async askUser() {
            const t = this;
            const question = t.getAttribute('ask');
            if (!question) return '';
            const content = webui.create('label', { class: 'ai-ask' });
            content.style.cssText = 'display:flex;flex-direction:column;gap:0.5em;';
            content.append(question);
            const area = webui.create('textarea', { name: 'ai_request', rows: '5', required: '' });
            // What was typed for a request that couldn't be sent comes back, until one is.
            area.value = t._keptAsk ?? (t.askValue || '');
            area.style.minWidth = 'min(36em, 80vw)';
            content.appendChild(area);
            let asked = null;
            await webui.dialog({
                title: t.getAttribute('label') || 'Write with AI',
                content,
                confirm: t.getAttribute('label') || 'Write with AI',
                cancel: 'Cancel',
                onconfirm: formData => {
                    // Only spaces asks for nothing, so the dialog stays open, and Cancel after it still runs nothing.
                    const text = `${formData.get('ai_request') || ''}`.trim();
                    if (text) asked = text;
                    return !!text;
                },
            }).catch(() => { asked = null; });
            return asked;
        },
        /** Shows why it couldn't write, under its buttons, or clears it. Kept with its job. */
        problem(text, key = this.jobKey()) {
            if (text) problems.set(key, text);
            else problems.delete(key);
            shown.forEach(action => action.jobKey() === key && action.refresh());
        },
        async run() {
            const t = this;
            if (t.isBusy() || typeof t.action !== 'function') return;
            const model = t._picker.value;
            if (!model) {
                t.problem('Choose a model to write with. Models come from the AI providers set up in Settings, under AI.');
                return;
            }
            // One question at a time: a second click while it is asked opens no second dialog.
            if (t._asking) return;
            t._asking = true;
            let asked;
            try {
                asked = await t.askUser();
            } finally {
                t._asking = false;
            }
            // What it said before stays until something is asked, so a question cancelled doesn't lose it.
            if (asked === null) return;
            t.problem();
            // Named once, so the answer goes to what was asked about, whatever is shown when it comes.
            const key = t.jobKey();
            if (running.has(key)) {
                // Started meanwhile, such as from another button for the same job: what was typed isn't dropped unsaid.
                if (asked) {
                    t._keptAsk = asked;
                    t.problem('This was already being written when you asked, so your request wasn\'t sent. What you typed is kept, to ask again once this is done.', key);
                }
                return;
            }
            t._keptAsk = undefined;
            listenForProgress();
            const requestId = webui.proxy.ai.newRequestId();
            running.set(key, { requestId, progress: null });
            problems.delete(key);
            refreshAll();
            const isCurrent = () => running.get(key)?.requestId === requestId;
            try {
                await t.action({ model, requestId, asked, isCurrent });
            } catch (err) {
                const text = `${err?.message ?? err}`;
                if (isCurrent() && text !== 'Cancelled.') {
                    problems.set(key, text);
                    // With no button left on screen for it, such as an editor that was closed, it is said in the app's alerts.
                    // An editor closed by Save or Undo keeps its button, hidden, where an alert under it can't be seen.
                    if (![...shown].some(action => action.isConnected && action.jobKey() === key && seen(action))) appAlert(text, 'warning');
                }
            } finally {
                if (isCurrent()) running.delete(key);
                refreshAll();
            }
        },
        /** Stops waiting: the answer is dropped when it comes, and the backend stops the request. */
        cancel() {
            const key = this.jobKey();
            const job = running.get(key);
            if (!job) return;
            running.delete(key);
            refreshAll();
            webui.proxy.ai.cancel(job.requestId);
        },
        openInstructions() {
            const t = this;
            const editor = webui.create('app-ai-instructions', { integration: t.getAttribute('integration') || '' });
            webui.dialog({ title: 'Instructions for AI', content: editor, confirm: 'Done', minWidth: 'min(48em, 90vw)' }).catch(() => { });
        },
    });
}
