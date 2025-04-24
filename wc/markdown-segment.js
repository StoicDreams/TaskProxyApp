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
    function getOption(value) {
        for (let option of segmentOptions) {
            if (option.value === value) return option;
        }
        return segmentOptions.slice(-1);
    }
    webui.define("app-markdown-segment", {
        linkCss: true,
        constructor: (t) => {
            t._content = t.template.querySelector('webui-content');
            t._btnEdit = t.template.querySelector('aside webui-button');
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
        attrChanged: (t, property, value) => {
            switch (property) {
            }
        },
        buildFinalMarkdown: function () {
            let t = this;
            console.log('build final markdown $o |%o|%o|%o|', t._inputType, t._inputValue, t._inputMessage.value, t._inputText.value)
            switch (t._inputType) {
                case inputTypes.MULTI_LINE:
                    t._inputValue = t._inputMessage.value;
                    break;
                case inputTypes.SINGLE_LINE:
                    t._inputValue = t._inputText.value;
                    break;
                default:
                    console.log('return raw option value', t._currentOption);
                    return t._currentOption;
            }
            console.log('return with replace');
            return t._currentOption.replace('{}', t._inputValue);
        },
        connected: function (t) {
            if (t._skipReconnect) {
                return;
            }
            let md = t.dataset.markdown;
            t.setMarkdown(md || '');
            t._inputMessage.addEventListener('input', ev => {
                let markdown = t.buildFinalMarkdown();
                t.setMarkdown(markdown);
            });
            t._inputText.addEventListener('input', ev => {
                let markdown = t.buildFinalMarkdown();
                t.setMarkdown(markdown);
            });
            t._btnEdit.addEventListener('click', _ => {
                t._isEditing = !t._isEditing;
                if (t._isEditing) {
                    t.classList.add('isEditing');
                    if (t._inputType === inputTypes.MULTI_LINE) {
                        t._inputMessage.autosize();
                    }
                } else {
                    t.classList.remove('isEditing');
                }
            });
            t._options.setOptions(segmentOptions);
            t._options.addEventListener('change', ev => {
                if (t._currentOption !== t._options.value) {
                    t._currentOption = t._options.value;
                    t.setInputType(getOption(t._currentOption).inputType);
                    let markdown = t.buildFinalMarkdown();
                    t.setMarkdown(markdown);
                }
            });
        },
        disconnected: function (t) {
            t._skipReconnect = true;
        },
        setInputType: function (inputType) {
            let t = this;
            t._inputType = inputType;
            switch (inputType) {
                case inputTypes.MULTI_LINE:
                    t._inputMessage.value = t._inputValue;
                    t._inputOptions.classList.remove('it-single');
                    t._inputOptions.classList.add('it-multi');
                    break;
                case inputTypes.SINGLE_LINE:
                    t._inputText.value = t._inputValue;
                    t._inputOptions.classList.remove('it-multi');
                    t._inputOptions.classList.add('it-single');
                    break;
                default:
                    t._inputOptions.classList.remove('it-multi');
                    t._inputOptions.classList.remove('it-single');
                    break;
            }
        },
        setMarkdown: function (markdown) {
            let t = this;
            console.log('set markdown', markdown);
            t._markdown = markdown;
            let foundMatch = false;
            segmentOptions.forEach(option => {
                if (foundMatch) return;
                if (option.value.indexOf('{}') === -1) {
                    if (markdown === option.value) {
                        console.log('found match', option);
                        foundMatch = true;
                        t.setInputType(option.inputType);
                        t._currentOption = option.value;
                        t.setOption();
                    }
                    return;
                }
                let [left, right] = option.value.split('{}');
                if (markdown.startsWith(left) && markdown.endsWith(right)) {
                    foundMatch = true;
                    console.log('found match', option);
                    t.setInputType(option.inputType);
                    t._currentOption = option.value;
                    t._inputValue = markdown.substring(left.length, markdown.length - right.length);
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
        setOption: function () {
            let t = this;
            if (t._options.value !== t._currentOption) {
                t._options.value = t._currentOption;
            }
            if (t._options.value !== t._currentOption) {
                webui.log.warn('option failed to set %o', t._currentOption);
                setTimeout(() => { t.setOption(); }, 100);
            }
        },
        getMarkdown: function () {
            let t = this;
            return t._inputType === inputTypes.DELETE ? null : t._markdown;
        },
        render: function () {
            let t = this;
            if (!t._content.setHtml) {
                setTimeout(() => t.render(), 100);
                return;
            }
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
display:grid;
grid-template-columns:1fr max-content;
align-items:start;
position: relative;
}
aside {
visibility:hidden;
}
:host(:hover) aside {
display:flex;
flex-direction:column;
visibility:visible;
}
:host div.content {
position:relative;
}
:host div.input {
display:grid;
align-items:start;
grid-template-columns:1fr max-content;
position:absolute;
width:100%;
min-height:100%;
z-index:1;
top:0;
left:0;
}
:host(:not(.isEditing)) div.input {
display:none;
}
.input-options:not(.it-single) > webui-input-text,
.input-options:not(.it-multi) > webui-input-message {
display:none;
}
</style>
<div class="content">
<webui-content></webui-content>
<div class="input">
<div class="input-options">
<webui-input-text></webui-input-text>
<webui-input-message></webui-input-message>
</div>
<webui-dropdown></webui-dropdown>
</div>
</div>
<aside>
<webui-button class="drag-handle" title="Click to edit, drag to move" start-icon="edit" theme="info"></webui-button>
</aside>
`
    });
}