/*
 * Settings' Performance tab: how much of the computer the scripts Task Proxy runs may use. The choices are app data
 * (app-script-performance: { priority: 'normal' | 'low' | 'lowest', threads: 0 for all, or how many }), which the
 * backend reads as each script starts (services/performance.rs), so they apply to scripts started after a change.
 */
"use strict"
{
    const KEY = 'app-script-performance';
    const PRIORITIES = [
        ['normal', 'Normal'],
        ['low', 'Low'],
        ['lowest', 'Lowest'],
    ];
    /** The saved choices, with anything missing or unreadable at Normal and every thread. */
    function saved() {
        const value = webui.getData(KEY);
        const priority = PRIORITIES.some(([id]) => id === value?.priority) ? value.priority : 'normal';
        const threads = Number.isInteger(value?.threads) && value.threads > 0 ? value.threads : 0;
        return { priority, threads };
    }
    webui.define('app-script-performance', {
        preload: 'switch',
        connected() {
            const t = this;
            if (t._built) return;
            t._built = true;
            t.innerHTML = `
<p>These limits apply to the scripts Task Proxy runs: in the Terminal Manager, from pages, and favorites, along with everything those scripts start. A script running now keeps the limits it started with. Scripts opened in a separate terminal window are started by that window, so these can't reach them.</p>
<h4>Priority</h4>
<webui-switch class="perf-priority" label="Priority"></webui-switch>
<p class="perf-priority-note"></p>
<h4>CPU threads</h4>
<label class="perf-threads-row"><input type="range" class="perf-threads" min="1" step="1" aria-label="CPU threads scripts may use"> <span class="perf-threads-label" aria-live="polite"></span></label>
<p class="perf-threads-note"></p>`;
            t._priority = t.querySelector('.perf-priority');
            t._priorityNote = t.querySelector('.perf-priority-note');
            t._threads = t.querySelector('.perf-threads');
            t._threadsLabel = t.querySelector('.perf-threads-label');
            t._threadsNote = t.querySelector('.perf-threads-note');
            customElements.whenDefined('webui-switch').then(() => {
                if (typeof t._priority.setOptions !== 'function') customElements.upgrade(t._priority);
                t._priority.setOptions(PRIORITIES.map(([, label]) => label));
                t.render();
            });
            t._priority.addEventListener('change', () => {
                const label = t._priority.value;
                const priority = PRIORITIES.find(([, name]) => name === label)?.[0] || 'normal';
                if (priority !== saved().priority) t.save({ priority });
            });
            // The label follows the slider as it moves, and the choice is saved once it is let go.
            t._threads.addEventListener('input', () => t.showThreads(Number(t._threads.value)));
            t._threads.addEventListener('change', () => {
                const value = Number(t._threads.value);
                t.save({ threads: value >= t._info.threads ? 0 : value });
            });
            t.dataset.subscribe = `${KEY}:render`;
            // The backend can take a while to be ready as the app starts.
            whenProxyReady().then(proxy => proxy.performance.info()).then(info => {
                if (!info) return;
                t._info = info;
                t.render();
            });
        },
        save(change) {
            webui.setData(KEY, { ...saved(), ...change });
        },
        /** Shows the saved choices, once what this computer offers is known. */
        render() {
            const t = this;
            const info = t._info;
            if (!info || typeof t._priority?.setValue !== 'function') return;
            const { priority, threads } = saved();
            t._priority.setValue(PRIORITIES.find(([id]) => id === priority)[1]);
            t._priorityNote.textContent = {
                normal: 'Scripts run as any program you start does.',
                low: 'Scripts run below your other programs, so the computer stays responsive while they work.',
                lowest: info.hasIdlePriority
                    ? 'Scripts only use CPU time nothing else wants. A busy computer can slow them a lot.'
                    : 'Scripts run at the lowest priority this computer offers.',
            }[priority];
            t._threads.max = `${info.threads}`;
            t._threads.disabled = !info.canLimitThreads || info.threads < 2;
            t._threads.value = `${threads > 0 && threads < info.threads ? threads : info.threads}`;
            t.showThreads(Number(t._threads.value));
            t._threadsNote.textContent = info.canLimitThreads
                ? 'Tools that size themselves to the computer, such as cargo, see only these threads and start fewer jobs.'
                : "This computer can't keep scripts to some CPU threads, so only their priority can be lowered.";
        },
        showThreads(value) {
            const t = this;
            const all = t._info?.threads || 1;
            t._threadsLabel.textContent = value >= all ? `All ${all} threads` : `${value} of ${all} threads`;
        },
    });
}
