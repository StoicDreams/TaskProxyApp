<webui-data data-page-title="Task Proxy Settings" data-page-subtitle=""></webui-data>

<app-project-manager class="my-3"></app-project-manager>

<webui-pinned-side class="settings-layout my-3" side-width="minmax(300px, 30%)">
<webui-tabs class="settings-tabs" vertical pad="var(--padding)" transition-timing="200" theme="primary" data-subscribe="session-settings-tab-index:setTab">
<webui-button align="left" slot="tabs" start-icon="folder-open" class="settings-tab-projects">Projects</webui-button>
<webui-content slot="content" nodetach class="settings-projects">
<h3>Your projects</h3>
<app-projects-report></app-projects-report>
<h3>Add a project</h3>
<app-add-project></app-add-project>
</webui-content>
<webui-button align="left" slot="tabs" start-icon="download" class="settings-tab-import">Import</webui-button>
<webui-content slot="content" nodetach class="settings-import">
<app-page-import></app-page-import>
</webui-content>
<webui-button align="left" slot="tabs" start-icon="key" class="settings-tab-key">Security Key</webui-button>
<webui-content slot="content" nodetach class="settings-key">
<p>Set a new security key, or delete the one saved in this computer's keychain.</p>
<webui-quote theme="warning">Deleting your key only removes it from your keychain. Your encrypted secrets stay, and come back when you enter the same key again.</webui-quote>
<app-security-key-setter></app-security-key-setter>
</webui-content>
<webui-button align="left" slot="tabs" start-icon="mobile" class="settings-tab-remote">Remote Connections</webui-button>
<webui-content slot="content" nodetach class="settings-remote">
<app-remote-connections></app-remote-connections>
</webui-content>
<webui-button align="left" slot="tabs" start-icon="gauge" class="settings-tab-performance">Performance</webui-button>
<webui-content slot="content" nodetach class="settings-performance">
<app-script-performance></app-script-performance>
</webui-content>
<webui-button align="left" slot="tabs" start-icon="exclamation" theme="danger" class="settings-tab-danger">Danger</webui-button>
<webui-content slot="content" nodetach class="settings-danger">
<app-project-remove></app-project-remove>
</webui-content>
</webui-tabs>
<webui-flex slot="side" column gap="var(--padding)">
<webui-card name="Application Updates" avatar="download|fill" theme="info" class="settings-updates">
<app-update-manager></app-update-manager>
</webui-card>
<webui-card name="Plugins" avatar="puzzle-piece|fill" theme="info" class="settings-plugins">
<p>Plugins add integrations such as Jira. Manage them from Tools, the toolbox at the top right, on its Plugins tab.</p>
</webui-card>
</webui-flex>
</webui-pinned-side>

<webui-line></webui-line>

<webui-flex class="my-3" justify="center">
<webui-link href="/about" icon="circle_exclamation|backing|bordered">About Task Proxy</webui-link>
<webui-link href="/contact" icon="messages|fill|shade:tri">Contact Stoic Dreams</webui-link>
<webui-link href="/privacy" icon="shield_exclamation|backing|bordered">Privacy</webui-link>
<webui-link href="/terms" icon="handshake|fill|shade|tri">Terms & Conditions</webui-link>
</webui-flex>

<webui-stoic-social-links class="mb-2"></webui-stoic-social-links>

<app-settings-footer class="settings-footer" since="2016" company="Stoic Dreams"></app-settings-footer>

<webui-page-help heading="Settings Help">
<h3>Project Management</h3>
<webui-content src="d/help/project_management.md"></webui-content>
<h3>Utilities & Settings</h3>
<webui-content src="d/help/utilities_settings.md"></webui-content>
</webui-page-help>
