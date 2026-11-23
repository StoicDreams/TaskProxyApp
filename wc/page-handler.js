"use strict"
{
    const notFound = `
    ## Not Found

    The page you were looking for was not found.
    `;
    let comp = null;
    let markdown = '';
    let myId = '';
    let myFile = '';
    let segments = [];
    /**
     * The page's segments, between the top and bottom bars, put in order by dragging a segment's edit button, or with
     * Alt+Up and Alt+Down on it. Saving reads them in the order they are in.
     */
    let segmentList = null;
    function segmentsElement() {
        segmentList ??= webui.create('webui-reorder', { class: 'page-segments', items: ':scope > app-markdown-segment', handle: '.drag-handle' });
        return segmentList;
    }
    /** The page's markdown as its file has it, to tell unsaved changes by. Null until the page is drawn. */
    let savedPage = null;
    /**
     * The file's markdown when the page's unsaved changes were first made, kept with them, to tell when the file has
     * changed underneath them since, as through git.
     */
    let draftBase = null;
    /** The project the page was opened in, which keeps the page's unsaved changes (`_pageDrafts` in its data). */
    let pageProject = null;
    /** Whether the warning that the page has unsaved changes is shown. */
    let pendingShown = false;
    /** Each bar's Save and Revert buttons, which show whether there are changes to save. */
    const pageBars = [];
    let pageScripts = [];
    let pageDataComponent = '';
    let lastScannedMarkdown = null;
    let currentLoad = 0;
    let pageHelp = null;
    /** Empties the page but keeps its help, which is not part of the page's markdown. */
    function clearPage() {
        if (!pageHelp) {
            pageHelp = webui.create('webui-page-help', { heading: 'Page Help', html: '<webui-content src="d/help/page_guide.md"></webui-content>' });
        }
        Array.from(comp.childNodes).forEach(node => {
            if (node !== pageHelp) node.remove();
        });
        if (pageHelp.parentNode !== comp) comp.prepend(pageHelp);
    }
    const variableKeyNames = new Map();
    /** Counts preview updates, so a slow answer cannot replace a newer one. */
    let previewRound = 0;
    webui.currentPageVariables = [];
    /** Tells the header's variables button how many variables the page has (wc/var-manager.js). */
    const announcePageVariables = () => window.dispatchEvent(new CustomEvent('app-page-variables', { detail: webui.currentPageVariables.length }));
    let onTitleClick = () => {
        // Set after opening, because markup in a dialog's content is processed before it renders.
        webui.wait(() => webui.querySelector('webui-input-text[name="pageSubtitle"]')?.setValue).then(() => {
            // Typing can start before the inputs are ready, and what was typed must not be replaced.
            const title = webui.querySelector('webui-input-text[name="pageTitle"]');
            const subtitle = webui.querySelector('webui-input-text[name="pageSubtitle"]');
            if (!title.value) title.value = webui.getData('page-title') || '';
            if (!subtitle.value) subtitle.value = webui.getData('page-subtitle') || '';
        });
        webui.dialog({
            title: 'Edit Page Title',
            content: `<webui-flex column gap="var(--padding)">
                <webui-input-text name="pageTitle" label="Page Title"></webui-input-text>
                <webui-input-text name="pageSubtitle" label="Page Subtitle"></webui-input-text>
            </webui-flex>`,
            confirm: 'Save',
            cancel: 'Cancel',
            onconfirm: async (data, content) => {
                let form = Object.fromEntries(data);
                const dataComponent = `<webui-data data-page-title="${webui.escapeForHTML(form.pageTitle || '')}" data-page-subtitle="${webui.escapeForHTML(form.pageSubtitle || '')}"></webui-data>`;
                const file = myFile;
                if (file) {
                    // Why it couldn't be saved is said in the dialog, which stays open, and the title is left as it was.
                    const saved = await webui.proxy.saveProjectFile(file, [dataComponent, ...currentSegmentsMarkdown()].join('\n\n').trim(), msg => content.alert(webui.escapeForHTML(`${msg}`), 'danger'));
                    if (!saved) return false;
                    // Saved to the page it was opened on, so another page shown since keeps its own title. The
                    // dialog closes and that page's title is gone, so nothing is left near to say it by.
                    if (myFile !== file) {
                        appAlert('Saved the title of the page that was shown.', 'success');
                        return true;
                    }
                }
                webui.setData('page-title', form.pageTitle || '');
                webui.setData('page-subtitle', form.pageSubtitle || '');
                pageDataComponent = dataComponent;
                // The page was saved with every change in it.
                if (file) markSaved();
                return true;
            }
        });
    };
    async function loadProject() {
        const load = ++currentLoad;
        myId = location.pathname.substring(1);
        const file = `.taskproxy/pages/${myId}.md`;
        myFile = file;
        await whenProxyReady();
        // Unsaved changes are kept with the project, so it must be loaded to find them.
        await new Promise(resolve => webui.proxy.projects.runWhenLoaded(resolve));
        if (load !== currentLoad || myFile !== file) return;
        pageProject = webui.projectData;
        let error = null;
        let md = await webui.proxy.getProjectFile(file, err => { error = `${err}`; });
        // Leaving this page while it loads must not put its content on the next page.
        if (load !== currentLoad || myFile !== file) return;
        if (error && !error.includes('File not found')) {
            // Saving now would replace the file with an empty page.
            myFile = '';
            clearPage();
            comp.appendChild(webui.create('webui-alert', { show: true, variant: 'danger', html: webui.escapeForHTML(`This page could not be loaded. ${error}`) }));
            return;
        }
        setMarkdown(md || '', pageDrafts()?.[myId]);
    }
    /** The page's segments as markdown, as saving writes them, including any being edited. */
    function currentSegmentsMarkdown() {
        let md = [];
        comp.querySelectorAll('app-markdown-segment').forEach(segment => {
            if (segment.parentNode !== segmentList) return;
            let markdown = segment.getMarkdown();
            if (markdown) md.push(markdown);
        });
        return md;
    }
    /** The page's markdown as saving writes it. */
    function pageMarkdown() {
        return [pageDataComponent, ...currentSegmentsMarkdown()].filter(Boolean).join('\n\n').trim();
    }
    /** The page's segments, in order. */
    function pageSegments() {
        return segmentList ? [...segmentList.children].filter(node => node.localName === 'app-markdown-segment') : [];
    }
    /** Whether the page differs from its file: segments changed, added, removed, or moved. */
    function hasPendingChanges() {
        return !!myFile && savedPage !== null && pageMarkdown() !== savedPage;
    }
    /** The open project's unsaved page changes, by page id, when the page's project is still the one open. */
    function pageDrafts(create = false) {
        const data = pageProject?.data;
        if (!data || pageProject !== webui.projectData) return null;
        if (create) data._pageDrafts ??= {};
        return data._pageDrafts || null;
    }
    /**
     * Keeps the page's unsaved changes with its project (in its .enc file), so they are still here after leaving the
     * page or restarting the app: each segment's markdown and the markdown its Revert puts back. Forgets them once
     * there are none.
     */
    function keepDraft() {
        if (!myId || savedPage === null) return;
        const pending = hasPendingChanges();
        const drafts = pageDrafts(pending);
        if (!drafts) return;
        if (pending) {
            draftBase ??= savedPage;
            drafts[myId] = { base: draftBase, segments: pageSegments().map(segment => ({ md: segment.getMarkdown(), saved: segment.getSavedMarkdown() })) };
        } else if (myId in drafts) {
            draftBase = null;
            delete drafts[myId];
        } else {
            return;
        }
        webui.proxy.syncProjectData();
    }
    /** Shows whether the page has changes to save: Save enabled, Revert shown, and a warning by Save. */
    function refreshPending() {
        if (savedPage === null) return;
        const pending = hasPendingChanges();
        pageBars.forEach(({ save, revert }) => {
            save.toggleAttribute('disabled', !pending);
            save.setAttribute('title', pending ? 'Save Page' : 'This page has no changes to save');
            revert.hidden = !pending;
        });
        if (pending !== pendingShown) {
            pendingShown = pending;
            const save = pageBars[0]?.save;
            if (save && pending) actionNote(save, 'This page has changes that aren\'t saved. They are kept, even when you leave the page, until you save or revert them.', 'warning');
            else if (save) clearActionNote(save);
        }
        keepDraft();
    }
    /** The page as it is now is its file: nothing left to save or revert. */
    function markSaved() {
        savedPage = pageMarkdown();
        draftBase = null;
        pageSegments().forEach(segment => { segment.setSavedMarkdown(segment.getMarkdown()); });
        refreshPending();
    }
    /** Saves the page. Why it couldn't be saved is said by `button`, and resolves to whether it was saved. */
    async function savePage(button) {
        if (!myFile) return false;
        clearActionNote(button);
        const md = pageMarkdown();
        const result = await webui.proxy.saveProjectFile(myFile, md, err => actionNote(button, err, 'danger'));
        if (!result) return false;
        markSaved();
        actionNote(button, result, 'success');
        return true;
    }
    /** Puts the page back as its file has it, after asking, since the changes can't be brought back. */
    function revertPage(button) {
        if (!hasPendingChanges()) return;
        webui.dialog({
            title: 'Revert This Page?',
            content: '<p>Every change to this page that isn\'t saved is discarded, and the page shows as it is saved.</p>',
            confirm: 'Revert',
            cancel: 'Keep Changes',
            onconfirm: () => {
                if (savedPage === null) return true;
                setMarkdown(savedPage);
                actionNote(button, 'Reverted this page to how it is saved.', 'success');
                return true;
            },
            // Cancel, Escape, and the close button reject the dialog's promise.
        }).catch(() => undefined);
    }
    /**
     * Asks what to do with the page's unsaved changes before going to `url`: stay, save them and go, or go and keep
     * them for later. Going without saving loses nothing, since they are kept with the project.
     */
    function askToLeave(url) {
        let choice = null;
        const go = () => webui.navigateTo(url);
        const dialog = webui.dialog({
            title: 'Unsaved Changes',
            content: `<webui-flex column gap="var(--padding)" class="leave-page-dialog">
                <p>This page has changes that aren't saved. Save them before leaving?</p>
                <p>Leaving without saving keeps them here, unsaved, for when you come back.</p>
                <webui-flex justify="right"><webui-button theme="secondary" class="leave-unsaved" start-icon="arrow-right">Leave Without Saving</webui-button></webui-flex>
            </webui-flex>`,
            confirm: 'Save and Leave',
            cancel: 'Stay on Page',
            onconfirm: async (data, content) => {
                const file = myFile;
                const saved = await webui.proxy.saveProjectFile(file, pageMarkdown(), err => content.alert(webui.escapeForHTML(`${err}`), 'danger'));
                if (!saved) return false;
                if (myFile === file) markSaved();
                choice = 'save';
                go();
                return true;
            },
        });
        dialog.catch(() => undefined);
        const leaveButton = () => document.querySelector('.leave-page-dialog .leave-unsaved');
        webui.wait(() => !!leaveButton()).then(() => {
            leaveButton()?.addEventListener('click', () => {
                if (choice) return;
                choice = 'leave';
                dialog.close?.();
                go();
            });
        });
    }
    /** Stops a link to another page while this one has unsaved changes, to ask first (askToLeave). */
    function onLeaveClick(ev) {
        if (ev.defaultPrevented || !hasPendingChanges() || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
        const link = ev.composedPath().find(node => node.getAttribute?.('href'));
        if (!link) return;
        const href = link.getAttribute('href');
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return;
        const target = link.getAttribute('target');
        if ((target && target !== '_self') || link.hasAttribute('download')) return;
        const url = new URL(href, document.baseURI);
        if (url.pathname === location.pathname) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        askToLeave(`${url.pathname}${url.search}${url.hash}`);
    }
    /**
     * Rewrites the whole page with AI from what the user asked, into its segments, unsaved, for the user to check and
     * then save or revert. Each segment's Revert puts back the segment the file has at its place, or the same one
     * where the draft kept it unchanged.
     */
    async function writePageWithAi({ model, requestId, asked, isCurrent }) {
        if (!myFile) throw 'This page can\'t be written until it has loaded.';
        const before = pageMarkdown();
        const title = webui.getData('page-title') || '';
        const page = currentSegmentsMarkdown().join('\n\n');
        const request = `${asked}\n\nReply with the whole page's markdown, as it should be once changed. Keep each part of the page that shouldn't change as it is, including its <webui-page-segment> tags and components. Leave out the <webui-data> tag that holds the page's title.`;
        const context = `The page${title ? `, "${title}"` : ''}, as it is now:\n\n${page || '(The page is empty.)'}`;
        const draft = await webui.proxy.ai.write({ integration: 'pages', model, requestId, request, context });
        if (!isCurrent()) return;
        if (!comp?.isConnected || pageMarkdown() !== before) throw 'This page changed while AI was writing, so the draft wasn\'t used, to keep your changes. Write with AI again to start from it as it is now.';
        const text = `${typeof draft === 'string' ? draft : ''}`.replace(/^\s*<webui-data\b[\s\S]*?<\/webui-data>\s*/i, '').trim();
        if (!text) throw 'The AI answer was empty, so the page was left as it was. Try again, or with another model.';
        const saved = splitMarkdownSegments(savedPage === null ? '' : savedPage.replace(/^<webui-data[\s\S]*?<\/webui-data>/i, '').trim()).map(item => item.md);
        const kept = new Set();
        const next = splitMarkdownSegments(text).map((item, index) => {
            // A segment the draft left as the file has it reverts to itself; any other, to the file's at its place.
            const same = saved.findIndex((md, at) => !kept.has(at) && md.trim() === item.md.trim());
            const at = same >= 0 ? same : (kept.has(index) ? -1 : index);
            if (at >= 0 && at < saved.length) kept.add(at);
            return webui.create('app-markdown-segment', { 'data-markdown': item.md, 'data-saved': at >= 0 && at < saved.length ? saved[at] : '' });
        });
        segments = next;
        segmentsElement().replaceChildren(...segments);
        refreshScripts();
        refreshPending();
    }
    const PREPEND = 'Before this page\'s content';
    const APPEND = 'After this page\'s content';
    /**
     * Adds one of the project's markdown files to this page and saves it (services/page_import.rs). The file is only
     * read. Before or after only matters when the page has content, so it can't be chosen on an empty page.
     */
    function openImport(button) {
        if (!myFile) return;
        const docs = webui.projectData?.docs || [];
        clearActionNote(button);
        if (!docs.length) {
            actionNote(button, 'This project has no markdown files to import.', 'warning');
            return;
        }
        const hasContent = currentSegmentsMarkdown().length > 0;
        // File names come from the project, so they are escaped as the attribute's text.
        const options = webui.escapeForHTML(JSON.stringify(fileOptions(docs, () => ({ icon: 'file' }))));
        webui.dialog({
            title: 'Import a Markdown File',
            content: `<webui-flex column gap="var(--padding)" class="page-import-dialog">
                <webui-select label="Markdown file" class="import-file" item-size="10em" options="${options}"></webui-select>
                <webui-switch label="Where it goes" class="import-position" options="${PREPEND}|${APPEND}" value="${APPEND}"${hasContent ? '' : ' inert aria-disabled="true"'}></webui-switch>
                ${hasContent ? '' : '<p class="import-empty-note">This page is empty, so the file becomes its content.</p>'}
                <p>The file itself is left as it is.</p>
            </webui-flex>`,
            confirm: 'Import',
            cancel: 'Cancel',
            onconfirm: async (data, content) => {
                const file = content.querySelector('.import-file')?.value;
                if (!file) return false;
                const before = content.querySelector('.import-position')?.value === PREPEND;
                // The dialog's alert shows HTML, and errors can name the project's files.
                const problem = msg => content.alert(webui.escapeForHTML(`${msg}`), 'danger');
                const imported = await webui.proxy.importPageFile(file, problem);
                if (imported === undefined) return false;
                return await addToPage(imported, before, problem, button, file);
            }
        });
    }
    /**
     * Puts imported markdown before or after the page's segments, saves the page, and shows it. Why it couldn't be
     * saved goes to `problem`, the import dialog's alert, and the dialog stays open. That it was imported is said by
     * `button`, the Import button, or, when another page is shown by the time it is saved, in the app's alerts, naming
     * `name`, the file imported.
     */
    async function addToPage(imported, before, problem, button, name) {
        const file = myFile;
        if (!file) return false;
        const current = currentSegmentsMarkdown();
        const body = imported ? (before ? [imported, ...current] : [...current, imported]) : current;
        const md = [pageDataComponent, ...body].filter(Boolean).join('\n\n').trim();
        const saved = await webui.proxy.saveProjectFile(file, md, problem);
        if (!saved) return false;
        if (myFile !== file) {
            // Saved, so the dialog closes, but the page it went into is no longer shown, nor its Import button.
            appAlert(`Imported ${name || 'the file'} into the page that was shown.`, 'success');
            return true;
        }
        setMarkdown(md);
        // The page is drawn again, keeping its top bar, so the Import button is still there to say it by.
        actionNote(button, 'Imported the file into this page.', 'success');
        return true;
    }
    /** The page's file as it is saved, not the segments being edited, for exporting it as it is. */
    async function readPageFile(failed) {
        const file = myFile;
        if (!file) return undefined;
        let error = null;
        const md = await webui.proxy.getProjectFile(file, err => { error = `${err}`; });
        if (error && !error.includes('File not found')) return failed(`This page's file could not be read. ${error}`);
        return md || '';
    }
    function setupBar(isEnd) {
        let wrap = webui.create('webui-flex', { column: true, gap: 0 });
        let bar = webui.create('webui-flex', { justify: 'right' });
        wrap.appendChild(bar);
        if (isEnd) {
            bar.before(webui.create('webui-line'));
        } else {
            bar.after(webui.create('webui-line'));
        }
        let btnSave = webui.create('webui-button', {
            html: 'Save', title: 'This page has no changes to save', 'start-icon': 'save', theme: 'primary', class: 'page-save', disabled: true
        });
        btnSave.addEventListener('click', () => savePage(btnSave));
        // Shown only while the page has unsaved changes (refreshPending).
        let btnRevert = webui.create('webui-button', {
            html: 'Revert', title: 'Discard every unsaved change to this page', 'start-icon': 'undo', theme: 'warning', class: 'page-revert'
        });
        btnRevert.hidden = true;
        btnRevert.addEventListener('click', () => revertPage(btnRevert));
        pageBars.push({ save: btnSave, revert: btnRevert });
        let btnAdd = webui.create('webui-button', {
            html: 'Add', title: 'Add Segment', 'start-icon': 'star', theme: 'secondary'
        });
        btnAdd.addEventListener('click', async _ => {
            let segment = webui.create('app-markdown-segment', {});
            if (isEnd) {
                segmentsElement().append(segment);
            } else {
                segmentsElement().prepend(segment);
            }
            segments = Array.from(comp.querySelectorAll('app-markdown-segment'));
        });
        bar.appendChild(btnAdd);
        if (!isEnd) {
            let btnImport = webui.create('webui-button', {
                html: 'Import', title: 'Import a markdown file into this page', 'start-icon': 'download', theme: 'secondary', class: 'page-import'
            });
            btnImport.addEventListener('click', () => openImport(btnImport));
            bar.appendChild(btnImport);
            const exporter = webui.create('app-page-export', { class: 'page-export' });
            exporter.source = () => ({
                title: webui.getData('page-title') || '',
                subtitle: webui.getData('page-subtitle') || '',
                markdown: pageMarkdown(),
                file: readPageFile,
            });
            bar.appendChild(exporter);
            const ai = webui.create('app-ai-action', { class: 'page-ai', integration: 'pages', label: 'Write with AI', ask: 'What should this page say? Describe the page, or the changes to make to all of it.' });
            ai.action = args => writePageWithAi(args);
            bar.appendChild(ai);
        }
        bar.appendChild(webui.create('webui-flex', { 'grow': true }));
        bar.appendChild(btnRevert);
        bar.appendChild(btnSave);
        return wrap;
    }
    let topBar = setupBar(false);
    let bottomBar = setupBar(true);
    /**
     * Bound values as saved when the page loaded, by key, before any field could change them. A dropdown that gets
     * its choices later writes its first choice to its data when they arrive, which syncBoundElements undoes.
     */
    let savedBoundValues = {};
    function rememberBoundValues(md) {
        savedBoundValues = {};
        for (const match of md.matchAll(/data-(?:bind|trigger)="([^"]*)"/g)) {
            attributeKeys(match[1]).forEach(key => {
                const value = webui.getData(key);
                if (!isBlank(value) && typeof value !== 'object') savedBoundValues[key] = value;
            });
        }
    }
    /**
     * Draws the page from its file's markdown, `md`, and with `draft`, the unsaved changes kept for it (keepDraft),
     * shows those changes in its segments.
     */
    function setMarkdown(md, draft = null) {
        if (!comp) return;
        savedPage = null;
        pendingShown = false;
        draftBase = typeof draft?.base === 'string' ? draft.base : null;
        pageBars.forEach(({ save }) => clearActionNote(save));
        rememberBoundValues(md);
        let mdTrimmed = md.trim();
        let webuiDataRegex = /^<webui-data[\s\S]*?<\/webui-data>/i;
        let match = mdTrimmed.match(webuiDataRegex);
        if (match) {
            pageDataComponent = match[0];
            markdown = mdTrimmed.substring(pageDataComponent.length).trim();
        } else {
            pageDataComponent = `<webui-data data-page-title="" data-page-subtitle=""></webui-data>`;
            webui.setData('page-title', '');
            webui.setData('page-subtitle', '');
            markdown = mdTrimmed;
        }
        clearPage();
        lastScannedMarkdown = null;
        let hiddenDataNode = webui.create('div', { style: 'display:none;', html: sanitizeProjectHtml(pageDataComponent) });
        comp.appendChild(hiddenDataNode);
        webui.currentPageVariables.forEach(key => webui.setData(key, undefined));
        webui.currentPageVariables = [];
        const reservedAttrs = ['bind', 'trigger', 'subscribe', 'default', 'state', 'hide', 'toggleclass', 'removeclass', 'setattr', 'toggleattr', 'stopclick', 'click', 'markdown', 'options', 'name', 'title', 'value', 'param'];
        const dataRegex = /data-([a-zA-Z0-9-]+)="([^"]*)"/g;
        let dMatch;
        while ((dMatch = dataRegex.exec(md)) !== null) {
            const attrName = dMatch[1];
            const attrValue = dMatch[2];
            if (attrName === 'bind' || attrName === 'trigger') {
                attrValue.split('|').forEach(bk => {
                    let bindKey = bk.split(':')[0].trim();
                    if (bindKey.includes('.')) bindKey = bindKey.split('.')[1];
                    if (bindKey && !webui.currentPageVariables.includes(bindKey)) {
                        webui.currentPageVariables.push(bindKey);
                    }
                });
                continue;
            }
            if (reservedAttrs.includes(attrName)) continue;
            if (attrName.startsWith('page-') || attrName.startsWith('app-') || attrName.startsWith('session-')) continue;
            if (!webui.currentPageVariables.includes(attrName)) {
                webui.currentPageVariables.push(attrName);
            }
            webui.setData(attrName, attrValue);
        }
        const allScopes = [webui.projectData?.data, webui.taskProxyData?.data];
        allScopes.forEach(scope => {
            if (!scope) return;
            Object.keys(scope).forEach(key => {
                let snakeKey = `{${webui.toSnake(key).toUpperCase()}}`;
                if (markdown.includes(snakeKey)) {
                    if (!webui.currentPageVariables.includes(key)) {
                        webui.currentPageVariables.push(key);
                        let val = webui.getData(key);
                        if (val !== undefined) {
                            webui.setData(key, val);
                        }
                    }
                }
            });
        });
        announcePageVariables();
        convertMarkdownToSegments(markdown);
        comp.appendChild(topBar);
        segmentsElement().replaceChildren(...segments);
        comp.appendChild(segmentsElement());
        comp.appendChild(bottomBar);
        savedPage = pageMarkdown();
        if (draft && Array.isArray(draft.segments)) {
            segments = draft.segments.map(item => webui.create('app-markdown-segment', { 'data-markdown': `${item?.md ?? ''}`, 'data-saved': `${item?.saved ?? ''}` }));
            segmentsElement().replaceChildren(...segments);
        }
        refreshScripts();
        refreshPending();
        // Changes kept from before the file changed, as through git: saving them replaces what changed.
        if (draft && hasPendingChanges() && draftBase !== null && draftBase !== savedPage && pageBars[0]) {
            actionNote(pageBars[0].save, 'This page has unsaved changes from before its file changed. Saving them replaces the file as it is now, and Revert shows the file as it is now.', 'warning');
        }
    }
    async function refreshScripts() {
        let mdContent = [];
        await webui.wait(100);
        segments.forEach(segment => {
            let segMd = segment.getMarkdown();
            if (segMd) mdContent.push(segMd);
        });
        let fullMd = mdContent.join('\n\n');
        if (fullMd === lastScannedMarkdown) {
            applyScriptUI();
            return;
        }
        lastScannedMarkdown = fullMd;
        const bindRegex = /data-(?:bind|trigger)="([^"]*)"/g;
        let bindMatch;
        while ((bindMatch = bindRegex.exec(fullMd)) !== null) {
            bindMatch[1].split('|').forEach(bk => {
                let bindKey = bk.split(':')[0].trim();
                if (bindKey.includes('.')) bindKey = bindKey.split('.')[1];
                if (bindKey && !webui.currentPageVariables.includes(bindKey)) {
                    webui.currentPageVariables.push(bindKey);
                }
            });
        }
        const allScopes = [webui.projectData?.data, webui.taskProxyData?.data];
        allScopes.forEach(scope => {
            if (!scope) return;
            Object.keys(scope).forEach(key => {
                let snakeKey = `{${webui.toSnake(key).toUpperCase()}}`;
                if (fullMd.includes(snakeKey)) {
                    if (!webui.currentPageVariables.includes(key)) {
                        webui.currentPageVariables.push(key);
                        let val = webui.getData(key);
                        if (val !== undefined) {
                            webui.setData(key, val);
                        }
                    }
                }
            });
        });
        pageScripts = [];
        const scriptRegex = /```(?:powershell|pwsh|ps1)\b[^\n]*\n([\s\S]*?)```/gi;
        const varRegex = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
        const ignoreVars = ['null', 'true', 'false', '_'];
        let scriptMatch;
        let lastMatchIndex = 0;
        let scriptIndex = 1;
        while ((scriptMatch = scriptRegex.exec(fullMd)) !== null) {
            const scriptContent = scriptMatch[1];
            // An empty block has nothing to run, and its element never shows text to wait for.
            if (!sameScript(scriptContent)) continue;
            let vars = [];
            let varMatch;
            while ((varMatch = varRegex.exec(scriptContent)) !== null) {
                const varName = varMatch[1];
                if (ignoreVars.includes(varName.toLowerCase())) continue;
                if (!vars.includes(varName)) vars.push(varName);
                if (!webui.currentPageVariables.includes(varName)) {
                    webui.currentPageVariables.push(varName);
                }
            }
            let textSinceLastScript = fullMd.substring(lastMatchIndex, scriptMatch.index);
            let cleanText = textSinceLastScript.replace(/<[^>]+>/g, '').replace(/[#*`_>]/g, '').trim();
            let lines = cleanText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            let lastText = lines.length > 0 ? lines[lines.length - 1] : '';
            pageScripts.push({
                content: scriptContent,
                variables: vars,
                lastText: lastText,
                scriptIndex: scriptIndex++
            });
            lastMatchIndex = scriptRegex.lastIndex;
        }
        syncBoundElements();
        applyScriptUI();
    }
    /** The data keys an element attribute names, without their getters or setters. */
    function attributeKeys(value) {
        return (value || '').split('|').map(k => k.split(':')[0].trim()).filter(Boolean);
    }
    function shownValue(el) {
        return webui.getDefined(typeof el.getValue === 'function' ? el.getValue() : undefined, el.value, el.dataset.value);
    }
    const isBlank = value => value === undefined || value === null || value === '';
    /**
     * Makes the values bound fields show and the values scripts use agree. A field starts its data at the
     * value it shows, when the data has none. A field whose choices come from data, such as a dropdown of
     * project files, gets its choices after the page loads and then shows the first one, which nothing
     * writes to the data, and it loses a saved value that arrived before its choices. So once its choices
     * arrive, it shows the saved value, or the data takes the value it shows when the saved one is not a choice.
     * With subscribedKey, only fields whose choices come from that key are checked.
     */
    function syncBoundElements(attempt = 0, subscribedKey) {
        if (attempt > 20) return;
        let boundEls = [];
        segments.forEach(seg => {
            webui.querySelectorAll('[data-bind],[data-trigger]', seg).forEach(el => {
                if (webui.closest(el, '.input')) return;
                if (subscribedKey && !attributeKeys(el.dataset.subscribe).some(key => key === subscribedKey || webui.toSnake(key, '-') === subscribedKey)) return;
                boundEls.push(el);
            });
        });
        let needsRetry = false;
        boundEls.forEach(el => {
            if ((el.nodeName.startsWith('WEBUI-') || el.nodeName.startsWith('APP-')) && !el._isConnected) {
                needsRetry = true;
                return;
            }
            const hasChoices = !!el.dataset.subscribe;
            attributeKeys([el.dataset.trigger, el.dataset.bind].filter(Boolean).join('|')).forEach(rawKey => {
                const current = webui.getData(rawKey);
                const shown = shownValue(el);
                if (isBlank(current)) {
                    if (!isBlank(shown)) {
                        webui.setData(rawKey, shown);
                    } else if (hasChoices || el.hasAttribute('options') || el.hasAttribute('data-options')) {
                        needsRetry = true;
                    }
                    return;
                }
                // When its choices arrive, a dropdown shows its first choice and writes that to the data, so the
                // value saved before the page loaded is put back, if it is still a choice.
                const saved = savedBoundValues[rawKey];
                if (hasChoices && saved !== undefined && !isBlank(shown)) {
                    delete savedBoundValues[rawKey];
                    if (`${current}` !== `${saved}` && typeof el.setValue === 'function') {
                        el.setValue(saved);
                        // Only when the saved value is still one of the choices.
                        if (`${shownValue(el)}` === `${saved}`) webui.setData(rawKey, saved);
                        return;
                    }
                }
                if (!hasChoices || typeof current === 'object' || isBlank(shown) || `${shown}` === `${current}`) return;
                if (typeof el.setValue === 'function') el.setValue(current);
                const now = shownValue(el);
                if (!isBlank(now) && `${now}` !== `${current}`) webui.setData(rawKey, now);
            });
        });
        if (needsRetry) {
            setTimeout(() => syncBoundElements(attempt + 1, subscribedKey), 50);
        }
    }
    /**
     * Gives the page's script blocks their previews and Run buttons. While blocks are still being drawn it tries again,
     * and once they are drawn, or it has waited long enough, the blocks that match a script get them, even when another
     * block matches none.
     */
    let scriptUIRound = 0;
    function applyScriptUI(attempt = 0, round = ++scriptUIRound) {
        // A newer call has started its own tries, so this one stops.
        if (round !== scriptUIRound) return;
        if (findAllWebuiCodes().length < pageScripts.length && scriptBlocksPending() && attempt < 50) {
            setTimeout(() => applyScriptUI(attempt + 1, round), 100);
            return;
        }
        updateScriptPreviews();
        injectPlayButtons();
    }
    /**
     * The values typed or set on this page for a script's variables. Rust fills the script with these, then the
     * project's and global values, so this window never needs secret values to run it.
     */
    function pageValuesFor(scriptMeta) {
        const values = {};
        scriptMeta.variables.forEach(name => {
            const value = webui.getNestedData(name, window.appData);
            if (value !== undefined) values[name] = value;
        });
        return values;
    }
    const scriptLanguages = ['powershell', 'pwsh', 'ps1'];
    /**
     * A script's text as a code block shows it, to compare one with the other. Drawing a block changes only the
     * whitespace at the ends of its lines: tabs become spaces, the block is trimmed, and the lines after the first lose
     * the indentation they share, as a block indented under a list item does. So this does the same to both, and
     * anything else that differs, differs.
     */
    function sameScript(text) {
        const lines = `${text ?? ''}`.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n').map(line => line.trimEnd());
        while (lines.length && !lines[0]) lines.shift();
        while (lines.length && !lines[lines.length - 1]) lines.pop();
        if (!lines.length) return '';
        const rest = lines.slice(1);
        const indent = Math.min(...rest.filter(Boolean).map(line => line.match(/^ */)[0].length));
        return [lines[0].trimStart(), ...rest.map(line => Number.isFinite(indent) ? line.substring(indent) : line)].join('\n');
    }
    /**
     * A fenced script as its block shows it. A segment is drawn with its {VARIABLE} placeholders filled in, so the
     * block shows their values. Rust runs the script as written, which the preview then shows, so that form matches too.
     */
    const shownScripts = meta => [sameScript(webui.replaceAppData(meta.content)), sameScript(meta.content)];
    /** The page's code elements in a script language. */
    function scriptCodeElements() {
        const list = [];
        segments.forEach(seg => {
            webui.querySelectorAll('webui-code', seg).forEach(el => {
                // The markdown parser writes language, and wrote lang before Web UI changed it.
                const language = el.getAttribute('language') || el.getAttribute('lang') || '';
                if (scriptLanguages.includes(language.toLowerCase())) list.push(el);
            });
        });
        return list;
    }
    /** The text a code element shows, read once, before a preview fills in its values. Nothing is kept while it is empty. */
    function codeText(el) {
        if (el._scriptText) return el._scriptText;
        const text = sameScript(typeof el.value === 'string' ? el.value : el.textContent);
        if (text) el._scriptText = text;
        return text;
    }
    /** Whether the page's script blocks are still being drawn: fewer than its scripts, not upgraded, or with no text yet. */
    function scriptBlocksPending() {
        const codes = scriptCodeElements();
        const Code = customElements.get('webui-code');
        return codes.length < pageScripts.length || codes.some(el => !Code || !(el instanceof Code) || !codeText(el));
    }
    /**
     * Each PowerShell code element on the page with the script it shows, as `{codeEl, scriptMeta}`. Scripts are
     * collected from the page's fenced blocks, and a page can also hold code elements written as HTML, so each element
     * is matched to the first script with the same text no other element has taken, never by its place: a Run button
     * only ever runs the script its block shows, an element with no script has none, and an element written as HTML
     * can't take the scripts of the blocks before it.
     */
    function findAllWebuiCodes() {
        const found = [];
        const shown = pageScripts.map(shownScripts);
        const used = new Set();
        scriptCodeElements().forEach(el => {
            const text = codeText(el);
            if (!text) return;
            const at = shown.findIndex((forms, index) => !used.has(index) && forms.includes(text));
            if (at < 0) return;
            used.add(at);
            found.push({ codeEl: el, scriptMeta: pageScripts[at] });
        });
        return found;
    }
    /** Shows each script with its values filled in and masked, as Rust fills them. */
    function updateScriptPreviews() {
        const round = ++previewRound;
        findAllWebuiCodes().forEach(async ({ codeEl, scriptMeta }) => {
            const masked = await webui.proxy.pageScriptPreview(scriptMeta.content, pageValuesFor(scriptMeta), () => { });
            if (round === previewRound && typeof masked === 'string') codeEl.value = masked;
        });
    }
    function injectPlayButtons() {
        let codes = findAllWebuiCodes();
        codes.forEach(({ codeEl, scriptMeta }) => {
            customElements.whenDefined('webui-code').then(async () => {
                let root = codeEl.shadowRoot || codeEl;
                const inject = () => {
                    if (webui.querySelectorAll('.run-script-btn', root).length !== 0) return;
                    let copyBtn = webui.querySelector('webui-icon[icon="copy"]', root);
                    let header = webui.querySelector('label', root);
                    if (!copyBtn && !header) return;
                    let playBtn = webui.create('webui-icon', {
                        icon: 'play',
                        class: 'run-script-btn',
                        style: 'cursor: pointer; margin-left: 8px;',
                        title: 'Run Script'
                    });
                    playBtn.addEventListener('click', () => runPageScript(scriptMeta, codeEl));
                    makeButton(playBtn, `Run script: ${scriptMeta.lastText || `#${scriptMeta.scriptIndex}`}`);
                    if (copyBtn) {
                        copyBtn.after(playBtn);
                    } else if (header) {
                        header.appendChild(playBtn);
                    }
                };
                if (!codeEl._playBtnObserver) {
                    codeEl._playBtnObserver = new MutationObserver(() => inject());
                    codeEl._playBtnObserver.observe(root, { childList: true, subtree: true });
                }
                inject();
            });
        });
    }
    /** Runs a page's script. Why it couldn't run is said under its code block, `codeEl`. */
    async function runPageScript(scriptMeta, codeEl) {
        // Its own row, so its alert goes straight after this block, not after the element holding every block.
        codeEl?.setAttribute('data-action-row', '');
        clearActionNote(codeEl);
        const pageValues = pageValuesFor(scriptMeta);
        const maskedContent = await webui.proxy.pageScriptPreview(scriptMeta.content, pageValues, err => actionNote(codeEl, err, 'danger'));
        if (typeof maskedContent !== 'string') return;
        if (!await webui.proxy.confirmProjectScript(maskedContent)) return;
        let projProject = webui.getData('app-current-project');
        let projName = projProject ? projProject.display : 'Project';
        let pageName = webui.getData('page-title') || 'Page';
        let lastName = scriptMeta.lastText || `#${scriptMeta.scriptIndex}`;
        let totalName = `${projName}_${pageName}_${lastName}`;
        if (totalName.length > 50) {
            if (projName.length > 18) projName = projName.substring(0, 18);
            totalName = `${projName}_${pageName}_${lastName}`;
            if (totalName.length > 50) {
                if (pageName.length > 18) pageName = pageName.substring(0, 18);
                totalName = `${projName}_${pageName}_${lastName}`;
                if (totalName.length > 50) {
                    totalName = totalName.substring(0, 50);
                }
            }
        }
        webui.proxy.terminalHelpers.ensureListeners();
        // Rust fills in the values and runs it, showing the masked copy in the Terminal Manager.
        const run = await webui.proxy.runPageScript(totalName, scriptMeta.content, pageValues, err => actionNote(codeEl, err, 'warning'));
        if (!run) return;
        webui.proxy.terminalHelpers.applyRun(run);
        // Opened on a running view showing this run, which stays listed even when it has already finished.
        document.querySelector('app-terminals')?.openDrawer({ run: true, terminalId: run.id, projectId: run.projectId });
    }
    // Tags with no closing tag, which can never open a multi-line component.
    const voidTags = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'];
    /** The tag that opens a component at the start of this line, if any. */
    function getComponentTag(line) {
        let match = line.match(/^\s*<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s>\/])/);
        if (!match) return null;
        let tag = match[1].toLowerCase();
        return voidTags.includes(tag) ? null : tag;
    }
    /** How much this line changes the number of open tags with this name. */
    function getTagDepthChange(line, tag) {
        let change = 0;
        const tagRegex = new RegExp(`<(\\/?)${tag}(?=[\\s>\\/])[^>]*?(\\/?)>`, 'gi');
        let match;
        while ((match = tagRegex.exec(line)) !== null) {
            if (match[1]) {
                --change;
            } else if (!match[2]) {
                ++change;
            }
        }
        return change;
    }
    /** Reads a fenced code block or a multi-line component from `index`, returning the index of its last line. */
    function findBlockEnd(lines, index) {
        let line = lines[index];
        let fence = line.match(/^\s*(```+|~~~+)/);
        if (fence) {
            let end = index + 1;
            const close = new RegExp(`^\\s*${fence[1]}`);
            while (end < lines.length && !close.test(lines[end])) ++end;
            return Math.min(end, lines.length - 1);
        }
        let tag = getComponentTag(line);
        if (!tag) return index;
        let depth = getTagDepthChange(line, tag);
        let end = index;
        let inFence = false;
        while (depth > 0 && end < lines.length - 1) {
            ++end;
            // Tags shown as code examples do not open or close anything.
            if (/^\s*(```+|~~~+)/.test(lines[end])) {
                inFence = !inFence;
            } else if (!inFence) {
                depth += getTagDepthChange(lines[end], tag);
            }
        }
        // An unclosed plain tag is prose such as "<string> values", not a component.
        if (depth > 0 && !tag.includes('-')) return index;
        return end;
    }
    /**
     * Split a page into editable segments: headings, line breaks, and page segments. Content that is
     * none of these is wrapped in a page segment, which ends where the next page segment, heading, or
     * line break starts, or at the end of the page. Code blocks and components are never split.
     */
    function splitMarkdownSegments(markdown) {
        let results = [];
        let lines = markdown.replace(/\r\n/g, '\n').split('\n');
        let body = [];
        const flushBody = () => {
            while (body.length && body[0].trim() === '') body.shift();
            while (body.length && body[body.length - 1].trim() === '') body.pop();
            if (body.length) {
                results.push({ md: `<webui-page-segment>\n\n${body.join('\n')}\n\n</webui-page-segment>`, mdt: 'segment' });
            }
            body = [];
        };
        for (let index = 0; index < lines.length; ++index) {
            let line = lines[index];
            let trimmed = line.trim();
            if (/^#{1,6}[ \t]+\S/.test(line)) {
                flushBody();
                results.push({ md: line.trimEnd(), mdt: 'heading' });
                continue;
            }
            if (/^<webui-line\s*>\s*<\/webui-line>$/i.test(trimmed)) {
                flushBody();
                results.push({ md: trimmed, mdt: 'line' });
                continue;
            }
            let end = findBlockEnd(lines, index);
            let block = lines.slice(index, end + 1);
            if (getComponentTag(line) === 'webui-page-segment' && end > index || /^\s*<webui-page-segment\b.*<\/webui-page-segment>\s*$/i.test(line)) {
                flushBody();
                results.push({ md: block.join('\n').trim(), mdt: 'segment' });
            } else {
                body.push(...block);
            }
            index = end;
        }
        flushBody();
        return results;
    }
    function convertMarkdownToSegments(markdown) {
        segments.length = 0;
        splitMarkdownSegments(markdown).forEach(item => {
            segments.push(webui.create('app-markdown-segment', { 'data-markdown': item.md, mdt: item.mdt }));
        });
    }
    let sharedDrawerObserver = null;
    function getVariableKeyName(name) {
        if (!variableKeyNames.has(name)) {
            variableKeyNames.set(name, webui.toSnake(name, '-'));
        }
        return variableKeyNames.get(name);
    }
    function onAppDataChanged(changes) {
        if (!changes || !changes.property) return;
        let prop = changes.property;
        // Fields given their choices by this data now show the first choice, which scripts need to use.
        setTimeout(() => syncBoundElements(0, prop), 0);
        let tracked = webui.currentPageVariables.find(v => getVariableKeyName(v) === prop || v === prop);
        if (tracked) {
            // Only segments showing this value need rendering. Bound inputs update themselves.
            let token = `{${webui.toSnake(tracked).toUpperCase()}}`;
            let renders = [];
            segments.forEach(seg => {
                if (typeof seg.render !== 'function' || seg.classList.contains('isEditing')) return;
                if ((seg.getMarkdown() || '').includes(token)) {
                    renders.push(seg.render());
                }
            });
            Promise.all(renders).then(() => {
                setTimeout(() => {
                    applyScriptUI();
                }, 50);
            });
        }
    }
    /** Titles a plugin's page with the plugin's name and the page's name from its manifest. */
    async function showPluginTitle(pluginId, pageId) {
        await whenProxyReady();
        const plugins = await webui.proxy.plugins.list(() => undefined);
        const manifest = (plugins || []).find(plugin => plugin.id === pluginId)?.manifest;
        if (!manifest || !location.pathname.startsWith(`/plugin/${pluginId}/${pageId}`)) return;
        const page = (manifest.pages || []).find(page => page.id === pageId);
        webui.setData('page-title', webui.escapeForHTML(manifest.name));
        webui.setData('page-subtitle', webui.escapeForHTML(page?.name || ''));
    }
    webui.define("app-page-handler", {
        preload: 'app:markdown-segment app:files app:page-export app:ai-action dropdown select switch input-text input-message code page-help reorder',
        constructor() {
            const t = this;
            comp = t;
        },
        connected() {
            const t = this;
            // A plugin's page, as /plugin/<plugin id>/<page id>, is drawn from the plugin rather than a project file.
            const pluginRoute = location.pathname.match(/^\/plugin\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)\/?$/);
            if (pluginRoute) {
                t._pluginPage = true;
                t.replaceChildren(webui.create('app-plugin-page', { plugin: pluginRoute[1], page: pluginRoute[2] }));
                showPluginTitle(pluginRoute[1], pluginRoute[2]);
                return;
            }
            webui.watchAppDataChanges(onAppDataChanged);
            t._shared = webui.querySelector('.shared');
            sharedDrawerObserver = new MutationObserver((mutations) => {
                mutations.forEach((m) => {
                    if (m.attributeName === 'class' && !t._shared.classList.contains('open')) {
                        updateScriptPreviews();
                    }
                });
            });
            sharedDrawerObserver.observe(t._shared, { attributes: true });
            t.addEventListener('segment-delete', ev => {
                // The segment removes itself after this event, so leave it out of the page's list now.
                segments = segments.filter(segment => segment !== ev.target);
                setTimeout(() => {
                    refreshScripts();
                    refreshPending();
                }, 0);
            });
            t.addEventListener('segment-change', () => refreshPending());
            t.addEventListener('reorder', () => refreshPending());
            document.addEventListener('click', onLeaveClick, true);
            t.addEventListener('click', (ev) => {
                let segment = ev.target.closest('app-markdown-segment');
                if (segment) {
                    setTimeout(() => {
                        if (!segment.classList.contains('isEditing')) {
                            refreshScripts();
                        }
                    }, 50);
                }
            });
            t._headerTitle = document.querySelector('header h1[data-subscribe="page-title:innerHTML"]');
            t._headerSubtitle = document.querySelector('header h2[data-subscribe="page-subtitle:innerHTML"]');
            if (t._headerTitle) {
                t._headerTitle.addEventListener('click', onTitleClick);
                t._headerTitle.style.cursor = 'pointer';
                t._headerTitle.setAttribute('title', 'Edit Page Title');
                // Shows a placeholder when the title is empty, which would otherwise leave nothing to click.
                t._headerTitle.classList.add('editable-title');
            }
            if (t._headerSubtitle) {
                t._headerSubtitle.addEventListener('click', onTitleClick);
                t._headerSubtitle.style.cursor = 'pointer';
                t._headerSubtitle.setAttribute('title', 'Edit Page Title');
            }
            let project = webui.getData('app-current-project');
            if (project && project.value) {
                loadProject();
            } else {
                setMarkdown(notFound);
            }
        },
        disconnected() {
            const t = this;
            // Leaving for a page this handler doesn't draw, such as Settings, leaves no page variables.
            if (!document.querySelector('app-page-handler')) {
                webui.currentPageVariables = [];
                announcePageVariables();
            }
            if (t._pluginPage) return;
            webui.unwatchAppDataChanges(onAppDataChanged);
            document.removeEventListener('click', onLeaveClick, true);
            if (sharedDrawerObserver) {
                sharedDrawerObserver.disconnect();
                sharedDrawerObserver = null;
            }
            if (t._headerTitle) {
                t._headerTitle.removeEventListener('click', onTitleClick);
                t._headerTitle.style.cursor = '';
                t._headerTitle.removeAttribute('title');
                t._headerTitle.classList.remove('editable-title');
            }
            if (t._headerSubtitle) {
                t._headerSubtitle.removeEventListener('click', onTitleClick);
                t._headerSubtitle.style.cursor = '';
                t._headerSubtitle.removeAttribute('title');
            }
            //comp = null;
            markdown = '';
            myId = '';
            myFile = '';
            segments = [];
            lastScannedMarkdown = null;
            pageDataComponent = '';
            pageHelp = null;
            savedPage = null;
            pageProject = null;
            pendingShown = false;
            draftBase = null;
        }
    });
}
