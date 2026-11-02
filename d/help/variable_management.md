## Variable Management Help

<webui-tabs theme="info" transition-timing="200">
    <webui-button slot="tabs">Variable Scopes</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        Variables in Task Proxy are prioritized by scope to allow local overrides of broader settings. When a variable is requested, Task Proxy checks in this order:
        1. **Page Scope**: Variables defined only for the currently active page. Highest priority.
        2. **Project Scope**: Variables saved to the `.taskproxy` configuration. Useful for project-wide defaults.
        3. **Global Scope**: Variables saved in the app's secure local storage, persisting across all projects. Useful for personal secrets (like API keys or PATs).
        </webui-page-segment>
    </webui-content>
    
    <webui-button slot="tabs">Environments</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Switching**: Use the Environment dropdown in the Project tab to swap between different variable sets (e.g., `dev`, `prod`).
        - **Managing**: Click **Manage** to rename existing environments, delete them, or create new ones.
        - **Storage**: Environment profiles are saved to your project's `.taskproxy/Variables.json` and are synced when you commit project changes.
        </webui-page-segment>
    </webui-content>

    <webui-button slot="tabs">Using Variables</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **In Scripts**: Task Proxy automatically injects your variable values into PowerShell scripts when executing them. Define them as standard PowerShell variables (e.g., `$MyVariable`).
        - **In Pages**: Use all-caps snake case wrapped in curly braces (e.g., `{MY_VARIABLE}`) to inject a variable directly into your custom page markdown.
        - **Variable Toggles**: Use the "Enabled" toggles at the top of the manager to quickly test scripts or pages without Page, Project, or Global variables interfering.
        </webui-page-segment>
    </webui-content>
</webui-tabs>
