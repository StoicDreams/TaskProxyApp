
$sharedFunctionsPath = Join-Path -Path $PSScriptRoot -ChildPath "SharedMethods.ps1"

. $sharedFunctionsPath

FilteredFileUpdate .\ deploy.yml 'RELEASE: (false|true)' "RELEASE: false"
