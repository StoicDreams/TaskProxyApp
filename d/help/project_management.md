<webui-tabs theme="info" transition-timing="200">
    <webui-button slot="tabs">Adding Projects</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Single Project**: Click **Select Project Folder** to target a local directory. Task Proxy initializes a `.taskproxy` folder inside it to store configurations.
        - **Multiple Projects**: Click **Add Multiple Projects** to bulk-import several directories at once. 
        - **Existing Projects**: Selecting a folder that already contains a `.taskproxy` directory automatically loads its existing configuration.
        </webui-page-segment>
    </webui-content>
    
    <webui-button slot="tabs">Managing Projects</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Switching Projects**: Use the **Project** dropdown located in the left navigation drawer to switch your active workspace context.
        - **Renaming**: Click **Edit Name** under the current project settings to change its display name in Task Proxy. This does not rename the physical folder on your drive.
        - **Removing**: Click **Remove Project** to unregister the workspace from Task Proxy. This action is safe and will **not** delete your actual files or the `.taskproxy` folder.
        </webui-page-segment>
    </webui-content>
</webui-tabs>
