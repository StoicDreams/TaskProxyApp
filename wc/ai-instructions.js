/*
 * The instructions sent with AI requests, at both scopes: Global, for every project, and This Project.
 *
 * <app-ai-instructions> edits them all, as Settings does, with a tab for each: the instructions shared by every
 * integration, then each integration's own, each with its global and project instructions. <app-ai-instructions
 * integration="git"> has only the shared tab and that integration's, starting on its own, as a Write with AI
 * button's Instructions shows. Each block is saved as it is typed. A request gets the built-in instructions, then
 * the shared ones, then the integration's. For each, the project's are used when it has any, in place of the global
 * ones; otherwise the global ones are. The global box says when this project's own takes its place.
 */
"use strict"
{
    const TABS = {
        shared: 'Shared',
        git: 'Commit Messages',
        review: 'Code Reviews',
        pages: 'Pages',
        scripts: 'Scripts',
        markdown: 'Markdown Import',
    };
    const ABOUT = {
        shared: 'Sent with every AI request, before the instructions for what is being written. Such as how you like things written, or what to avoid. A project\'s own replaces the global one there.',
        git: 'Sent when writing a commit message, such as the form your messages take.',
        review: 'Sent with every code review, such as your rules for code and what matters most to you.',
        pages: 'Sent when writing a part of a page, such as who reads your pages and how they are written.',
        scripts: 'Sent when writing a script, such as tools to use or rules your scripts follow.',
        markdown: 'Sent when suggesting titles, descriptions, and navigation for imported markdown files.',
    };
    /**
     * What each box could hold, shown in it while empty. These are examples, never used themselves: an empty box adds
     * nothing, and the built-in instructions, shown above the boxes, are sent either way.
     */
    const EXAMPLES = {
        shared: 'For example: Write in plain English, and keep it short.',
        git: 'For example: Start each change on its own line with Feature: or Bug:.',
        review: 'For example: Check that every public function has a doc comment.',
        pages: 'For example: Write for people new to the project, and explain any jargon.',
        scripts: 'For example: Use Write-Host for progress messages, and stop on the first error.',
        markdown: 'For example: Keep titles under five words.',
    };
    const SAVE_DELAY = 400;

    webui.define('app-ai-instructions', {
        attr: ['integration'],
        attrChanged() {
            if (!this._built) return;
            // What was typed is saved before its box is drawn again.
            this.flush();
            this.build();
        },
        connected() {
            const t = this;
            // Typing in the project's box is saved into the project it was typed for, before another one opens.
            t.dataset.subscribe = 'app-current-project:flush';
            t._onProject = () => t.projectChanged();
            // The app can still be starting, before it can reach the backend, which holds the instructions.
            whenProxyReady().then(() => {
                t._ready = true;
                if (t.isConnected) t.reconnected();
                return webui.proxy.ai.settings(() => null);
            }).then(view => {
                t._defaults = view?.defaults || {};
                t.showBuiltIn();
            });
        },
        reconnected() {
            const t = this;
            if (!t._ready) return;
            document.removeEventListener('app-ai-defaults-changed', t._onProject);
            document.addEventListener('app-ai-defaults-changed', t._onProject);
            t.flush();
            t.build();
        },
        disconnected() {
            document.removeEventListener('app-ai-defaults-changed', this._onProject);
            this.flush();
        },
        /** Another project is open, so the project's boxes are drawn again for it. */
        projectChanged() {
            const t = this;
            if (`${webui.projectData?.id ?? ''}` === t._drawnFor) return;
            t.flush();
            t.build();
        },
        blocks() {
            const integration = this.getAttribute('integration');
            return integration ? ['shared', integration] : ['shared', ...webui.proxy.ai.integrations];
        },
        build() {
            const t = this;
            t._built = true;
            t._drawnFor = `${webui.projectData?.id ?? ''}`;
            const hasProject = !!webui.projectData?.id;
            // Says when something typed couldn't be saved, kept above the boxes when they are drawn again.
            t._note ??= webui.create('webui-alert', { class: 'ai-instructions-note' });
            // Drawn again for the project it names, the boxes are there to type it in, so it has been said.
            if (t._noteFor && t._noteFor === t._drawnFor) {
                t._noteFor = null;
                setNote(t._note);
            }
            const scopes = [['global', 'Global, for every project'], ...(hasProject ? [['project', `This Project, only for ${webui.getData('app-current-project')?.display || 'this project'}`]] : [])];
            const integration = t.getAttribute('integration');
            // From a Write with AI button, its own instructions are shown first.
            const tabs = webui.create('webui-tabs', { theme: 'secondary', class: 'ai-instruction-tabs', index: integration ? '1' : '0' });
            t.blocks().forEach(block => {
                tabs.appendChild(webui.create('webui-button', { slot: 'tabs', class: `ai-block-tab ai-block-tab-${block}`, text: TABS[block] || block }));
                const content = webui.create('webui-content', { slot: 'content', nodetach: '', class: `ai-block-content ai-block-content-${block}` });
                content.appendChild(webui.create('p', { class: 'ai-scope-note', text: ABOUT[block] || '' }));
                // What Task Proxy always sends for this, before anything typed here, which adds to it.
                const builtIn = webui.create('div', { class: 'ai-built-in', 'data-block': block });
                builtIn.hidden = true;
                content.appendChild(builtIn);
                scopes.forEach(([scope, label]) => {
                    const id = `ai-instr-${scope}-${block}-${Math.random().toString(36).slice(2, 7)}`;
                    const caption = webui.create('label', { for: id, class: 'ai-instruction-label', text: label });
                    const area = webui.create('textarea', { id, rows: 4, class: 'ai-instruction', 'data-block': block, 'data-scope': scope });
                    // A project's box belongs to the project it was drawn for, which can change before it saves.
                    if (scope === 'project') {
                        area.dataset.project = webui.projectData.id;
                        area.dataset.projectName = webui.getData('app-current-project')?.display || 'the project';
                    }
                    area.value = webui.proxy.ai.scope(scope).instructions[block] || '';
                    area.dataset.savedValue = area.value;
                    t.placeholder(area);
                    area.addEventListener('input', () => t.queue(area));
                    area.addEventListener('change', () => t.save(area));
                    content.append(caption, area);
                    if (scope === 'global' && hasProject) {
                        // Said while this project's own takes the global one's place.
                        const replaced = webui.create('p', { class: 'ai-replaced-note', 'data-block': block, text: `Not used in ${webui.getData('app-current-project')?.display || 'this project'}, which has its own below.` });
                        content.appendChild(replaced);
                    }
                });
                const sync = () => {
                    const own = content.querySelector('textarea[data-scope="project"]');
                    const note = content.querySelector('.ai-replaced-note');
                    if (note) note.hidden = !own?.value.trim();
                };
                content.addEventListener('input', sync);
                sync();
                tabs.appendChild(content);
            });
            t.replaceChildren(t._note, tabs);
            t.showBuiltIn();
        },
        /** Shows each integration's built-in instructions, once they are known. */
        showBuiltIn() {
            const t = this;
            t.querySelectorAll('.ai-built-in[data-block]').forEach(box => {
                const text = t._defaults?.[box.dataset.block];
                box.hidden = !text;
                if (!text) return;
                box.replaceChildren(
                    webui.create('strong', { text: 'Always sent first, built in:' }),
                    webui.create('p', { text }),
                    webui.create('p', { class: 'ai-built-in-note', text: 'What you write below is sent after this, adding to it or changing it, never replacing it. This project\'s box, when it has text, is used in place of the global box.' }),
                );
            });
        },
        /** An example of what the box could hold, shown while it is empty. */
        placeholder(area) {
            area.placeholder = EXAMPLES[area.dataset.block] || '';
        },
        queue(area) {
            const t = this;
            t._pending ??= new Set();
            t._pending.add(area);
            clearTimeout(t._timer);
            t._timer = setTimeout(() => t.flush(), SAVE_DELAY);
        },
        flush() {
            const t = this;
            clearTimeout(t._timer);
            const pending = [...(t._pending || [])];
            t._pending?.clear();
            pending.forEach(area => t.save(area));
        },
        save(area) {
            this._pending?.delete(area);
            // Typed for a project that is no longer open, so it must not go into the one that is.
            if (area.dataset.scope === 'project' && area.dataset.project !== `${webui.projectData?.id ?? ''}`) {
                if (area.value.trim() !== (area.dataset.savedValue ?? '').trim()) {
                    this._noteFor = area.dataset.project;
                    setNote(this._note, `What you typed for ${area.dataset.projectName} wasn't saved, as another project was opened first. Open ${area.dataset.projectName} again to type it there.`, 'warning');
                }
                return;
            }
            webui.proxy.ai.setScope(area.dataset.scope, 'instructions', area.dataset.block, area.value);
            area.dataset.savedValue = area.value;
        },
    });
}
