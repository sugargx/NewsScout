[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][string]$VaultName,
    [Parameter(Mandatory)][string]$IdentitySecretFile
)
$ErrorActionPreference = 'Stop'
if ($VaultName -notmatch '^[a-zA-Z0-9-]{3,24}$') { throw 'Invalid vault name.' }
$tokenJson = & az account get-access-token --subscription $SubscriptionId --resource https://vault.azure.net --output json --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Cannot obtain the selected subscription Key Vault credential.' }
$token = $tokenJson | ConvertFrom-Json
if ($token.tenant -ne $TenantId.ToString()) { throw 'Refusing a credential from another tenant.' }
$headers = @{ Authorization = 'Bearer ' + $token.accessToken }
$base = 'https://' + $VaultName + '.vault.azure.net'
$metadata = @()
$next = $base + '/secrets?api-version=7.4'
while ($next) {
    $page = Invoke-RestMethod -Uri $next -Headers $headers
    $metadata += $page.value
    $next = $page.nextLink
}
$names = @('csrf-secret', 'proxy-token', 'gateway-shared-secret', 'entra-client-secret')
foreach ($name in $names) {
    $existing = @($metadata | Where-Object { $_.id -eq ($base + '/secrets/' + $name) })
    if ($existing.Count -gt 0) {
        if (-not $existing[0].attributes.enabled) { throw "Secret $name is disabled; it was not changed." }
        continue
    }
    if ($name -eq 'entra-client-secret') {
        $secure = Get-Content -LiteralPath $IdentitySecretFile -Raw | ConvertTo-SecureString
        $value = [System.Net.NetworkCredential]::new('', $secure).Password
    } else {
        $bytes = New-Object byte[] 32
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
        $value = [Convert]::ToBase64String($bytes)
    }
    $payload = @{ value = $value; attributes = @{ enabled = $true }; contentType = 'NewsScout invited-preview service credential' } | ConvertTo-Json -Depth 4
    Invoke-RestMethod -Method Put -Uri ($base + '/secrets/' + $name + '?api-version=7.4') -Headers $headers -ContentType 'application/json' -Body $payload | Out-Null
    Remove-Variable value, payload
}
$copilot = @($metadata | Where-Object { $_.id -eq ($base + '/secrets/copilot-github-token') -and $_.attributes.enabled })
Remove-Variable token, tokenJson, headers
[pscustomobject]@{ vault = $VaultName; serviceSecretNames = $names; copilotSecretPresent = $copilot.Count -gt 0 } | ConvertTo-Json
