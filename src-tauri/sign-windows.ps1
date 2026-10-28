param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$FilePath
)

$ErrorActionPreference = "Stop"

try {
    $file = (Resolve-Path -LiteralPath $FilePath).Path

    Write-Host "Azure signing: $file"

    # Validate required environment variables
    $required = @(
        "EV_AZURE_SECRET",
        "EV_AZURE_CLIENT",
        "EV_AZURE_TENANT",
        "EV_AZURE_ENDPOINT",
        "EV_AZURE_ACCOUNT",
        "EV_AZURE_PROFILE"
    )

    foreach ($name in $required) {
        if ([string]::IsNullOrWhiteSpace(
            [Environment]::GetEnvironmentVariable($name)
        )) {
            throw "Missing environment variable: $name"
        }
    }

    Import-Module Az.Accounts -ErrorAction Stop
    Import-Module TrustedSigning -ErrorAction Stop

    # Authenticate with Azure
    $password = ConvertTo-SecureString `
        $env:EV_AZURE_SECRET -AsPlainText -Force

    $credential = [PSCredential]::new(
        $env:EV_AZURE_CLIENT,
        $password
    )

    $null = Connect-AzAccount `
        -ServicePrincipal `
        -Tenant $env:EV_AZURE_TENANT `
        -Credential $credential `
        -ErrorAction Stop

    # Sign the file Tauri passed to us
    Invoke-TrustedSigning `
        -Endpoint $env:EV_AZURE_ENDPOINT `
        -CodeSigningAccountName $env:EV_AZURE_ACCOUNT `
        -CertificateProfileName $env:EV_AZURE_PROFILE `
        -FileDigest sha256 `
        -Files $file `
        -TimestampRfc3161 "http://timestamp.acs.microsoft.com" `
        -TimestampDigest sha256 `
        -ErrorAction Stop

    Write-Host "Signing completed: $file"
    exit 0
}
catch {
    Write-Error "Azure signing failed: $_"
    exit 1
}
