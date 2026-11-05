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
    let dragNDrop = getDragNDropSetup((_) => segments);
    let segments = [];
    let pageScripts = [];
    let pageDataComponent = '';
    let lastScannedMarkdown = null;
    const variableKeyNames = new Map();
    const variableRegexes = new Map();
    webui.currentPageVariables = [];
    let onTitleClick = () => {
        webui.dialog({
            title: 'Edit Page Title',
            content: `<webui-flex column gap="var(--padding)">
                <webui-input-text name="pageTitle" label="Page Title" value="${webui.escapeForHTML(webui.getData('page-title') || '')}"></webui-input-text>
                <webui-input-text name="pageSubtitle" label="Page Subtitle" value="${webui.escapeForHTML(webui.getData('page-subtitle') || '')}"></webui-input-text>
            </webui-flex>`,
            confirm: 'Save',
            cancel: 'Cancel',
            onconfirm: (data) => {
                let form = Object.fromEntries(data);
                webui.setData('page-title', form.pageTitle || '');
                webui.setData('page-subtitle', form.pageSubtitle || '');
                pageDataComponent = `<webui-data data-page-title="${webui.escapeForHTML(form.pageTitle || '')}" data-page-subtitle="${webui.escapeForHTML(form.pageSubtitle || '')}"></webui-data>`;
                if (myFile) {
                    let md = [pageDataComponent];
                    comp.querySelectorAll('app-markdown-segment').forEach(segment => {
                        if (segment.parentNode !== comp) return;
                        let markdown = segment.getMarkdown();
                        if (markdown) {
                            md.push(markdown);
                        }
                    });
                    webui.proxy.saveProjectFile(myFile, md.join('\n\n').trim());
                }
                return true;
            }
        });
    };
    async function loadProject() {
        myId = location.pathname.substring(1);
        myFile = `.taskproxy/pages/${myId}.md`;
        await webui.wait(()=>!!webui.proxy);
        let md = await webui.proxy.getProjectFile(myFile, err => { webui.log.warn('getProjectFile:%o', err); });
        if (!md) {
            md = '';
        }
        setMarkdown(md);
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
            html: 'Save', title: "Save Page", 'start-icon': 'emoji-floppy_disk', theme: 'primary'
        });
        btnSave.addEventListener('click', async _ => {
            if (!myFile) return;
            let md = [];
            if (pageDataComponent) {
                md.push(pageDataComponent);
            }
            comp.querySelectorAll('app-markdown-segment').forEach(segment => {
                if (segment.parentNode !== comp) return;
                let markdown = segment.getMarkdown();
                if (markdown) {
                    md.push(markdown);
                }
            });
            let result = await webui.proxy.saveProjectFile(myFile, md.join('\n\n').trim());
            if (result) {
                webui.alert(result, 'success');
            }
        });
        let btnAdd = webui.create('webui-button', {
            html: 'Add', title: 'Add Segment', 'start-icon': 'star', theme: 'secondary'
        });
        btnAdd.addEventListener('click', async _ => {
            let segment = webui.create('app-markdown-segment', {});
            if (isEnd) {
                wrap.before(segment);
            } else {
                wrap.after(segment);
            }
            dragNDrop(segment);
            segments = Array.from(comp.querySelectorAll('app-markdown-segment'));
        });
        bar.appendChild(btnAdd);
        bar.appendChild(webui.create('webui-flex', { 'grow': true }));
        bar.appendChild(btnSave);
        return wrap;
    }
    let topBar = setupBar(false);
    let bottomBar = setupBar(true);
    function setMarkdown(md) {
        if (!comp) return;
        let mdTrimmed = md.trim();
        let webuiDataRegex = /^<webui-data[\s\S]*?<\/webui-data>/i;
        let match = mdTrimmed.match(webuiDataRegex);
        if (match) {
            pageDataComponent = match[0];
            markdown = mdTrimmed.substring(pageDataComponent.length).trim();
        } else {
            pageDataComponent = `<webui-data data-page-title="${webui.escapeForHTML(webui.getData('page-title') || '')}" data-page-subtitle="${webui.escapeForHTML(webui.getData('page-subtitle') || '')}"></webui-data>`;
            markdown = mdTrimmed;
        }
        comp.innerHTML = '';
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
        convertMarkdownToSegments(markdown);
        comp.appendChild(topBar);
        segments.forEach(segment => {
            dragNDrop(segment);
            comp.appendChild(segment);
        });
        comp.appendChild(bottomBar);
        refreshScripts();
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
        syncInitialBoundElements();
        applyScriptUI();
    }
    function syncInitialBoundElements(attempt = 0) {
        if (attempt > 20) return;
        let boundEls = [];
        segments.forEach(seg => {
            webui.querySelectorAll('[data-bind],[data-trigger]', seg).forEach(el => {
                if (webui.closest(el, '.input')) return;
                boundEls.push(el);
            });
        });
        let needsRetry = false;
        boundEls.forEach(el => {
            if ((el.nodeName.startsWith('WEBUI-') || el.nodeName.startsWith('APP-')) && !el._isConnected) {
                needsRetry = true;
                return;
            }
            let keyAttr = [el.dataset.trigger, el.dataset.bind].filter(Boolean).join('|');
            keyAttr.split('|').forEach(k => {
                let rawKey = k.split(':')[0].trim();
                if (!rawKey) return;
                if (webui.getData(rawKey) === undefined) {
                    let val = webui.getDefined(
                        typeof el.getValue === 'function' ? el.getValue() : undefined,
                        el.value,
                        el.dataset.value
                    );
                    if (val !== undefined && val !== '') {
                        webui.setData(rawKey, val);
                    } else if (el.hasAttribute('options') || el.hasAttribute('data-options')) {
                        needsRetry = true;
                    }
                }
            });
        });
        if (needsRetry) {
            setTimeout(() => syncInitialBoundElements(attempt + 1), 50);
        }
    }
    function applyScriptUI(attempt = 0) {
        if (attempt > 50) return;
        let codes = findAllWebuiCodes();
        if (codes.length < pageScripts.length) {
            setTimeout(() => applyScriptUI(attempt + 1), 100);
            return;
        }
        updateScriptPreviews();
        injectPlayButtons();
    }
    function getVariableRegexes(varName) {
        if (!variableRegexes.has(varName)) {
            const name = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            variableRegexes.set(varName, [
                new RegExp(`(\\$${name}\\s*=\\s*)(['"])([\\s\\S]*?)(\\2)`, 'gi'),
                new RegExp(`(\\$${name}\\s*=\\s*)([^'"\\s][^\\n\\r]*)`, 'gi')
            ]);
        }
        return variableRegexes.get(varName);
    }
    function injectVariableValues(scriptContent, forPreview) {
        let updatedScript = scriptContent;
        webui.currentPageVariables.forEach(varName => {
            let rawValue = webui.getData(varName);
            if (rawValue === undefined || rawValue === null || rawValue === '') {
                return;
            }
            let val = String(rawValue);
            let [stringRegex, nonStringRegex] = getVariableRegexes(varName);
            updatedScript = updatedScript.replace(stringRegex, (match, prefix, quote, oldContent, suffix) => {
                let formattedVal = val;
                if (forPreview) {
                    if (formattedVal.length > 6) {
                        formattedVal = `${formattedVal.substring(0, 3)}***${formattedVal.substring(formattedVal.length - 3)}`;
                    }
                } else {
                    if (quote === "'") {
                        formattedVal = formattedVal.replace(/'/g, "''");
                    } else if (quote === '"') {
                        formattedVal = formattedVal.replace(/"/g, '`"');
                    }
                }
                return `${prefix}${quote}${formattedVal}${suffix}`;
            });
            updatedScript = updatedScript.replace(nonStringRegex, (match, prefix, oldContent) => {
                if (!isNaN(val)) {
                    return `${prefix}${Number(val)}`;
                } else if (val.toLowerCase() === 'true' || val.toLowerCase() === 'false') {
                    return `${prefix}$${val.toLowerCase()}`;
                } else if (forPreview) {
                    return `${prefix}[INVALID TYPE]`;
                }
                return match;
            });
        });
        return updatedScript;
    }
    const scriptLanguages = ['powershell', 'pwsh', 'ps1'];
    function findAllWebuiCodes() {
        let codes = [];
        segments.forEach(seg => {
            webui.querySelectorAll('webui-code', seg).forEach(el => {
                // Scripts are only collected from PowerShell blocks, so only those line up with them.
                if (scriptLanguages.includes((el.getAttribute('lang') || '').toLowerCase())) {
                    codes.push(el);
                }
            });
        });
        return codes;
    }
    function updateScriptPreviews() {
        let codes = findAllWebuiCodes();
        codes.forEach((codeEl, index) => {
            let scriptMeta = pageScripts[index];
            if (!scriptMeta) return;
            codeEl.value = injectVariableValues(scriptMeta.content, true);
        });
    }
    function injectPlayButtons() {
        let codes = findAllWebuiCodes();
        codes.forEach((codeEl, index) => {
            let scriptMeta = pageScripts[index];
            if (!scriptMeta) return;
            customElements.whenDefined('webui-code').then(async () => {
                let root = codeEl.shadowRoot || codeEl;
                const inject = () => {
                    if (webui.querySelectorAll('.run-script-btn', root).length !== 0) return;
                    let copyBtn = webui.querySelector('webui-icon[icon="copy"]', root);
                    let header = webui.querySelector('label', root);
                    if (!copyBtn && !header) return;
                    let playBtn = webui.create('webui-icon', {
                        icon: 'emoji-play_button',
                        class: 'run-script-btn',
                        style: 'cursor: pointer; margin-left: 8px;',
                        title: 'Run Script'
                    });
                    playBtn.addEventListener('click', () => runPageScript(scriptMeta));
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
    async function runPageScript(scriptMeta) {
        let executableContent = injectVariableValues(scriptMeta.content, false);
        if (!await webui.proxy.confirmProjectScript(injectVariableValues(scriptMeta.content, true))) return;
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
        webui.setData('app-terminals-page-scripts', true);
        let state = webui.proxy.terminalHelpers.getState();
        state.activeId = totalName;
        webui.proxy.terminalHelpers.ensureListeners();
        await new Promise(r => setTimeout(r, 200));
        try {
            let result = await webui.proxy.terminalHelpers.runScript(
                totalName,
                executableContent,
                [],
                false,
                false,
                true
            );
            let terminalsApp = document.querySelector('app-terminals');
            if (terminalsApp) {
                terminalsApp.openDrawer();
            }
        } catch (err) {
            webui.alert(err, 'warning');
        }
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
    /**
     * Split a page into editable segments. Saving joins them with a blank line, so every
     * line must end up in a segment, and only blank lines may separate them.
     */
    function splitMarkdownSegments(markdown) {
        let results = [];
        let lines = markdown.replace(/\r\n/g, '\n').split('\n');
        let text = [];
        const flushText = () => {
            if (text.length) results.push({ md: text.join('\n'), mdt: 'text' });
            text = [];
        };
        for (let index = 0; index < lines.length; ++index) {
            let line = lines[index];
            if (line.trim() === '') {
                flushText();
                continue;
            }
            let fence = line.match(/^\s*(```+|~~~+)/);
            if (fence) {
                flushText();
                let end = index + 1;
                const close = new RegExp(`^\\s*${fence[1]}`);
                while (end < lines.length && !close.test(lines[end])) ++end;
                results.push({ md: lines.slice(index, end + 1).join('\n'), mdt: 'text' });
                index = end;
                continue;
            }
            if (line.startsWith('#')) {
                flushText();
                results.push({ md: line, mdt: 'heading' });
                continue;
            }
            let tag = getComponentTag(line);
            if (tag) {
                flushText();
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
                if (depth > 0 && !tag.includes('-')) {
                    text.push(line);
                    continue;
                }
                results.push({ md: lines.slice(index, end + 1).join('\n'), mdt: end > index ? 'ml-comp' : 'sl-comp' });
                index = end;
                continue;
            }
            text.push(line);
        }
        flushText();
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
    webui.define("app-page-handler", {
        preload: 'app:markdown-segment app:files dropdown input-text input-message code',
        constructor() {
            const t = this;
            comp = t;
        },
        connected() {
            const t = this;
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
            webui.unwatchAppDataChanges(onAppDataChanged);
            if (sharedDrawerObserver) {
                sharedDrawerObserver.disconnect();
                sharedDrawerObserver = null;
            }
            if (t._headerTitle) {
                t._headerTitle.removeEventListener('click', onTitleClick);
                t._headerTitle.style.cursor = '';
                t._headerTitle.removeAttribute('title');
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
        }
    });
}
