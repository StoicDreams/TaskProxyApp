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
    async function loadProject() {
        myId = location.pathname.substring(1);
        myFile = `.taskproxy/pages/${myId}.md`;
        let md = await webui.proxy.getProjectFile(myFile, err => { webui.log.warn('getProjectFile:%o', err); });
        if (!md) {
            md = '';
            await webui.proxy.saveProjectFile(myFile, md);
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
            html: 'Save', title: "Save Page", 'start-icon': 'save', theme: 'primary'
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
                bar.before(segment);
            } else {
                bar.after(segment);
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
        markdown = md;
        comp.innerHTML = '';
        convertMarkdownToSegments(markdown);
        comp.appendChild(topBar);
        segments.forEach(segment => {
            dragNDrop(segment);
            comp.appendChild(segment);
        });
        comp.appendChild(bottomBar);
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
    webui.define("app-page-handler", {
        preload: 'app-markdown-segment webui-dropdown webui-input-text webui-input-message',
        constructor: (t) => {
            comp = t;
        },
        connected: function (t) {
            let project = webui.getData('app-current-project');
            if (project && project.value) {
                loadProject();
            } else {
                setMarkdown(notFound);
            }
        },
        disconnected: function (t) {
            comp = null;
            markdown = '';
            myId = '';
            myFile = '';
            segments = [];
        }
    });
}
