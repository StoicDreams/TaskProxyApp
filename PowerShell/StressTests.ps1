<#
.SYNOPSIS
Runs the UI tests affected by the last week's changes many times each under heavy load, to find tests that only pass
some of the time.

.DESCRIPTION
Run it by hand once a week for each project worked on that week. It is never part of a normal test run, Publish, or CI.

It looks at what changed in the last -Days days: commits, and work not committed yet. With nothing changed, it says
so and runs nothing. Otherwise it stresses the specs those changes affect: where the UI test cache (.test-cache, see
tests/support/test-cache.mjs) knows what each test used, the specs whose tests used a changed file; and without it,
every spec. A change to the test setup itself (tests/support, the Playwright config, or package-lock.json) stresses
every spec. Each runs -Repeat times at heavy parallel load, against the files CI tests, with no retries and no cache.

.PARAMETER Days
How many days of changes to look at.

.PARAMETER Repeat
How many times each test runs.

.PARAMETER All
Stress every spec, whatever changed.
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 365)]
    [int]$Days = 7,
    [ValidateRange(2, 100)]
    [int]$Repeat = 10,
    [switch]$All
)
$ErrorActionPreference = 'Stop'

Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    if (-not (Test-Path 'package.json')) {
        Write-Host 'This project has no UI tests to stress.'
        return
    }
    $scripts = (Get-Content 'package.json' -Raw | ConvertFrom-Json).scripts
    # The same files CI tests: the minified ones where the project has test:min, or the project npm test names.
    $project = if ($scripts.'test:min') { 'min' } elseif ("$($scripts.test)" -match '--project[= ](\S+)') { $Matches[1] } else { $null }

    $changed = @()
    if (-not $All) {
        $since = "$Days days ago"
        $changed = @(git log --since="$since" --name-only --pretty=format: 2>$null) + @(git status --porcelain 2>$null | ForEach-Object { $_.Substring(3) -replace '^.* -> ', '' })
        $changed = @($changed | Where-Object { $_ } | ForEach-Object { $_.Trim().Trim('"') -replace '\\', '/' } | Sort-Object -Unique)
        if (-not $changed.Count) {
            Write-Host "Nothing changed in the last $Days days, so there is nothing to stress." -ForegroundColor Green
            return
        }
    }

    $specs = @()
    $setup = $changed | Where-Object { $_ -like 'tests/support/*' -or $_ -like 'playwright*.config.mjs' -or $_ -eq 'package-lock.json' }
    if (-not $All -and -not $setup -and (Test-Path '.test-cache')) {
        $changedSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$changed)
        $found = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($entry in Get-ChildItem '.test-cache' -Filter '*.json') {
            $record = Get-Content $entry.FullName -Raw | ConvertFrom-Json
            $spec = ($record.id -split ' > ')[1]
            if (-not $spec -or $found.Contains($spec)) { continue }
            foreach ($key in $record.deps.PSObject.Properties.Name) {
                if ($changedSet.Contains(($key -replace '^[a-z]+:', ''))) { [void]$found.Add($spec); break }
            }
        }
        # Specs changed themselves, including ones the cache never records, such as those that run scripts.
        foreach ($path in $changed) {
            if ($path -like 'tests/*.spec.mjs' -and (Test-Path $path)) { [void]$found.Add($path) }
        }
        $specs = @($found | Sort-Object)
        if (-not $specs.Count) {
            Write-Host "Nothing the UI tests use changed in the last $Days days, so there is nothing to stress." -ForegroundColor Green
            return
        }
        Write-Host "Stressing the $($specs.Count) specs affected by the last $Days days of changes:" -ForegroundColor Cyan
        $specs | ForEach-Object { Write-Host "  $_" }
    }
    else {
        Write-Host 'Stressing every spec.' -ForegroundColor Cyan
    }

    $arguments = @('playwright', 'test') + $specs + @("--repeat-each=$Repeat", '--workers=150%', '--retries=0', '--timeout=60000', '--reporter=dot')
    if ($project) { $arguments += "--project=$project" }
    # Every test runs, rather than the cache skipping the ones that passed.
    $previousNoCache = $env:PW_NO_CACHE
    $env:PW_NO_CACHE = '1'
    try {
        & npx @arguments
        $code = $LASTEXITCODE
    }
    finally {
        $env:PW_NO_CACHE = $previousNoCache
    }
    if ($code -ne 0) {
        Write-Host 'Some tests failed under load. Each is a timing race to fix: see "Tests that pass every time".' -ForegroundColor Red
        exit $code
    }
    Write-Host "Every test passed $Repeat times under load." -ForegroundColor Green
}
finally {
    Pop-Location
}
