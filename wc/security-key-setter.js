
"use strict"
{
    function generateSecurityKey() {
        let segments = [];
        for (let index = 0; index < 50; ++index) {
            segments.push(generateSecurityKeySegment(20));
        }
        return segments.join(' ');
    }
    function generateSecurityKeySegment(length) {
        const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_=+?~";
        let result = '';
        const array = new Uint32Array(length);
        window.crypto.getRandomValues(array);
        for (let i = 0; i < length; i++) {
            result += charset[array[i] % charset.length];
        }
        return result;
    }

    webui.define("app-security-key-setter", {
        linkCss: true,
        preload: 'input-message alert alerts',
        constructor: (t) => {
            t._alert = t.template.querySelector('webui-alert');
            t._sav = t.template.querySelector('webui-button[theme="primary"]');
            t._gen = t.template.querySelector('webui-button[theme="secondary"]');
            t._input = t.template.querySelector('webui-input-message');
        },
        linkCss: true,
        attr: ['example'],
        attrChanged: (t, property, value) => {
            switch (property) {
                case 'example':
                    break;
            }
        },
        connected: function (t) {
            let isSaving = false;
            t._sav.addEventListener('click', async _ => {
                if (isSaving) return;
                isSaving = true;
                let secKey = `${t._input.value}`.trim();
                if (secKey.length < 100) {
                    t._alert.setValue({ text: 'Security key must be at least 100 characters in length.', theme: 'danger' });
                    isSaving = false;
                    return;
                }

                t._alert.setValue({ text: 'Key saving coming soon!', theme: 'info' });
                //await window.__TAURI__.core.invoke('set_security_key', {}).catch(msg=>t._alert.setValue({ text: msg, theme: 'danger' });)
                isSaving = false;
            });
            t._gen.addEventListener('click', _ => {
                t._input.setValue(generateSecurityKey());
            });
        },
        disconnected: function (t) { },
        shadowTemplate: `
<style type="text/css">
:host {
display:flex;
max-width:700px;
margin: 0 auto;
flex-direction:column;
gap: 10px;
}
</style>
<webui-input-message theme="primary" label="Enter your security key here!" autofocus></webui-input-message>
<webui-flex gap="10" justify="flex-end">
<webui-alert id="alert"></webui-alert>
<webui-button theme="secondary">Generate Key</webui-button>
<webui-button theme="primary">Save</webui-button>
</webui-flex>
`
    });
}