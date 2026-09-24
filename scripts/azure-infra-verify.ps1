[CmdletBinding()]
param(
    [string]$SubscriptionId,
    [string]$TenantId,
    [string]$DeployerPrincipalId,
    [string]$ExpectedAccount,
    [string]$TargetPath = 'tmp\azure-preview-20260920\target.json',
    [string]$FoundationPath = 'tmp\azure-preview-20260920\foundation.json'
)

. "$PSScriptRoot\azure-infra-common.ps1"
$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not [IO.Path]::IsPathRooted($TargetPath)) { $TargetPath = Join-Path $repoRoot $TargetPath }
$target = Resolve-PreviewTarget -SubscriptionId $SubscriptionId -TenantId $TenantId -DeployerPrincipalId $DeployerPrincipalId -ExpectedAccount $ExpectedAccount -TargetPath $TargetPath
$SubscriptionId = $target.SubscriptionId
$TenantId = $target.TenantId
$DeployerPrincipalId = $target.DeployerPrincipalId
$ExpectedAccount = $target.ExpectedAccount
if (-not [IO.Path]::IsPathRooted($FoundationPath)) { $FoundationPath = Join-Path $repoRoot $FoundationPath }
$foundation = Get-Content -LiteralPath $FoundationPath -Raw | ConvertFrom-Json -Depth 100
if ($foundation.subscriptionId -ne $SubscriptionId -or $foundation.tenantId -ne $TenantId) {
    throw 'Foundation output does not belong to the authorized subscription and tenant.'
}
$resourceGroupName = $foundation.resourceGroupId.Split('/')[-1]
Initialize-PreviewContext -SubscriptionId $SubscriptionId -TenantId $TenantId -DeployerPrincipalId $DeployerPrincipalId -ExpectedAccount $ExpectedAccount
$checks = [Collections.Generic.List[object]]::new()

function Add-PreviewCheck {
    param([string]$Name, [bool]$Passed)
    $checks.Add([pscustomobject]@{ name = $Name; passed = $Passed })
}

