<webui-data data-page-title="Task Proxy Settings" data-page-subtitle=""></webui-data>

## Add additional projects

Use this form to add additional projects as needed.

<webui-page-segment>

<app-add-project></app-add-project>

</webui-page-segment>

### Current Project: <strong data-subscribe="app-current-project.display:html"></strong>

<webui-page-segment>

<app-project-manager></app-project-manager>

</webui-page-segment>

### Change or remove your key

<webui-page-segment>

Set a new security key or delete your existing security key.

<webui-quote theme="warning">

NOTE: Deleting your security key only removes the key from your OS' key store. Your encrypted secrets will remain and can be reloaded by using the same key that you used to encrypt them.

</webui-quote>

</webui-page-segment>

<app-security-key-setter></app-security-key-setter>

## Application Updates

<webui-page-segment>
<app-update-manager></app-update-manager>
</webui-page-segment>

<webui-line></webui-line>

<webui-flex class="my-3" justify="center">
<webui-link href="/about" icon="circle_exclamation|backing|bordered">About Task Proxy</webui-link>
<webui-link href="/contact" icon="messages|fill|shade:tri">Contact Stoic Dreams</webui-link>
<webui-link href="/privacy" icon="shield_exclamation|backing|bordered">Privacy</webui-link>
<webui-link href="/terms" icon="handshake|fill|shade|tri">Terms & Conditions</webui-link>
</webui-flex>

<webui-stoic-social-links class="mb-2"></webui-stoic-social-links>

<webui-page-help heading="Settings Help">
<h3>Project Management</h3>
<webui-content src="d/help/project_management.md"></webui-content>
<h3>Utilities & Settings</h3>
<webui-content src="d/help/utilities_settings.md"></webui-content>
</webui-page-help>
