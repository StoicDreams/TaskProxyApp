/*
 * The Git Controller's Review tab: an AI code review of the changes included for the next commit, or of every file
 * in the repo, looking at what the user asks for this time on top of the review instructions.
 *
 * The Git Controller sets `source` to `{repo(), files()}`, the selected repo and its included files. A large review is
 * done in batches, with a last pass joining them (services/ai.rs), and its progress shows beside the button. The
 * report is drawn from markdown, copied as markdown, or saved as a page under Reviews in the project's navigation.
 * A review carries on when the page is left or another project is opened, and the tab shows it running when it is
 * drawn again (`job` on app-ai-action). Each repo's last report is kept in the project's data, `_aiReviews`, until
 * Clear or the next review of that repo, across pages, projects, and restarts.
 */
"use strict"
{
    const REVIEWS_FOLDER = 'Reviews';
    /**
     * Reports finished while their project wasn't open, by `path|repo`, kept in app data until it is, then saved in
     * it, so a restart meanwhile doesn't lose them. Null for one cleared.
     */
    const PENDING = 'app-ai-pending-reviews';
    const unsaved = {
        all: () => webui.getData(PENDING) || {},
        has: key => key in unsaved.all(),
        get: key => unsaved.all()[key],
        set(key, report) {
            webui.setData(PENDING, { ...unsaved.all(), [key]: report });
        },
        delete(key) {
            const all = { ...unsaved.all() };
            if (!(key in all)) return;
            delete all[key];
            webui.setData(PENDING, Object.keys(all).length ? all : undefined);
        },
        entries: () => Object.entries(unsaved.all()),
    };
    /** The Review tabs on screen, which draw a report that finishes after the review was asked for. */
    const shown = new Set();
    const keyOf = (path, repo) => `${path ?? ''}|${repo ?? ''}`;
    /** The open project's saved reports, by repo. */
    const savedReports = () => webui.projectData?.data?._aiReviews || {};
    /** Saves a report, or removes it when null, in the open project when it is the one reviewed, or else later. */
    function keep(path, repo, report) {
        // While another project loads, projectData is still the one before, which can no longer be saved.
        if (!webui.proxy.projects.isLoaded || !webui.projectData?.data || webui.projectData.path !== path) {
            unsaved.set(keyOf(path, repo), report);
            // Saved as soon as that project is opened again, whichever page shows.
            webui.proxy.projects.onLoaded?.(saveUnsaved);
            return;
        }
        unsaved.delete(keyOf(path, repo));
        const saved = webui.projectData.data._aiReviews ??= {};
        if (report) saved[repo] = report;
        else delete saved[repo];
        webui.proxy.syncProjectData();
    }
    /** Saves the reports that finished while their project wasn't open, once it is. */
    function saveUnsaved() {
        const path = webui.projectData?.path;
        if (!webui.proxy.projects.isLoaded || !webui.projectData?.data) return;
        unsaved.entries().forEach(([key, report]) => {
            const at = key.lastIndexOf('|');
            if (key.slice(0, at) === `${path}`) keep(path, key.slice(at + 1), report);
        });
    }
    const escapeAttribute = text => `${text}`.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    /**
     * A review's markdown, made safe to save in a page. Repo text can shape what the model writes, so nothing in it may
     * end the page's segment, add page data, or become a script with a Run button: those tags, and code elements,
     * which get Run buttons by their language, are kept from being tags by a zero-width space after their <, which
     * shows as typed wherever they are, in code blocks and inline code too, where an entity would show as typed. And
     * PowerShell code blocks become plain text ones.
     */
    function pageSafe(markdown) {
        return `${markdown}`
            .replace(/<(\/?)(webui-page-segment|webui-data|webui-code)\b/gi, '<\u200b$1$2')
            .replace(/(`{3,}|~{3,})([ \t]*)(?:powershell|pwsh|ps1)\b/gi, '$1$2text');
    }
    const STYLE = `
app-ai-review { display:flex; flex-direction:column; gap:var(--padding); padding:var(--padding); }
app-ai-review .review-scope { display:flex; flex-wrap:wrap; gap:var(--padding); align-items:center; }
app-ai-review textarea.review-focus { width:100%; box-sizing:border-box; min-height:4em; font:inherit; }
app-ai-review .review-report-tools { display:flex; flex-wrap:wrap; gap:var(--padding); align-items:center; }
app-ai-review .review-report:empty, app-ai-review [hidden] { display:none !important; }
app-ai-review .review-report { overflow-wrap:anywhere; }
`;

    webui.define('app-ai-review', {
        constructor() {
            // The Git Controller can set this before this element is upgraded.
            this.source ??= null;
        },
        connected() {
            const t = this;
            shown.add(t);
            if (t._built) return t.showReport();
            t._built = true;
            const style = webui.create('style', { text: STYLE });
            const intro = webui.create('p', { class: 'review-intro', text: 'Review the changes you are about to commit, or the whole project, with the AI model you choose. The review follows your review instructions, and anything you add below for this review.' });
            const scope = webui.create('div', { class: 'review-scope', role: 'radiogroup', 'aria-label': 'What to review' });
            const group = `review-scope-${Math.random().toString(36).slice(2, 7)}`;
            t._scopes = [['changes', 'The changes included for the next commit'], ['project', 'The entire project']].map(([value, label], index) => {
                const row = webui.create('label');
                const radio = webui.create('input', { type: 'radio', name: group, value });
                radio.checked = index === 0;
                row.append(radio, ` ${label}`);
                scope.appendChild(row);
                return radio;
            });
            const focusLabel = webui.create('label', { class: 'review-focus-label', text: 'What to look for this time (optional)' });
            t._focus = webui.create('textarea', { class: 'review-focus', placeholder: 'Such as security, error handling, or how well it follows our naming rules.' });
            focusLabel.appendChild(t._focus);
            t._action = webui.create('app-ai-action', { integration: 'review', label: 'Review', icon: 'clipboard-check', 'busy-label': 'Reviewing' });
            t._action.action = args => t.review(args);
            // A review is of the open project's selected repo, and carries on whatever is shown meanwhile.
            t._action.job = () => t.repo() === undefined ? '' : keyOf(webui.projectData?.path, t.repo());
            t._tools = webui.create('div', { class: 'review-report-tools' });
            t._tools.hidden = true;
            const copy = webui.create('webui-button', { theme: 'secondary', 'start-icon': 'copy', label: 'Copy', class: 'review-copy' });
            copy.addEventListener('click', () => t.copy());
            const save = webui.create('webui-button', { theme: 'success', 'start-icon': 'save', label: 'Save as Page', class: 'review-save' });
            save.addEventListener('click', () => t.saveAsPage());
            t._heading = webui.create('strong', { class: 'review-heading' });
            const clear = webui.create('webui-button', { theme: 'secondary', 'start-icon': 'xmark', label: 'Clear', class: 'review-clear' });
            clear.addEventListener('click', () => t.clear());
            t._tools.append(t._heading, copy, save, clear);
            // What Copy or Save as Page did, under their buttons.
            t._done = webui.create('webui-alert', { class: 'review-done' });
            t._report = webui.create('div', { class: 'review-report' });
            t.append(style, intro, scope, focusLabel, t._action, t._tools, t._done, t._report);
            t.showReport();
        },
        disconnected() {
            shown.delete(this);
        },
        repo() {
            return this.source?.repo?.();
        },
        scope() {
            return this._scopes.find(radio => radio.checked)?.value || 'changes';
        },
        async review({ model, requestId, isCurrent }) {
            const t = this;
            const repo = t.repo();
            if (repo === undefined) throw 'No repo is set.';
            const scope = t.scope();
            const files = scope === 'changes' ? (t.source?.files?.() || []) : [];
            if (scope === 'changes' && !files.length) throw 'Include at least one changed file to review, or review the entire project.';
            // Kept under the project and repo reviewed, which can change while the review is written.
            const path = webui.projectData?.path;
            const focus = t._focus.value.trim();
            const markdown = await webui.proxy.ai.review({ repo, scope, files, focus, model, requestId });
            if (!isCurrent()) return;
            keep(path, repo, { markdown, scope, focus, at: new Date().toISOString() });
            shown.forEach(review => review.showReport());
        },
        current() {
            const key = keyOf(webui.projectData?.path, this.repo());
            if (unsaved.has(key)) return unsaved.get(key);
            const report = savedReports()[this.repo()];
            return report?.markdown ? report : null;
        },
        /** Removes the report shown, until the next review. */
        clear() {
            const t = this;
            if (t.repo() === undefined) return;
            keep(webui.projectData?.path, t.repo(), null);
            shown.forEach(review => review.showReport());
        },
        /** The report for the repo shown, drawn from its markdown, which comes from the model and is sanitized. */
        showReport() {
            const t = this;
            if (!t._report) return;
            saveUnsaved();
            // Shows whether a review of this repo is running, which may have been asked for before it was drawn.
            t._action.refresh?.();
            const report = t.current();
            t._tools.hidden = !report;
            setNote(t._done);
            if (!report) {
                t._report.replaceChildren();
                return;
            }
            t._heading.textContent = `${report.scope === 'project' ? 'Project review' : 'Review of the changes'}, ${new Date(report.at).toLocaleString()}`;
            const html = webui.parseMarkdown ? webui.parseMarkdown(report.markdown) : webui.escapeHtml(report.markdown);
            t._report.innerHTML = typeof sanitizeProjectHtml === 'function' ? sanitizeProjectHtml(html) : webui.escapeHtml(report.markdown);
        },
        async copy() {
            const report = this.current();
            if (!report) return;
            const note = this._done;
            if (await webui.proxy.copyText(report.markdown, err => setNote(note, `The review couldn't be copied: ${err}`, 'danger'))) setNote(note, 'Copied the review.', 'success');
        },
        /**
         * Saves the report as a new page, in a Reviews folder at the top level of the project's navigation, added after
         * what is there when it is new. A project opened meanwhile is left alone: the page stays in the project it was
         * saved in, without a place in its navigation. A navigation that can't be saved is put back as it was.
         */
        async saveAsPage() {
            const t = this;
            // A second click while it saves would write a second page and navigation entry.
            if (t._saving) return;
            t._saving = true;
            try {
                await t.savePage();
            } finally {
                t._saving = false;
            }
        },
        async savePage() {
            const t = this;
            const report = t.current();
            const projectId = webui.projectData?.id;
            if (!report || !projectId) return;
            const id = crypto.randomUUID();
            const title = `${report.scope === 'project' ? 'Project Review' : 'Change Review'} ${new Date(report.at).toLocaleDateString()}`;
            const subtitle = report.focus ? `Looking at: ${report.focus}` : (t.repo() ? `Repo ${t.repo()}` : '');
            const markdown = `<webui-data data-page-title="${escapeAttribute(title)}" data-page-subtitle="${escapeAttribute(subtitle)}"></webui-data>\n\n<webui-page-segment>\n\n${pageSafe(report.markdown.trim())}\n\n</webui-page-segment>\n`;
            const failed = err => setNote(t._done, `The review couldn't be saved: ${err}`, 'danger');
            const saved = await webui.proxy.saveProjectFile(`.taskproxy/pages/${id}.md`, markdown, failed);
            if (!saved) return;
            if (webui.projectData?.id !== projectId) {
                setNote(t._done, `The review was saved as .taskproxy/pages/${id}.md, but another project was opened before it was added to the navigation.`, 'warning');
                return;
            }
            const before = structuredClone(webui.projectData.navigation || []);
            const navigation = webui.projectData.navigation ||= [];
            let folder = navigation.find(item => !item.url && `${item.name}`.trim().toLowerCase() === REVIEWS_FOLDER.toLowerCase());
            if (!folder) {
                folder = { name: REVIEWS_FOLDER, icon: 'clipboard-check', url: null, children: [] };
                navigation.push(folder);
            }
            (folder.children ||= []).push({ name: title, icon: 'file', url: `/${id}`, children: null });
            // saveProjectData shows the navigation as it saves it.
            const unsaved = err => setNote(t._done, `The review couldn't be added to the navigation: ${err} The page itself was saved as .taskproxy/pages/${id}.md.`, 'danger');
            if (!await webui.proxy.saveProjectData(unsaved)) {
                // Left in memory, the next save of anything would write it.
                if (webui.projectData?.id === projectId) {
                    webui.projectData.navigation = before;
                    webui.setData('app-nav-routes', before);
                }
                return;
            }
            setNote(t._done, `Saved the review as ${title}, under ${REVIEWS_FOLDER}.`, 'success');
        },
    });
}
