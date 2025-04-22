"use strict"
{
    const segmentOptions = [
        { value: '<webui-page-segment>\n\n{}\n\n</webui-page-segment>', display: 'segment' },
        { value: '# {}', display: 'h1' },
        { value: '## {}', display: 'h2' },
        { value: '### {}', display: 'h3' },
        { value: '#### {}', display: 'h4' },
        { value: '##### {}', display: 'h5' },
        { value: '###### {}', display: 'h6' },
        { value: '{}', display: 'Raw' },
    ];
    webui.define("app-markdown-segment", {
        linkCss: true,
        constructor: (t) => {
            t._content = t.template.querySelector('webui-content');
            t._btnEdit = t.template.querySelector('aside webui-button');
            t._input = t.template.querySelector('webui-input-message');
            t._options = t.template.querySelector('webui-dropdown');
            t._isEditing = false;
            t._inputValue = '';
            t._currentOption = segmentOptions[0].value;
        },
        attr: ['example'],
        attrChanged: (t, property, value) => {
            switch (property) {
                case 'example':
                    break;
            }
        },
        buildFinalMarkdown: function (input) {
            let t = this;
            t._inputValue = input;
            return t._currentOption.replace('{}', input);
        },
        connected: function (t) {
            let md = t.dataset.markdown;
            t.setMarkdown(md || '');
            t._input.addEventListener('input', ev => {
                t._inputValue = t._input.value;
                let markdown = t.buildFinalMarkdown(t._inputValue);
                t.setMarkdown(markdown);
            });
            t._btnEdit.addEventListener('click', _ => {
                t._isEditing = !t._isEditing;
                if (t._isEditing) {
                    t.classList.add('isEditing');
                    t._input.autosize();
                } else {
                    t.classList.remove('isEditing');
                }
            });
            t._options.setOptions(segmentOptions);
            t._options.addEventListener('change', ev => {
                console.log('options changed', ev, t._options.value);
                if (t._currentOption !== t._options.value) {
                    t._currentOption = t._options.value;
                    let markdown = t.buildFinalMarkdown(t._input.value);
                    t.setMarkdown(markdown);
                }
            });
        },
        disconnected: function (t) { },
        setMarkdown: function (markdown) {
            let t = this;
            t._markdown = markdown;
            let foundMatch = false;
            console.log('Setting markdown', markdown);
            segmentOptions.forEach(option => {
                if (foundMatch) return;
                let [left, right] = option.value.split('{}');
                if (markdown.startsWith(left) && markdown.endsWith(right)) {
                    foundMatch = true;
                    t._currentOption = option.value;
                    t._inputValue = markdown.substring(left.length, markdown.length - right.length);
                    console.log('found match', option, t._currentOption, t._options, t._options.value);
                    console.log('input value', t._inputValue);
                    t.setOption();
                }
            });
            if (!foundMatch) {
                webui.log.warn("markdown-segment did not find match", markdown);
            }
            if (t._inputValue !== t._input.value) {
                t._input.value = t._inputValue;
            }
            t.render();
        },
        setOption: function () {
            let t = this;
            console.log('set option %o', t._options.value, t._currentOption);
            if (t._options.value !== t._currentOption) {
                console.log('is connected', t._options._isConnected, !t._options._optionsSet);
                t._options.value = t._currentOption;
                console.log('set match', t._options.value);
            }
            if (t._options.value !== t._currentOption) {
                webui.log.warn('option failed to set %o', t._currentOption);
                setTimeout(() => { t.setOption(); }, 100);
            }
        },
        getMarkdown: function () {
            let t = this;
            return t._markdown;
        },
        render: function () {
            let t = this;
            t._content.setHtml('');
            let mdt = t.getAttribute('mdt');
            switch (mdt) {
                case 'wrap':
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
</style>
<div class="content">
<webui-content></webui-content>
<div class="input">
<webui-input-message></webui-input-message>
<webui-dropdown></webui-dropdown>
</div>
</div>
<aside>
<webui-button start-icon="edit" theme="info"></webui-button>
</aside>
`
    });
}