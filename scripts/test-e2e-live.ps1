[CmdletBinding()]
param(
    [switch]$BootstrapPostgres,
    [switch]$SkipBuild,
    [string]$TestPattern,
    [string]$ApiExecutable,
    [string]$DatabaseBackup
)

. (Join-Path $PSScriptRoot 'runtime-common.ps1')
$root = $script:ScoutNewsRoot
$owned = New-Object System.Collections.ArrayList
$postgres = $null
$databaseCreated = $false
$database = 'scoutnews_e2e_' + [Guid]::NewGuid().ToString('N')
$runDirectory = Join-Path $root "tmp\e2e-runs\$database"
$data = Join-Path $root 'tmp\postgres-e2e\data'
$postgresBin = $null
$failure = $null

try {
    if ($ApiExecutable -and -not $SkipBuild) {
        throw '-ApiExecutable requires -SkipBuild; build the candidate executable separately.'
    }
    Import-ScoutNewsEnvironment
    Set-ScoutNewsRuntimeEnvironment -ApiPort 18080 -GatewayPort 18787 -WebPort 15173
    $env:SCOUTNEWS_E2E_BASE_URL = 'http://127.0.0.1:15173'
    $env:SCOUTNEWS_E2E_API_URL = 'http://127.0.0.1:18080'
    $env:SCOUTNEWS_E2E_GATEWAY_URL = 'http://127.0.0.1:18787'
    $env:SCOUTNEWS_DISABLE_COPILOT_RESTORE = 'true'
    $env:SCOUTNEWS_E2E_CORPUS_BACKUP = if ($DatabaseBackup) { 'true' } else { 'false' }
    $env:DATABASE_URL = "postgres://scoutnews@127.0.0.1:55432/$database"
    $env:SCOUTNEWS_E2E_DATABASE_URL = $env:DATABASE_URL
    Assert-ScoutNewsPortsFree @(18080, 18787, 15173, 55432)
    $postgresBin = Get-ScoutNewsPostgresBin -BootstrapPostgres:$BootstrapPostgres
    $env:SCOUTNEWS_E2E_PSQL = Join-Path $postgresBin 'psql.exe'
    if (-not $SkipBuild) { Build-ScoutNews }
    Assert-ScoutNewsPortsFree @(18080, 18787, 15173, 55432)
    New-Item -ItemType Directory -Force $runDirectory | Out-Null
    $postgres = Start-ScoutNewsPostgres -Bin $postgresBin -Data $data -Port 55432 -LogDirectory $runDirectory -Owned $owned
    & (Join-Path $postgresBin 'createdb.exe') -w -h 127.0.0.1 -p 55432 -U scoutnews $database
    if ($LASTEXITCODE -ne 0) { throw "E2E database creation failed with exit code $LASTEXITCODE." }
    $databaseCreated = $true
    if ($DatabaseBackup) {
        $backupPath = (Resolve-Path -LiteralPath $DatabaseBackup -ErrorAction Stop).Path
        & (Join-Path $postgresBin 'pg_restore.exe') -w -h 127.0.0.1 -p 55432 -U scoutnews `
            -d $database --no-owner --no-privileges --exit-on-error $backupPath
        if ($LASTEXITCODE -ne 0) { throw "Isolated corpus restore failed with exit code $LASTEXITCODE." }
        # --no-privileges also drops the reader-role grants that migration 0025 recorded as applied.
        $grants = 'GRANT USAGE ON SCHEMA public TO scoutnews_reader; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO scoutnews_reader; REVOKE ALL ON _sqlx_migrations,source_directory_imports FROM scoutnews_reader; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO scoutnews_reader;'
        & (Join-Path $postgresBin 'psql.exe') -w -h 127.0.0.1 -p 55432 -U scoutnews -d $database -v ON_ERROR_STOP=1 -q -c $grants
        if ($LASTEXITCODE -ne 0) { throw "Reader-role grant restore failed with exit code $LASTEXITCODE." }
    }
    Start-ScoutNewsApplication -WebPort 15173 -LogDirectory $runDirectory -Owned $owned -ApiExecutable $ApiExecutable
    Write-Host "Isolated live E2E: $($env:SCOUTNEWS_E2E_BASE_URL), database $database"
    Write-Host "Logs: $runDirectory"
    $services = @($owned.ToArray())
    $testArguments = @((Join-Path $root 'node_modules\@playwright\test\cli.js'), 'test')
    if ($TestPattern) { $testArguments += @('--grep', $TestPattern) }
    $test = Start-ScoutNewsOwnedProcess -Name playwright -FilePath (Get-Command node.exe -ErrorAction Stop).Source `
        -Arguments $testArguments `
        -WorkingDirectory $root -LogDirectory $runDirectory -Owned $owned
    while (-not $test.Process.HasExited) {
        Assert-ScoutNewsServicesAlive $services
        Start-Sleep -Milliseconds 300
        $test.Process.Refresh()
    }
    $test.Process.WaitForExit()
    Get-Content -LiteralPath $test.Stdout
    Get-Content -LiteralPath $test.Stderr
    if ($test.Process.ExitCode -ne 0) { throw "Playwright E2E failed with exit code $($test.Process.ExitCode)." }
} catch {
    $failure = $_
} finally {
    for ($index = $owned.Count - 1; $index -ge 0; $index--) {
        if ($owned[$index].Identity.Name -eq 'postgres') { continue }
        try { Stop-ScoutNewsOwnedProcess $owned[$index].Identity }
        catch { if (-not $failure) { $failure = $_ }; Write-Warning $_.Exception.Message }
    }
    if ($databaseCreated) {
        try {
            if ($database -notmatch '^scoutnews_e2e_[a-f0-9]{32}$' -or
                -not (Test-ScoutNewsProcessIdentity $postgres.Identity)) {
                throw 'Refusing to drop E2E database: database name or owned PostgreSQL identity did not match.'
            }
            & (Join-Path $postgresBin 'dropdb.exe') -w -h 127.0.0.1 -p 55432 -U scoutnews --force $database
            if ($LASTEXITCODE -ne 0) { throw "E2E database cleanup failed with exit code $LASTEXITCODE." }
        } catch { if (-not $failure) { $failure = $_ }; Write-Warning $_.Exception.Message }
    }
    $postgresEntry = $owned | Where-Object { $_.Identity.Name -eq 'postgres' } | Select-Object -First 1
    if ($postgresEntry) {
        try { Stop-ScoutNewsPostgres -Bin $postgresBin -Data $data -Identity $postgresEntry.Identity }
        catch { if (-not $failure) { $failure = $_ }; Write-Warning $_.Exception.Message }
    }
}
if ($failure) { throw $failure }
