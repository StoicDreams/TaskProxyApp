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
    async function loadProject() {
        myId = location.pathname.substring(1);
        myFile = `pages/${myId}.md`;
        let md = await webui.proxy.getProjectFile(myFile, err => { webui.log.warn('getProjectFile:%o', err); });
        if (!md) {
            md = '';
            await webui.proxy.saveProjectFile(myFile, md);
        }
        setMarkdown(md);
    }
    let topBar = webui.create('webui-flex', { justify: 'right' });
    {
        let btnSave = webui.create('webui-button', { html: 'Save', startIcon: 'star', theme: 'primary' });
        btnSave.addEventListener('click', async _ => {
            if (!myFile) return;
            let md = [];
            comp.querySelectorAll('app-markdown-segment').forEach(segment => {
                if (segment.parentNode !== comp) return;
                md.push(segment.getMarkdown());
            });
            let result = await webui.proxy.saveProjectFile(myFile, md.join('\n\n').trim());
            if (result) {
                webui.alert(result, 'success');
            }
        });
        topBar.appendChild(btnSave);
    }
    let bottomBar = webui.create('webui-flex', { justify: 'right' });
    {
        let btnSave = webui.create('webui-button', { html: 'Save', startIcon: 'star', theme: 'primary' });
        btnSave.addEventListener('click', async _ => {
            if (!myFile) return;
            let md = [];
            segments.forEach(segment => {
                md.push(segment.getMarkdown());
            });
            let result = await webui.proxy.saveProjectFile(myFile, md.join('\n\n').trim());
            if (result) {
                webui.alert(result, 'success');
            }
        });
        bottomBar.appendChild(btnSave);
    }
    function setMarkdown(md) {
        markdown = md;
        comp.innerHTML = '';
        convertMarkdownToSegments(markdown);
        comp.appendChild(topBar);
        segments.forEach(segment => {
            let canStart = false;
            let ismoving = false;
            let mouseisdown = false;
            let offsetX = 0, offsetY = 0;
            let placeholder = webui.create('div', { class: 'placeholder' });
            function onMove(event) {
                if (!mouseisdown) return;
                if (ismoving) {
                    let left = event.clientX - offsetX;
                    let top = event.clientY - offsetY;
                    segment.style.left = `${left}px`;
                    segment.style.top = `${top}px`;
                    let closest = null;
                    let minDistance = Infinity;
                    let aboveOrBelow = null;
                    segments.forEach(el => {
                        if (el === segment) {
                            return;
                        }
                        const rect = el.getBoundingClientRect();
                        const centerY = rect.top + rect.height / 2;
                        const distance = Math.abs(event.clientY - centerY);
                        if (distance < minDistance) {
                            minDistance = distance;
                            closest = el;
                            aboveOrBelow = event.clientY < centerY ? 'above' : 'below';
                        }
                    });
                    if (aboveOrBelow === 'below') {
                        closest.after(placeholder);
                    } else {
                        closest.before(placeholder);
                    }
                    return;
                }
                if (canStart) {
                    ismoving = true;
                    canStart = false;
                    document.body.classList.add('dragging');
                    segment.style.width = `${segment.clientWidth}px`;
                    segment.style.height = `${segment.clientHeight}px`;
                    segment.classList.add('moving');
                    comp.insertBefore(placeholder, segment);
                    comp.insertBefore(segment, placeholder);
                    if (document.getSelection) {
                        document.getSelection().empty();
                    } else if (window.getSelection) {
                        window.getSelection().removeAllRanges();
                    }
                }
            }
            function onRemove(ev) {
                mouseisdown = false;
                placeholder.before(segment);
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onRemove);
                segment.classList.remove('moving');
                segment.style.left = '';
                segment.style.top = '';
                segment.style.width = '';
                segment.style.height = '';
                placeholder.remove();
                ismoving = false;
                canStart = false;
                document.body.classList.remove('dragging');
            }
            comp.appendChild(segment);
            segment.addEventListener('mousedown', ev => {
                if (ev.buttons !== 1 || mouseisdown) return;
                mouseisdown = true;
                let cs = segment.getClientRects()[0];
                offsetX = ev.clientX - cs.x;
                offsetY = ev.clientY - cs.y;
                setTimeout(() => {
                    if (mouseisdown) {
                        canStart = true;
                    }
                }, 200);
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onRemove, { once: true });
            });
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
        disconnected: function (t) { }
    });
}
