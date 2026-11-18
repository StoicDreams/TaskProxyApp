<#
.SYNOPSIS
In a development build, points the app at a local MyFiCDN server instead of cdn.myfi.ws.

.DESCRIPTION
Trunk runs this after each build, before the files are served (the post_build hook in Trunk.toml), so
`cargo tauri dev` loads Web UI from a MyFiCDN checkout started with its PowerShell/RunLocal.ps1. The Web UI loader
loads its components, styles, and data from wherever the loader came from, so only the files that name cdn.myfi.ws
themselves change: index.html and the pages in d/.

A release build is never changed. In a development build:
- TASKPROXY_CDN set to an address, such as http://127.0.0.1:3210, uses that server.
- TASKPROXY_CDN=live keeps cdn.myfi.ws.
- Otherwise the local MyFiCDN server's usual address, http://127.0.0.1:3180, is used when it answers, and
  cdn.myfi.ws when it doesn't.
#>
[CmdletBinding()]
param(
    [string]$StagingDir = $env:TRUNK_STAGING_DIR,
    [string]$BuildProfile = $env:TRUNK_PROFILE,
    # Where a local MyFiCDN server usually answers, used when TASKPROXY_CDN names none.
    [string]$LocalAddress = 'http://127.0.0.1:3180'
)
$ErrorActionPreference = 'Stop'

if ($BuildProfile -eq 'release' -or -not $StagingDir) { return }

$choice = "$env:TASKPROXY_CDN".Trim()
if ($choice -eq 'live') { return }
$local = if ($choice) { $choice } else { $LocalAddress }
$local = $local.TrimEnd('/')
if (-not $choice) {
    try {
        $null = Invoke-WebRequest "$local/webui/loader.min.js" -Method Head -TimeoutSec 1
    }
    catch {
        return
    }
}

$files = @(Join-Path $StagingDir 'index.html') + @(Get-ChildItem (Join-Path $StagingDir 'd') -Filter '*.md' -Recurse -ErrorAction SilentlyContinue | ForEach-Object FullName)
$changed = 0
foreach ($file in $files) {
    if (-not (Test-Path $file)) { continue }
    $text = [System.IO.File]::ReadAllText($file)
    $updated = $text.Replace('https://cdn.myfi.ws/', "$local/")
    if ($updated -ne $text) {
        [System.IO.File]::WriteAllText($file, $updated)
        $changed++
    }
}
Write-Host "Web UI loads from the local MyFiCDN server at $local ($changed files). Set TASKPROXY_CDN=live to use cdn.myfi.ws." -ForegroundColor Cyan
