[CmdletBinding()]
param(
    [switch]$Provision,
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
$FoundationPath = [IO.Path]::GetFullPath($FoundationPath)
if (-not $FoundationPath.StartsWith("$repoRoot\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Operational artifacts must stay inside the project directory.'
}
$foundation = Get-Content -LiteralPath $FoundationPath -Raw | ConvertFrom-Json -AsHashtable
if ($foundation.subscriptionId -ne $SubscriptionId -or $foundation.tenantId -ne $TenantId) {
    throw 'Foundation output does not match the authorized subscription and tenant.'
}
$resourceGroupName = $foundation.resourceGroupId.Split('/')[-1]
$expectedServerId = "$($foundation.resourceGroupId)/providers/Microsoft.DBforPostgreSQL/flexibleServers/$($foundation.postgres.name)"
if ($foundation.postgres.id -ne $expectedServerId) { throw 'PostgreSQL escaped the authorized preview resource group.' }
$artifactPath = Split-Path $FoundationPath -Parent
Initialize-PreviewContext -SubscriptionId $SubscriptionId -TenantId $TenantId -DeployerPrincipalId $DeployerPrincipalId -ExpectedAccount $ExpectedAccount

try {
    $group = Invoke-PreviewAz -Arguments @('group', 'show', '--name', $resourceGroupName)
    if ($group.tags.product -ne 'NewsScout' -or $group.tags.environment -ne 'invited-preview') {
        throw 'Refusing to change PostgreSQL configuration outside the tagged NewsScout preview group.'
    }
    $allowed = @(Get-PreviewPostgresExtensions -ResourceGroupName $resourceGroupName -ServerName $foundation.postgres.name)
    $templatePath = Join-Path $artifactPath 'postgres-extensions.template.json'
    & az bicep build --file (Join-Path $repoRoot 'infra\azure\postgres-extensions.bicep') --outfile $templatePath --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL extension Bicep build failed.' }
    $parametersPath = Join-Path $artifactPath 'postgres-extensions.parameters.json'
    Write-PreviewJson -Path $parametersPath -Value @{
        '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters = @{
            postgresServerName = @{ value = $foundation.postgres.name }
            allowedExtensions = @{ value = $allowed }
        }
    }
    $base = @('--resource-group', $resourceGroupName, '--name', 'newsscout-preview-postgres-extensions',
        '--template-file', $templatePath, '--parameters', "@$parametersPath", '--mode', 'Incremental')
    $whatIf = Invoke-PreviewAz -Arguments (@('deployment', 'group', 'what-if') + $base +
        @('--result-format', 'ResourceIdOnly', '--no-pretty-print'))
    Write-PreviewJson -Value $whatIf -Path (Join-Path $artifactPath 'postgres-extensions.what-if.json')
    if ($whatIf.status -ne 'Succeeded') { throw 'PostgreSQL extension what-if failed.' }
    $configurationId = "$expectedServerId/configurations/azure.extensions"
    foreach ($change in $whatIf.changes) {
        if ($change.changeType -in @('Ignore', 'NoChange')) { continue }
        # ResourceIdOnly uses Deploy when it cannot distinguish Create from Modify.
        if ($change.resourceId -ne $configurationId -or $change.changeType -notin @('Create', 'Modify', 'Deploy')) {
            throw "Unexpected configuration-only change: $($change.changeType) $($change.resourceId)"
        }
    }
    Write-Host "Configuration-only what-if passed; allowlist: $($allowed -join ',')."
    if (-not $Provision) { return }
    $outputs = Invoke-PreviewAz -Arguments (@('deployment', 'group', 'create') + $base + @('--query', 'properties.outputs'))
    Write-PreviewJson -Value $outputs -Path (Join-Path $artifactPath 'postgres-extensions.outputs.json')

    $setting = Invoke-PreviewAz -Arguments @('postgres', 'flexible-server', 'parameter', 'show',
        '--resource-group', $resourceGroupName, '--server-name', $foundation.postgres.name, '--name', 'azure.extensions')
    $actual = @($setting.value -split ',' | ForEach-Object { $_.Trim().ToUpperInvariant() })
    $missing = @($allowed | Where-Object { $_ -notin $actual })
    $report = @{
        checkedAt = [DateTime]::UtcNow.ToString('o')
        configurationId = $configurationId
        allowedExtensions = $actual
        pgTrgmAllowed = ('PG_TRGM' -in $actual)
        existingEntriesPreserved = ($missing.Count -eq 0)
        pendingRestart = $setting.isConfigPendingRestart
        sqlExecuted = $false
        credentialsOrRolesChanged = $false
    }
    Write-PreviewJson -Value $report -Path (Join-Path $artifactPath 'postgres-extensions.verification.json')
    if (-not $report.pgTrgmAllowed -or -not $report.existingEntriesPreserved -or $report.pendingRestart) {
        throw 'Extension allowlist did not verify as active without restart; inspect the verification artifact.'
    }
    $foundation.postgres.allowedExtensions = $actual
    Write-PreviewJson -Value $foundation -Path $FoundationPath
    Write-Host 'PG_TRGM is allowlisted with no restart pending. CREATE EXTENSION remains the application migration responsibility.'
} finally {
    Assert-PreviewDefaultUnchanged
}
