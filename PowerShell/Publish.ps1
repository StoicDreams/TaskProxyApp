<#
.SYNOPSIS
Prepares Task Proxy for a commit: updates the Rust dependencies, increments the version, minifies the CSS and JavaScript, runs the tests that CI runs, and starts updating the website's images and videos.

.DESCRIPTION
Select this script in Task Proxy's Git Controller to run it before every commit. If any step fails, the commit is cancelled.

.PARAMETER Version
Which part of the version to increment.

.PARAMETER SkipCargoUpdate
Do not run cargo update, so Cargo.lock keeps the dependency versions it has.

.PARAMETER SkipIncrementVersion
Leave the version as it is.

.PARAMETER SkipMinify
Do not regenerate the .min.js and .min.css files.

.PARAMETER SkipTests
Do not run the tests that the deploy workflow runs. They run on the minified files and the new version.

.PARAMETER SkipScreenshots
Do not update the TaskProxy.com images and videos with screenshots.ps1, for a commit whose UI changes are not worth
re-recording them. Also -SkipMedia. They are updated last, once the tests pass, and only when this project has that script.

.PARAMETER WaitForScreenshots
Wait for the images and videos, and fail if they can't be recorded. Otherwise they start once the tests pass and record
after Publish ends, so the commit doesn't wait for them: in a Task Proxy terminal named "Website media" when Task Proxy
runs Publish, or else in the background, with a log. They are written to the TaskProxy website's repo, not this one, so
nothing in this commit needs them. Commit them there once they finish.
#>
[CmdletBinding()]
param(
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Version = 'patch',
    [switch]$SkipCargoUpdate,
    [switch]$SkipIncrementVersion,
    [switch]$SkipMinify,
    [switch]$SkipTests,
    [Alias('SkipMedia')]
    [switch]$SkipScreenshots,
    [switch]$WaitForScreenshots
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
        # --lib: the tests are all in the library. Without it, cargo also builds main.rs's test binary and the doc tests,
        # which have none, and that doubles the build after a version bump. CI's release build still compiles main.rs.
        Invoke-Check 'Run the Rust tests' { cargo test -p taskproxy --lib }
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

# Starts screenshots.ps1 without waiting for it: in a Task Proxy terminal when Task Proxy runs this, so its progress and
# result show there, or else as a process of its own that writes a log.
function Start-Screenshots {
    $script = Join-Path $PSScriptRoot 'screenshots.ps1'
    $command = "& '$($script -replace "'", "''")'"
    Write-Host '== Update the website images and videos, without holding up the commit' -ForegroundColor Cyan
    if ((Get-Command Test-TaskProxy -ErrorAction SilentlyContinue) -and (Test-TaskProxy)) {
        Start-TaskProxyTerminal -Name 'Website media' -Command $command -WorkingDirectory (Get-Location).ProviderPath -Replace | Out-Null
        Write-Host "Recording in Task Proxy's 'Website media' terminal. Commit them in the website's repo once it finishes."
        return
    }
    $log = Join-Path ([System.IO.Path]::GetTempPath()) 'taskproxy-website-media.log'
    $pwsh = (Get-Process -Id $PID).Path
    Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile', '-NonInteractive', '-File', $script) `
        -WorkingDirectory (Get-Location).ProviderPath -RedirectStandardOutput $log -RedirectStandardError "$log.errors" | Out-Null
    Write-Host "Recording in the background. Its output is in $log, and any errors in $log.errors."
}

Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    # First, so the build and the tests below use the updated dependencies. It moves Cargo.lock to the newest
    # semver-compatible versions, which picks up security fixes such as the ones Dependabot reports.
    if (-not $SkipCargoUpdate -and (Test-Path 'Cargo.toml')) { Invoke-Check 'Update the Rust dependencies' { cargo update } }
    if (-not $SkipIncrementVersion) {
        $versionArguments = @{}
        if ($Version -eq 'major') { $versionArguments.major = $true }
        if ($Version -eq 'minor') { $versionArguments.minor = $true }
        Invoke-Step "Increment the $Version version" 'IncrementVersion.ps1' $versionArguments
    }
    if (-not $SkipMinify) { Invoke-Step 'Minify CSS and JavaScript' 'Minify.ps1' }
    if (-not $SkipTests) { Invoke-Tests }
    if (-not $SkipScreenshots -and (Test-Path (Join-Path $PSScriptRoot 'screenshots.ps1'))) {
        if ($WaitForScreenshots) { Invoke-Step 'Update the website images and videos' 'screenshots.ps1' }
        else { Start-Screenshots }
    }
    Write-Host 'Ready to commit.' -ForegroundColor Green
}
finally {
    Pop-Location
}
