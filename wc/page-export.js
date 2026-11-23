"use strict"
{
    /**
     * The page's Export menu (wc/page-handler.js): saves or copies the page as a PDF, a web page, Markdown, its own Web UI
     * Markdown, or plain text. Each is built here from the page's markdown. Saving goes through the desktop's save dialog
     * (services/page_export.rs), so the window never chooses a path.
     *
     * The page's {VARIABLE} placeholders are exported as written, never filled in, so no value, secret or not, leaves
     * in a file.
     */
    const FORMATS = [
        { id: 'pdf', name: 'PDF', icon: 'pdf', about: 'a PDF document, to print or send', copy: 'Copy the PDF as a file, to paste into a folder, an email, or a chat.' },
        { id: 'html', name: 'HTML', icon: 'code', about: 'a web page that opens in any browser', copy: 'Copy it formatted, to paste into a document or an email. Pasted where only text goes, it is the HTML.' },
        { id: 'md', name: 'Markdown', icon: 'file', about: 'Markdown any editor reads, without Task Proxy\'s components', copy: 'Copy it as Markdown, without Task Proxy\'s components.' },
        { id: 'webui', name: 'Web UI Markdown', icon: 'file', about: 'this page\'s file as it is saved, with its components, for another project or a Web UI site', copy: 'Copy this page\'s file as it is saved, with its components.' },
        { id: 'txt', name: 'Plain Text', icon: 'clipboard-list', about: 'just the text', copy: 'Copy just the text, for an email or a chat.' },
    ];
    /** What each format saves as: services/page_export.rs's kind. */
    const KINDS = { pdf: 'pdf', html: 'html', md: 'md', webui: 'md', txt: 'txt' };
    const OPTIONS = [
        { id: '', value: '', display: 'Export', icon: 'share-from-square', title: 'Save or copy this page as a PDF, a web page, Markdown, or text' },
        ...FORMATS.flatMap(format => [
            { id: `save:${format.id}`, value: `save:${format.id}`, display: `Save ${format.name}`, icon: format.icon, title: `Save as a file: ${format.about}.` },
            { id: `copy:${format.id}`, value: `copy:${format.id}`, display: `Copy ${format.name}`, icon: format.icon, title: format.copy },
        ]),
    ];
    const COMPONENT_TAG = /<\/?(?:webui|app)-[a-z0-9-]*\b[^>]*>/gi;
    const FENCE = /^\s*(```+|~~~+)/;

    /**
     * The page as Markdown any editor reads: its page data left out, segments unwrapped, line breaks as rules, code
     * written as a component as a fenced block, and every other component's tags removed, keeping what is inside them.
     * Fenced code is left as it is.
     */
    function plainMarkdown(markdown) {
        const md = `${markdown || ''}`.replace(/\r\n?/g, '\n').replace(/^\s*<webui-data\b[\s\S]*?<\/webui-data>\s*/i, '');
        const out = [];
        let fence = null;
        let inCode = false;
        for (const line of md.split('\n')) {
            const opens = line.match(FENCE);
            if (fence) {
                out.push(line);
                if (opens && opens[1][0] === fence[0] && opens[1].length >= fence.length && !line.trim().substring(opens[1].length).trim()) fence = null;
                continue;
            }
            if (inCode) {
                const end = line.search(/<\/webui-code>/i);
                if (end < 0) {
                    out.push(line);
                    continue;
                }
                if (line.substring(0, end).trim()) out.push(line.substring(0, end));
                out.push('```');
                inCode = false;
                continue;
            }
            if (opens) {
                fence = opens[1];
                out.push(line);
                continue;
            }
            const trimmed = line.trim();
            if (/^<webui-line\b[^>]*>\s*<\/webui-line>$/i.test(trimmed)) {
                out.push('', '---', '');
                continue;
            }
            const code = trimmed.match(/^<webui-code\b([^>]*)>(.*)$/i);
            if (code) {
                const language = (code[1].match(/\b(?:language|lang)="([^"]*)"/i) || [])[1] || '';
                out.push(`\`\`\`${language}`);
                const rest = code[2];
                const end = rest.search(/<\/webui-code>/i);
                if (end < 0) {
                    if (rest.trim()) out.push(rest);
                    inCode = true;
                } else {
                    if (rest.substring(0, end).trim()) out.push(rest.substring(0, end));
                    out.push('```');
                }
                continue;
            }
            const stripped = line.replace(COMPONENT_TAG, '');
            out.push(stripped !== line && !stripped.trim() ? '' : stripped);
        }
        if (inCode) out.push('```');
        return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    /** The page's content as plain HTML, in a template so nothing in it runs or loads: components become plain elements. */
    function plainBody(markdown) {
        const parsed = webui.markdown?.parse ? webui.markdown.parse(plainMarkdown(markdown)) : '';
        const template = document.createElement('template');
        template.innerHTML = sanitizeProjectHtml(`${parsed || ''}`);
        const body = template.content;
        body.querySelectorAll('*').forEach(el => {
            if (!el.isConnected && !body.contains(el)) return;
            const name = el.localName;
            const replace = tag => {
                const next = document.createElement(tag);
                next.append(...el.childNodes);
                el.replaceWith(next);
                return next;
            };
            if (name === 'webui-code') {
                const pre = document.createElement('pre');
                const code = document.createElement('code');
                const language = el.getAttribute('language') || el.getAttribute('lang');
                if (language) code.className = `language-${language}`;
                code.textContent = el.textContent.replace(/^\n/, '').replace(/\n$/, '');
                pre.appendChild(code);
                el.replaceWith(pre);
            } else if (name === 'webui-quote') {
                replace('blockquote');
            } else if (name === 'webui-line') {
                el.replaceWith(document.createElement('hr'));
            } else if (name.startsWith('webui-') || name.startsWith('app-')) {
                el.replaceWith(...el.childNodes);
            }
        });
        body.querySelectorAll('[theme]').forEach(el => el.removeAttribute('theme'));
        body.querySelectorAll('.text-justify').forEach(el => el.classList.remove('text-justify'));
        body.querySelectorAll('[class=""]').forEach(el => el.removeAttribute('class'));
        return body;
    }

    const STYLE = `body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5;color:#1d1d1f;max-width:50rem;margin:2rem auto;padding:0 1rem}
pre{background:#f4f4f5;padding:.75rem 1rem;overflow:auto;border-radius:4px}code{font-family:ui-monospace,Consolas,monospace}
table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:.25rem .5rem}blockquote{border-left:4px solid #ccc;margin-left:0;padding-left:1rem;color:#555}
img{max-width:100%}.subtitle{color:#555;margin-top:-.5rem}`;

    /** The page as a web page on its own. */
    function htmlDocument({ title, subtitle, markdown }) {
        const holder = document.createElement('div');
        holder.appendChild(plainBody(markdown));
        const header = title ? `<header>\n<h1>${webui.escapeForHTML(title)}</h1>\n${subtitle ? `<p class="subtitle">${webui.escapeForHTML(subtitle)}</p>\n` : ''}</header>\n` : '';
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${webui.escapeForHTML(title || 'Page')}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
${header}${holder.innerHTML.trim()}
</main>
</body>
</html>
`;
    }

    /** The page's Markdown, with its title above it. */
    function markdownDocument({ title, subtitle, markdown }) {
        const head = title ? `# ${title}\n\n${subtitle ? `${subtitle}\n\n` : ''}` : '';
        return `${head}${plainMarkdown(markdown)}\n`;
    }

    const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'pre', 'blockquote', 'table', 'hr', 'div', 'section', 'header', 'main', 'figure', 'details', 'summary']);
    /** An element's text on one line, as read: links keep their address, images their description. */
    function inlineText(node) {
        let text = '';
        node.childNodes.forEach(child => {
            if (child.nodeType === Node.TEXT_NODE) text += child.textContent.replace(/\s+/g, ' ');
            else if (child.nodeType !== Node.ELEMENT_NODE) return;
            else if (child.localName === 'br') text += '\n';
            else if (child.localName === 'img') text += child.getAttribute('alt') ? `[${child.getAttribute('alt')}]` : '';
            else if (child.localName === 'a') {
                const label = inlineText(child).trim();
                const href = child.getAttribute('href') || '';
                text += href && href !== label && /^https?:/i.test(href) ? `${label} (${href})` : label;
            } else text += inlineText(child);
        });
        return text;
    }
    /** The lines of plain text for a list of nodes, as blocks separated by blank lines. */
    function textBlocks(nodes, indent = '') {
        const blocks = [];
        let inline = document.createElement('span');
        const flushInline = () => {
            const text = inlineText(inline).trim();
            if (text) blocks.push(text.split('\n').map(line => `${indent}${line.trim()}`).join('\n'));
            inline = document.createElement('span');
        };
        nodes.forEach(node => {
            const name = node.nodeType === Node.ELEMENT_NODE ? node.localName : '';
            if (!BLOCKS.has(name)) {
                inline.appendChild(node.cloneNode(true));
                return;
            }
            flushInline();
            if (/^h[1-6]$|^p$|^summary$/.test(name)) {
                const text = inlineText(node).trim();
                if (text) blocks.push(text.split('\n').map(line => `${indent}${line.trim()}`).join('\n'));
            } else if (name === 'ul' || name === 'ol') {
                const items = [...node.children].filter(item => item.localName === 'li').map((item, index) => {
                    const marker = name === 'ol' ? `${index + 1}. ` : '- ';
                    const inner = textBlocks([...item.childNodes], `${indent}${' '.repeat(marker.length)}`).join('\n');
                    return `${indent}${marker}${inner.trimStart()}`;
                });
                if (items.length) blocks.push(items.join('\n'));
            } else if (name === 'pre') {
                blocks.push(node.textContent.replace(/\n$/, '').split('\n').map(line => `${indent}${line}`).join('\n'));
            } else if (name === 'blockquote') {
                const inner = textBlocks([...node.childNodes]).join('\n\n');
                if (inner) blocks.push(inner.split('\n').map(line => `${indent}> ${line}`.trimEnd()).join('\n'));
            } else if (name === 'table') {
                const rows = [...node.querySelectorAll('tr')].map(row => [...row.children].map(cell => inlineText(cell).trim()).join('\t'));
                if (rows.length) blocks.push(rows.map(row => `${indent}${row}`).join('\n'));
            } else if (name === 'hr') {
                blocks.push(`${indent}----------`);
            } else {
                blocks.push(...textBlocks([...node.childNodes], indent));
            }
        });
        flushInline();
        return blocks;
    }
    /** The page as plain text, with its title above it. */
    function textDocument({ title, subtitle, markdown }) {
        const head = [title, subtitle].filter(Boolean);
        return `${[...(head.length ? [head.join('\n')] : []), ...textBlocks([...plainBody(markdown).childNodes])].join('\n\n')}\n`;
    }

    /** Text runs for pdfmake, keeping bold, italics, inline code, and links. */
    function pdfInline(node, style = {}) {
        const runs = [];
        node.childNodes.forEach(child => {
            if (child.nodeType === Node.TEXT_NODE) {
                const text = child.textContent.replace(/\s+/g, ' ');
                if (text) runs.push({ text, ...style });
                return;
            }
            if (child.nodeType !== Node.ELEMENT_NODE) return;
            const name = child.localName;
            if (name === 'br') runs.push({ text: '\n', ...style });
            else if (name === 'img') {
                if (child.getAttribute('alt')) runs.push({ text: `[${child.getAttribute('alt')}]`, italics: true, ...style });
            } else if (name === 'strong' || name === 'b') runs.push(...pdfInline(child, { ...style, bold: true }));
            else if (name === 'em' || name === 'i') runs.push(...pdfInline(child, { ...style, italics: true }));
            else if (name === 'code') runs.push(...pdfInline(child, { ...style, background: '#eeeeee' }));
            else if (name === 'a' && /^https?:/i.test(child.getAttribute('href') || '')) runs.push(...pdfInline(child, { ...style, link: child.getAttribute('href'), color: '#1a5fb4', decoration: 'underline' }));
            else runs.push(...pdfInline(child, style));
        });
        return runs;
    }
    /** pdfmake content for a list of nodes. */
    function pdfBlocks(nodes) {
        const content = [];
        let inline = document.createElement('span');
        const flushInline = () => {
            const runs = pdfInline(inline);
            if (runs.some(run => run.text.trim())) content.push({ text: runs, style: 'p' });
            inline = document.createElement('span');
        };
        nodes.forEach(node => {
            const name = node.nodeType === Node.ELEMENT_NODE ? node.localName : '';
            if (!BLOCKS.has(name)) {
                inline.appendChild(node.cloneNode(true));
                return;
            }
            flushInline();
            if (/^h[1-6]$/.test(name)) content.push({ text: pdfInline(node), style: name });
            else if (name === 'p' || name === 'summary') content.push({ text: pdfInline(node), style: 'p' });
            else if (name === 'ul' || name === 'ol') {
                const items = [...node.children].filter(item => item.localName === 'li').map(item => {
                    const parts = pdfBlocks([...item.childNodes]).map(part => ({ ...part, style: part.style === 'p' ? undefined : part.style }));
                    return parts.length === 1 ? parts[0] : { stack: parts };
                });
                if (items.length) content.push({ [name]: items, style: 'list' });
            } else if (name === 'pre') content.push({ text: node.textContent.replace(/\n$/, ''), style: 'code' });
            else if (name === 'blockquote') content.push({ stack: pdfBlocks([...node.childNodes]), style: 'quote' });
            else if (name === 'table') {
                const rows = [...node.querySelectorAll('tr')].map(row => [...row.children].map(cell => ({ text: pdfInline(cell), bold: cell.localName === 'th' })));
                const columns = Math.max(0, ...rows.map(row => row.length));
                rows.forEach(row => { while (row.length < columns) row.push(''); });
                if (columns) content.push({ table: { headerRows: node.querySelector('thead') ? 1 : 0, body: rows }, layout: 'lightHorizontalLines', style: 'table' });
            } else if (name === 'hr') content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#999999' }], margin: [0, 6, 0, 10] });
            else content.push(...pdfBlocks([...node.childNodes]));
        });
        flushInline();
        return content;
    }
    let pdfMakeLoading = null;
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src;
            el.onload = resolve;
            el.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(el);
        });
    }
    /** pdfmake and its fonts, bundled with the app (root_files/vendor/pdfmake), loaded the first time a PDF is made. */
    function loadPdfMake() {
        pdfMakeLoading ??= loadScript('/vendor/pdfmake/pdfmake.min.js')
            .then(() => loadScript('/vendor/pdfmake/vfs_fonts.js'))
            .then(() => window.pdfMake)
            .catch(err => {
                pdfMakeLoading = null;
                throw err;
            });
        return pdfMakeLoading;
    }
    /** The page as a PDF's bytes. */
    async function pdfDocument({ title, subtitle, markdown }) {
        const pdfMake = await loadPdfMake();
        const head = title ? [{ text: title, style: 'title' }, ...(subtitle ? [{ text: subtitle, style: 'subtitle' }] : [])] : [];
        const definition = {
            info: { title: title || 'Page', creator: 'Task Proxy' },
            pageMargins: [40, 48, 40, 48],
            content: [...head, ...pdfBlocks([...plainBody(markdown).childNodes])],
            defaultStyle: { fontSize: 10.5, lineHeight: 1.2 },
            styles: {
                title: { fontSize: 22, bold: true, margin: [0, 0, 0, 4] },
                subtitle: { fontSize: 12, color: '#555555', margin: [0, 0, 0, 14] },
                h1: { fontSize: 18, bold: true, margin: [0, 14, 0, 6] },
                h2: { fontSize: 15, bold: true, margin: [0, 12, 0, 5] },
                h3: { fontSize: 13, bold: true, margin: [0, 10, 0, 4] },
                h4: { fontSize: 11.5, bold: true, margin: [0, 8, 0, 4] },
                h5: { fontSize: 10.5, bold: true, margin: [0, 8, 0, 4] },
                h6: { fontSize: 10.5, bold: true, italics: true, margin: [0, 8, 0, 4] },
                p: { margin: [0, 0, 0, 8] },
                list: { margin: [0, 0, 0, 8] },
                code: { fontSize: 9, background: '#f4f4f5', margin: [0, 0, 0, 8], preserveLeadingSpaces: true },
                quote: { color: '#555555', italics: true, margin: [14, 0, 0, 8] },
                table: { margin: [0, 0, 0, 10] },
            },
        };
        const buffer = await pdfMake.createPdf(definition).getBuffer();
        return new Uint8Array(buffer);
    }

    const encode = text => new TextEncoder().encode(text);
    webui.define('app-page-export', {
        preload: 'select',
        constructor() {
            const t = this;
            t._select = webui.create('webui-select', { class: 'page-export-select', title: 'Export this page', 'item-size': '9em', options: JSON.stringify(OPTIONS), value: '' });
            t._select.addEventListener('change', () => t.choose(t._select.value));
        },
        connected() {
            const t = this;
            if (t._select.parentNode !== t) t.appendChild(t._select);
        },
        /**
         * Exports the page as chosen, from `source`, a function the page sets that gives `{ title, subtitle, markdown,
         * file }`: its markdown as shown, unsaved changes and all, and `file`, an async function for its file as saved,
         * which Web UI Markdown exports. `choice` is `save:<format>` or `copy:<format>`, and Export shows again.
         */
        async choose(choice) {
            const t = this;
            if (!choice) return;
            t._select.setValue('');
            const [action, format] = `${choice}`.split(':');
            if (!FORMATS.some(known => known.id === format) || typeof t.source !== 'function') return;
            clearActionNote(t);
            const failed = err => {
                actionNote(t, `The page couldn't be exported: ${err}`, 'danger');
                return undefined;
            };
            const page = await t.source();
            if (!page) return;
            const name = FORMATS.find(known => known.id === format).name;
            let body;
            try {
                if (format === 'webui') {
                    body = await page.file(failed);
                    if (typeof body !== 'string') return;
                } else if (format === 'pdf') body = await pdfDocument(page);
                else if (format === 'html') body = htmlDocument(page);
                else if (format === 'md') body = markdownDocument(page);
                else body = textDocument(page);
            } catch (err) {
                failed(err?.message || err);
                return;
            }
            if (action === 'save') {
                const bytes = typeof body === 'string' ? encode(body) : body;
                const saved = await webui.proxy.exportSave(bytes, page.title, KINDS[format], failed);
                if (saved) actionNote(t, `Saved the page as ${saved}.`, 'success');
                return;
            }
            let copied;
            if (format === 'pdf') copied = await webui.proxy.exportCopyFile(body, page.title, 'pdf', failed);
            else if (format === 'html') copied = await webui.proxy.copyHtml(body, body, failed);
            else copied = await webui.proxy.copyText(body, failed);
            if (copied) actionNote(t, format === 'pdf' ? 'Copied the page as a PDF file, to paste where files go.' : `Copied the page as ${name}.`, 'success');
        },
    });
}
