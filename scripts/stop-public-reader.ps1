[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'runtime-common.ps1')
Initialize-ScoutNewsNode
$root = $script:ScoutNewsRoot
$path = Join-Path $root 'tmp\public-reader-runtime.json'
if (-not (Test-Path -LiteralPath $path)) { Write-Host 'No public-reader runtime is registered; nothing was stopped.'; return }
$metadata = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
if ($metadata.Version -ne 1 -or $metadata.Root -ne $root -or $metadata.SessionId -notmatch '^[a-f0-9]{32}$') {
    throw 'Unrecognized public-reader metadata; refusing to stop anything.'
}
$stop = Join-Path $root "tmp\public-reader-runs\$($metadata.SessionId)\stop.request"
if ($metadata.StopRequest -ne $stop) { throw 'Invalid public-reader stop path.' }
if (Test-ScoutNewsProcessIdentity $metadata.Supervisor) {
    [IO.File]::WriteAllText($stop, 'stop')
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $deadline -and (Test-Path -LiteralPath $path)) {
        if (-not (Test-ScoutNewsProcessIdentity $metadata.Supervisor)) { break }
        Start-Sleep -Milliseconds 300
    }
    if (-not (Test-Path -LiteralPath $path)) { Write-Host 'Public access stopped. Personal reader and persistent tunnel configuration were retained.'; return }
    if (Test-ScoutNewsProcessIdentity $metadata.Supervisor) { throw 'Public supervisor is still shutting down; inspect its logs.' }
}
$lock = [IO.File]::Open((Join-Path $root 'tmp\public-reader-runtime.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    if (-not (Test-Path -LiteralPath $path)) { return }
    $current = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($current.SessionId -ne $metadata.SessionId) { throw 'Public runtime changed; retry.' }
    $allowed = @{ 'public-reader' = (Get-Command node.exe).Source; devtunnel = (Get-Command devtunnel.exe).Source }
    $processes = @($current.Processes)
    for ($index = $processes.Count - 1; $index -ge 0; $index--) {
        $identity = $processes[$index]
        if (-not $allowed.ContainsKey($identity.Name) -or $identity.ExecutablePath -ne $allowed[$identity.Name]) {
            throw 'Unexpected public-reader executable; refusing to stop it.'
        }
        Stop-ScoutNewsOwnedProcess $identity
    }
    Remove-Item -LiteralPath $path
    Write-Host 'Stopped only verified public-reader processes. Personal reader remains unchanged.'
} finally { $lock.Dispose() }
