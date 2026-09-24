[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupPath
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$backup = (Resolve-Path -LiteralPath $BackupPath).Path
if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) { throw 'A PostgreSQL custom-format backup file is required.' }
. (Join-Path $root 'scripts\runtime-common.ps1')
$run = Join-Path $root ('services\api\target\owner-upgrade-validation\' + [guid]::NewGuid().ToString('N'))
$data = Join-Path $run 'data'
$log = Join-Path $run 'logs'
New-Item -ItemType Directory -Force $log | Out-Null
$owned = New-Object System.Collections.ArrayList
$bin = Get-ScoutNewsPostgresBin
$port = 55490
$database = 'scoutnews_upgrade_check_' + [guid]::NewGuid().ToString('N')
$server = $null
try {
    $server = Start-ScoutNewsPostgres -Bin $bin -Data $data -Port $port -LogDirectory $log -Owned $owned
    & (Join-Path $bin 'createdb.exe') -h 127.0.0.1 -p $port -U scoutnews -w $database
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create isolated upgrade-check database.' }
    & (Join-Path $bin 'pg_restore.exe') -w --exit-on-error --no-owner --no-privileges `
        -h 127.0.0.1 -p $port -U scoutnews -d $database $backup *> (Join-Path $log 'restore.log')
    if ($LASTEXITCODE -ne 0) { throw "Restore failed; inspect the private log in $log." }
    $env:SCOUTNEWS_OWNER_UPGRADE_DATABASE_URL = "postgres://scoutnews@127.0.0.1:$port/$database"
    & (Join-Path $root 'scripts\rust.ps1') -CargoArgs @('test','--locked','--bin','scoutnews-api','owner_upgrade_tests','--','--ignored','--nocapture','--test-threads=1')
} finally {
    Remove-Item Env:\SCOUTNEWS_OWNER_UPGRADE_DATABASE_URL -ErrorAction SilentlyContinue
    if ($server) { Stop-ScoutNewsPostgres -Bin $bin -Data $data -Identity $server.Identity }
    if ($server -and -not (Test-ScoutNewsProcessIdentity $server.Identity)) {
        Remove-Item -LiteralPath $data -Recurse -Force
    }
    Write-Host "Isolated owner-upgrade logs: $log"
}
