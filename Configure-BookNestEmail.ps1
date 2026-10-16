$ErrorActionPreference = "Stop"

$projectPath = Join-Path $PSScriptRoot "LibraryManagement.csproj"
if (-not (Test-Path -LiteralPath $projectPath)) {
    throw "LibraryManagement.csproj was not found beside this script."
}

[xml]$project = Get-Content -LiteralPath $projectPath -Raw
$userSecretsId = $project.Project.PropertyGroup.UserSecretsId
if ([string]::IsNullOrWhiteSpace($userSecretsId)) {
    throw "The project does not have a UserSecretsId. Initialize .NET User Secrets first."
}

$secretDirectory = Join-Path (Join-Path $env:APPDATA "Microsoft\UserSecrets") $userSecretsId
$secretFile = Join-Path $secretDirectory "secrets.json"
$securePassword = Read-Host "Paste your NEW Gmail App Password, then press Enter" -AsSecureString
if ($null -eq $securePassword -or $securePassword.Length -eq 0) {
    throw "No password was entered. Run the script again."
}

$pointer = [IntPtr]::Zero
$plainPassword = $null
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Replace(" ", "")

    $secrets = @{}
    if (Test-Path -LiteralPath $secretFile) {
        $existingSecrets = Get-Content -LiteralPath $secretFile -Raw | ConvertFrom-Json
        foreach ($property in $existingSecrets.PSObject.Properties) {
            $secrets[$property.Name] = $property.Value
        }
    }

    $secrets["Email:Smtp:Password"] = $plainPassword
    New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
    $json = $secrets | ConvertTo-Json
    [System.IO.File]::WriteAllText(
        $secretFile,
        $json + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false))

    Write-Host "Saved the SMTP password to the local .NET User Secrets file."
    Write-Host "It was not added to the project folder or GitHub."
}
finally {
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    $plainPassword = $null
    $securePassword = $null
    $secrets = $null
}
