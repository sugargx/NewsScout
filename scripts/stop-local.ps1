[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'runtime-common.ps1')
$root = $script:ScoutNewsRoot
$metadataPath = Join-Path $root 'tmp\local-runtime.json'
if (-not (Test-Path -LiteralPath $metadataPath)) {
    Write-Host 'No ScoutNews local runtime metadata exists; no processes were stopped.'
    return
}
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
if ($metadata.Version -ne 1 -or $metadata.Root -ne $root -or $metadata.SessionId -notmatch '^[a-f0-9]{32}$') {
    throw 'Unrecognized runtime metadata; refusing to stop anything.'
}
$stopRequest = Join-Path $root "tmp\local-runs\$($metadata.SessionId)\stop.request"
if ($metadata.StopRequest -ne $stopRequest) { throw 'Invalid runtime stop-request path.' }
if (Test-ScoutNewsProcessIdentity $metadata.Supervisor) {
    [IO.File]::WriteAllText($stopRequest, 'stop')
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Test-Path -LiteralPath $metadataPath)) {
            Write-Host 'ScoutNews stopped. Persistent database data was retained.'
            return
        }
        if (-not (Test-ScoutNewsProcessIdentity $metadata.Supervisor)) { break }
        Start-Sleep -Milliseconds 300
    }
    if (Test-ScoutNewsProcessIdentity $metadata.Supervisor) {
        throw 'Supervisor has not finished stopping. Check its output; no unrelated process was stopped.'
    }
}

# A supervisor that was forcibly closed cannot run its finally block. Recover only verified PIDs.
$lockPath = Join-Path $root 'tmp\local-runtime.lock'
$lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
try {
    if (-not (Test-Path -LiteralPath $metadataPath)) {
        Write-Host 'ScoutNews stopped. Persistent database data was retained.'
        return
    }
    $current = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if ($current.SessionId -ne $metadata.SessionId) { throw 'Runtime changed during shutdown; retry.' }
    $allowedExecutables = @{
        api = Join-Path $root 'services\api\target\debug\scoutnews-api.exe'
        gateway = (Get-Command node.exe -ErrorAction Stop).Source
        web = (Get-Command node.exe -ErrorAction Stop).Source
        postgres = Join-Path $root 'tmp\postgres-e2e\runtime\pgsql\bin\postgres.exe'
    }
    $processes = @($current.Processes)
    for ($index = $processes.Count - 1; $index -ge 0; $index--) {
        $identity = $processes[$index]
        if (-not $allowedExecutables.ContainsKey($identity.Name) -or
            $identity.ExecutablePath -ne $allowedExecutables[$identity.Name]) {
            throw 'Unexpected executable in runtime metadata; refusing to stop it.'
        }
        if ($identity.Name -eq 'postgres') {
            Stop-ScoutNewsPostgres -Bin (Join-Path $root 'tmp\postgres-e2e\runtime\pgsql\bin') `
                -Data (Join-Path $root 'tmp\postgres-local\data') -Identity $identity
        } else { Stop-ScoutNewsOwnedProcess $identity }
    }
    Remove-Item -LiteralPath $metadataPath
    Write-Host 'Stopped verified orphaned ScoutNews processes. Persistent database data was retained.'
} finally { $lock.Dispose() }