function Read-PreviewResource {
    param([string]$Id, [string]$ApiVersion)
    if (-not $Id.StartsWith("$($foundation.resourceGroupId)/", [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Verification resource escaped the preview group.'
    }
    return Invoke-PreviewAz -Arguments @('resource', 'show', '--ids', $Id, '--api-version', $ApiVersion)
}

function Test-PreviewRole {
    param([string]$Scope, [string]$PrincipalId, [string]$RoleId)
    if (-not $Scope.StartsWith("$($foundation.resourceGroupId)/", [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Role-verification scope escaped the preview group.'
    }
    $uri = "https://management.azure.com${Scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&`$filter=atScope()"
    $token = Get-PreviewToken -Resource 'https://management.azure.com/'
    try {
        $roles = (Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $token" } -Method Get).value
    } finally {
        $token = $null
    }
    return @($roles | Where-Object {
        $_.properties.principalId -eq $PrincipalId -and $_.properties.scope -eq $Scope -and $_.properties.roleDefinitionId.EndsWith("/$RoleId")
    }).Count -eq 1
}

try {
    $pg = Read-PreviewResource -Id $foundation.postgres.id -ApiVersion '2025-08-01'
    Add-PreviewCheck 'postgres-ready' ($pg.properties.state -eq 'Ready')
    Add-PreviewCheck 'postgres-17-b1ms-32gib' ($pg.properties.version -eq '17' -and $pg.sku.name -eq 'Standard_B1ms' -and
        $pg.sku.tier -eq 'Burstable' -and $pg.properties.storage.storageSizeGB -eq 32)
    Add-PreviewCheck 'postgres-private-only' ($pg.properties.network.publicNetworkAccess -eq 'Disabled' -and
        $pg.properties.network.delegatedSubnetResourceId -eq $foundation.network.postgresSubnetId -and
        $pg.properties.network.privateDnsZoneArmResourceId -eq $foundation.postgres.privateDnsZoneId)
    Add-PreviewCheck 'postgres-seven-day-backup-no-ha' ($pg.properties.backup.backupRetentionDays -eq 7 -and
        $pg.properties.backup.geoRedundantBackup -eq 'Disabled' -and $pg.properties.highAvailability.mode -eq 'Disabled')
    # PostgreSQL rejects firewall-rule operations for a VNet-only server; the public surface is disabled.
    Add-PreviewCheck 'postgres-public-firewall-surface-disabled' ($pg.properties.network.publicNetworkAccess -eq 'Disabled')
    $database = Read-PreviewResource -Id "$($foundation.postgres.id)/databases/$($foundation.postgres.database)" -ApiVersion '2025-08-01'
    Add-PreviewCheck 'application-database-created' ($database.name -eq 'scoutnews')
    $transport = Read-PreviewResource -Id "$($foundation.postgres.id)/configurations/require_secure_transport" -ApiVersion '2025-08-01'
    Add-PreviewCheck 'postgres-requires-tls' ($transport.properties.value -eq 'on')
    $extensions = Read-PreviewResource -Id "$($foundation.postgres.id)/configurations/azure.extensions" -ApiVersion '2025-08-01'
    Add-PreviewCheck 'postgres-pg-trgm-allowlisted' (@($extensions.properties.value -split ',' |
        ForEach-Object { $_.Trim() }) -contains 'PG_TRGM')

    $vnet = Read-PreviewResource -Id $foundation.network.id -ApiVersion '2026-03-01'
    $appSubnet = @($vnet.properties.subnets | Where-Object name -EQ 'container-apps')[0]
    $dbSubnet = @($vnet.properties.subnets | Where-Object name -EQ 'postgres')[0]
    Add-PreviewCheck 'dedicated-service-subnets' ($appSubnet.properties.delegations[0].properties.serviceName -eq 'Microsoft.App/environments' -and
        $dbSubnet.properties.delegations[0].properties.serviceName -eq 'Microsoft.DBforPostgreSQL/flexibleServers')
    $dnsLinks = @(Invoke-PreviewAz -Arguments @('network', 'private-dns', 'link', 'vnet', 'list',
        '--resource-group', $resourceGroupName, '--zone-name', $foundation.postgres.privateDnsZoneId.Split('/')[-1]))
    Add-PreviewCheck 'private-dns-linked-to-app-network' (@($dnsLinks | Where-Object {
        $_.virtualNetwork.id -eq $foundation.network.id -and $_.virtualNetworkLinkState -eq 'Completed'
    }).Count -eq 1)

    $vault = Read-PreviewResource -Id $foundation.keyVault.id -ApiVersion '2026-05-15'
    Add-PreviewCheck 'key-vault-rbac-purge-protected' ($vault.properties.enableRbacAuthorization -eq $true -and
        $vault.properties.enablePurgeProtection -eq $true -and $vault.properties.tenantId -eq $TenantId)
    Add-PreviewCheck 'app-vault-secrets-user' (Test-PreviewRole -Scope $vault.id -PrincipalId $foundation.identity.principalId -RoleId '4633458b-17de-408a-b874-0445c86b69e6')
    Add-PreviewCheck 'deployer-vault-secrets-officer' (Test-PreviewRole -Scope $vault.id -PrincipalId $DeployerPrincipalId -RoleId 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
    foreach ($name in $foundation.keyVault.secretNames) {
        $secret = Invoke-PreviewVault -VaultUri $foundation.keyVault.uri -SecretName $name
        Add-PreviewCheck "saved-secret-$name" ($secret.attributes.enabled -eq $true -and -not [string]::IsNullOrWhiteSpace($secret.value))
        if ($name -eq 'database-url') {
            Add-PreviewCheck 'database-url-verify-full' ($secret.value.EndsWith('?sslmode=verify-full') -and
                $secret.value.Contains("@$($foundation.postgres.fqdn):5432/scoutnews"))
        }
        $secret = $null
    }

    $acr = Read-PreviewResource -Id $foundation.registry.id -ApiVersion '2025-11-01'
    Add-PreviewCheck 'basic-acr-no-admin-no-anonymous' ($acr.sku.name -eq 'Basic' -and
        $acr.properties.adminUserEnabled -eq $false -and $acr.properties.anonymousPullEnabled -eq $false)
    Add-PreviewCheck 'app-acr-pull' (Test-PreviewRole -Scope $acr.id -PrincipalId $foundation.identity.principalId -RoleId '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    $registryProbe = Invoke-WebRequest -Uri "https://$($foundation.registry.loginServer)/v2/" -SkipHttpErrorCheck -TimeoutSec 30
    Add-PreviewCheck 'registry-denies-anonymous-request' ([int]$registryProbe.StatusCode -in @(401, 403))

    $storage = Read-PreviewResource -Id $foundation.storage.id -ApiVersion '2026-06-01'
    Add-PreviewCheck 'storage-private-blobs-no-shared-keys' ($storage.properties.allowBlobPublicAccess -eq $false -and
        $storage.properties.allowSharedKeyAccess -eq $false -and $storage.properties.supportsHttpsTrafficOnly -eq $true -and
        $storage.properties.minimumTlsVersion -eq 'TLS1_2' -and $storage.sku.name -eq 'Standard_LRS')
    $exports = Read-PreviewResource -Id $foundation.storage.containerId -ApiVersion '2026-06-01'
    Add-PreviewCheck 'exports-container-not-public' ($exports.properties.publicAccess -eq 'None')
    $lifecycle = Read-PreviewResource -Id "$($foundation.storage.id)/managementPolicies/default" -ApiVersion '2026-06-01'
    $rule = @($lifecycle.properties.policy.rules | Where-Object name -EQ 'delete-generated-exports-after-seven-days')[0]
    Add-PreviewCheck 'exports-seven-day-lifecycle' ($rule.enabled -eq $true -and
        $rule.definition.actions.baseBlob.delete.daysAfterModificationGreaterThan -eq 7 -and
        $rule.definition.filters.prefixMatch -contains 'exports/')
    Add-PreviewCheck 'app-container-scoped-blob-contributor' (Test-PreviewRole -Scope $exports.id -PrincipalId $foundation.identity.principalId -RoleId 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    $exportsProbe = Invoke-WebRequest -Uri "$($foundation.storage.blobEndpoint)exports?restype=container&comp=list" -SkipHttpErrorCheck -TimeoutSec 30
    Add-PreviewCheck 'exports-deny-anonymous-listing' ([int]$exportsProbe.StatusCode -in @(401, 403, 409))

    $workspace = Read-PreviewResource -Id $foundation.observability.logAnalyticsId -ApiVersion '2026-03-01'
    Add-PreviewCheck 'logs-thirty-days-with-ingestion-cap' ($workspace.properties.retentionInDays -eq 30 -and
        $workspace.properties.workspaceCapping.dailyQuotaGb -eq [double]$foundation.observability.logDailyQuotaGb -and
        $workspace.properties.features.disableLocalAuth -eq $true)
    $insights = Read-PreviewResource -Id $foundation.observability.applicationInsightsId -ApiVersion '2020-02-02'
    Add-PreviewCheck 'workspace-insights-entra-ingestion' ($insights.properties.WorkspaceResourceId -eq $workspace.id -and
        $insights.properties.DisableLocalAuth -eq $true)
    Add-PreviewCheck 'app-monitoring-metrics-publisher' (Test-PreviewRole -Scope $insights.id -PrincipalId $foundation.identity.principalId -RoleId '3913510d-42f4-4e42-8a64-420c390055eb')

    $environment = Read-PreviewResource -Id $foundation.containerEnvironment.id -ApiVersion '2026-01-01'
    Add-PreviewCheck 'consumption-environment-ready' ($environment.properties.provisioningState -eq 'Succeeded' -and
        $environment.properties.workloadProfiles.Count -eq 1 -and
        $environment.properties.workloadProfiles[0].workloadProfileType -eq 'Consumption' -and
        $environment.properties.vnetConfiguration.infrastructureSubnetId -eq $foundation.network.containerSubnetId)
    $diagnostics = Read-PreviewResource -Id "$($environment.id)/providers/Microsoft.Insights/diagnosticSettings/service" -ApiVersion '2016-09-01'
    Add-PreviewCheck 'container-logs-routed-without-workspace-keys' ($environment.properties.appLogsConfiguration.destination -eq 'azure-monitor' -and
        $diagnostics.properties.workspaceId -eq $workspace.id)
    $apps = @(Invoke-PreviewAz -Arguments @('containerapp', 'list', '--resource-group', $resourceGroupName))
    Add-PreviewCheck 'no-runtime-container-deployed' ($apps.Count -eq 0)
    $environmentUsage = Invoke-PreviewAz -Arguments @('containerapp', 'env', 'list-usages', '--name',
        $foundation.containerEnvironment.name, '--resource-group', $resourceGroupName)
    Write-PreviewJson -Value $environmentUsage -Path (Join-Path (Split-Path $FoundationPath -Parent) 'container-environment-quota.json')
    $consumptionQuota = @($environmentUsage.value | Where-Object { $_.name.value -match 'Consumption.*Core' })
    Add-PreviewCheck 'one-core-runtime-quota-available' ($consumptionQuota.Count -gt 0 -and
        ($consumptionQuota[0].limit - $consumptionQuota[0].currentValue) -ge 1)

    $report = @{
        checkedAt = [DateTime]::UtcNow.ToString('o')
        resourceGroupId = $foundation.resourceGroupId
        checks = $checks.ToArray()
        inVnetDatabaseConnectivity = 'Not exercised: no runtime image deployed. Verify DNS and TLS from the eventual authenticated runtime.'
    }
    Write-PreviewJson -Value $report -Path (Join-Path (Split-Path $FoundationPath -Parent) 'verification.json')
    $failed = @($checks | Where-Object passed -EQ $false)
    if ($failed.Count -gt 0) { throw "Foundation verification failed: $($failed.name -join ', ')" }
    Write-Host "Verified $($checks.Count) foundation controls. In-VNet runtime connectivity remains a deployment gate."
} finally {
    $secret = $null
    Assert-PreviewDefaultUnchanged
}
