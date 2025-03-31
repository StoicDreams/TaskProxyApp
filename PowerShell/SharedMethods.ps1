
function UpdateProjectVersion {
    Param (
        [string] $projectPath,
        [string] $version,
        [string] $rgxTargetXML,
        [string] $newXML
    )

    if (!(Test-Path -Path $projectPath)) {
        Write-Host "Not found - $projectPath" -BackgroundColor Red -ForegroundColor White
        return;
    }
    $content = Get-Content -Path $projectPath -Encoding UTF8 -Raw

    $content -match $rgxTargetXML | ForEach-Object {
        if ($_ -eq $False) { return; }
        $old = $Matches[0];
        Write-Host "Matches '$old'";
        if ($old -eq $newXML) {
            Write-Host "Already up to date - $projectPath - $old === $newXML" -ForegroundColor Cyan
            return;
        }
        $newContent = ($content).replace($old, $newXML).Trim()
        $newContent | Set-Content -Path $projectPath -Encoding UTF8
        Write-Host "Updated - $projectPath" -ForegroundColor Green
    }
}

function FilteredFileUpdate {
    Param (
        [string] $path,
        [string] $filter,
        [string] $rgxTargetXML,
        [string] $newXML
    )
    $count = 0
    Get-ChildItem -Path $path -Filter $filter -Recurse -File -Force | ForEach-Object {
        $count += 1
        UpdateProjectVersion $_.FullName $version $rgxTargetXML $newXML
    }
    if ($count -eq 0) {
        Write-Host "Filter not matched $path -> $filter" -ForegroundColor Red
    }
}
