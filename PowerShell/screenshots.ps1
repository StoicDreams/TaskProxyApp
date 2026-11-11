<#
.SYNOPSIS
Updates the TaskProxy.com tutorial screenshots from the current UI.

.DESCRIPTION
Runs the screenshot captures in tools/capture, which drive the real UI against the mock backend with a made-up demo project.
They are written to the TaskProxy website checkout beside this repo, in webapp/root_files/img/tutorials, so commit them there.
The captures use the source files, so they show changes that are not minified yet. Videos are not updated: run `npm run capture -- videos` for those.

.PARAMETER OutputPath
Write the screenshots under this folder instead, as img/tutorials/*.webp.
#>
[CmdletBinding()]
param(
    [string]$OutputPath
)
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
$previousOut = $env:CAPTURE_OUT
try {
    if ($OutputPath) {
        $out = [System.IO.Path]::GetFullPath($OutputPath, (Get-Location).Path)
    }
    else {
        # The same place tools/capture/helpers.mjs writes to by default.
        $out = [System.IO.Path]::GetFullPath((Join-Path $root '../../Websites/TaskProxy/webapp/root_files'))
        if (-not (Test-Path $out)) {
            throw "The TaskProxy website checkout was not found at $out. Clone it there, or pass -OutputPath."
        }
    }
    if (-not (Test-Path 'node_modules') -and (Test-Path 'package-lock.json')) {
        Write-Host 'Installing the capture tools' -ForegroundColor Cyan
        npm ci
        if ($LASTEXITCODE) { throw "Installing the capture tools failed with exit code $LASTEXITCODE." }
    }
    $env:CAPTURE_OUT = $out
    Write-Host "Capturing screenshots into $out" -ForegroundColor Cyan
    npm run capture -- screenshots
    if ($LASTEXITCODE) { throw "Capturing the screenshots failed with exit code $LASTEXITCODE." }
    Write-Host "Screenshots updated in $(Join-Path $out 'img/tutorials'). Commit them in the website's repo." -ForegroundColor Green
}
finally {
    $env:CAPTURE_OUT = $previousOut
    Pop-Location
}
