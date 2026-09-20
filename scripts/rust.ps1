[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$CargoArgs = @('build')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cargoCommand = Get-Command cargo.exe -ErrorAction SilentlyContinue
$cargo = if ($cargoCommand) { $cargoCommand.Source } else { Join-Path $HOME '.cargo\bin\cargo.exe' }
if (-not (Test-Path -LiteralPath $cargo -PathType Leaf)) {
    throw 'Rust cargo.exe was not found. Install Rust, or add cargo.exe to PATH.'
}

$installations = @()
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path -LiteralPath $vswhere) {
    $installations = @(& $vswhere -all -products '*' -property installationPath)
    if ($LASTEXITCODE -ne 0) { throw "vswhere failed with exit code $LASTEXITCODE." }
    $installations += @(& $vswhere -all -prerelease -products '*' -property installationPath)
    if ($LASTEXITCODE -ne 0) { throw "vswhere failed with exit code $LASTEXITCODE." }
}
if ($env:VSINSTALLDIR) { $installations += $env:VSINSTALLDIR }
$developerCommand = $null
foreach ($installation in ($installations | Select-Object -Unique)) {
    $vcvars = Join-Path $installation 'VC\Auxiliary\Build\vcvars64.bat'
    $vcvarsall = Join-Path $installation 'VC\Auxiliary\Build\vcvarsall.bat'
    $vsdev = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
    if ((Test-Path -LiteralPath $vcvars) -and (Test-Path -LiteralPath $vcvarsall)) {
        $developerCommand = "call `"$vcvars`" >nul"
        break
    }
    if (Test-Path -LiteralPath $vsdev) {
        $toolsets = @(Get-ChildItem -LiteralPath (Join-Path $installation 'VC\Tools\MSVC') -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending)
        foreach ($toolset in $toolsets) {
            if (-not (Test-Path -LiteralPath (Join-Path $toolset.FullName 'bin\Hostx64\x64\link.exe'))) { continue }
            $platform = 'Desktop'
            if (-not (Test-Path -LiteralPath (Join-Path $toolset.FullName 'lib\x64\msvcrt.lib'))) {
                if (-not (Test-Path -LiteralPath (Join-Path $toolset.FullName 'lib\onecore\x64\msvcrt.lib'))) { continue }
                $platform = 'OneCore'
            }
            # Partial VS installs can lack vcvarsall/default-version files. Let VS itself
            # select its installed toolset, platform libraries and Windows SDK.
            $developerCommand = "call `"$vsdev`" -arch=x64 -host_arch=x64 -vcvars_ver=$($toolset.Name) -app_platform=$platform >nul"
            break
        }
        if ($developerCommand) { break }
    }
}
if (-not $developerCommand) {
    throw 'Visual Studio C++ build tools were not found by vswhere. Install the Desktop development with C++ workload.'
}

# cmd.exe expands shell metacharacters even inside some quoted arguments.
foreach ($argument in @($cargo) + $CargoArgs) {
    if ($argument -match '[\r\n"%!&|<>^]') {
        throw 'Cargo arguments must not contain cmd.exe shell metacharacters.'
    }
}
$quotedArguments = @($CargoArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
$command = "$developerCommand && where link.exe >nul && `"$cargo`" $quotedArguments"
$originalPath = $env:PATH
if (Test-Path -LiteralPath $vswhere) { $env:PATH = (Split-Path $vswhere) + ';' + $env:PATH }
Push-Location (Join-Path $root 'services\api')
try {
    # The compiler and linker inherit the SDK environment in this SAME cmd process.
    & $env:ComSpec /d /s /c $command
    if ($LASTEXITCODE -ne 0) { throw "cargo failed with exit code $LASTEXITCODE." }
} finally {
    $env:PATH = $originalPath
    Pop-Location
}
