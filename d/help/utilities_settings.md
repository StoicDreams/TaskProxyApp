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
        - **Global Access**: Open **Tools**, the toolbox at the top right, and choose its **Icons & Emojis** tab, from anywhere in the application.
        - **Search**: Use the search bar to filter through standard emojis and integrated Web UI icons.
        - **Integration**: When using tools like the **Nav Manager**, opening this drawer and selecting an icon will automatically assign it to the currently selected page or folder.
        </webui-page-segment>
    </webui-content>

    <webui-button slot="tabs">Performance</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **What it limits**: Settings' **Performance** tab limits the scripts Task Proxy runs, in the Terminal Manager, from pages, and favorites, along with everything they start. Scripts opened in a separate terminal window are not limited.
        - **Priority**: **Low** runs scripts below your other programs. **Lowest** gives them only CPU time nothing else wants.
        - **CPU threads**: Keeps scripts to some of the computer's threads. Tools that size themselves to the computer, such as cargo, start fewer jobs. macOS can only lower priority.
        - **When it applies**: To scripts started after a change. A script already running keeps the limits it started with.
        </webui-page-segment>
    </webui-content>
</webui-tabs>
