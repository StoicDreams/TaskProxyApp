"use strict"
{
    const inputTypes = {
        SINGLE_LINE: 0,
        MULTI_LINE: 1,
        NO_INPUT: 2,
        SPECIAL: 3,
        DELETE: 4,
    };
    const segmentOptions = [
        { value: '<webui-page-segment>\n\n{}\n\n</webui-page-segment>', display: 'segment', inputType: inputTypes.MULTI_LINE },
        { value: '# {}', display: 'h1', inputType: inputTypes.SINGLE_LINE },
        { value: '## {}', display: 'h2', inputType: inputTypes.SINGLE_LINE },
        { value: '### {}', display: 'h3', inputType: inputTypes.SINGLE_LINE },
        { value: '#### {}', display: 'h4', inputType: inputTypes.SINGLE_LINE },
        { value: '##### {}', display: 'h5', inputType: inputTypes.SINGLE_LINE },
        { value: '###### {}', display: 'h6', inputType: inputTypes.SINGLE_LINE },
        { value: '<webui-line></webui-line>', display: 'Line Break', inputType: inputTypes.NO_INPUT },
        { value: '***DELETING CONTENT***', display: 'Delete Segment', inputType: inputTypes.DELETE },
        { value: '{}', display: 'Raw', inputType: inputTypes.MULTI_LINE },
    ];
    const segmentChecks = [
        segmentOptions[0],
        segmentOptions[6],
        segmentOptions[5],
        segmentOptions[4],
        segmentOptions[3],
        segmentOptions[2],
        segmentOptions[1],
        segmentOptions[7],
        segmentOptions[9],
    ];
    function getOption(value) {
        for (let option of segmentOptions) {
            if (option.value === value) return option;
        }
        return segmentOptions.slice(-1);
    }
    webui.define("app-markdown-segment", {
        linkCss: true,
        constructor() {
            const t = this;
            t._content = t.template.querySelector('webui-content');
            t._btnEdit = t.template.querySelector('aside webui-button');
            t._btnUndo = t.template.querySelector('#btn-undo');
            t._inputMessage = t.template.querySelector('webui-input-message');
            t._inputText = t.template.querySelector('webui-input-text');
            t._options = t.template.querySelector('webui-dropdown');
            t._inputOptions = t.template.querySelector('.input-options');
            t._isEditing = false;
            t._inputValue = '';
            t._currentOption = segmentOptions.slice(-1).value;
            t._inputType = segmentOptions.slice(-1).inputType;
        },
        attr: [],
        attrChanged(property, value) {
            const t = this;
            switch (property) {
            }
        },
        buildFinalMarkdown() {
            let t = this;
            switch (t._inputType) {
                case inputTypes.MULTI_LINE:
                    t._inputValue = t._inputMessage.value;
                    break;
                case inputTypes.SINGLE_LINE:
                    t._inputValue = t._inputText.value;
                    break;
                default:
                    return t._currentOption;
            }
            return t._currentOption.replace('{}', t._inputValue);
        },
        connected() {
            const t = this;
            if (t._skipReconnect) {
                return;
            }
            t._options.setOptions(segmentOptions);
            let md = t.dataset.markdown;
            t.setMarkdown(md || '');
            const liveUpdate = () => {
                if (!t._isEditing) return;
                let markdown = t.buildFinalMarkdown();
                switch (t._inputType) {
                    case inputTypes.SPECIAL:
                        t._content.setHtml('TODO: Implement Special Displays');
                        break;
                    default:
                        t._content.setHtml(webui.applyAppDataToContent(markdown));
                        break;
                }
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
                    let markdown = t.buildFinalMarkdown();
                    t.setMarkdown(markdown);
                }
            });
            t._btnUndo.addEventListener('click', _ => {
                if (!t._isEditing) return;
                t._isEditing = false;
                t.classList.remove('isEditing');
                t.setMarkdown(t._originalMarkdown);
            });
            t._options.addEventListener('change', ev => {
                if (t._currentOption !== t._options.value) {
                    t._currentOption = t._options.value;
                    t.setInputType(getOption(t._currentOption).inputType);
                    liveUpdate();
                }
            });
        },
        disconnected() {
            const t = this;
            t._skipReconnect = true;
        },
        setInputType(inputType) {
            let t = this;
            t._inputType = inputType;
            switch (inputType) {
                case inputTypes.MULTI_LINE:
                    if (t._inputMessage.value !== t._inputValue) {
                        t._inputMessage.value = t._inputValue;
                    }
                    t._inputOptions.classList.remove('it-single');
                    t._inputOptions.classList.add('it-multi');
                    break;
                case inputTypes.SINGLE_LINE:
                    if (t._inputMessage.value !== t._inputValue) {
                        t._inputMessage.value = t._inputValue;
                    }
                    t._inputOptions.classList.remove('it-multi');
                    t._inputOptions.classList.add('it-single');
                    break;
                default:
                    t._inputOptions.classList.remove('it-multi');
                    t._inputOptions.classList.remove('it-single');
                    break;
            }
        },
        setMarkdown(markdown) {
            const t = this;
            t._markdown = markdown;
            let foundMatch = false;
            let mdTrimmed = markdown.trim();
            segmentChecks.forEach(option => {
                if (foundMatch) return;
                if (option.value.indexOf('{}') === -1) {
                    if (mdTrimmed === option.value) {
                        foundMatch = true;
                        t.setInputType(option.inputType);
                        t._currentOption = option.value;
                        t.setOption();
                    }
                    return;
                }
                let [left, right] = option.value.split('{}');
                let leftTrimmed = left.trim();
                let rightTrimmed = right.trim();
                if (mdTrimmed.startsWith(leftTrimmed) && mdTrimmed.endsWith(rightTrimmed)) {
                    foundMatch = true;
                    t.setInputType(option.inputType);
                    t._currentOption = option.value;
                    t._inputValue = mdTrimmed.substring(leftTrimmed.length, mdTrimmed.length - rightTrimmed.length).trim();
                    t.setOption();
                }
            });
            if (!foundMatch) {
                t.setInputType(inputTypes.NO_INPUT);
                webui.log.warn("markdown-segment did not find match", markdown);
            }
            switch (t._inputType) {
                case inputTypes.MULTI_LINE:
                    if (t._inputValue !== t._inputMessage.value) {
                        t._inputMessage.value = t._inputValue;
                    }
                    break;
                case inputTypes.SINGLE_LINE:
                    if (t._inputValue !== t._inputText.value) {
                        t._inputText.value = t._inputValue;
                    }
                    break;
                default:
                    break;
            }
            t.render();
        },
        setOption(attempt) {
            const t = this;
            attempt = (attempt || 0) + 1;
            if (t._options.value !== t._currentOption) {
                t._options.value = t._currentOption;
            }
            if (t._options.value !== t._currentOption) {
                webui.log.warn('option failed to set %o - %o', t._currentOption, t._options.value);
                if (attempt > 5) return;
                setTimeout(() => { t.setOption(attempt); }, 100);
            }
        },
        getMarkdown() {
            const t = this;
            if (t._inputType === inputTypes.DELETE) return null;
            if (t._isEditing) {
                return t.buildFinalMarkdown();
            }
            return t._markdown;
        },
        async render() {
            const t = this;
            await customElements.whenDefined('webui-content');
            t._content.setHtml('');
            switch (t._inputType) {
                case inputTypes.SPECIAL:
                    t._content.setHtml('TODO: Implement Special Displays');
                    break;
                default:
                    t._content.setHtml(webui.applyAppDataToContent(t._markdown));
                    break;
            }
        },
        shadowTemplate: `
<style type="text/css">
:host {
display: flex;
align-items: stretch;
position: relative;
width: 100%;
}
aside {
display: flex;
flex-direction: column;
gap: 4px;
flex: 0 0 36px;
margin-right: var(--padding);
}
aside webui-button {
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
<aside>
<webui-button id="btn-edit" class="drag-handle" title="Click to toggle edit, drag to move" start-icon="pencil" theme="info"></webui-button>
<webui-button id="btn-undo" title="Revert changes & close" start-icon="arrow|rotate:180|bordered|shape:circle|inverted|theme:warning" theme="warning"></webui-button>
</aside>
<div class="content">
<div class="input">
<webui-dropdown></webui-dropdown>
<div class="input-options">
<webui-input-text></webui-input-text>
<webui-input-message></webui-input-message>
</div>
</div>
<webui-content></webui-content>
</div>
`
    });
}
