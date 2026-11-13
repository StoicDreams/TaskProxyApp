"use strict"
{
    // xterm.js is bundled with the app, so a CDN change can never break the terminal.
    const vendorRoot = '/vendor/xterm';
    const theme = {
        background: '#111111', foreground: '#eeeeee', cursor: '#eeeeee', cursorAccent: '#111111',
        selectionBackground: '#4a5a75',
        black: '#000000', red: '#ff4d4d', green: '#00cc00', yellow: '#e6e600', blue: '#3366ff', magenta: '#cc33ff', cyan: '#00cccc', white: '#e0e0e0',
        brightBlack: '#808080', brightRed: '#ff6666', brightGreen: '#33cc33', brightYellow: '#ffff00', brightBlue: '#668cff', brightMagenta: '#d966ff', brightCyan: '#33ffff', brightWhite: '#ffffff',
    };
    let xtermLoading = null;
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src;
            el.onload = resolve;
            el.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(el);
        });
    }
    /** Loads xterm.js once, however many views are created. */
    function loadXterm() {
        xtermLoading ??= loadScript(`${vendorRoot}/xterm.js`)
            .then(() => loadScript(`${vendorRoot}/addon-fit.js`))
            .then(() => ({ Terminal: window.Terminal, FitAddon: window.FitAddon.FitAddon }))
            .catch(err => {
                xtermLoading = null;
                throw err;
            });
        return xtermLoading;
    }
    const helpers = () => webui.proxy.terminalHelpers;
    webui.define("app-terminal-view", {
        linkCss: false,
        watchVisibility: false,
        isInput: false,
        preload: '',
        constructor() {
            const t = this;
            t._host = t.template.querySelector('.terminal-host');
            t._placeholder = t.template.querySelector('.placeholder');
            t._onData = ev => {
                const data = ev.detail;
                if (!t._term || data.terminalId !== t._terminalId || data.projectId !== (t._projectId ?? webui.projectData?.id)) return;
                t._term.write(data.data);
                t.showPlaceholder(false);
            };
        },
        connected() {
            const t = this;
            document.addEventListener('term-data', t._onData);
            t._ready ??= t.setup();
        },
        disconnected() {
            const t = this;
            document.removeEventListener('term-data', t._onData);
            t._resizeObserver?.disconnect();
            t._resizeObserver = null;
            t._term?.dispose();
            t._term = null;
            t._ready = null;
            t._terminalId = null;
        },
        async setup() {
            const t = this;
            let xterm;
            try {
                xterm = await loadXterm();
            } catch (err) {
                t._placeholder.textContent = `The terminal could not be loaded: ${err.message || err}`;
                t.showPlaceholder(true);
                return;
            }
            if (!t.isConnected) return;
            const term = new xterm.Terminal({
                theme,
                fontFamily: 'ui-monospace, "Cascadia Mono", "DejaVu Sans Mono", Consolas, monospace',
                fontSize: 13,
                scrollback: 10000,
                cursorBlink: true,
                allowProposedApi: false,
            });
            const fit = new xterm.FitAddon();
            term.loadAddon(fit);
            term.open(t._host);
            t._term = term;
            t._fit = fit;
            // With text selected, Ctrl+C copies it. Otherwise it reaches the script, as in a terminal.
            term.attachCustomKeyEventHandler(ev => {
                const isCopy = (ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 'c';
                if (ev.type === 'keydown' && isCopy && term.hasSelection()) {
                    navigator.clipboard?.writeText(term.getSelection()).catch(() => { });
                    return false;
                }
                return true;
            });
            term.onData(data => t.sendInput(data));
            t._resizeObserver = new ResizeObserver(() => t.fitToView());
            t._resizeObserver.observe(t._host);
            t.fitToView();
            if (t._pendingId !== undefined) {
                const id = t._pendingId;
                t._pendingId = undefined;
                t.attach(id, true, t._pendingProject);
            }
        },
        /** Fits the terminal to its space, and tells a running script its new size. */
        fitToView() {
            const t = this;
            if (!t._term || !t._host.clientWidth || !t._host.clientHeight) return;
            try {
                t._fit.fit();
            } catch (_) {
                return;
            }
            const size = { cols: t._term.cols, rows: t._term.rows };
            helpers().setViewSize(size);
            if (t._lastSize && t._lastSize.cols === size.cols && t._lastSize.rows === size.rows) return;
            t._lastSize = size;
            t.reportSize();
        },
        reportSize() {
            const t = this;
            const current = t.current();
            if (!t._lastSize || !current || current.status !== 'Running' || !current.interactive) return;
            webui.proxy.terminal.resize(current.id, t._lastSize.cols, t._lastSize.rows, helpers().otherProject(t._projectId)).catch(() => { });
        },
        current() {
            const t = this;
            if (!t._terminalId) return null;
            return helpers().getState(t._projectId).terminals[t._terminalId] || null;
        },
        /** Typed keys only reach a script that is running in a terminal. */
        sendInput(data) {
            const t = this;
            // Replayed output can ask the terminal questions, such as where the cursor is, and its answers
            // to those old questions must not be typed into the script.
            if (t._replaying) return;
            const current = t.current();
            if (!current || current.status !== 'Running' || !current.interactive) return;
            webui.proxy.terminal.write(current.id, data, helpers().otherProject(t._projectId)).catch(() => { });
        },
        /**
         * Shows a terminal's output. Its kept output is replayed when the terminal changes, or when `force`
         * is set, such as after its output is cleared. `projectId` names another project's terminal, as the
         * Terminal Manager's All Running list shows them.
         */
        async attach(id, force, projectId) {
            const t = this;
            projectId = helpers().otherProject(projectId);
            if (!t._term) {
                t._pendingId = id;
                t._pendingProject = projectId;
                return;
            }
            if (id === t._terminalId && projectId === t._projectId && !force) {
                t.reportSize();
                return;
            }
            t._terminalId = id;
            t._projectId = projectId;
            const current = t.current();
            t._term.reset();
            const output = current ? current.output.join('') : '';
            if (output) {
                const replay = t._replay = {};
                t._replaying = true;
                t._term.write(output, () => {
                    if (t._replay === replay) t._replaying = false;
                });
            } else {
                t._replaying = false;
            }
            t.showPlaceholder(!output);
            t.reportSize();
        },
        showPlaceholder(show) {
            this._placeholder.hidden = !show;
        },
        focusTerminal() {
            this._term?.focus();
        },
        /** Selects all output, scrollback included, and returns it. The terminal keeps focus, so Ctrl+C copies it again. */
        selectAll() {
            const t = this;
            if (!t._term) return '';
            t._term.selectAll();
            t._term.focus();
            return t._term.getSelection();
        },
        /** The selected text, for tests. */
        getSelectedText() {
            return this._term?.getSelection() ?? '';
        },
        /** The text on screen, for tests and copying. */
        getScreenText() {
            const t = this;
            if (!t._term) return '';
            const buffer = t._term.buffer.active;
            const lines = [];
            for (let i = 0; i < buffer.length; i++) {
                lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
            }
            while (lines.length && lines[lines.length - 1] === '') lines.pop();
            return lines.join('\n');
        },
        shadowTemplate: `
<link rel="stylesheet" href="${vendorRoot}/xterm.css" />
<style type="text/css">
:host {
    display: block;
    position: relative;
    height: 100%;
    width: 100%;
    min-height: 140px;
}
.frame {
    position: absolute;
    inset: 0;
    padding: 0.4rem;
    background: ${theme.background};
    border: 1px solid var(--site-background-offset, #444);
    border-radius: 4px;
    box-sizing: border-box;
}
.terminal-host {
    width: 100%;
    height: 100%;
}
.placeholder {
    position: absolute;
    top: 0.6rem;
    left: 0.8rem;
    color: #888;
    font-style: italic;
    pointer-events: none;
}
.placeholder[hidden] {
    display: none;
}
</style>
<div class="frame">
    <div class="terminal-host"></div>
    <div class="placeholder">No terminal output.</div>
</div>
`
    });
}
