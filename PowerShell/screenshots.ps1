<#
.SYNOPSIS
Updates the TaskProxy.com images and videos from the current UI.

.DESCRIPTION
Runs every capture in tools/capture, which drive the real UI against the mock backend with a made-up demo project: the
short looping videos that stand in for screenshots (video/loops), and the narrated tutorial videos (video). They are
written to the TaskProxy website checkout beside this repo, in webapp/root_files, so commit them there.
Every file is captured again on every run. Recordings never come out byte for byte the same, so git shows them all as
changed: commit them when the UI changed enough to be worth it, or discard them. Publish.ps1 -SkipScreenshots leaves
this out. It takes a few minutes; CAPTURE_WORKERS sets how many recordings run at once (3 by default).
The captures use the source files, so they show changes that are not minified yet.

.PARAMETER OutputPath
Write the images and videos under this folder instead.
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
    Write-Host "Capturing images and videos into $out" -ForegroundColor Cyan
    npm run capture
    if ($LASTEXITCODE) { throw "Capturing the images and videos failed with exit code $LASTEXITCODE." }
    Write-Host "Images and videos updated in $out. Commit them in the website's repo." -ForegroundColor Green
}
finally {
    $env:CAPTURE_OUT = $previousOut
    Pop-Location
}
