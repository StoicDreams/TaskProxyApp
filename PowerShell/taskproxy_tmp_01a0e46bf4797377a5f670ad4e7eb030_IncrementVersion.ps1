# This script is used to update the Patch version number
Param (
    [Switch]$major,
    [Switch]$minor
)

$sharedFunctionsPath = Join-Path -Path $PSScriptRoot -ChildPath “SharedMethods.ps1"

. $sharedFunctionsPath

$version = $null
$vmajor = 0
$vminor = 0
$vpatch = 0

$rgxTargetGetVersion = 'version = "([0-9]+)\.([0-9]+)\.([0-9]+)"'
$projectRoot = Resolve-Path (Join-Path -Path $PSScriptRoot -ChildPath "..”)

Get-ChildItem -Path $projectRoot -Filter *Cargo.toml -Recurse -File | ForEach-Object {
    $result = Select-String -Path $_.FullName -Pattern $rgxTargetGetVersion
    if ($result.Matches.Count -gt 0) {
        $vmajor = [int]$result.Matches[0].Groups[1].Value
        $vminor = [int]$result.Matches[0].Groups[2].Value
        $vpatch = [int]$result.Matches[0].Groups[3].Value
        if ($major) {
            $vmajor = $vmajor + 1;
            $vminor = 0;
            $vpatch = 0;
        }
        elseif ($minor) {
            $vminor = $vminor + 1;
            $vpatch = 0;
        }
        else {
            $vpatch = $vpatch + 1;
        }
        $script:version = "$vmajor.$vminor.$vpatch"
    }
    else {
        Write-Host "Source Not Found" -ForegroundColor Red
    }
}

Write-Host "Found version $version";

if ($null -ne $version) {
    Write-Host Found Version: $version -ForegroundColor Green
    $rootpath = Get-Location
    $rootpath = $rootpath.ToString().ToLower()
    Write-Host Path: "Root Path Start: $rootpath"

    FilteredFileUpdate "$projectRoot" Cargo.toml 'version = "([0-9\.]+)"' "version = ""$version"""
    FilteredFileUpdate "$projectRoot/src-tauri" Cargo.toml 'version = "([0-9\.]+)"' "version = ""$version"""
    FilteredFileUpdate "$projectRoot/Docs" README.md '\[Version: ([0-9\.]+)\]' "[Version: $version]"
    FilteredFileUpdate "$projectRoot" deploy.yml ' VERSION: ([0-9\.]+)' " VERSION: $version"
    FilteredFileUpdate "$projectRoot/src-tauri" tauri.conf.json '"version": "([0-9\.]+)"' """version"": ""$version"""
    FilteredFileUpdate "$projectRoot/src" main.rs 'const VERSION: &amp;str = "([0-9\.]+)";' "const VERSION: &amp;str = ""$version"";"
    FilteredFileUpdate "$projectRoot" deploy.yml ' if: (false|true)' " if: true"
    FilteredFileUpdate "$projectRoot/src-tauri" tauri.conf.json '"userAgent": "Task Proxy/([0-9\.]+)"' """userAgent"": ""Task Proxy/$version"""
}
else {
    Write-Host Current version was not found -ForegroundColor Red
}
