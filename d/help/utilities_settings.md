<webui-tabs theme="info" transition-timing="200">
    <webui-button slot="tabs">App Updates</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Checking for Updates**: Click **Check for Updates** to query the server for the latest version.
        - **Installing**: If an update is available, the **Install Updates** button will become active. Clicking it will download the update and automatically restart Task Proxy to apply the new version.
        - **Version Info**: Your current application version is always displayed next to the update controls.
        </webui-page-segment>
    </webui-content>
    
    <webui-button slot="tabs">Icons & Emojis</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Global Access**: Click the smiley face icon in the top header to open the Icon & Emoji Drawer from anywhere in the application.
        - **Search**: Use the search bar to filter through standard emojis and integrated Web UI icons.
        - **Integration**: When using tools like the **Nav Manager**, opening this drawer and selecting an icon will automatically assign it to the currently selected page or folder.
        </webui-page-segment>
    </webui-content>
</webui-tabs>
