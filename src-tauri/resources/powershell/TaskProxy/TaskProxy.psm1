# Task Proxy gives this module to every script it runs, so the script can ask Task Proxy for things.
# Scripts started anywhere else do not have it, so check for it first:
#
#   if (Get-Command Start-TaskProxyTerminal -ErrorAction SilentlyContinue) {
#       Start-TaskProxyTerminal -Name 'api' -Command "& './run-api.ps1'"
#   }
#   else {
#       Start-Process pwsh -ArgumentList '-NoExit', '-Command', "& './run-api.ps1'"
#   }

function Test-TaskProxy {
    <#
    .SYNOPSIS
    Whether this script was started by Task Proxy, so it can open terminals there.
    #>
    [CmdletBinding()]
    param()
    return [bool]($env:TASKPROXY_URL -and $env:TASKPROXY_RUN)
}

function Start-TaskProxyTerminal {
    <#
    .SYNOPSIS
    Opens a terminal in Task Proxy that runs a command, rather than a terminal window of its own.

    .DESCRIPTION
    The terminal shows in Task Proxy's Terminal Manager under the name given, in the project this script runs in,
    and keeps running after this script ends. It returns once the command has started.

    .PARAMETER Name
    The terminal's name in the Terminal Manager.

    .PARAMETER Command
    The PowerShell to run, as you would pass to pwsh -Command.

    .PARAMETER WorkingDirectory
    The folder the command starts in. Defaults to this script's current location.

    .PARAMETER Replace
    Stop the terminal's running command first, rather than failing because one is running.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Command,
        [string]$WorkingDirectory = (Get-Location).ProviderPath,
        [switch]$Replace
    )
    if (-not (Test-TaskProxy)) {
        throw 'Start-TaskProxyTerminal only works in scripts Task Proxy runs.'
    }
    $body = @{
        name             = $Name
        command          = $Command
        workingDirectory = $WorkingDirectory
        replace          = [bool]$Replace
    } | ConvertTo-Json -Compress
    try {
        Invoke-RestMethod -Method Post -Uri "$env:TASKPROXY_URL/terminal" -Headers @{ 'X-TaskProxy-Run' = $env:TASKPROXY_RUN } `
            -ContentType 'application/json' -Body $body
    }
    catch {
        $reason = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        throw "Task Proxy could not open the terminal '$Name': $reason"
    }
}

Export-ModuleMember -Function Test-TaskProxy, Start-TaskProxyTerminal
