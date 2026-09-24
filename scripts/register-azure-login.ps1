[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$ExpectedPrincipalId,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\tmp\azure-preview-20260920'),
    [string]$SiteOrigin
)
$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($output) | Out-Null
$recordPath = Join-Path $output 'identity.json'
$secretPath = Join-Path $output 'identity-secret.dpapi'
$credentialJson = & az account get-access-token --subscription $SubscriptionId --resource-type ms-graph --output json --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Cannot obtain the requested personal subscription credential.' }
$credential = $credentialJson | ConvertFrom-Json
if ($credential.tenant -ne $TenantId.ToString()) { throw 'Refusing to use a Graph token from another tenant.' }
$headers = @{ Authorization = 'Bearer ' + $credential.accessToken }
$me = Invoke-RestMethod -Uri 'https://graph.microsoft.com/v1.0/me?$select=id' -Headers $headers
if ($me.id -ne $ExpectedPrincipalId.ToString()) { throw 'Refusing to register an app for an unexpected principal.' }

if (Test-Path -LiteralPath $recordPath) {
    $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    if ($record.subscriptionId -ne $SubscriptionId.ToString() -or $record.tenantId -ne $TenantId.ToString()) {
        throw 'The existing identity record belongs to another deployment.'
    }
    $application = Invoke-RestMethod -Uri ('https://graph.microsoft.com/v1.0/applications/' + $record.objectId) -Headers $headers
    if ($application.appId -ne $record.clientId -or 'newsscout-invited-preview' -notin $application.tags) {
        throw 'The existing registration does not match the NewsScout deployment.'
    }
} else {
    $body = @{
        displayName = 'NewsScout Invited Preview'
        signInAudience = 'AzureADandPersonalMicrosoftAccount'
        tags = @('newsscout-invited-preview')
        api = @{ requestedAccessTokenVersion = 2 }
        web = @{ implicitGrantSettings = @{ enableIdTokenIssuance = $true; enableAccessTokenIssuance = $false } }
        requiredResourceAccess = @()
    } | ConvertTo-Json -Depth 8
    $application = Invoke-RestMethod -Method Post -Uri 'https://graph.microsoft.com/v1.0/applications' -Headers $headers -ContentType 'application/json' -Body $body
    $record = @{
        subscriptionId = $SubscriptionId.ToString()
        tenantId = $TenantId.ToString()
        objectId = $application.id
        clientId = $application.appId
        createdAt = [DateTime]::UtcNow.ToString('o')
    }
    [IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    $principalBody = @{ appId = $application.appId } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri 'https://graph.microsoft.com/v1.0/servicePrincipals' -Headers $headers -ContentType 'application/json' -Body $principalBody | Out-Null
}
if (-not (Test-Path -LiteralPath $secretPath)) {
    $passwordBody = @{ passwordCredential = @{ displayName = 'newsscout-preview-90-days'; endDateTime = [DateTime]::UtcNow.AddDays(90).ToString('o') } } | ConvertTo-Json -Depth 4
    $password = Invoke-RestMethod -Method Post -Uri ('https://graph.microsoft.com/v1.0/applications/' + $application.id + '/addPassword') -Headers $headers -ContentType 'application/json' -Body $passwordBody
    $encrypted = ConvertTo-SecureString $password.secretText -AsPlainText -Force | ConvertFrom-SecureString
    [IO.File]::WriteAllText($secretPath, $encrypted, [Text.UTF8Encoding]::new($false))
    Remove-Variable password, encrypted
}
if ($SiteOrigin) {
    $uri = [uri]$SiteOrigin
    if ($uri.Scheme -ne 'https' -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.UserInfo) { throw 'SiteOrigin must be the HTTPS origin.' }
    $base = $uri.GetLeftPart([UriPartial]::Authority)
    $update = @{
        web = @{
            redirectUris = @($base + '/.auth/login/aad/callback')
            logoutUrl = $base + '/.auth/logout'
            implicitGrantSettings = @{ enableIdTokenIssuance = $true; enableAccessTokenIssuance = $false }
        }
        info = @{ privacyStatementUrl = $base + '/privacy' }
    } | ConvertTo-Json -Depth 8
    Invoke-RestMethod -Method Patch -Uri ('https://graph.microsoft.com/v1.0/applications/' + $application.id) -Headers $headers -ContentType 'application/json' -Body $update | Out-Null
}
Remove-Variable credential, credentialJson, headers
[pscustomobject]@{ clientId = $application.appId; objectId = $application.id; tenantId = $TenantId; recordPath = $recordPath; encryptedSecretPath = $secretPath } | ConvertTo-Json
