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
    webui.currentPageVariables = [];
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
        bar.appendChild(btnSave);
        return wrap;
    }
    let topBar = setupBar(false);
    let bottomBar = setupBar(true);
    function setMarkdown(md) {
        if (!comp) return;
        markdown = md;
        comp.innerHTML = '';
        webui.currentPageVariables.forEach(key => webui.setData(key, undefined));
        webui.currentPageVariables = [];
        const reservedAttrs = ['bind', 'trigger', 'subscribe', 'default', 'state', 'hide', 'toggleclass', 'removeclass', 'setattr', 'toggleattr', 'stopclick', 'click', 'markdown', 'options', 'name', 'title', 'value', 'param'];
        const dataRegex = /data-([a-zA-Z0-9-]+)="([^"]*)"/g;
        let match;
        while ((match = dataRegex.exec(md)) !== null) {
            const attrName = match[1];
            const attrValue = match[2];
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
            // Prevent overwriting internal webui-data routing properties like page-title
            if (attrName.startsWith('page-') || attrName.startsWith('app-') || attrName.startsWith('session-')) continue;
            if (!webui.currentPageVariables.includes(attrName)) {
                webui.currentPageVariables.push(attrName);
            }
            webui.setData(attrName, attrValue);
        }
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
        pageScripts = [];
        const scriptRegex = /```(?:powershell|ps1)\n([\s\S]*?)```/gi;
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
    function injectVariableValues(scriptContent, forPreview) {
        let updatedScript = scriptContent;
        webui.currentPageVariables.forEach(varName => {
            let rawValue = webui.getData(varName);
            if (rawValue === undefined || rawValue === null || rawValue === '') {
                return;
            }
            let val = String(rawValue);
            let stringRegex = new RegExp(`(\\$${varName}\\s*=\\s*)(['"])([\\s\\S]*?)(\\2)`, 'gi');
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
            let nonStringRegex = new RegExp(`(\\$${varName}\\s*=\\s*)([^'"\\s][^\\n\\r]*)`, 'gi');
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
    function findAllWebuiCodes() {
        let codes = [];
        segments.forEach(seg => {
            webui.querySelectorAll('webui-code', seg).forEach(el => {
                codes.push(el);
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
            customElements.whenDefined('webui-code').then(() => {
                setTimeout(() => {
                    let root = codeEl.shadowRoot || codeEl;
                    if (webui.querySelectorAll('.run-script-btn', root).length !== 0) return;
                    let copyBtn = webui.querySelectorAll('webui-icon[icon="copy"]', root)[0];
                    let playBtn = webui.create('webui-icon', {
                        icon: 'emoji-play_button',
                        class: 'run-script-btn',
                        style: 'cursor: pointer; margin-left: 8px;',
                        title: 'Run Script'
                    });
                    playBtn.addEventListener('click', () => runPageScript(scriptMeta));
                    if (copyBtn) {
                        copyBtn.after(playBtn);
                    } else {
                        let header = webui.querySelectorAll('label', root);
                        if (header) {
                            header.appendChild(playBtn);
                        }
                    }
                }, 200);
            });
        });
    }
    async function runPageScript(scriptMeta) {
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
        webui.setData('app-terminal-state', state);
        let executableContent = injectVariableValues(scriptMeta.content, false);
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
    const segmentType = {
        INVALID: 0,
        EMTPY: 1,
        RAW: 2,
        COMPONENT: 3,
        COMPONENTSTART: 4,
        COMPONENTEND: 5
    };
    function getSegmentDetail(line) {
        if (line.trim() === '') return [segmentType.EMTPY, { mdt: 'empty' }];
        if (line.startsWith('#')) return [segmentType.RAW, { mdt: 'heading' }];
        if (line.match(/<([^ >]+)[^>]*>.*<\/\1>\s*$/)) return [segmentType.COMPONENT, { mdt: 'sl-comp' }];
        let match = line.match(/<\/([^ >]+)[^>]*>/);
        if (match) {
            let [_, tag] = match;
            return [segmentType.COMPONENTEND, { tag: tag }];
        }
        match = line.match(/<([^ >]+)[^>]*>/);
        if (match) {
            let [_, tag] = match;
            return [segmentType.COMPONENTSTART, { tag: tag }];
        }
        return [segmentType.RAW, { mdt: 'text' }];
    }
    function convertMarkdownToSegments(markdown) {
        segments.length = 0;
        let lines = markdown.replace(/\r\n/g, '\n').split('\n');
        let s = [];
        let currentSegment = null;
        let tag = null;
        let last = null;
        for (let index = 0; index < lines.length; ++index) {
            let line = lines[index];
            let [st, options] = getSegmentDetail(line);
            let prev = last;
            last = st;
            switch (st) {
                case segmentType.INVALID:
                    break;
                case segmentType.COMPONENTSTART:
                    if (!currentSegment) {
                        currentSegment = webui.create('app-markdown-segment');
                        tag = options.tag;
                    }
                    s.push(line);
                    break;
                case segmentType.COMPONENTEND:
                    if (!currentSegment) continue;
                    s.push(line);
                    let md = s.join('\n');
                    let ms = webui.create('app-markdown-segment', { 'data-markdown': md, mdt: 'ml-comp' });
                    segments.push(ms);
                    s.length = 0;
                    currentSegment = null;
                    break;
                default:
                    if (currentSegment) {
                        s.push(line);
                    } else {
                        if (st === segmentType.EMTPY && prev !== segmentType.EMTPY) {
                            continue;
                        }
                        options['data-markdown'] = line;
                        let ms = webui.create('app-markdown-segment', options);
                        segments.push(ms);
                    }
                    break;
            }
        }
    }
    let sharedDrawerObserver = null;
    function onAppDataChanged(changes) {
        if (!changes || !changes.property) return;
        let prop = changes.property;
        let isTracked = webui.currentPageVariables.some(v => webui.toSnake(v, '-') === prop || v === prop);
        if (isTracked) {
            updateScriptPreviews();
        }
    }
    webui.define("app-page-handler", {
        preload: 'app:markdown-segment dropdown input-text input-message code',
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
            //comp = null;
            markdown = '';
            myId = '';
            myFile = '';
            segments = [];
        }
    });
}
