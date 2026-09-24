[CmdletBinding()]
param(
    [switch]$Provision,
    [string]$SubscriptionId,
    [string]$TenantId,
    [string]$DeployerPrincipalId,
    [string]$ExpectedAccount,
    [string]$TargetPath = 'tmp\azure-preview-20260920\target.json',
    [string]$ResourceGroupName = 'rg-newsscout-preview',
    [string]$Location = 'eastasia',
    [string]$ArtifactDirectory = 'tmp\azure-preview-20260920'
)

. "$PSScriptRoot\azure-infra-common.ps1"
$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not [IO.Path]::IsPathRooted($TargetPath)) { $TargetPath = Join-Path $repoRoot $TargetPath }
$target = Resolve-PreviewTarget -SubscriptionId $SubscriptionId -TenantId $TenantId -DeployerPrincipalId $DeployerPrincipalId -ExpectedAccount $ExpectedAccount -TargetPath $TargetPath
$SubscriptionId = $target.SubscriptionId
$TenantId = $target.TenantId
$DeployerPrincipalId = $target.DeployerPrincipalId
$ExpectedAccount = $target.ExpectedAccount
$artifactPath = [IO.Path]::GetFullPath((Join-Path $repoRoot $ArtifactDirectory))
if (-not $artifactPath.StartsWith("$repoRoot\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Operational artifacts must stay inside the project directory.'
}
$null = New-Item -ItemType Directory -Path $artifactPath -Force
Initialize-PreviewContext -SubscriptionId $SubscriptionId -TenantId $TenantId -DeployerPrincipalId $DeployerPrincipalId -ExpectedAccount $ExpectedAccount

function New-PreviewParameters {
    param([hashtable]$Values, [string]$FileName)
    $parameters = @{}
    foreach ($key in $Values.Keys) { $parameters[$key] = @{ value = $Values[$key] } }
    $document = @{
        '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters = $parameters
    }
    $path = Join-Path $artifactPath $FileName
    Write-PreviewJson -Value $document -Path $path
    return $path
}

function Invoke-PreviewGroupDeployment {
    param([string]$Name, [string]$TemplateName, [string]$ParametersPath)
    $base = @('--resource-group', $ResourceGroupName, '--name', $Name, '--template-file',
        (Join-Path $artifactPath "$TemplateName.template.json"), '--parameters', "@$ParametersPath", '--mode', 'Incremental')
    $whatIf = Invoke-PreviewAz -Arguments (@('deployment', 'group', 'what-if') + $base + @('--result-format', 'ResourceIdOnly', '--no-pretty-print'))
    Write-PreviewJson -Value $whatIf -Path (Join-Path $artifactPath "$TemplateName.what-if.json")
    if ($whatIf.status -ne 'Succeeded') { throw "$TemplateName what-if did not succeed." }
    $deletes = @($whatIf.changes | Where-Object changeType -EQ 'Delete')
    if ($deletes.Count -gt 0) { throw "$TemplateName would delete resources; refusing deployment." }
    Write-Host "$TemplateName what-if succeeded ($(@($whatIf.changes).Count) resource entries)."
    if ($Provision) {
        $outputs = Invoke-PreviewAz -Arguments (@('deployment', 'group', 'create') + $base + @('--query', 'properties.outputs'))
        Write-PreviewJson -Value $outputs -Path (Join-Path $artifactPath "$TemplateName.outputs.json")
        return $outputs
    }
}

try {
    foreach ($template in @('resource-group', 'bootstrap', 'foundation')) {
        & az bicep build --file (Join-Path $repoRoot "infra\azure\$template.bicep") --outfile (Join-Path $artifactPath "$template.template.json") --only-show-errors
        if ($LASTEXITCODE -ne 0) { throw "Bicep build failed: $template" }
    }

    $requiredProviders = @('Microsoft.App', 'Microsoft.DBforPostgreSQL', 'Microsoft.Network',
        'Microsoft.ManagedIdentity', 'Microsoft.ContainerRegistry', 'Microsoft.Storage',
        'Microsoft.KeyVault', 'Microsoft.OperationalInsights', 'Microsoft.Insights')
    foreach ($provider in $requiredProviders) {
        $state = Invoke-PreviewAz -Arguments @('provider', 'show', '--namespace', $provider, '--query', 'registrationState')
        if ($state -ne 'Registered') {
            if (-not $Provision) { throw "Provider $provider is $state. Provision mode registers only required providers." }
            $null = Invoke-PreviewAz -Arguments @('provider', 'register', '--namespace', $provider, '--wait')
        }
    }

    $capabilities = @(Invoke-PreviewAz -Arguments @('postgres', 'flexible-server', 'list-skus', '--location', $Location))
    Write-PreviewJson -Value $capabilities -Path (Join-Path $artifactPath "postgres-$Location-capabilities.json")
    $editions = @($capabilities | ForEach-Object { $_.supportedServerEditions } | Where-Object name -EQ 'Burstable')
    $b1ms = @($editions | ForEach-Object { $_.supportedServerSkus } | Where-Object name -EQ 'Standard_B1ms')
    $version17 = @($capabilities | ForEach-Object { $_.supportedServerVersions } | Where-Object name -EQ '17')
    $storage32 = @($editions | ForEach-Object { $_.supportedStorageEditions } |
        Where-Object name -EQ 'ManagedDisk' | ForEach-Object { $_.supportedStorageMb } |
        Where-Object storageSizeMb -EQ 32768)
    if (-not $b1ms -or -not $version17 -or -not $storage32) {
        throw "$Location does not advertise the authorized PostgreSQL 17 / Standard_B1ms / 32 GiB tier. No costly fallback is permitted."
    }
    $restrictions = @($capabilities + $editions + $b1ms + $version17 + $storage32 |
        Where-Object { $_.status -in @('Disabled', 'Restricted') -or $_.reason })
    if ($restrictions.Count -gt 0) { throw "$Location PostgreSQL capabilities report a restriction; inspect the non-secret capability artifact." }
    $usage = Invoke-PreviewAz -Arguments @('containerapp', 'list-usages', '--location', $Location)
    Write-PreviewJson -Value $usage -Path (Join-Path $artifactPath "container-apps-$Location-quota.json")
    $environmentQuota = @($usage.value | Where-Object { $_.name.value -eq 'ManagedEnvironmentCount' })
    if (-not $environmentQuota -or $environmentQuota[0].limit -le $environmentQuota[0].currentValue) {
        throw "No available Container Apps environment quota in $Location. No quota increase will be requested."
    }

    $exists = Invoke-PreviewAz -Arguments @('group', 'exists', '--name', $ResourceGroupName)
    if ($exists) {
        $group = Invoke-PreviewAz -Arguments @('group', 'show', '--name', $ResourceGroupName)
        if ($group.tags.product -ne 'NewsScout' -or $group.tags.environment -ne 'invited-preview' -or $group.location -ne $Location) {
            throw 'The existing group is not this NewsScout invited preview in the requested location; refusing changes.'
        }
    } else {
        $groupParameters = New-PreviewParameters -Values @{ resourceGroupName = $ResourceGroupName; location = $Location } -FileName 'resource-group.parameters.json'
        $base = @('--name', 'newsscout-preview-group', '--location', $Location, '--template-file',
            (Join-Path $artifactPath 'resource-group.template.json'), '--parameters', "@$groupParameters")
        $whatIf = Invoke-PreviewAz -Arguments (@('deployment', 'sub', 'what-if') + $base + @('--result-format', 'ResourceIdOnly', '--no-pretty-print'))
        Write-PreviewJson -Value $whatIf -Path (Join-Path $artifactPath 'resource-group.what-if.json')
        if ($whatIf.status -ne 'Succeeded') { throw 'Resource-group what-if did not succeed.' }
        if (-not $Provision) {
            Write-Host 'Build and subscription what-if passed. Group what-if runs before each group deployment in -Provision mode.'
            return
        }
        $null = Invoke-PreviewAz -Arguments (@('deployment', 'sub', 'create') + $base + @('--query', 'properties.outputs'))
    }

    $bootstrapParameters = New-PreviewParameters -Values @{
        location = $Location
        tenantId = $TenantId
        deployerPrincipalId = $DeployerPrincipalId
    } -FileName 'bootstrap.parameters.json'
    $bootstrap = Invoke-PreviewGroupDeployment -Name 'newsscout-preview-bootstrap' -TemplateName 'bootstrap' -ParametersPath $bootstrapParameters
    if (-not $Provision) {
        $bootstrap = Invoke-PreviewAz -Arguments @('deployment', 'group', 'show', '--resource-group', $ResourceGroupName,
            '--name', 'newsscout-preview-bootstrap', '--query', 'properties.outputs')
    }
    $vaultUri = $bootstrap.keyVaultUri.value
    $postgresName = "psql-newsscout-preview-$($bootstrap.resourceToken.value)"
    $existingPostgres = @(Invoke-PreviewAz -Arguments @('resource', 'list', '--resource-group', $ResourceGroupName,
        '--resource-type', 'Microsoft.DBforPostgreSQL/flexibleServers') | Where-Object name -EQ $postgresName)
    $adminSecret = Invoke-PreviewVault -VaultUri $vaultUri -SecretName 'postgres-admin-password' -AllowMissing
    if ($null -eq $adminSecret) {
        if ($existingPostgres.Count -gt 0) { throw 'Existing PostgreSQL server has no saved admin secret. Refusing to generate a replacement or reset credentials.' }
        if (-not $Provision) { throw 'First-time password initialization requires -Provision, after successful bootstrap what-if.' }
        $randomBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(48)
        $password = 'Aa1!' + [Convert]::ToBase64String($randomBytes)
        $adminSecret = Invoke-PreviewVault -VaultUri $vaultUri -SecretName 'postgres-admin-password' -Method Put -Value $password
        $password = $null
        [Array]::Clear($randomBytes, 0, $randomBytes.Length)
    }

    $allowedExtensions = @('PG_TRGM')
    if ($existingPostgres.Count -gt 0) {
        $allowedExtensions = @(Get-PreviewPostgresExtensions -ResourceGroupName $ResourceGroupName -ServerName $postgresName)
    }
    $foundationParameters = New-PreviewParameters -Values @{
        location = $Location
        initializePostgresPassword = ($existingPostgres.Count -eq 0)
        postgresAllowedExtensions = $allowedExtensions
    } -FileName 'foundation.parameters.json'
    if ($existingPostgres.Count -eq 0) {
        $parameters = Get-Content -LiteralPath $foundationParameters -Raw | ConvertFrom-Json -AsHashtable
        $parameters.parameters.postgresAdministratorPassword = @{
            reference = @{
                keyVault = @{ id = $bootstrap.keyVaultId.value }
                secretName = 'postgres-admin-password'
            }
        }
        Write-PreviewJson -Value $parameters -Path $foundationParameters
    }
    $outputs = Invoke-PreviewGroupDeployment -Name 'newsscout-preview-foundation' -TemplateName 'foundation' -ParametersPath $foundationParameters
    if (-not $Provision) { return }
    $foundation = $outputs.foundation.value
    Write-PreviewJson -Value $foundation -Path (Join-Path $artifactPath 'foundation.json')

    $encodedPassword = [Uri]::EscapeDataString($adminSecret.value)
    $databaseUrl = "postgresql://$($foundation.postgres.administratorLogin):${encodedPassword}@$($foundation.postgres.fqdn):5432/$($foundation.postgres.database)?sslmode=verify-full"
    # A later runtime may use a restricted database login; never revert its saved URL to the administrator.
    Set-PreviewSecretIfMissing -VaultUri $vaultUri -SecretName 'database-url' -Value $databaseUrl
    $insightsConnection = Invoke-PreviewAz -Arguments @('resource', 'show', '--ids', $foundation.observability.applicationInsightsId,
        '--api-version', '2020-02-02', '--query', 'properties.ConnectionString')
    Set-PreviewSecretIfChanged -VaultUri $vaultUri -SecretName 'applicationinsights-connection-string' -Value $insightsConnection
    $databaseUrl = $null
    $encodedPassword = $null
    $adminSecret = $null
    $insightsConnection = $null

    & "$PSScriptRoot\azure-infra-verify.ps1" -SubscriptionId $SubscriptionId -TenantId $TenantId `
        -DeployerPrincipalId $DeployerPrincipalId -ExpectedAccount $ExpectedAccount `
        -FoundationPath (Join-Path $artifactPath 'foundation.json')
    Write-Host "Foundation ready; no application container deployed. Non-secret outputs: $artifactPath\foundation.json"
} finally {
    $adminSecret = $null
    $databaseUrl = $null
    $encodedPassword = $null
    $insightsConnection = $null
    Assert-PreviewDefaultUnchanged
}
