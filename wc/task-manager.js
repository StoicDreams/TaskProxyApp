/*
 * The header's Task Manager button, between Terminals and the alerts. It opens the shared right drawer on every
 * process the user runs, wherever it was started, such as a dev server left running by an editor's terminal, with
 * preset and custom filters, and stops or force closes them.
 *
 * It stays light: the backend reads processes only while the drawer is open and shown, at the chosen pace, one read
 * at a time, and lets go of them when it closes. Ports take longer to read, so the backend reuses them for a few
 * seconds. Rows are drawn in one pass, and only so many at once.
 */
"use strict"
{
    const settingsKey = 'app-task-manager';
    const rowLimit = 300;
    const MB = 1024 * 1024;
    const escape = text => webui.escapeForHTML(`${text ?? ''}`);
    const paces = [
        { ms: 1000, label: 'Every second' },
        { ms: 2000, label: 'Every 2 seconds' },
        { ms: 5000, label: 'Every 5 seconds' },
        { ms: 10000, label: 'Every 10 seconds' },
        { ms: 0, label: 'Paused' },
    ];
    /** What a process is, beyond its numbers, for the Kind field and the badges. */
    const kinds = {
        terminal: { label: 'Terminal', title: 'Started from a terminal, or an editor\'s terminal', has: p => p.terminal },
        orphan: { label: 'Orphaned', title: 'Kept running after what started it ended, such as a dev server after its terminal or editor closed', has: p => p.orphan },
        listening: { label: 'Listening', title: 'Listening on a port', has: p => p.ports.length > 0 },
        taskproxy: { label: 'Task Proxy', title: 'Task Proxy, or started by it, such as a script', has: p => p.taskProxy },
        project: { label: 'Project', title: 'Running in one of your projects\' folders', has: p => !!p.project },
    };
    /** The fields a rule can test. `kind` chooses its operators. */
    const fields = {
        name: { label: 'Name', kind: 'text', get: p => p.name },
        command: { label: 'Command', kind: 'text', get: p => p.command },
        folder: { label: 'Folder', kind: 'text', get: p => p.folder },
        project: { label: 'Project', kind: 'text', get: p => p.project || '' },
        status: { label: 'Status', kind: 'text', get: p => p.status },
        pid: { label: 'PID', kind: 'number', get: p => p.pid },
        parent: { label: 'Parent PID', kind: 'number', get: p => p.parent ?? NaN },
        port: { label: 'Port', kind: 'ports', get: p => p.ports },
        cpu: { label: 'CPU %', kind: 'number', get: p => p.cpu },
        memory: { label: 'Memory (MB)', kind: 'number', get: p => p.memory / MB },
        age: { label: 'Running for (minutes)', kind: 'number', get: (p, now) => (now - p.started) / 60 },
        kind: { label: 'Kind', kind: 'kind', get: p => p },
    };
    const operators = {
        text: [['contains', 'contains'], ['missing', 'does not contain'], ['is', 'is'], ['isnt', 'is not'], ['starts', 'starts with'], ['ends', 'ends with'], ['regex', 'matches pattern'], ['set', 'is set'], ['unset', 'is not set']],
        number: [['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤'], ['=', '='], ['!=', '≠']],
        ports: [['=', 'includes'], ['!=', 'does not include'], ['set', 'is set'], ['unset', 'is not set']],
        kind: [['is', 'is'], ['isnt', 'is not']],
    };
    /** Ready-made filters. Each can be copied into a custom filter to change. */
    const presets = [
        { id: 'terminal', name: 'Terminal', title: 'Started from a terminal or an editor\'s terminal, the shells themselves left out', match: 'all', rules: [{ field: 'kind', op: 'is', value: 'terminal' }] },
        { id: 'orphan', name: 'Orphaned', title: 'Kept running after what started it ended', match: 'all', rules: [{ field: 'kind', op: 'is', value: 'orphan' }] },
        { id: 'listening', name: 'Listening on a port', title: 'Servers and anything else waiting for connections', match: 'all', rules: [{ field: 'kind', op: 'is', value: 'listening' }], sort: { key: 'ports', desc: false } },
        { id: 'projects', name: 'In my projects', title: 'Running in one of your projects\' folders', match: 'all', rules: [{ field: 'kind', op: 'is', value: 'project' }], sort: { key: 'project', desc: false } },
        { id: 'taskproxy', name: 'Started by Task Proxy', title: 'Task Proxy and the scripts it runs', match: 'all', rules: [{ field: 'kind', op: 'is', value: 'taskproxy' }] },
        { id: 'cpu', name: 'Busy', title: 'Using more than 5% of the CPU', match: 'all', rules: [{ field: 'cpu', op: '>', value: '5' }], sort: { key: 'cpu', desc: true } },
        { id: 'memory', name: 'Large', title: 'Using more than 500 MB of memory', match: 'all', rules: [{ field: 'memory', op: '>', value: '500' }], sort: { key: 'memory', desc: true } },
        { id: 'recent', name: 'Started recently', title: 'Started in the last hour', match: 'all', rules: [{ field: 'age', op: '<', value: '60' }], sort: { key: 'age', desc: false } },
        { id: 'all', name: 'All my processes', title: 'Every process you run', match: 'all', rules: [] },
    ];
    const columns = [
        { key: 'name', label: 'Name' },
        { key: 'pid', label: 'PID', numeric: true },
        { key: 'cpu', label: 'CPU', numeric: true },
        { key: 'memory', label: 'Memory', numeric: true },
        { key: 'age', label: 'Running', numeric: true },
        { key: 'ports', label: 'Ports' },
        { key: 'project', label: 'Project or folder' },
    ];
    /** The class of a column's cells, which a narrow drawer hides, the least needed first. */
    const cellClass = key => `c-${key}`;
    const sortValue = {
        name: p => p.name.toLowerCase(),
        pid: p => p.pid,
        cpu: p => p.cpu,
        memory: p => p.memory,
        age: p => -p.started,
        ports: p => p.ports.length ? p.ports[0] : Infinity,
        project: p => (p.project || p.folder || '').toLowerCase(),
    };

    function loadSettings() {
        const saved = webui.getData(settingsKey);
        const value = saved && typeof saved === 'object' ? saved : {};
        return {
            filter: typeof value.filter === 'string' ? value.filter : 'terminal',
            pace: paces.some(pace => pace.ms === value.pace) ? value.pace : 2000,
            sort: value.sort && sortValue[value.sort.key] ? value.sort : null,
            tree: value.tree !== false,
            guide: value.guide !== false,
            custom: validFilter(value.custom) || { match: 'all', rules: [] },
            saved: Array.isArray(value.saved) ? value.saved.map(validFilter).filter(filter => filter?.name) : [],
        };
    }
    function validFilter(filter) {
        if (!filter || typeof filter !== 'object') return null;
        const rules = (Array.isArray(filter.rules) ? filter.rules : [])
            .filter(rule => rule && fields[rule.field])
            .map(rule => ({ field: rule.field, op: `${rule.op ?? ''}`, value: `${rule.value ?? ''}` }));
        return { name: typeof filter.name === 'string' ? filter.name : undefined, match: filter.match === 'any' ? 'any' : 'all', rules };
    }

    /** Whether a process passes one rule. A rule that cannot be read, such as a broken pattern, passes everything. */
    function ruleMatches(rule, p, now) {
        const field = fields[rule.field];
        if (!field) return true;
        const value = field.get(p, now);
        const wanted = rule.value.trim();
        switch (field.kind) {
            case 'kind': {
                const has = kinds[wanted]?.has(p) ?? true;
                return rule.op === 'isnt' ? !has : has;
            }
            case 'ports': {
                if (rule.op === 'set') return value.length > 0;
                if (rule.op === 'unset') return value.length === 0;
                const port = Number(wanted);
                if (!wanted || !Number.isFinite(port)) return true;
                return rule.op === '!=' ? !value.includes(port) : value.includes(port);
            }
            case 'number': {
                const number = Number(wanted);
                if (wanted === '' || !Number.isFinite(number)) return true;
                if (!Number.isFinite(value)) return rule.op === '!=';
                switch (rule.op) {
                    case '>': return value > number;
                    case '>=': return value >= number;
                    case '<': return value < number;
                    case '<=': return value <= number;
                    case '!=': return Math.abs(value - number) > 1e-9;
                    default: return Math.abs(value - number) < 1e-9;
                }
            }
            default: {
                const text = `${value ?? ''}`.toLowerCase();
                const needle = wanted.toLowerCase();
                switch (rule.op) {
                    case 'set': return text !== '';
                    case 'unset': return text === '';
                    case 'regex':
                        try { return new RegExp(wanted, 'i').test(`${value ?? ''}`); } catch { return true; }
                    case 'is': return text === needle;
                    case 'isnt': return text !== needle;
                    case 'starts': return text.startsWith(needle);
                    case 'ends': return text.endsWith(needle);
                    case 'missing': return !needle || !text.includes(needle);
                    default: return text.includes(needle);
                }
            }
        }
    }
    function filterMatches(filter, p, now) {
        if (!filter.rules.length) return true;
        return filter.match === 'any'
            ? filter.rules.some(rule => ruleMatches(rule, p, now))
            : filter.rules.every(rule => ruleMatches(rule, p, now));
    }
    /** Every word of the search is in the name, command, folder, project, pid, or a port. */
    function searchMatches(words, p) {
        if (!words.length) return true;
        const text = `${p.name} ${p.command} ${p.folder} ${p.project || ''} ${p.pid} ${p.ports.join(' ')}`.toLowerCase();
        return words.every(word => text.includes(word));
    }

    function formatBytes(bytes) {
        if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
        if (bytes >= MB) return `${(bytes / MB).toFixed(bytes >= 100 * MB ? 0 : 1)} MB`;
        return `${Math.max(0, Math.round(bytes / 1024))} KB`;
    }
    function formatAge(seconds) {
        seconds = Math.max(0, Math.floor(seconds));
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ${minutes % 60}m`;
        return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    }
    const formatCpu = cpu => `${cpu >= 10 ? cpu.toFixed(0) : cpu.toFixed(1)}%`;

    /** The drawer's contents, which run while they are shown and stop once the drawer closes or another replaces them. */
    class TaskManagerView {
        constructor(body) {
            this.body = body;
            this.settings = loadSettings();
            this.processes = [];
            this.byPid = new Map();
            this.selected = null;
            this.search = '';
            this.loading = false;
            this.closedTicks = 0;
            this.build();
            this.refresh();
        }
        save() {
            webui.setData(settingsKey, JSON.parse(JSON.stringify(this.settings)));
        }
        /** The filter in use: a preset, a saved filter, or the custom one being edited. */
        currentFilter() {
            const id = this.settings.filter;
            const preset = presets.find(preset => preset.id === id);
            if (preset) return { ...preset, readOnly: true };
            if (id.startsWith('saved:')) {
                const saved = this.settings.saved.find(filter => filter.name === id.substring(6));
                if (saved) return { ...saved, id };
            }
            return { id: 'custom', name: 'Custom', ...this.settings.custom };
        }
        build() {
            const t = this;
            t.body.innerHTML = `
<style>
.task-manager { display: flex; flex-direction: column; gap: calc(0.5 * var(--padding)); height: 100%; min-height: 0; container-type: inline-size; }
.task-manager .tm-tools { display: flex; flex-wrap: wrap; gap: calc(0.5 * var(--padding)); align-items: center; }
.task-manager select, .task-manager input, .task-manager button { font: inherit; color: var(--color-background-offset); background: var(--color-background); border: 1px solid var(--color-background-offset); border-radius: var(--corners); padding: 2px 6px; }
.task-manager button { cursor: pointer; }
.task-manager button:hover, .task-manager button:focus-visible { outline: 1px solid var(--color-info); }
.task-manager button.danger { border-color: var(--color-danger, #c33); }
.task-manager button[aria-pressed="true"] { background: var(--color-info); color: var(--color-info-offset); }
.task-manager .tm-search { flex: 1 1 10em; min-width: 6em; }
.task-manager .tm-summary, .task-manager .tm-note { font-size: 0.9em; opacity: 0.85; }
.task-manager details.tm-rules > summary { cursor: pointer; }
.task-manager details.tm-guide { flex: 0 0 auto; max-height: 35%; overflow: auto; font-size: 0.85em; }
.task-manager details.tm-guide > summary { cursor: pointer; }
.task-manager details.tm-guide dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 8px; margin: 4px 0; }
.task-manager details.tm-guide dt { font-weight: bold; }
.task-manager details.tm-guide dd { margin: 0; }
.task-manager details.tm-guide p { margin: 4px 0 0; }
@container (max-width: 420px) { .task-manager details.tm-guide dl { grid-template-columns: 1fr; } .task-manager details.tm-guide dd { margin-bottom: 4px; } }
.task-manager .tm-rule { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin: 4px 0; }
.task-manager .tm-rule input { flex: 1 1 8em; min-width: 4em; }
.task-manager .tm-table-wrap { flex: 1 1 auto; min-height: 8em; overflow: auto; overflow-anchor: none; border: 1px solid var(--color-background-offset); border-radius: var(--corners); container-type: inline-size; }
@container (max-width: 620px) { .task-manager .c-project { display: none; } }
@container (max-width: 500px) { .task-manager .c-age { display: none; } }
/* In the narrowest drawer the ports go too, so the table fits rather than scrolling sideways by a few pixels. */
@container (max-width: 380px) { .task-manager .c-ports { display: none; } }
.task-manager .tm-details td { padding: 0; }
.task-manager .tm-inner { position: sticky; left: 0; width: 100cqw; box-sizing: border-box; padding: 4px 8px; }
.task-manager table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
.task-manager th { position: sticky; top: 0; background: var(--color-background); text-align: left; white-space: nowrap; z-index: 1; }
.task-manager th button { border: none; background: none; padding: 4px; font-weight: bold; }
.task-manager td { padding: 3px 4px; border-top: 1px solid rgba(128, 128, 128, 0.25); vertical-align: top; }
.task-manager td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.task-manager tr.tm-row { cursor: pointer; }
.task-manager tr.tm-row:hover, .task-manager tr.tm-row:focus-visible { background: rgba(128, 128, 128, 0.15); outline: none; }
.task-manager tr.tm-row.selected { background: rgba(80, 140, 220, 0.25); }
.task-manager .tm-name { white-space: nowrap; }
.task-manager .tm-place { max-width: 16em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-manager .tm-badge { display: inline-block; font-size: 0.75em; padding: 0 4px; margin-left: 4px; border-radius: var(--corners); border: 1px solid currentColor; opacity: 0.85; }
.task-manager .tm-badge.orphan { color: var(--color-warning); }
.task-manager .tm-details td { background: rgba(128, 128, 128, 0.08); }
.task-manager .tm-details pre { background: none; color: inherit; }
.task-manager .tm-details dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 8px; margin: 4px 0; }
.task-manager .tm-details dt { font-weight: bold; }
.task-manager .tm-details dd { margin: 0; overflow-wrap: anywhere; }
.task-manager .tm-details pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-size: 0.95em; }
.task-manager .tm-details .tm-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.task-manager .tm-link { cursor: pointer; text-decoration: underline; }
</style>
<div class="task-manager">
    <div class="tm-tools">
        <select class="tm-filter" aria-label="Filter"></select>
        <input type="search" class="tm-search" placeholder="Search name, command, folder, PID, or port" aria-label="Search processes" />
        <select class="tm-pace" aria-label="Refresh">${paces.map(pace => `<option value="${pace.ms}">${pace.label}</option>`).join('')}</select>
        <button type="button" class="tm-refresh" title="Refresh now">Refresh</button>
        <button type="button" class="tm-tree" aria-pressed="false" title="Show each process under the one that started it">Tree</button>
    </div>
    <details class="tm-rules">
        <summary>Filter rules</summary>
        <div class="tm-rules-body"></div>
    </details>
    <webui-alert class="tm-message"></webui-alert>
    <div class="tm-summary"></div>
    <div class="tm-table-wrap">
        <table>
            <thead><tr>${columns.map(column => `<th scope="col" class="${cellClass(column.key)}"><button type="button" data-sort="${column.key}">${column.label}</button></th>`).join('')}</tr></thead>
            <tbody></tbody>
        </table>
    </div>
    <details class="tm-guide">
        <summary>How stopping works</summary>
        <dl>
            <dt>Stop</dt>
            <dd>Asks only this process to stop, as Ctrl+C would, so it can clean up. What it started may keep running.</dd>
            <dt>Stop with children</dt>
            <dd>Asks it and everything under it to stop, the deepest first. The number counts all of them.</dd>
            <dt>Force close</dt>
            <dd>Ends only this process at once, with no clean up. What it started keeps running.</dd>
            <dt>Force close with children</dt>
            <dd>Ends it and everything under it at once, the deepest first, with no clean up.</dd>
        </dl>
        <p>Try Stop first. A process left running after what started it ended shows as Orphaned. Rest the pointer on a button for more.</p>
    </details>
</div>`;
            const $ = selector => t.body.querySelector(selector);
            t.filterSelect = $('.tm-filter');
            t.searchInput = $('.tm-search');
            t.paceSelect = $('.tm-pace');
            t.treeBox = $('.tm-tree');
            t.rulesBody = $('.tm-rules-body');
            t.rulesDetails = $('.tm-rules');
            t.guide = $('.tm-guide');
            t.guide.open = t.settings.guide;
            t.message = $('.tm-message');
            t.summary = $('.tm-summary');
            t.tbody = $('tbody');
            t.paceSelect.value = `${t.settings.pace}`;
            t.treeBox.setAttribute('aria-pressed', `${t.settings.tree}`);
            t.fillFilterSelect();
            t.drawRules();
            t.filterSelect.addEventListener('change', () => t.chooseFilter(t.filterSelect.value));
            t.searchInput.addEventListener('input', () => {
                t.search = t.searchInput.value;
                t.draw();
            });
            t.paceSelect.addEventListener('change', () => {
                t.settings.pace = Number(t.paceSelect.value);
                t.save();
                t.draw();
                t.schedule();
            });
            // The drawer stops the default action of clicks inside it, so checkboxes and details elements are toggled here.
            t.treeBox.addEventListener('click', () => {
                t.settings.tree = !t.settings.tree;
                t.treeBox.setAttribute('aria-pressed', `${t.settings.tree}`);
                t.save();
                t.draw();
            });
            t.rulesDetails.querySelector('summary').addEventListener('click', ev => {
                ev.preventDefault();
                t.rulesDetails.open = !t.rulesDetails.open;
            });
            t.guide.querySelector('summary').addEventListener('click', ev => {
                ev.preventDefault();
                t.guide.open = !t.guide.open;
                t.settings.guide = t.guide.open;
                t.save();
            });
            $('.tm-refresh').addEventListener('click', () => {
                t.clearDone();
                t.refresh();
            });
            $('thead').addEventListener('click', ev => {
                const button = ev.target.closest('[data-sort]');
                if (!button) return;
                const key = button.dataset.sort;
                const sort = t.sort();
                const numeric = columns.find(column => column.key === key)?.numeric;
                t.settings.sort = { key, desc: sort.key === key ? !sort.desc : !!numeric && key !== 'pid' };
                t.save();
                t.draw();
            });
            t.tbody.addEventListener('click', ev => t.onTableClick(ev));
            t.tbody.addEventListener('keydown', ev => {
                const row = ev.target.closest?.('tr.tm-row');
                if (!row || ev.target !== row || (ev.key !== 'Enter' && ev.key !== ' ')) return;
                ev.preventDefault();
                t.select(Number(row.dataset.pid));
            });
            t.rulesBody.addEventListener('input', ev => t.onRuleEdit(ev));
            t.rulesBody.addEventListener('change', ev => t.onRuleEdit(ev));
            t.rulesBody.addEventListener('click', ev => t.onRuleClick(ev));
        }
        fillFilterSelect() {
            const t = this;
            const option = (value, label, title) => `<option value="${escape(value)}"${title ? ` title="${escape(title)}"` : ''}>${escape(label)}</option>`;
            t.filterSelect.innerHTML = `<optgroup label="Presets">${presets.map(preset => option(preset.id, preset.name, preset.title)).join('')}</optgroup>`
                + (t.settings.saved.length ? `<optgroup label="Saved">${t.settings.saved.map(filter => option(`saved:${filter.name}`, filter.name)).join('')}</optgroup>` : '')
                + `<optgroup label="Your own">${option('custom', 'Custom')}</optgroup>`;
            t.filterSelect.value = t.currentFilter().id;
        }
        chooseFilter(id) {
            const t = this;
            t.clearDone();
            t.settings.filter = id;
            const filter = t.currentFilter();
            if (filter.sort) t.settings.sort = { ...filter.sort };
            if (id === 'custom') t.rulesDetails.open = true;
            t.save();
            t.drawRules();
            t.draw();
        }
        /** The rule editor: the filter's rules, which a preset only shows, with a way to copy it to change. */
        drawRules() {
            const t = this;
            const filter = t.currentFilter();
            const readOnly = !!filter.readOnly;
            const disabled = readOnly ? ' disabled' : '';
            const rule = (rule, index) => {
                const field = fields[rule.field];
                const ops = operators[field.kind];
                const needsValue = !['set', 'unset'].includes(rule.op);
                const value = field.kind === 'kind'
                    ? `<select data-part="value" aria-label="Kind"${disabled}>${Object.entries(kinds).map(([id, kind]) => `<option value="${id}"${rule.value === id ? ' selected' : ''}>${kind.label}</option>`).join('')}</select>`
                    : needsValue ? `<input data-part="value" aria-label="Value" value="${escape(rule.value)}"${field.kind === 'number' || field.kind === 'ports' ? ' inputmode="decimal"' : ''}${disabled} />` : '';
                return `<div class="tm-rule" data-index="${index}">
                    <select data-part="field" aria-label="Field"${disabled}>${Object.entries(fields).map(([id, f]) => `<option value="${id}"${rule.field === id ? ' selected' : ''}>${f.label}</option>`).join('')}</select>
                    <select data-part="op" aria-label="Test"${disabled}>${ops.map(([id, label]) => `<option value="${escape(id)}"${rule.op === id ? ' selected' : ''}>${escape(label)}</option>`).join('')}</select>
                    ${value}
                    ${readOnly ? '' : `<button type="button" data-do="remove" title="Remove this rule">Remove</button>`}
                </div>`;
            };
            const match = `<label>Show processes that match <select data-part="match" aria-label="Match"${disabled}>
                <option value="all"${filter.match !== 'any' ? ' selected' : ''}>every rule</option>
                <option value="any"${filter.match === 'any' ? ' selected' : ''}>any rule</option></select></label>`;
            let html = match;
            html += filter.rules.length ? filter.rules.map(rule).join('') : `<p class="tm-note">No rules, so every process shows.</p>`;
            if (readOnly) {
                html += `<p class="tm-note">${escape(filter.title)}. Presets cannot change: copy one to make your own.</p>
                    <button type="button" data-do="copy">Copy to Custom</button>`;
            } else {
                html += `<div class="tm-tools">
                    <button type="button" data-do="add">Add a rule</button>
                    <input data-part="name" aria-label="Filter name" placeholder="Name to save it as" value="${filter.id.startsWith('saved:') ? escape(filter.name) : ''}" />
                    <button type="button" data-do="save">Save</button>
                    ${filter.id.startsWith('saved:') ? '<button type="button" data-do="delete" class="danger">Delete</button>' : ''}
                </div>`;
            }
            t.rulesBody.innerHTML = html;
        }
        /** The filter being edited, as stored: the custom filter, or a saved one. */
        editedFilter() {
            const t = this;
            const id = t.settings.filter;
            if (id.startsWith('saved:')) return t.settings.saved.find(filter => filter.name === id.substring(6)) || t.settings.custom;
            return t.settings.custom;
        }
        onRuleEdit(ev) {
            const t = this;
            const part = ev.target.dataset?.part;
            if (!part || part === 'name' || t.currentFilter().readOnly) return;
            const filter = t.editedFilter();
            if (part === 'match') {
                filter.match = ev.target.value === 'any' ? 'any' : 'all';
            } else {
                const index = Number(ev.target.closest('.tm-rule')?.dataset.index);
                const rule = filter.rules[index];
                if (!rule) return;
                if (part === 'field') {
                    rule.field = ev.target.value;
                    const kind = fields[rule.field].kind;
                    rule.op = operators[kind][0][0];
                    rule.value = kind === 'kind' ? 'terminal' : '';
                } else if (part === 'op') {
                    rule.op = ev.target.value;
                } else {
                    rule.value = ev.target.value;
                }
                // The field or test changes which inputs show, so the editor is drawn again. A typed value is not.
                if (part !== 'value' && ev.type === 'change') t.drawRules();
            }
            if (ev.type === 'change' || part === 'value') {
                t.save();
                t.draw();
            }
        }
        onRuleClick(ev) {
            const t = this;
            const trigger = ev.target.closest?.('[data-do]');
            const action = trigger?.dataset.do;
            if (!action) return;
            // What the last action did is not about this one.
            t.clearDone();
            const filter = t.editedFilter();
            if (action === 'copy') {
                const preset = t.currentFilter();
                t.settings.custom = { match: preset.match, rules: preset.rules.map(rule => ({ ...rule })) };
                t.settings.filter = 'custom';
            } else if (action === 'add') {
                filter.rules.push({ field: 'name', op: 'contains', value: '' });
            } else if (action === 'remove') {
                filter.rules.splice(Number(ev.target.closest('.tm-rule').dataset.index), 1);
            } else if (action === 'save') {
                const name = t.rulesBody.querySelector('[data-part="name"]').value.trim();
                if (!name) {
                    // Said by Save, beside the name it asks for, and gone once the rules are drawn again.
                    actionNote(trigger, 'Give the filter a name to save it.', 'warning');
                    return;
                }
                const copy = { name, match: filter.match, rules: filter.rules.map(rule => ({ ...rule })) };
                const at = t.settings.saved.findIndex(saved => saved.name === name);
                if (at === -1) t.settings.saved.push(copy);
                else t.settings.saved[at] = copy;
                t.settings.filter = `saved:${name}`;
                t.say(`Saved the filter ${name}.`);
            } else if (action === 'delete') {
                t.settings.saved = t.settings.saved.filter(saved => saved !== filter);
                t.settings.filter = 'custom';
            }
            t.save();
            t.fillFilterSelect();
            t.drawRules();
            t.draw();
        }
        sort() {
            return this.settings.sort || this.currentFilter().sort || { key: 'name', desc: false };
        }
        /**
         * What an action did, or why it failed, in an alert above the list, which stays as the list is drawn again
         * until the next action starts (clearDone). `variant` is success, info, warning, or danger.
         */
        say(text, variant = 'success') {
            // Whatever said last is shown now, so a read that works again no longer has a failure of its own to clear.
            this.listFailed = false;
            setNote(this.message, text, variant);
        }
        /**
         * Takes away what the last action said, whether it worked or failed, as the user's next action starts, so it
         * is not read as being about that one. A list that couldn't be read stays until a read works again.
         */
        clearDone() {
            if (this.message?.hasAttribute('show') && !this.listFailed) this.say();
        }
        /** Reads the processes now, unless a read is already under way, then waits for the next turn. */
        async refresh() {
            const t = this;
            clearTimeout(t.timer);
            if (!t.isShown()) return;
            if (t.loading) return;
            t.loading = true;
            try {
                let failed = false;
                const list = await webui.proxy.taskManager.list(true, err => {
                    failed = true;
                    t.say(`${err}`, 'danger');
                    t.listFailed = true;
                });
                if (!t.body.isConnected) return;
                // A read that works again takes away why the last one failed, which would otherwise stay.
                if (!failed && t.listFailed) t.say();
                if (list) {
                    t.list = list;
                    t.processes = list.processes;
                    t.byPid = new Map(t.processes.map(p => [p.pid, p]));
                    t.readAt = Date.now();
                    t.draw();
                }
            } finally {
                t.loading = false;
                t.schedule();
            }
        }
        schedule() {
            const t = this;
            clearTimeout(t.timer);
            if (!t.body.isConnected) return t.close();
            if (t.settings.pace > 0) t.timer = setTimeout(() => t.refresh(), t.settings.pace);
        }
        /** Whether the drawer is open on these contents, and the window is shown. A closed drawer lets go. */
        isShown() {
            const t = this;
            if (!t.body.isConnected) {
                t.close();
                return false;
            }
            const drawer = t.body.closest('webui-drawer');
            // A closed drawer, or another tab of Tools, lets go the same way.
            if ((drawer && !drawer.classList.contains('open')) || t.body.closest('[tab-hidden], [inert]')) {
                // A closing drawer stays in the page, so give it a moment before letting go.
                if (++t.closedTicks > 1) {
                    t.close();
                    return false;
                }
                t.schedule();
                return false;
            }
            t.closedTicks = 0;
            if (document.hidden) {
                t.schedule();
                return false;
            }
            return true;
        }
        close() {
            const t = this;
            clearTimeout(t.timer);
            if (t.closed) return;
            t.closed = true;
            webui.proxy.taskManager.close();
        }
        /** The processes the filter and search keep, sorted, and in tree order when chosen. */
        shown() {
            const t = this;
            const now = (t.readAt || Date.now()) / 1000;
            const filter = t.currentFilter();
            const words = t.search.toLowerCase().split(/\s+/).filter(Boolean);
            const kept = t.processes.filter(p => filterMatches(filter, p, now) && searchMatches(words, p));
            const { key, desc } = t.sort();
            const value = sortValue[key];
            const compare = (a, b) => {
                const x = value(a), y = value(b);
                const order = x < y ? -1 : x > y ? 1 : a.pid - b.pid;
                return desc ? -order : order;
            };
            kept.sort(compare);
            if (!t.settings.tree) return kept.map(p => ({ p, depth: 0 }));
            // Each process under the nearest one above it that is also shown.
            const shownPids = new Set(kept.map(p => p.pid));
            const children = new Map();
            const roots = [];
            const shownParent = p => {
                const seen = new Set();
                for (let at = t.byPid.get(p.parent); at && !seen.has(at.pid); at = t.byPid.get(at.parent)) {
                    seen.add(at.pid);
                    if (shownPids.has(at.pid)) return at.pid;
                }
                return null;
            };
            kept.forEach(p => {
                const parent = shownParent(p);
                if (parent === null) roots.push(p);
                else (children.get(parent) || children.set(parent, []).get(parent)).push(p);
            });
            const ordered = [];
            const visit = (p, depth) => {
                ordered.push({ p, depth });
                (children.get(p.pid) || []).forEach(child => visit(child, depth + 1));
            };
            roots.forEach(p => visit(p, 0));
            return ordered;
        }
        draw() {
            const t = this;
            if (!t.list) return;
            // A refresh keeps the list where it was scrolled to, and one scrolled to its end stays there. This is saved
            // before anything changes, since WebKit moved the list when the header and summary were written together.
            const wrap = t.tbody.closest('.tm-table-wrap');
            const scrollTop = wrap.scrollTop;
            const atEnd = scrollTop > 0 && scrollTop + wrap.clientHeight >= wrap.scrollHeight - 2;
            const rows = t.shown();
            const now = (t.readAt || Date.now()) / 1000;
            const { key, desc } = t.sort();
            t.body.querySelectorAll('thead [data-sort]').forEach(button => {
                const column = columns.find(column => column.key === button.dataset.sort);
                const active = column.key === key;
                const label = column.label + (active ? (desc ? ' ▾' : ' ▴') : '');
                const sorted = active ? (desc ? 'descending' : 'ascending') : 'none';
                if (button.textContent !== label) button.textContent = label;
                const th = button.closest('th');
                if (th.getAttribute('aria-sort') !== sorted) th.setAttribute('aria-sort', sorted);
            });
            const list = t.list;
            const pace = t.settings.pace ? '' : ' Paused.';
            const total = t.processes.length;
            const count = rows.length === total ? `${total} processes.` : `${rows.length} of ${total} processes match.`;
            const summary = `${count} CPU ${formatCpu(list.cpu)}, memory ${formatBytes(list.memoryUsed)} of ${formatBytes(list.memoryTotal)}.${pace}`;
            if (t.summary.textContent !== summary) t.summary.textContent = summary;
            let html = '';
            rows.slice(0, rowLimit).forEach(({ p, depth }) => {
                const badges = Object.entries(kinds)
                    .filter(([id, kind]) => id !== 'listening' && id !== 'project' && kind.has(p))
                    .map(([id, kind]) => `<span class="tm-badge ${id}" title="${escape(kind.title)}">${kind.label}</span>`).join('');
                const place = p.project ? p.project : p.folder;
                html += `<tr class="tm-row${t.selected === p.pid ? ' selected' : ''}" data-pid="${p.pid}" tabindex="0" aria-expanded="${t.selected === p.pid}" title="${escape(p.command || p.name)}">
                    <td class="tm-name c-name" style="padding-left:${4 + depth * 14}px">${depth ? '└ ' : ''}${escape(p.name)}${badges}</td>
                    <td class="num c-pid">${p.pid}</td>
                    <td class="num c-cpu">${formatCpu(p.cpu)}</td>
                    <td class="num c-memory">${formatBytes(p.memory)}</td>
                    <td class="num c-age">${formatAge(now - p.started)}</td>
                    <td class="c-ports">${escape(p.ports.join(', '))}</td>
                    <td class="tm-place c-project" title="${escape(p.folder)}">${escape(place)}</td>
                </tr>`;
                if (t.selected === p.pid) html += t.detailsHtml(p, now);
            });
            if (!rows.length) html = `<tr><td colspan="${columns.length}" class="tm-note">No processes match.</td></tr>`;
            if (rows.length > rowLimit) html += `<tr><td colspan="${columns.length}" class="tm-note">${rows.length - rowLimit} more match. Search or filter to narrow them down.</td></tr>`;
            // The selected process can be outside the rows shown, such as after filtering, and keeps its details.
            const selected = t.byPid.get(t.selected);
            if (selected && !rows.slice(0, rowLimit).some(row => row.p.pid === selected.pid)) {
                html = t.detailsHtml(selected, now, true) + html;
            }
            t.patchRows(html);
            const restored = atEnd ? wrap.scrollHeight : scrollTop;
            if (wrap.scrollTop !== restored) wrap.scrollTop = restored;
        }
        /** Swaps in only the rows that changed, leaving the rest of the list as it is. */
        patchRows(html) {
            const t = this;
            const fresh = document.createElement('tbody');
            fresh.innerHTML = html;
            const next = [...fresh.children];
            const old = [...t.tbody.children];
            next.forEach((row, index) => {
                const current = old[index];
                if (!current) t.tbody.appendChild(row);
                else if (current.outerHTML !== row.outerHTML) current.replaceWith(row);
            });
            old.slice(next.length).forEach(row => row.remove());
        }
        detailsHtml(p, now, outside) {
            const t = this;
            const parent = t.byPid.get(p.parent);
            const children = t.processes.filter(child => child.parent === p.pid);
            const all = t.descendants(p.pid);
            const one = all.length === 1;
            const under = `${all.length} process${one ? '' : 'es'} under it`;
            // What each button does, and what it leaves alone, shown when the pointer rests on it.
            const tips = {
                stop: all.length
                    ? `Asks only this process to stop, as Ctrl+C or closing its window would, so it can save and clean up. The ${under} ${one ? 'is' : 'are'} not asked: many programs stop their own children, but some leave them running. It may take a moment to stop, or not stop at all.`
                    : 'Asks this process to stop, as Ctrl+C or closing its window would, so it can save and clean up. It may take a moment to stop, or not stop at all.',
                stopTree: `Asks this process and the ${under} (what it started, and what those started) to stop, the deepest first, so each can save and clean up. Any of them may take a moment to stop, or not stop at all.`,
                kill: all.length
                    ? `Ends only this process at once. It cannot save or clean up, and the ${under} ${one ? 'keeps' : 'keep'} running.`
                    : 'Ends this process at once. It cannot save or clean up.',
                killTree: `Ends this process and the ${under} (what it started, and what those started) at once, the deepest first. None of them can save or clean up.`,
            };
            const link = q => `<span class="tm-link" data-select="${q.pid}">${escape(q.name)} (${q.pid})</span>`;
            const kindsText = Object.values(kinds).filter(kind => kind.has(p)).map(kind => kind.label).join(', ');
            const started = new Date(p.started * 1000).toLocaleString();
            return `<tr class="tm-details" data-for="${p.pid}"><td colspan="${columns.length}"><div class="tm-inner">
                ${outside ? `<p class="tm-note">${escape(p.name)} (${p.pid}) does not match the filter.</p>` : ''}
                <dl>
                    <dt>Command</dt><dd><pre>${escape(p.command || p.name)}</pre></dd>
                    ${p.exe ? `<dt>Program</dt><dd>${escape(p.exe)}</dd>` : ''}
                    <dt>Folder</dt><dd>${escape(p.folder || 'Unknown')}${p.project ? ` (${escape(p.project)})` : ''}</dd>
                    <dt>Started</dt><dd>${escape(started)}, ${formatAge(now - p.started)} ago</dd>
                    <dt>Status</dt><dd>${escape(p.status)}${kindsText ? `, ${escape(kindsText)}` : ''}</dd>
                    ${p.ports.length ? `<dt>Ports</dt><dd>${escape(p.ports.join(', '))}</dd>` : ''}
                    <dt>Started by</dt><dd>${parent ? link(parent) : p.parent ? `Process ${p.parent}, which is not yours` : 'A process that has ended'}</dd>
                    ${children.length ? `<dt>It started</dt><dd>${children.map(link).join(', ')}${all.length > children.length ? `, and ${all.length - children.length} below them` : ''}</dd>` : ''}
                </dl>
                <div class="tm-actions">
                    <button type="button" data-act="stop" title="${escape(tips.stop)}">Stop</button>
                    ${all.length ? `<button type="button" data-act="stop-tree" title="${escape(tips.stopTree)}">Stop with children (${all.length})</button>` : ''}
                    <button type="button" class="danger" data-act="kill" title="${escape(tips.kill)}">Force close</button>
                    ${all.length ? `<button type="button" class="danger" data-act="kill-tree" title="${escape(tips.killTree)}">Force close with children (${all.length})</button>` : ''}
                    <button type="button" data-act="copy" title="Copy the command">Copy command</button>
                </div>
            </div></td></tr>`;
        }
        /** Everything a process started, and everything those started, from the last list. */
        descendants(pid) {
            const t = this;
            const found = [];
            const seen = new Set([pid]);
            const walk = at => t.processes.forEach(p => {
                if (p.parent === at && !seen.has(p.pid)) {
                    seen.add(p.pid);
                    found.push(p);
                    walk(p.pid);
                }
            });
            walk(pid);
            return found;
        }
        select(pid) {
            const t = this;
            t.clearDone();
            t.selected = t.selected === pid ? null : pid;
            t.draw();
            if (t.selected !== null) t.tbody.querySelector(`tr.tm-row[data-pid="${pid}"]`)?.focus();
        }
        onTableClick(ev) {
            const t = this;
            const target = ev.target;
            const link = target.closest?.('[data-select]');
            if (link) {
                t.selected = null;
                t.select(Number(link.dataset.select));
                return;
            }
            const act = target.closest?.('[data-act]');
            if (act) {
                const pid = Number(act.closest('tr.tm-details').dataset.for);
                t.act(act.dataset.act, t.byPid.get(pid));
                return;
            }
            const row = target.closest?.('tr.tm-row');
            if (row) t.select(Number(row.dataset.pid));
        }
        act(action, p) {
            const t = this;
            if (!p) return;
            t.clearDone();
            if (action === 'copy') {
                navigator.clipboard?.writeText(p.command || p.name).then(() => t.say('Copied the command.'), () => t.say('The clipboard could not be reached.', 'danger'));
                return;
            }
            const force = action.startsWith('kill');
            const tree = action.endsWith('-tree');
            const others = tree ? t.descendants(p.pid).length : 0;
            const what = `${p.name} (${p.pid})${others ? ` and the ${others} process${others === 1 ? '' : 'es'} it started` : ''}`;
            const question = force
                ? `Force close ${what}? It ends at once, without saving or cleaning up.`
                : `Ask ${what} to stop?`;
            webui.dialog({
                title: force ? 'Force Close' : 'Stop Process',
                content: `<p>${escape(question)}</p><pre style="white-space:pre-wrap;word-break:break-all;max-height:30vh;overflow:auto;">${escape(p.command || p.name)}</pre>`,
                confirm: force ? 'Force Close' : 'Stop',
                cancel: 'Cancel',
                onconfirm: () => {
                    webui.proxy.taskManager.stop(p.pid, p.started, tree, force).then(
                        message => t.say(message),
                        err => t.say(`${err}`, 'danger'),
                    ).finally(() => setTimeout(() => t.refresh(), 400));
                    return true;
                },
            });
        }
    }

    function getHeaderContent() {
        const container = webui.create('div');
        container.style.padding = 'var(--padding)';
        container.setAttribute('slot', 'header');
        container.setAttribute('role', 'heading');
        container.setAttribute('aria-level', '2');
        container.textContent = 'Task Manager';
        return container;
    }
    /** Shows the Task Manager in `target`, a Tools tab or a drawer, and starts reading processes once it shows. */
    function openDrawer(target) {
        const el = typeof target === 'string' ? document.querySelector(target) : target;
        if (!el) {
            webui.log.warn('Drawer not found!');
            return;
        }
        const body = webui.create('section');
        body.className = 'task-manager-body';
        body.style.padding = 'var(--padding)';
        body.style.boxSizing = 'border-box';
        if (el.localName === 'webui-drawer') body.style.height = 'calc(100% - var(--header-height, 60px))';
        showTool(el, getHeaderContent(), body, () => {
            body._view = new TaskManagerView(body);
        });
    }
    webui.define("app-task-manager", {
        preload: 'alert',
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        attr: ['data-toggleclass'],
        attrChanged(property, value) {
            const t = this;
            if (property === 'dataToggleclass') t.drawer = value.split('|')[0];
        },
        connected() {
            const t = this;
            makeButton(t, t.getAttribute('title') || 'Task Manager');
            t.addEventListener('click', () => t.open());
        },
        /** Opens the Task Manager, as the Task Manager tab of Tools when it is one. `target` is where Tools has it draw. */
        open({ target = null } = {}) {
            const t = this;
            const tools = toolsPanelOf(t);
            if (tools && !target) {
                tools.show('tasks');
                return;
            }
            openDrawer(target || t.drawer || '.shared');
        },
        shadowTemplate: `
<webui-icon icon="circle_gauge|theme:info|fill|backing|bordered"></webui-icon>
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
