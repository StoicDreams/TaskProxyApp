<#
.SYNOPSIS
Prepares Task Proxy for a commit: increments the version, minifies the CSS and JavaScript, runs the tests that CI runs, and updates the website's screenshots.

.DESCRIPTION
Select this script in Task Proxy's Git Controller to run it before every commit. If any step fails, the commit is cancelled.

.PARAMETER Version
Which part of the version to increment.

.PARAMETER SkipIncrementVersion
Leave the version as it is.

.PARAMETER SkipMinify
Do not regenerate the .min.js and .min.css files.

.PARAMETER SkipTests
Do not run the tests that the deploy workflow runs. They run on the minified files and the new version.

.PARAMETER SkipScreenshots
Do not update the TaskProxy.com screenshots with screenshots.ps1. They are updated last, once the tests pass, and only when this project has that script.
#>
[CmdletBinding()]
param(
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Version = 'patch',
    [switch]$SkipIncrementVersion,
    [switch]$SkipMinify,
    [switch]$SkipTests,
    [switch]$SkipScreenshots
)
$ErrorActionPreference = 'Stop'

# IncrementVersion.ps1 clears the screen when it starts, which would hide what ran before it.
function Clear-Host { }

function Invoke-Step([string]$Name, [string]$Script, [hashtable]$Arguments = @{}) {
    Write-Host "== $Name" -ForegroundColor Cyan
    $global:LASTEXITCODE = 0
    & (Join-Path $PSScriptRoot $Script) @Arguments
    if ($LASTEXITCODE) { throw "$Name failed with exit code $LASTEXITCODE." }
}

function Invoke-Check([string]$Name, [scriptblock]$Command) {
    Write-Host "== $Name" -ForegroundColor Cyan
    $global:LASTEXITCODE = 0
    & $Command
    if ($LASTEXITCODE) { throw "$Name failed with exit code $LASTEXITCODE." }
}

# The same tests the deploy workflow runs, found from the project, so a push that would fail CI is caught here first.
function Invoke-Tests {
    if (Test-Path 'src-tauri') {
        # The backend embeds dist/, so it has to exist before the Rust tests compile.
        if (-not (Test-Path 'dist')) { Invoke-Check 'Build the frontend' { trunk build } }
        Invoke-Check 'Run the Rust tests' { cargo test -p taskproxy }
    }
    elseif (Test-Path 'Cargo.toml') {
        Invoke-Check 'Run the Rust tests' { cargo test }
    }
    if (Test-Path 'package.json') {
        if (-not (Test-Path 'node_modules') -and (Test-Path 'package-lock.json')) { Invoke-Check 'Install the test tools' { npm ci } }
        $scripts = (Get-Content 'package.json' -Raw | ConvertFrom-Json).scripts
        # Playwright reads CI, which turns on the same retries and checks the deploy workflow gets.
        $previousCI = $env:CI
        $env:CI = 'true'
        try {
            if ($scripts.'test:min') { Invoke-Check 'Run the UI tests on the minified files' { npm run test:min } }
            elseif ($scripts.test) { Invoke-Check 'Run the UI tests' { npm test } }
        }
        finally {
            $env:CI = $previousCI
        }
    }
}

Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    if (-not $SkipIncrementVersion) {
        $versionArguments = @{}
        if ($Version -eq 'major') { $versionArguments.major = $true }
        if ($Version -eq 'minor') { $versionArguments.minor = $true }
        Invoke-Step "Increment the $Version version" 'IncrementVersion.ps1' $versionArguments
    }
    if (-not $SkipMinify) { Invoke-Step 'Minify CSS and JavaScript' 'Minify.ps1' }
    if (-not $SkipTests) { Invoke-Tests }
    if (-not $SkipScreenshots -and (Test-Path (Join-Path $PSScriptRoot 'screenshots.ps1'))) {
        Invoke-Step 'Update the website screenshots' 'screenshots.ps1'
    }
    Write-Host 'Ready to commit.' -ForegroundColor Green
}
finally {
    Pop-Location
}
