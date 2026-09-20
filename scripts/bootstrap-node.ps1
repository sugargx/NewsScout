[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'tmp\node-runtime'
$version = '22.23.2'
$name = "node-v$version-win-x64"
$node = Join-Path $runtime "$name\node.exe"
if (Test-Path -LiteralPath $node) {
    & $node --version
    if ($LASTEXITCODE -ne 0) { throw 'The existing project-local Node runtime could not start.' }
    return
}
New-Item -ItemType Directory -Force $runtime | Out-Null
$archive = Join-Path $runtime "$name.zip"
Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$version/$name.zip" -OutFile $archive
$expected = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Node archive SHA-256 does not match the official release checksum; nothing was installed.'
}
Expand-Archive -LiteralPath $archive -DestinationPath $runtime -Force
& $node --version
if ($LASTEXITCODE -ne 0) { throw 'The downloaded Node runtime could not start.' }
Remove-Item -LiteralPath $archive
Write-Host 'Project-local Node is ready. Global Node/NVM settings were not changed.'
