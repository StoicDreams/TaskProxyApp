"use strict"
{
    webui.define("app-console-powershell", {
        constructor() {
            const t = this;
            t._console = t.template.querySelector('.console-container');
            t._currentState = { fg: null, bg: null, bold: false };
        },
        connected() {
        },
        clear() {
            const t = this;
            t._console.innerHTML = '';
            t._currentState = { fg: null, bg: null, bold: false };
        },
        showPlaceholder() {
            const t = this;
            t.clear();
            const placeholder = webui.create('div');
            placeholder.style.color = 'var(--site-background-offset, #888)';
            placeholder.style.fontStyle = 'italic';
            placeholder.classList.add('placeholder');
            placeholder.textContent = 'No terminal output.';
            t._console.appendChild(placeholder);
        },
        appendLine(text, isError) {
            const t = this;
            if (t._console.firstChild && t._console.firstChild.classList.contains('placeholder')) {
                t._console.innerHTML = '';
            }

            // Handle Clear-Host / clear screen ANSI escape sequences
            if (text.includes('\x1B[2J') || text.includes('\x1B[3J')) {
                t.clear();
                // Strip the clear codes from the text string so they don't render empty spans
                text = text.replace(/\x1B\[[23]J/g, '').replace(/\x1B\[H/g, '');
            }

            let html = '';
            if (isError) {
                // Strip formatting from errors and strictly color them red
                html = `<span style="color: var(--color-danger, #ff4d4d);">${t.escapeHtml(text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''))}</span>`;
            } else {
                html = t.ansiToHtml(text);
            }

            const line = webui.create('div');
            line.innerHTML = html || ' '; // Ensure empty lines still take up vertical space
            t._console.appendChild(line);
            t._console.scrollTop = t._console.scrollHeight;
        },
        escapeHtml(str) {
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
        ansiToHtml(text) {
            const t = this;
            let html = '';
            let lastIndex = 0;
            const regex = /\x1B\[([0-9;]*)([a-zA-Z])/g;
            let match;

            while ((match = regex.exec(text)) !== null) {
                if (match.index > lastIndex) {
                    html += t.wrapText(text.substring(lastIndex, match.index));
                }

                const codes = match[1] ? match[1].split(';') : ['0'];
                const command = match[2];

                if (command === 'm') {
                    codes.forEach(code => {
                        const c = parseInt(code, 10);
                        if (isNaN(c) || c === 0) {
                            t._currentState.fg = null;
                            t._currentState.bg = null;
                            t._currentState.bold = false;
                        } else if (c === 1) {
                            t._currentState.bold = true;
                        } else if (c >= 30 && c <= 37) {
                            t._currentState.fg = t.getAnsiColor(c);
                        } else if (c >= 90 && c <= 97) {
                            t._currentState.fg = t.getAnsiColor(c);
                        } else if (c === 39) {
                            t._currentState.fg = null;
                        } else if (c >= 40 && c <= 47) {
                            t._currentState.bg = t.getAnsiColor(c - 10);
                        } else if (c >= 100 && c <= 107) {
                            t._currentState.bg = t.getAnsiColor(c - 60);
                        } else if (c === 49) {
                            t._currentState.bg = null;
                        }
                    });
                }
                lastIndex = regex.lastIndex;
            }

            if (lastIndex < text.length) {
                html += t.wrapText(text.substring(lastIndex));
            }

            return html;
        },
        getAnsiColor(code) {
            // Colors mapped to readable terminal equivalents
            const colors = {
                30: '#000000', 31: '#ff4d4d', 32: '#00cc00', 33: '#e6e600', 34: '#3366ff', 35: '#cc33ff', 36: '#00cccc', 37: '#e0e0e0',
                90: '#808080', 91: '#ff6666', 92: '#33cc33', 93: '#ffff00', 94: '#668cff', 95: '#d966ff', 96: '#33ffff', 97: '#ffffff'
            };
            return colors[code] || null;
        },
        wrapText(text) {
            const t = this;
            if (!text) return '';
            let escaped = t.escapeHtml(text);
            let style = '';
            if (t._currentState.fg) style += `color: ${t._currentState.fg};`;
            if (t._currentState.bg) style += `background-color: ${t._currentState.bg};`;
            if (t._currentState.bold) style += `font-weight: bold;`;

            if (style) {
                return `<span style="${style}">${escaped}</span>`;
            }
            return escaped;
        },
        shadowTemplate: `
        <style type="text/css">
        :host {
            display: block;
            height: 100%;
            width: 100%;
        }
        .console-container {
            flex: 1;
            background: #111;
            color: #eee;
            padding: 0.5rem;
            border-radius: 4px;
            overflow-y: auto;
            font-family: monospace;
            border: 1px solid var(--site-background-offset, #444);
            min-height: 140px;
            height: 100%;
            box-sizing: border-box;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        </style>
        <div class="console-container"><div class="placeholder" style="color: #888; font-style: italic;">No terminal output.</div></div>
        `
    });
}
