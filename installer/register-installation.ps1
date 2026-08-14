$ErrorActionPreference = 'Stop'

$registryPath = 'HKLM:\SOFTWARE\AuthorityGate\RackSight'
$endpoint = 'https://license.authoritygate.com/api/racksight/installations'
$attemptedAt = [DateTimeOffset]::UtcNow.ToString('o')

function Set-RackSightRegistryValue {
    param([string]$Name, [string]$Value)
    New-ItemProperty -Path $registryPath -Name $Name -Value $Value -PropertyType String -Force | Out-Null
}

try {
    if (-not [Environment]::Is64BitProcess) {
        throw 'Registration must run in a 64-bit PowerShell process.'
    }

    $installation = Get-ItemProperty -Path $registryPath
    $email = [string]$installation.RegistrationEmail
    $company = [string]$installation.RegistrationCompany
    $appVersion = [string]$installation.Version
    if ([string]::IsNullOrWhiteSpace($email) -or $email -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
        throw 'The required registration email is missing or invalid.'
    }
    if ([string]::IsNullOrWhiteSpace($company)) {
        throw 'The required registration company name is missing.'
    }

    $ipProperties = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
    $fqdn = if ($ipProperties.DomainName) {
        "$($ipProperties.HostName).$($ipProperties.DomainName)"
    } else {
        try { [System.Net.Dns]::GetHostEntry($env:COMPUTERNAME).HostName }
        catch { $ipProperties.HostName }
    }
    if ([string]::IsNullOrWhiteSpace($fqdn)) { $fqdn = $env:COMPUTERNAME }
    $fqdn = $fqdn.Trim().TrimEnd('.').ToLowerInvariant()

    Set-RackSightRegistryValue -Name 'RegistrationAttemptedAt' -Value $attemptedAt
    Set-RackSightRegistryValue -Name 'ComputerFqdn' -Value $fqdn

    $payload = @{
        company = $company.Trim()
        email = $email.Trim().ToLowerInvariant()
        fqdn = $fqdn
        app_version = $appVersion
    } | ConvertTo-Json -Compress

    $response = Invoke-RestMethod -Method Post -Uri $endpoint -ContentType 'application/json' -Body $payload -TimeoutSec 10
    Set-RackSightRegistryValue -Name 'RegistrationStatus' -Value 'Registered'
    Set-RackSightRegistryValue -Name 'RegistrationId' -Value ([string]$response.id)
    Set-RackSightRegistryValue -Name 'RegisteredAt' -Value ([string]$response.received_at)
    Remove-ItemProperty -Path $registryPath -Name 'RegistrationLastError' -ErrorAction SilentlyContinue
} catch {
    try {
        if (-not (Test-Path $registryPath)) { New-Item -Path $registryPath -Force | Out-Null }
        Set-RackSightRegistryValue -Name 'RegistrationAttemptedAt' -Value $attemptedAt
        Set-RackSightRegistryValue -Name 'RegistrationStatus' -Value 'Skipped'
        $message = [string]$_.Exception.Message
        if ($message.Length -gt 500) { $message = $message.Substring(0, 500) }
        Set-RackSightRegistryValue -Name 'RegistrationLastError' -Value $message
    } catch { }
}

# Installation and RackSight operation never depend on registration success.
exit 0
