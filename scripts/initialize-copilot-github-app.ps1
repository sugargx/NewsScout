[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9._-]{8,128}$')][string]$GitHubClientId,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9-]{3,24}$')][string]$VaultName,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9-]{1,39}$')][string]$ExpectedGitHubLogin,
    [ValidatePattern('^[A-Za-z0-9-]{1,127}$')][string]$SecretName = 'copilot-github-oauth-bundle',
    [switch]$ReplaceExisting,
    [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'
$githubHeaders = @{
    Accept = 'application/json'
    'User-Agent' = 'NewsScout-Copilot-Credential-Bootstrap'
}
$vaultBase = "https://$VaultName.vault.azure.net"
$accessToken = $null
$refreshToken = $null
$nextAccessToken = $null
$nextRefreshToken = $null
$bundleJson = $null
$vaultPayload = $null

function Invoke-GitHubForm {
    param([hashtable]$Body)
    Invoke-RestMethod -Method Post -Uri 'https://github.com/login/oauth/access_token' `
        -Headers $githubHeaders -ContentType 'application/x-www-form-urlencoded' -Body $Body
}

function Assert-TokenResponse {
    param([object]$Response, [string]$Stage)
    if ($Response.error) {
        $code = if ([string]$Response.error -match '^[a-z_]+$') { [string]$Response.error } else { 'oauth_error' }
        throw "GitHub $Stage failed: $code."
    }
    if ([string]$Response.access_token -notmatch '^ghu_' -or
        [string]$Response.refresh_token -notmatch '^ghr_' -or
        [int64]$Response.expires_in -le 3600 -or
        [int64]$Response.refresh_token_expires_in -le [int64]$Response.expires_in) {
        throw "GitHub $Stage did not return an expiring GitHub App user credential."
    }
}

function Get-GitHubAccount {
    param([Parameter(Mandatory)][string]$Token)
    $headers = @{
        Accept = 'application/vnd.github+json'
        Authorization = "Bearer $Token"
        'User-Agent' = 'NewsScout-Copilot-Credential-Bootstrap'
        'X-GitHub-Api-Version' = '2026-03-10'
    }
    $account = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers
    if ($account.id -isnot [ValueType] -or [int64]$account.id -le 0 -or
        [string]::IsNullOrWhiteSpace([string]$account.login)) {
        throw 'GitHub account verification returned an invalid identity.'
    }
    return $account
}

try {
    $tokenJson = & az account get-access-token --subscription $SubscriptionId `
        --resource https://vault.azure.net --output json --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Cannot obtain the selected subscription Key Vault credential.' }
    $azureToken = $tokenJson | ConvertFrom-Json
    if ($azureToken.tenant -ne $TenantId.ToString()) {
        throw 'Refusing a Key Vault credential from another tenant.'
    }
    $vaultHeaders = @{ Authorization = 'Bearer ' + $azureToken.accessToken }

    $metadata = @()
    $nextPage = "$vaultBase/secrets?api-version=7.4"
    while ($nextPage) {
        $page = Invoke-RestMethod -Uri $nextPage -Headers $vaultHeaders
        $metadata += $page.value
        $nextPage = $page.nextLink
    }
    $existing = @($metadata | Where-Object {
        $_.id -eq "$vaultBase/secrets/$SecretName" -and $_.attributes.enabled
    })
    if ($existing.Count -gt 0 -and -not $ReplaceExisting) {
        throw "Secret $SecretName already exists. Use -ReplaceExisting only for an intentional reauthorization."
    }

    $device = Invoke-RestMethod -Method Post -Uri 'https://github.com/login/device/code' `
        -Headers $githubHeaders -ContentType 'application/x-www-form-urlencoded' `
        -Body @{ client_id = $GitHubClientId }
    if ([string]::IsNullOrWhiteSpace([string]$device.device_code) -or
        [string]::IsNullOrWhiteSpace([string]$device.user_code) -or
        [string]::IsNullOrWhiteSpace([string]$device.verification_uri)) {
        throw 'GitHub did not return a valid device authorization challenge.'
    }
    $interval = [Math]::Max(5, [int]$device.interval)
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds([int]$device.expires_in)
    Write-Host "Open $($device.verification_uri) and enter code $($device.user_code)."
    Write-Host "Authorize only the expected dedicated GitHub account: $ExpectedGitHubLogin."
    if ($OpenBrowser) { Start-Process $device.verification_uri }

    $initial = $null
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds $interval
        $candidate = Invoke-GitHubForm -Body @{
            client_id = $GitHubClientId
            device_code = $device.device_code
            grant_type = 'urn:ietf:params:oauth:grant-type:device_code'
        }
        if ($candidate.access_token) {
            $initial = $candidate
            break
        }
        switch ([string]$candidate.error) {
            'authorization_pending' { continue }
            'slow_down' {
                $interval = [Math]::Max($interval + 5, [int]$candidate.interval)
                continue
            }
            'expired_token' { throw 'The GitHub device code expired before authorization completed.' }
            'access_denied' { throw 'GitHub device authorization was denied.' }
            'device_flow_disabled' { throw 'Device Flow is not enabled for this GitHub App.' }
            default {
                $code = if ([string]$candidate.error -match '^[a-z_]+$') { [string]$candidate.error } else { 'oauth_error' }
                throw "GitHub device authorization failed: $code."
            }
        }
    }
    if ($null -eq $initial) { throw 'The GitHub device authorization window expired.' }
    Assert-TokenResponse -Response $initial -Stage 'device authorization'
    $accessToken = [string]$initial.access_token
    $refreshToken = [string]$initial.refresh_token
    $firstAccount = Get-GitHubAccount -Token $accessToken
    if (-not [string]::Equals([string]$firstAccount.login, $ExpectedGitHubLogin, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The authorized GitHub account does not match ExpectedGitHubLogin.'
    }

    $refreshed = Invoke-GitHubForm -Body @{
        client_id = $GitHubClientId
        grant_type = 'refresh_token'
        refresh_token = $refreshToken
    }
    Assert-TokenResponse -Response $refreshed -Stage 'immediate refresh verification'
    $nextAccessToken = [string]$refreshed.access_token
    $nextRefreshToken = [string]$refreshed.refresh_token
    $secondAccount = Get-GitHubAccount -Token $nextAccessToken
    if ([int64]$secondAccount.id -ne [int64]$firstAccount.id -or
        -not [string]::Equals([string]$secondAccount.login, $ExpectedGitHubLogin, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The refreshed GitHub credential belongs to a different account.'
    }

    $now = [DateTimeOffset]::UtcNow
    $accessExpiresAt = $now.AddSeconds([int64]$refreshed.expires_in)
    $refreshExpiresAt = $now.AddSeconds([int64]$refreshed.refresh_token_expires_in)
    $generationId = [Guid]::NewGuid().ToString()
    $bundleJson = [ordered]@{
        version = 1
        generationId = $generationId
        accountId = ([int64]$secondAccount.id).ToString()
        accessToken = $nextAccessToken
        accessTokenExpiresAt = $accessExpiresAt.ToString('O')
        refreshToken = $nextRefreshToken
        refreshTokenExpiresAt = $refreshExpiresAt.ToString('O')
        updatedAt = $now.ToString('O')
    } | ConvertTo-Json -Compress
    $vaultPayload = @{
        value = $bundleJson
        contentType = 'application/vnd.newsscout.github-oauth-bundle+json'
        attributes = @{
            enabled = $true
            exp = $refreshExpiresAt.ToUnixTimeSeconds()
        }
        tags = @{
            accountId = ([int64]$secondAccount.id).ToString()
            generationId = $generationId
            managedBy = 'NewsScout'
        }
    } | ConvertTo-Json -Depth 5 -Compress

    $saved = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $saved = Invoke-RestMethod -Method Put `
                -Uri "$vaultBase/secrets/$SecretName?api-version=7.4" `
                -Headers $vaultHeaders -ContentType 'application/json' -Body $vaultPayload
            break
        } catch {
            if ($attempt -eq 3) { throw }
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
    $verified = Invoke-RestMethod -Uri "$vaultBase/secrets/$SecretName?api-version=7.4" `
        -Headers $vaultHeaders
    $storedBundle = $verified.value | ConvertFrom-Json
    if ($storedBundle.generationId -ne $generationId) {
        throw 'The saved Key Vault credential generation could not be verified.'
    }
    $secretVersion = ([Uri]$saved.id).Segments[-1].Trim('/')
    [pscustomobject]@{
        vault = $VaultName
        secretName = $SecretName
        secretVersion = $secretVersion
        accountId = ([int64]$secondAccount.id).ToString()
        accountVerified = $true
        immediateRefreshVerified = $true
        accessTokenExpiresAt = $accessExpiresAt.ToString('O')
        refreshTokenExpiresAt = $refreshExpiresAt.ToString('O')
    } | ConvertTo-Json
} finally {
    $accessToken = $null
    $refreshToken = $null
    $nextAccessToken = $null
    $nextRefreshToken = $null
    $bundleJson = $null
    $vaultPayload = $null
    $initial = $null
    $refreshed = $null
    $storedBundle = $null
    $verified = $null
    $azureToken = $null
    $tokenJson = $null
    $vaultHeaders = $null
}
