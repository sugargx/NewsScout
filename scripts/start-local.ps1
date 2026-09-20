[CmdletBinding()]
param(
    [switch]$Demo,
    [switch]$SkipBuild,
    [switch]$BootstrapPostgres
)

. (Join-Path $PSScriptRoot 'runtime-common.ps1')
$root = $script:ScoutNewsRoot
$metadataPath = Join-Path $root 'tmp\local-runtime.json'
$lockPath = Join-Path $root 'tmp\local-runtime.lock'
$owned = New-Object System.Collections.ArrayList
$postgres = $null
$lock = $null
$sessionId = [Guid]::NewGuid().ToString('N')
$runDirectory = Join-Path $root "tmp\local-runs\$sessionId"
$stopRequest = Join-Path $runDirectory 'stop.request'
$data = Join-Path $root 'tmp\postgres-local\data'
$postgresBin = $null

try {
    New-Item -ItemType Directory -Force (Join-Path $root 'tmp') | Out-Null
    try { $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw 'Another local launcher is active. Use scripts\stop-local.ps1 first.' }
    if (Test-Path -LiteralPath $metadataPath) {
        throw 'Previous runtime metadata exists. Run scripts\stop-local.ps1 to stop or reconcile it before starting.'
    }
    Import-ScoutNewsEnvironment
    Set-ScoutNewsRuntimeEnvironment -ApiPort 8080 -GatewayPort 8787 -WebPort 5173 -Demo:$Demo
    $ports = @(8080, 8787, 5173)
    if (-not $Demo) { $ports += 55433 }
    Assert-ScoutNewsPortsFree $ports
    if (-not $Demo) { $postgresBin = Get-ScoutNewsPostgresBin -BootstrapPostgres:$BootstrapPostgres }
    if (-not $SkipBuild) { Build-ScoutNews }
    Assert-ScoutNewsPortsFree $ports
    New-Item -ItemType Directory -Force $runDirectory | Out-Null

    $metadata = [ordered]@{
        Version = 1
        SessionId = $sessionId
        Root = $root
        Supervisor = Get-ScoutNewsProcessIdentity (Get-Process -Id $PID) 'supervisor'
        StopRequest = $stopRequest
        PostgresBin = $postgresBin
        PostgresData = if ($Demo) { $null } else { $data }
        Processes = @()
    }
    function Save-LocalRuntime {
        $metadata.Processes = @($owned | ForEach-Object { $_.Identity })
        $json = $metadata | ConvertTo-Json -Depth 6
        $pending = "$metadataPath.$sessionId.pending"
        [IO.File]::WriteAllText($pending, $json)
        if (Test-Path -LiteralPath $metadataPath) {
            [IO.File]::Replace($pending, $metadataPath, [NullString]::Value)
        } else {
            [IO.File]::Move($pending, $metadataPath)
        }
    }
    Save-LocalRuntime
    $script:ScoutNewsProcessStarted = { Save-LocalRuntime }
    if (-not $Demo) {
        $env:DATABASE_URL = 'postgres://scoutnews@127.0.0.1:55433/scoutnews'
        $postgres = Start-ScoutNewsPostgres -Bin $postgresBin -Data $data -Port 55433 -LogDirectory $runDirectory -Owned $owned
        Save-LocalRuntime
        $exists = & (Join-Path $postgresBin 'psql.exe') -X -w -h 127.0.0.1 -p 55433 -U scoutnews -d postgres -v ON_ERROR_STOP=1 -Atc "SELECT 1 FROM pg_database WHERE datname='scoutnews'"
        if ($LASTEXITCODE -ne 0) { throw "Database lookup failed with exit code $LASTEXITCODE." }
        if ($exists -ne '1') {
            & (Join-Path $postgresBin 'createdb.exe') -w -h 127.0.0.1 -p 55433 -U scoutnews scoutnews
            if ($LASTEXITCODE -ne 0) { throw "Database creation failed with exit code $LASTEXITCODE." }
        }
    }
    Start-ScoutNewsApplication -WebPort 5173 -LogDirectory $runDirectory -Owned $owned
    Save-LocalRuntime
    Write-Host "ScoutNews ready: http://127.0.0.1:5173"
    Write-Host "API: http://127.0.0.1:8080 | Gateway: http://127.0.0.1:8787"
    if ($Demo) { Write-Host 'Demo mode: volatile sample data; PostgreSQL is not used.' }
    else { Write-Host "Persistent database: tmp\postgres-local\data (127.0.0.1:55433/scoutnews)" }
    Write-Host "Logs: $runDirectory"
    Write-Host 'Basic reading does not require OAuth. Provider credentials are not configured by this launcher.'
    Write-Host 'Keep this supervisor running. Ctrl+C or scripts\stop-local.ps1 stops only this run.'
    while (-not (Test-Path -LiteralPath $stopRequest)) {
        Assert-ScoutNewsServicesAlive $owned
        Start-Sleep -Milliseconds 500
    }
} finally {
    # Include any children started before a readiness failure.
    if ($lock -and $owned.Count -gt 0 -and (Get-Command Save-LocalRuntime -ErrorAction SilentlyContinue)) {
        try { Save-LocalRuntime } catch { Write-Warning 'Could not update runtime metadata during cleanup.' }
    }
    $cleanupFailed = $false
    for ($index = $owned.Count - 1; $index -ge 0; $index--) {
        $entry = $owned[$index]
        try {
            if ($entry.Identity.Name -eq 'postgres') {
                Stop-ScoutNewsPostgres -Bin $postgresBin -Data $data -Identity $entry.Identity
            } else { Stop-ScoutNewsOwnedProcess $entry.Identity }
        } catch { $cleanupFailed = $true; Write-Warning $_.Exception.Message }
    }
    if ($lock) {
        if (-not $cleanupFailed -and (Test-Path -LiteralPath $metadataPath)) {
            $current = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
            if ($current.SessionId -eq $sessionId) { Remove-Item -LiteralPath $metadataPath }
        }
        $lock.Dispose()
    }
    if ($cleanupFailed) { throw 'Some owned services could not be stopped; use scripts\stop-local.ps1 to retry.' }
}
