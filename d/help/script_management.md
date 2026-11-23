<webui-tabs theme="info" transition-timing="200">
    <webui-button slot="tabs">Script Manager</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        - **Editing Scripts**: Pick any `.ps1` file in your project from the list beside the editor, or click **New Script** to start from scratch. **View** shows the list and the script side by side, or one at a time.
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

    <webui-button slot="tabs">Scripts That Open Terminals</webui-button>
    <webui-content slot="content" nodetach>
        <webui-page-segment>
        A script that starts other scripts, such as one that launches a dev server for each site, can open them as terminals in the **Terminal Manager** instead of terminal windows of their own. You can watch, answer, and stop each one there.

        Every script Task Proxy runs gets the `TaskProxy` PowerShell module, with two commands:

        - **`Start-TaskProxyTerminal`** opens a terminal in the Terminal Manager that runs a command. It returns once the command has started, and the terminal keeps running after your script ends.
        - **`Test-TaskProxy`** says whether the script was started by Task Proxy.

        | Parameter | What it does |
        |---|---|
        | `-Name` | The terminal's name in the Terminal Manager. Required. |
        | `-Command` | The PowerShell to run, as you would pass to `pwsh -Command`. Required. |
        | `-WorkingDirectory` | The folder the command starts in. Defaults to the script's current folder. |
        | `-Replace` | Stops what is still running in a terminal of that name and waits for it to end first. Without it, the call fails while that terminal runs. |

        The terminal opens in the same project as the script that opened it.

        **Open a terminal.** Use this in a script only Task Proxy runs.

        ```pwsh:Open a terminal
        Start-TaskProxyTerminal -Name 'api' -Command "& './scripts/run-api.ps1'"
        ```

        **Open a terminal in Task Proxy, and a window anywhere else.** Scripts run outside Task Proxy, such as by teammates who don't use it, don't have the module, so check for it.

        ```pwsh:Works in and out of Task Proxy
        $command = "& './scripts/run-api.ps1'"
        if (Get-Command Start-TaskProxyTerminal -ErrorAction SilentlyContinue) {
            Start-TaskProxyTerminal -Name 'api' -Command $command -Replace
        }
        else {
            Start-Process pwsh -ArgumentList '-NoExit', '-Command', $command
        }
        ```

        **Restart several servers.** `-Replace` stops each one still running from the last time, so running the script again restarts them on free ports.

        ```pwsh:Restart several servers
        $sites = @('web', 'admin', 'api')
        foreach ($site in $sites) {
            Start-TaskProxyTerminal -Name $site -Command "& './run-$site.ps1' -Watch" -WorkingDirectory "$PSScriptRoot/sites/$site" -Replace
        }
        ```

        **Carry on when one fails to open.** The command throws an error that says why, such as a terminal of that name still running.

        ```pwsh:Handle errors
        try {
            Start-TaskProxyTerminal -Name 'worker' -Command 'dotnet run --project ./Worker' | Out-Null
        }
        catch {
            Write-Host "Could not open the worker: $($_.Exception.Message)" -ForegroundColor Red
        }
        ```

        To leave a teammate's script unchanged, write a script of your own that does what theirs does, opening its terminals with `Start-TaskProxyTerminal`, and run yours from Task Proxy.
        </webui-page-segment>
    </webui-content>
</webui-tabs>
