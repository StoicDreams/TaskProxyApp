"use strict"
{
    const SEGMENT = 'segment';
    const LINE_BREAK = 'line break';
    const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
    const TYPES = [SEGMENT, ...HEADINGS, LINE_BREAK];
    const SEGMENT_OPEN = '<webui-page-segment>';
    const SEGMENT_CLOSE = '</webui-page-segment>';
    const LINE_BREAK_MARKDOWN = '<webui-line></webui-line>';
    /**
     * Works out a segment's type and text from its markdown. `exact` is true when the markdown is
     * already in that type's form, so it can be kept as written until the text or type changes.
     */
    function parseSegment(markdown) {
        const trimmed = (markdown || '').trim();
        if (/^<webui-line\s*>\s*<\/webui-line>$/i.test(trimmed)) {
            return { type: LINE_BREAK, text: '', exact: true };
        }
        // A heading is one line. Text such as #hashtag, with no space, is not a heading.
        const heading = trimmed.match(/^(#{1,6})[ \t]+(.*)$/);
        if (heading && !trimmed.includes('\n')) {
            return { type: HEADINGS[heading[1].length - 1], text: heading[2].trim(), exact: true };
        }
        const segment = trimmed.match(/^(<webui-page-segment\b[^>]*>)([\s\S]*)<\/webui-page-segment>$/i);
        if (segment && !/<\/?webui-page-segment\b/i.test(segment[2])) {
            return { type: SEGMENT, open: segment[1], text: segment[2].trim(), exact: true };
        }
        // Anything else is content that belongs inside a page segment.
        return { type: SEGMENT, text: trimmed, exact: false };
    }
    function isHeading(type) {
        return HEADINGS.includes(type);
    }
    webui.define("app-markdown-segment", {
        linkCss: true,
        preload: 'switch button flex input-text input-message content',
        constructor() {
            const t = this;
            t._content = t.template.querySelector('webui-content');
            t._btnEdit = t.template.querySelector('#btn-edit');
            t._btnUndo = t.template.querySelector('#btn-undo');
            t._btnDelete = t.template.querySelector('#btn-delete');
            t._inputMessage = t.template.querySelector('webui-input-message');
            t._inputText = t.template.querySelector('webui-input-text');
            t._type = t.template.querySelector('webui-switch');
            t._inputOptions = t.template.querySelector('.input-options');
            t._isEditing = false;
            t._parsed = parseSegment('');
            t._segmentType = SEGMENT;
            t._inputValue = '';
        },
        /** The markdown for the type and text in the editor. */
        buildFinalMarkdown() {
            const t = this;
            const type = t._segmentType;
            if (type === LINE_BREAK) return LINE_BREAK_MARKDOWN;
            const text = isHeading(type) ? t._inputText.value : t._inputMessage.value;
            t._inputValue = text;
            // Unchanged markdown keeps how it was written, such as its spacing and attributes.
            if (t._parsed.exact && type === t._parsed.type && text === t._parsed.text) {
                return t._markdown.trim();
            }
            if (isHeading(type)) {
                return `${'#'.repeat(HEADINGS.indexOf(type) + 1)} ${text.replace(/\s*\n\s*/g, ' ').trim()}`;
            }
            const open = t._parsed.type === SEGMENT && t._parsed.open ? t._parsed.open : SEGMENT_OPEN;
            return `${open}\n\n${text.trim()}\n\n${SEGMENT_CLOSE}`;
        },
        connected() {
            const t = this;
            if (t._skipReconnect) {
                return;
            }
            // The switch can still be loading, even though it is preloaded, so wait for it before using it.
            if (typeof t._type.setOptions !== 'function') {
                customElements.whenDefined('webui-switch').then(() => {
                    customElements.upgrade(t._type);
                    if (t.isConnected) t.connected();
                });
                return;
            }
            t._type.setOptions(TYPES);
            t.setMarkdown(t.dataset.markdown || '');
            const liveUpdate = () => {
                if (!t._isEditing) return;
                t._content.setHtml(sanitizeProjectHtml(webui.applyAppDataToContent(t.buildFinalMarkdown())));
            };
            t._inputMessage.addEventListener('input', liveUpdate);
            t._inputText.addEventListener('input', liveUpdate);
            t._btnEdit.addEventListener('click', _ => {
                t._isEditing = !t._isEditing;
                if (t._isEditing) {
                    t._originalMarkdown = t.getMarkdown();
                    t.classList.add('isEditing');
                } else {
                    t.classList.remove('isEditing');
                    t.setMarkdown(t.buildFinalMarkdown());
                }
            });
            t._btnUndo.addEventListener('click', _ => {
                if (!t._isEditing) return;
                t._isEditing = false;
                t.classList.remove('isEditing');
                t.setMarkdown(t._originalMarkdown);
            });
            t._btnDelete.addEventListener('click', _ => {
                // The page leaves this segment out from now on. Leaving the page without saving brings it back.
                t.dispatchEvent(new CustomEvent('segment-delete', { bubbles: true }));
                t.remove();
            });
            t._type.addEventListener('change', _ => {
                const type = t._type.value;
                if (type === t._segmentType) return;
                // The text carries over, so changing the type never loses what was typed.
                t._inputValue = isHeading(t._segmentType) ? t._inputText.value : (t._segmentType === LINE_BREAK ? t._inputValue : t._inputMessage.value);
                t.setSegmentType(type);
                liveUpdate();
            });
        },
        disconnected() {
            const t = this;
            t._skipReconnect = true;
        },
        /** Shows the input for a type, filled with the current text. */
        setSegmentType(type) {
            const t = this;
            t._segmentType = TYPES.includes(type) ? type : SEGMENT;
            if (t._type.value !== t._segmentType) t._type.setValue(t._segmentType);
            t._inputOptions.classList.remove('it-single', 'it-multi');
            if (isHeading(t._segmentType)) {
                const text = t._inputValue.replace(/\s*\n\s*/g, ' ').trim();
                if (t._inputText.value !== text) t._inputText.value = text;
                t._inputOptions.classList.add('it-single');
            } else if (t._segmentType === SEGMENT) {
                if (t._inputMessage.value !== t._inputValue) t._inputMessage.value = t._inputValue;
                t._inputOptions.classList.add('it-multi');
            }
        },
        setMarkdown(markdown) {
            const t = this;
            t._markdown = markdown || '';
            t._parsed = parseSegment(t._markdown);
            t._inputValue = t._parsed.text;
            t.setSegmentType(t._parsed.type);
            t.render();
        },
        /** The type shown in the editor: segment, h1 to h6, or line break. */
        getSegmentType() {
            return this._segmentType;
        },
        getMarkdown() {
            const t = this;
            if (t._isEditing) {
                return t.buildFinalMarkdown();
            }
            // Before it connects, which waits for its components to load, a segment still has the markdown it was made with.
            return t._markdown ?? t.dataset.markdown ?? '';
        },
        async render() {
            const t = this;
            await customElements.whenDefined('webui-content');
            t._content.setHtml(sanitizeProjectHtml(webui.applyAppDataToContent(t._markdown)));
        },
        shadowTemplate: `
<style type="text/css">
:host {
display: flex;
align-items: stretch;
position: relative;
width: 100%;
}
.tools {
display: flex;
flex-direction: column;
gap: 4px;
flex: 0 0 36px;
margin-right: var(--padding);
}
.tools webui-button {
flex-grow: 1;
min-height: 36px;
}
#btn-undo { display: none; }
:host(.isEditing) #btn-undo { display: inline-flex; }
:host div.content {
position: relative;
display: grid;
grid-template-columns: 1fr;
flex: 1 1 0%;
min-width: 0;
}
:host(.isEditing) div.content {
grid-template-columns: 1fr 1fr;
gap: var(--padding);
}
:host div.input {
display: flex;
flex-direction: column;
align-items: stretch;
gap: var(--padding);
position: relative;
width: 100%;
min-height: 100%;
z-index: 1;
top: 0;
left: 0;
}
:host(:not(.isEditing)) div.input {
display: none;
}
.input-options {
display: flex;
flex-direction: column;
flex-grow: 1;
}
.input-options > webui-input-text,
.input-options > webui-input-message {
flex-grow: 1;
}
.input-options:not(.it-single) > webui-input-text,
.input-options:not(.it-multi) > webui-input-message {
display: none;
}
</style>
<div class="tools">
<webui-button id="btn-edit" class="drag-handle" title="Edit segment. Drag, or press Alt+Up or Alt+Down, to move it" start-icon="pencil" theme="info"></webui-button>
<webui-button id="btn-undo" title="Revert changes & close" start-icon="circle_arrow|rotate:180|bordered|inverted|theme:warning" theme="warning"></webui-button>
</div>
<div class="content">
<div class="input">
<webui-flex align="center" gap="var(--padding)">
<webui-switch label="Segment type"></webui-switch>
<webui-flex grow></webui-flex>
<webui-button id="btn-delete" theme="danger" start-icon="trash-can" label="Delete" title="Delete this segment"></webui-button>
</webui-flex>
<div class="input-options">
<webui-input-text aria-label="Heading text"></webui-input-text>
<webui-input-message aria-label="Segment content"></webui-input-message>
</div>
</div>
<webui-content></webui-content>
</div>
`
    });
}
