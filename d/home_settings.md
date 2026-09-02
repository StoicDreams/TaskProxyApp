<webui-data data-page-title="Task Proxy Settings" data-page-subtitle=""></webui-data>

## Add additional projects

Use this form to add additional projects as needed.

<webui-page-segment>

<app-add-project></app-add-project>

</webui-page-segment>

### Remove Current Project

Coming soon!

### Change or remove your key

<webui-page-segment>

Set a new security key or delete your existing security key.

<webui-quote theme="warning">

NOTE: Deleting your security key only removes the key from your OS' key store. Your encrypted secrets will remain and can be reloaded by using the same key that you used to encrypt them.

</webui-quote>

</webui-page-segment>

<app-security-key-setter></app-security-key-setter>
