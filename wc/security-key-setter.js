
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
            t._del = t.template.querySelector('webui-button[theme="danger"]');
            t._sav = t.template.querySelector('webui-button[theme="primary"]');
            t._gen = t.template.querySelector('webui-button[theme="secondary"]');
            t._input = t.template.querySelector('webui-input-message');
        },
        linkCss: true,
        connected: async function (t) {
            let hasSecurityKey = await webui.proxy.hasSecurityKey(handleError);
            if (hasSecurityKey) {
                t._del.classList.remove('hidden');
            } else {
                t._del.classList.add('hidden');
            }
            t._del.addEventListener('click', webui.trySoloProcess(async _ => {
                let result = await webui.proxy.deleteSecurityKey(handleError);
                if (!result) return;
                t._alert.setValue({ text: result, theme: 'success' });
                webui.setData('home-state', 'sec-key-deleted');
            }, handleError));
            t._sav.addEventListener('click', webui.trySoloProcess(async _ => {
                let secKey = `${t._input.value}`.trim();
                if (secKey.length < 100) {
                    t._alert.setValue({ text: 'Security key must be at least 100 characters in length.', theme: 'danger' });
                    return;
                }
                t._alert.setValue({ text: 'Setting key, please wait', theme: 'info' });
                let result = await webui.proxy.setSecurityKey(secKey, handleError);
                if (!result) return;
                t._alert.setValue({ text: result, theme: 'success' });
                webui.setData('home-state', 'sec-key-saved');
            }, handleError));
            t._gen.addEventListener('click', webui.trySoloProcess(async _ => {
                t._input.setValue(generateSecurityKey());
            }, handleError));
            function handleError(ex) {
                t._alert.setValue({ text: ex, theme: 'danger' });
            }
        },
        disconnected: function (t) { },
        shadowTemplate: `
<style type="text/css">
:host {
display:flex;
max-width:700px;
margin: 0 auto;
flex-direction:column;
gap: var(--padding);
}
</style>
<webui-input-message theme="primary" label="Enter your security key here!" autofocus></webui-input-message>
<webui-flex gap="var(--padding)" justify="flex-end">
<webui-alert id="alert"></webui-alert>
<webui-button theme="danger">Delete Key</webui-button>
<webui-button theme="secondary">Generate Key</webui-button>
<webui-button theme="primary">Save</webui-button>
</webui-flex>
`
    });
}