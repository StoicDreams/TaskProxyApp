# This script is used to update the Patch version number
Param (
    [Switch]$major,
    [Switch]$minor
)

$sharedFunctionsPath = Join-Path -Path $PSScriptRoot -ChildPath "SharedMethods.ps1"

. $sharedFunctionsPath

$version = $null
$vmajor = 0
$vminor = 0
$vpatch = 0

$rgxTargetGetVersion = 'version = "([0-9]+)\.([0-9]+)\.([0-9]+)"'
Get-ChildItem -Path .\ -Filter *Cargo.toml -Recurse -File | ForEach-Object {
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

    FilteredFileUpdate .\ Cargo.toml 'version = "([0-9\.]+)"' "version = ""$version"""
    FilteredFileUpdate .\Docs README.md '\[Version: ([0-9\.]+)\]' "[Version: $version]"
    FilteredFileUpdate .\ deploy.yml ' VERSION: ([0-9\.]+)' " VERSION: $version"
    FilteredFileUpdate .\src-tauri tauri.conf.json '"version": "([0-9\.]+)"' """version"": ""$version"""
    FilteredFileUpdate .\src main.rs 'const VERSION: &str = "([0-9\.]+)";' "const VERSION: &str = ""$version"";"
    FilteredFileUpdate .\ deploy.yml 'RELEASE: (false|true)' "RELEASE: true"
}
else {
    Write-Host Current version was not found -ForegroundColor Red
}
