[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-zA-Z0-9-]+\.[a-zA-Z0-9]+$')]
    [string]$TunnelId,
    [switch]$SkipBuild
)

. (Join-Path $PSScriptRoot 'runtime-common.ps1')
$root = $script:ScoutNewsRoot
$port = 5190
$metadataPath = Join-Path $root 'tmp\public-reader-runtime.json'
$lockPath = Join-Path $root 'tmp\public-reader-runtime.lock'
$sessionId = [Guid]::NewGuid().ToString('N')
$runDirectory = Join-Path $root "tmp\public-reader-runs\$sessionId"
$stopRequest = Join-Path $runDirectory 'stop.request'
$owned = New-Object System.Collections.ArrayList
$lock = $null
$metadata = $null
try {
    Initialize-ScoutNewsNode
    New-Item -ItemType Directory -Force (Join-Path $root 'tmp') | Out-Null
    $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
    if (Test-Path -LiteralPath $metadataPath) { throw 'Public reader metadata exists. Run scripts\stop-public-reader.ps1 before restarting.' }
    Assert-ScoutNewsPortsFree @($port)
    $tunnel = (Get-Command devtunnel.exe -ErrorAction Stop).Source
    $listing = @(& $tunnel port list $TunnelId)
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the requested tunnel. Nothing was exposed.' }
    $ports = @($listing | ForEach-Object { if ($_ -match '^\s*(\d+)\s+(http|https|auto)\b') { [int]$Matches[1] } })
    if ($ports.Count -ne 1 -or $ports[0] -ne $port -or ($listing -join "`n") -notmatch 'Found 1 tunnel port') {
        throw 'Refusing to host: this dedicated tunnel must contain exactly one port, 5190.'
    }
    if (-not $SkipBuild) {
        Push-Location $root
        try { & npm.cmd run build --workspace '@scoutnews/web'; if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' } }
        finally { Pop-Location }
    }
    $dist = Join-Path $root 'apps\web\dist'
    if (-not (Test-Path -LiteralPath (Join-Path $dist 'index.html'))) { throw 'Production frontend is missing.' }
    New-Item -ItemType Directory -Force $runDirectory | Out-Null
    $site = Join-Path $runDirectory 'site'
    Copy-Item -LiteralPath $dist -Destination $site -Recurse
    $metadata = [ordered]@{
        Version = 1; Root = $root; SessionId = $sessionId; TunnelId = $TunnelId
        Port = $port; PublicUrl = $null; StopRequest = $stopRequest
        Supervisor = Get-ScoutNewsProcessIdentity (Get-Process -Id $PID) 'public-supervisor'
        Processes = @()
    }
    function Save-PublicRuntime {
        $metadata.Processes = @($owned | ForEach-Object { $_.Identity })
        $pending = "$metadataPath.$sessionId.pending"
        [IO.File]::WriteAllText($pending, ($metadata | ConvertTo-Json -Depth 6))
        if (Test-Path -LiteralPath $metadataPath) { [IO.File]::Replace($pending, $metadataPath, [NullString]::Value) }
        else { [IO.File]::Move($pending, $metadataPath) }
    }
    Save-PublicRuntime
    $script:ScoutNewsProcessStarted = { Save-PublicRuntime }
    $env:SCOUTNEWS_PUBLIC_PORT = "$port"
    $env:SCOUTNEWS_PUBLIC_API_ORIGIN = 'http://127.0.0.1:8080'
    $env:SCOUTNEWS_PUBLIC_DIST = $site
    $reader = Start-ScoutNewsOwnedProcess -Name public-reader -FilePath (Get-Command node.exe).Source `
        -Arguments @((Join-Path $root 'services\public-reader\server.cjs')) -WorkingDirectory $root -LogDirectory $runDirectory -Owned $owned
    Wait-ScoutNewsHttp -Url "http://127.0.0.1:$port/health" -Services $owned
    $null = Invoke-RestMethod "http://127.0.0.1:$port/beta/api/events?limit=1"
    $hostProcess = Start-ScoutNewsOwnedProcess -Name devtunnel -FilePath $tunnel -Arguments @('host', $TunnelId) `
        -WorkingDirectory $root -LogDirectory $runDirectory -Owned $owned
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while ([DateTime]::UtcNow -lt $deadline -and -not $metadata.PublicUrl) {
        Assert-ScoutNewsServicesAlive $owned
        $output = Get-Content -LiteralPath $hostProcess.Stdout -Raw -ErrorAction SilentlyContinue
        if ($output -match 'https://[a-zA-Z0-9-]+-5190\.[a-zA-Z0-9]+\.devtunnels\.ms') { $metadata.PublicUrl = $Matches[0] }
        else { Start-Sleep -Milliseconds 400 }
    }
    if (-not $metadata.PublicUrl) { throw 'Tunnel did not report a reader URL. Inspect the dedicated run logs.' }
    Save-PublicRuntime
    Write-Host "Public reader: $($metadata.PublicUrl)"
    Write-Host "Read-only server API; reader feedback is browser-local. No owner/admin/account APIs are exposed."
    Write-Host "Stop with scripts\stop-public-reader.ps1. Logs: $runDirectory"
    while (-not (Test-Path -LiteralPath $stopRequest)) {
        Assert-ScoutNewsServicesAlive $owned
        Start-Sleep -Milliseconds 500
    }
} finally {
    $cleanupFailed = $false
    for ($index = $owned.Count - 1; $index -ge 0; $index--) {
        try { Stop-ScoutNewsOwnedProcess $owned[$index].Identity }
        catch { $cleanupFailed = $true; Write-Warning $_.Exception.Message }
    }
    if ($metadata -and -not $cleanupFailed -and (Test-Path -LiteralPath $metadataPath)) {
        $current = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
        if ($current.SessionId -eq $sessionId) { Remove-Item -LiteralPath $metadataPath }
    }
    if ($lock) { $lock.Dispose() }
    if ($cleanupFailed) { throw 'Some public-reader processes remain; run scripts\stop-public-reader.ps1 to retry.' }
}
