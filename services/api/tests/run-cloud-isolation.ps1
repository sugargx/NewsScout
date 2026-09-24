[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
. (Join-Path $root 'scripts\runtime-common.ps1')
$run = Join-Path $root ('services\api\target\cloud-validation\' + [guid]::NewGuid().ToString('N'))
$data = Join-Path $run 'data'
$log = Join-Path $run 'logs'
$previousTarget = $env:CARGO_TARGET_DIR
$env:CARGO_TARGET_DIR = Join-Path $root 'tmp\performance-r8\target'
New-Item -ItemType Directory -Force $log | Out-Null
$owned = New-Object System.Collections.ArrayList
$bin = Get-ScoutNewsPostgresBin
$port = 55489
$database = 'scoutnews_cloud_test_' + [guid]::NewGuid().ToString('N')
$server = $null
try {
    $server = Start-ScoutNewsPostgres -Bin $bin -Data $data -Port $port -LogDirectory $log -Owned $owned
    $migrationRole = 'scoutnews_cloud_migrator'
    & (Join-Path $bin 'psql.exe') -X -w -h 127.0.0.1 -p $port -U scoutnews -d postgres -v ON_ERROR_STOP=1 `
        -c "CREATE ROLE $migrationRole LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB CREATEROLE NOREPLICATION"
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create isolated non-superuser migration role' }
    & (Join-Path $bin 'createdb.exe') -h 127.0.0.1 -p $port -U scoutnews -w -O $migrationRole $database
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create isolated cloud-test database' }
    $env:SCOUTNEWS_CLOUD_TEST_DATABASE_URL = "postgres://${migrationRole}@127.0.0.1:$port/$database"
    $env:SCOUTNEWS_DISABLE_COPILOT_RESTORE = 'true'
    & (Join-Path $root 'scripts\rust.ps1') -CargoArgs @('test','cloud_tests','--','--ignored','--nocapture','--test-threads=1')
    $localDatabase = 'scoutnews_e2e_' + [guid]::NewGuid().ToString('N')
    & (Join-Path $bin 'createdb.exe') -h 127.0.0.1 -p $port -U scoutnews -w -O $migrationRole $localDatabase
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create isolated local-regression database' }
    $env:SCOUTNEWS_DIRECTORY_TEST_DATABASE_URL = "postgres://${migrationRole}@127.0.0.1:$port/$localDatabase"
    $env:SCOUTNEWS_E2E_DATABASE_URL = $env:SCOUTNEWS_DIRECTORY_TEST_DATABASE_URL
    & (Join-Path $root 'scripts\rust.ps1') -CargoArgs @('test','source_directory_database_contract','--','--ignored','--nocapture')
    & (Join-Path $root 'scripts\rust.ps1') -CargoArgs @('test','morning_database_contract','--','--ignored','--nocapture')
    & (Join-Path $root 'scripts\rust.ps1') -CargoArgs @('test','daily_selection_','--','--ignored','--nocapture','--test-threads=1')
} finally {
    Remove-Item Env:\SCOUTNEWS_CLOUD_TEST_DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\SCOUTNEWS_DIRECTORY_TEST_DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\SCOUTNEWS_E2E_DATABASE_URL -ErrorAction SilentlyContinue
    if ($null -eq $previousTarget) {
        Remove-Item Env:\CARGO_TARGET_DIR -ErrorAction SilentlyContinue
    } else {
        $env:CARGO_TARGET_DIR = $previousTarget
    }
    if ($server) { Stop-ScoutNewsPostgres -Bin $bin -Data $data -Identity $server.Identity }
    if ($server -and -not (Test-ScoutNewsProcessIdentity $server.Identity)) {
        Remove-Item -LiteralPath $data -Recurse -Force
    }
    Write-Host "Isolated cloud-test logs: $log"
}
