<webui-tabs theme="info" transition-timing="200">
    <webui-button slot="tabs">Script Manager</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Editing Scripts**: Use the script dropdown to load existing `.ps1` files from your project's `.taskproxy/scripts` folder, or click **New Script** to start from scratch.
        - **Automatic Parameters**: Task Proxy automatically detects `param()` blocks in your PowerShell scripts and generates input fields or toggle switches for them directly above the script preview.
        - **Live Preview**: The command preview automatically builds the exact execution string (including your parameter inputs) that will be sent to the terminal. Toggle **Full Path** to switch between relative and absolute execution paths.
        - **Execution**: Click **Run** to immediately execute the script in a background terminal.
        - **Saving**: Use **Save** to overwrite the current script, or **Save As** to create a new script file in the workspace.
        </webui-page-segment>
    </webui-content>
    
    <webui-button slot="tabs">Terminal Manager</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Accessing Terminals**: Click the pager icon (Terminal Manager) in the top-right header to view live and historical terminal outputs.
        - **Process Control**: Select a running script from the dropdown to view its live output. Click **Stop** to stop it the way Ctrl+C does in a terminal. If it is still running a few seconds later, it is forced to end. **Kill All** ends every running script straight away.
        - **A Real Terminal**: Scripts run in a terminal, so colors, progress bars, and redrawn output look the way they do in your own terminal.
        - **Answering Prompts**: When a script asks a question, such as `Read-Host` or a "Continue? [Y/N]" prompt, click the terminal and type your answer. Ctrl+C copies selected text, and otherwise stops the script.
        - **Queue Management**: Scripts that are executed while another terminal is already running will be automatically queued and executed sequentially.
        - **Filtering**: Use the **Page** and **All** toggles to filter the terminal dropdown list between scripts triggered from the current page vs. all historical scripts.
        - **PowerShell Requirement**: Task Proxy requires PowerShell to execute scripts. If PowerShell is not detected, the Terminal Manager will prompt you with automatic or manual installation instructions.
        </webui-page-segment>
    </webui-content>
</webui-tabs>
