Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-PreviewAz {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $result = & az @Arguments --subscription $script:PreviewSubscriptionId --only-show-errors --output json
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed ($LASTEXITCODE): $($Arguments[0..([Math]::Min(2, $Arguments.Count - 1))] -join ' '). No account context was changed."
    }
    if ($result) {
        return ($result -join "`n" | ConvertFrom-Json -Depth 100)
    }
}

function Write-PreviewJson {
    param([Parameter(Mandatory)]$Value, [Parameter(Mandatory)][string]$Path)
    $Value | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $Path -Encoding utf8
}

function Resolve-PreviewTarget {
    # Explicit parameters win; otherwise the git-ignored local target record supplies the authorized identity.
    param(
        [string]$SubscriptionId,
        [string]$TenantId,
        [string]$DeployerPrincipalId,
        [string]$ExpectedAccount,
        [Parameter(Mandatory)][string]$TargetPath
    )

    $stored = $null
    if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
        $stored = Get-Content -LiteralPath $TargetPath -Raw | ConvertFrom-Json
    }
    $values = [ordered]@{
        SubscriptionId = @($SubscriptionId, 'subscriptionId')
        TenantId = @($TenantId, 'tenantId')
        DeployerPrincipalId = @($DeployerPrincipalId, 'deployerPrincipalId')
        ExpectedAccount = @($ExpectedAccount, 'expectedAccount')
    }
    $target = [ordered]@{}
    foreach ($name in $values.Keys) {
        $value = [string]$values[$name][0]
        if ([string]::IsNullOrWhiteSpace($value) -and $null -ne $stored) {
            $property = $stored.PSObject.Properties[$values[$name][1]]
            if ($null -ne $property) { $value = [string]$property.Value }
        }
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "Missing $name. Pass -$name or record the authorized preview target in $TargetPath (git-ignored)."
        }
        $target[$name] = $value.Trim()
    }
    foreach ($name in 'SubscriptionId', 'TenantId', 'DeployerPrincipalId') {
        $parsed = [guid]::Empty
        if (-not [guid]::TryParse($target[$name], [ref]$parsed)) { throw "$name must be a GUID." }
    }
    return [pscustomobject]$target
}

function Initialize-PreviewContext {
    param(
        [string]$SubscriptionId,
        [string]$TenantId,
        [string]$DeployerPrincipalId,
        [string]$ExpectedAccount
    )

    $script:PreviewSubscriptionId = $SubscriptionId
    $script:PreviewTenantId = $TenantId
    $script:PreviewPrincipalId = $DeployerPrincipalId
    $script:PreviewDefaultAccount = & az account show --query '{id:id,tenantId:tenantId,user:user.name}' --output json --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect current CLI context; no logout or default-account change will be attempted.' }
    $account = Invoke-PreviewAz -Arguments @('account', 'show')
    if ($account.id -ne $SubscriptionId -or $account.tenantId -ne $TenantId -or
        $account.user.name -ne $ExpectedAccount -or $account.state -ne 'Enabled') {
        throw 'Subscription, tenant, signed-in account or subscription state differs from the authorized preview target.'
    }
    $null = Get-PreviewToken -Resource 'https://management.azure.com/'
    Write-Host "Verified target: $SubscriptionId / $TenantId / $ExpectedAccount"
}

function Assert-PreviewDefaultUnchanged {
    $current = & az account show --query '{id:id,tenantId:tenantId,user:user.name}' --output json --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify the unchanged global Azure CLI context.' }
    if (($current -join "`n") -ne ($script:PreviewDefaultAccount -join "`n")) {
        throw 'The global CLI default changed during this operation. This script did not change it.'
    }
}

function Get-PreviewToken {
    param([Parameter(Mandatory)][string]$Resource)

    $token = Invoke-PreviewAz -Arguments @('account', 'get-access-token', '--resource', $Resource)
    $payload = $token.accessToken.Split('.')[1].Replace('-', '+').Replace('_', '/')
    $payload = $payload.PadRight($payload.Length + (4 - $payload.Length % 4) % 4, '=')
    $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
    if ($token.tenant -ne $script:PreviewTenantId -or $claims.tid -ne $script:PreviewTenantId -or
        $claims.oid -ne $script:PreviewPrincipalId) {
        throw 'Access token does not belong to the authorized personal tenant and deployer. Refusing request.'
    }
    return $token.accessToken
}

function Invoke-PreviewVault {
    param(
        [Parameter(Mandatory)][string]$VaultUri,
        [Parameter(Mandatory)][string]$SecretName,
        [ValidateSet('Get', 'Put')][string]$Method = 'Get',
        [string]$Value,
        [switch]$AllowMissing
    )

    # Explicitly acquire the personal-tenant token: az rest can otherwise choose a work identity.
    $token = Get-PreviewToken -Resource 'https://vault.azure.net'
    $uri = "$($VaultUri.TrimEnd('/'))/secrets/${SecretName}?api-version=7.4"
    $headers = @{ Authorization = "Bearer $token" }
    $body = if ($Method -eq 'Put') {
        @{ value = $Value; attributes = @{ enabled = $true }; tags = @{ product = 'NewsScout'; environment = 'invited-preview' } } | ConvertTo-Json -Depth 8 -Compress
    } else { $null }
    try {
        for ($attempt = 0; $attempt -lt 24; $attempt++) {
            try {
                $request = @{ Uri = $uri; Headers = $headers; Method = $Method; ErrorAction = 'Stop' }
                if ($Method -eq 'Put') {
                    $request.Body = $body
                    $request.ContentType = 'application/json'
                }
                return Invoke-RestMethod @request
            } catch {
                $responseProperty = $_.Exception.PSObject.Properties['Response']
                $status = if ($responseProperty -and $responseProperty.Value) { [int]$responseProperty.Value.StatusCode } else { 0 }
                if ($status -eq 404 -and $AllowMissing) { return $null }
                if ($status -in @(0, 403, 429, 500, 502, 503, 504) -and $attempt -lt 23) {
                    Start-Sleep -Seconds 10
                    continue
                }
                # Never include request bodies or returned secret values in an error message.
                throw "Key Vault $Method failed for secret '$SecretName' (HTTP $status)."
            }
        }
    } finally {
        $token = $null
        $headers = $null
        $body = $null
        $Value = $null
    }
}

function Set-PreviewSecretIfChanged {
    param([string]$VaultUri, [string]$SecretName, [string]$Value)
    $existing = Invoke-PreviewVault -VaultUri $VaultUri -SecretName $SecretName -AllowMissing
    if ($null -eq $existing -or $existing.value -cne $Value) {
        $null = Invoke-PreviewVault -VaultUri $VaultUri -SecretName $SecretName -Method Put -Value $Value
    }
}

function Set-PreviewSecretIfMissing {
    param([string]$VaultUri, [string]$SecretName, [string]$Value)
    $existing = Invoke-PreviewVault -VaultUri $VaultUri -SecretName $SecretName -AllowMissing
    if ($null -eq $existing) {
        $null = Invoke-PreviewVault -VaultUri $VaultUri -SecretName $SecretName -Method Put -Value $Value
    }
}

function Get-PreviewPostgresExtensions {
    param([string]$ResourceGroupName, [string]$ServerName)
    $setting = Invoke-PreviewAz -Arguments @('postgres', 'flexible-server', 'parameter', 'show',
        '--resource-group', $ResourceGroupName, '--server-name', $ServerName, '--name', 'azure.extensions')
    return @(@('PG_TRGM') + @($setting.value -split ',') |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_.Trim().ToUpperInvariant() } | Sort-Object -Unique)
}
