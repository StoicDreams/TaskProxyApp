$sharedFunctionsPath = Join-Path -Path $PSScriptRoot -ChildPath "SharedMethods.ps1"

. $sharedFunctionsPath

$projectRoot = Resolve-Path (Join-Path -Path $PSScriptRoot -ChildPath "..”)

FilteredFileUpdate $projectRoot deploy.yml 'RELEASE: (false|true)' "RELEASE: false"
FilteredFileUpdate $projectRoot deploy.yml ' if: (false|true)' " if: false"
