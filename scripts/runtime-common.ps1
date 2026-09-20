$ErrorActionPreference = 'Stop'
$script:ScoutNewsRoot = Split-Path -Parent $PSScriptRoot
$script:ScoutNewsProcessStarted = $null

function Initialize-ScoutNewsNode {
    $portable = Join-Path $script:ScoutNewsRoot 'tmp\node-runtime\node-v22.23.2-win-x64'
    if (Test-Path -LiteralPath (Join-Path $portable 'node.exe')) {
        $env:PATH = $portable + ';' + $env:PATH
    }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) {
        throw 'Node.js is unavailable. Run scripts\bootstrap-node.ps1 to install an isolated project-local runtime, then retry.'
    }
    $version = & $node.Source --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        throw 'ScoutNews requires Node.js 22+. Use scripts\bootstrap-node.ps1 for a project-local runtime without changing NVM.'
    }
}

function Import-ScoutNewsEnvironment {
    $path = Join-Path $script:ScoutNewsRoot '.env'
    if (-not (Test-Path -LiteralPath $path)) { return }
    $lineNumber = 0
    foreach ($line in [IO.File]::ReadAllLines($path)) {
        $lineNumber++
        $text = $line.Trim()
        if (-not $text -or $text.StartsWith('#')) { continue }
        if ($text -notmatch '^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            throw "Invalid .env assignment at line $lineNumber (values are not logged)."
        }
        $name = $Matches[1]
        $value = $Matches[2].Trim()
        if ($value.StartsWith('"') -or $value.StartsWith("'")) {
            $quote = $value.Substring(0, 1)
            $end = $value.IndexOf($quote, 1)
            if ($end -lt 1 -or $value.Substring($end + 1).Trim() -notmatch '^(#.*)?$') {
                throw "Invalid quoted .env value at line $lineNumber."
            }
            $value = $value.Substring(1, $end - 1)
            if ($quote -eq '"') {
                $value = $value.Replace('\n', "`n").Replace('\r', "`r")
            }
        } else {
            $value = ($value -replace '\s+#.*$', '').TrimEnd()
        }
        # Existing process environment takes precedence, as with dotenv.
        if ($null -eq [Environment]::GetEnvironmentVariable($name, 'Process')) {
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}

function Set-ScoutNewsRuntimeEnvironment {
    param([int]$ApiPort, [int]$GatewayPort, [int]$WebPort, [switch]$Demo)
    Initialize-ScoutNewsNode
    $env:SCOUTNEWS_BIND = "127.0.0.1:$ApiPort"
    $env:SCOUTNEWS_API_URL = "http://127.0.0.1:$ApiPort"
    $env:WEB_ORIGIN = "http://127.0.0.1:$WebPort"
    $env:COPILOT_GATEWAY_BIND = '127.0.0.1'
    $env:COPILOT_GATEWAY_PORT = "$GatewayPort"
    $env:COPILOT_GATEWAY_URL = "http://127.0.0.1:$GatewayPort"
    $env:SCOUTNEWS_DEMO_MODE = if ($Demo) { 'true' } else { 'false' }
    $env:SCOUTNEWS_BROWSER_NODE = (Get-Command node.exe -ErrorAction Stop).Source
    $env:SCOUTNEWS_BROWSER_CAPTURE_SCRIPT = Join-Path $script:ScoutNewsRoot 'services\source-access\browser-article.cjs'
    if ($null -eq $env:SCOUTNEWS_BROWSER_ARTICLE_HOSTS) {
        $env:SCOUTNEWS_BROWSER_ARTICLE_HOSTS = 'openai.com,www.openai.com'
    }
    if (-not $env:GITHUB_CALLBACK_URL) {
        $env:GITHUB_CALLBACK_URL = "$($env:SCOUTNEWS_API_URL)/api/v1/auth/github/callback"
    }
    if ([string]::IsNullOrWhiteSpace($env:COPILOT_GATEWAY_SHARED_SECRET)) {
        $bytes = New-Object byte[] 32
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($bytes) } finally { $random.Dispose() }
        $env:COPILOT_GATEWAY_SHARED_SECRET = [Convert]::ToBase64String($bytes)
    }
}

function Assert-ScoutNewsPortsFree {
    param([int[]]$Ports)
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    foreach ($port in $Ports) {
        if (@($listeners | Where-Object { $_.Port -eq $port }).Count -gt 0) {
            throw "Port $port is already occupied. Nothing was stopped; stop its owner or the other ScoutNews run first."
        }
    }
}

function Get-ScoutNewsProcessIdentity {
    param([Diagnostics.Process]$Process, [string]$Name)
    $path = $null
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $Process.Refresh()
        if ($Process.HasExited) { throw "$Name exited before it could be registered (exit $($Process.ExitCode))." }
        # WMI can lag process creation; prefer the path from the owned process handle.
        $path = $Process.Path
        if (-not $path) {
            $native = Get-CimInstance Win32_Process -Filter "ProcessId = $($Process.Id)" -ErrorAction Stop
            $path = $native.ExecutablePath
        }
        if ($path) { break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $path) { throw "Cannot identify the executable for $Name (PID $($Process.Id))." }
    [pscustomobject]@{
        Name = $Name
        Id = $Process.Id
        StartedUtcTicks = $Process.StartTime.ToUniversalTime().Ticks.ToString()
        ExecutablePath = $path
    }
}

function Test-ScoutNewsProcessIdentity {
    param($Identity)
    if (-not $Identity) { return $false }
    try {
        $process = Get-Process -Id ([int]$Identity.Id) -ErrorAction Stop
        $path = $process.Path
        if (-not $path) {
            $native = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Identity.Id)" -ErrorAction Stop
            $path = $native.ExecutablePath
        }
        return (
            $process.StartTime.ToUniversalTime().Ticks.ToString() -eq [string]$Identity.StartedUtcTicks -and
            [string]::Equals($path, [string]$Identity.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)
        )
    } catch { return $false }
}

function Stop-ScoutNewsOwnedProcess {
    param($Identity)
    if (-not (Test-ScoutNewsProcessIdentity $Identity)) { return }
    # Snapshot the complete tree before stopping anything: stopping conhost can make
    # its parent exit before the other children have been visited.
    $tree = New-Object System.Collections.ArrayList
    [void]$tree.Add($Identity)
    for ($index = 0; $index -lt $tree.Count; $index++) {
        $parent = $tree[$index]
        if (-not (Test-ScoutNewsProcessIdentity $parent)) { continue }
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $([int]$parent.Id)" -ErrorAction Stop)
        foreach ($child in $children) {
            $process = Get-Process -Id ([int]$child.ProcessId) -ErrorAction SilentlyContinue
            if (-not $process) { continue }
            try { $childIdentity = Get-ScoutNewsProcessIdentity $process 'owned child' }
            catch { continue }
            $sameCreation = [Math]::Abs([long]$childIdentity.StartedUtcTicks - $child.CreationDate.ToUniversalTime().Ticks) -lt [TimeSpan]::TicksPerMillisecond
            if ($sameCreation -and [long]$childIdentity.StartedUtcTicks -ge [long]$parent.StartedUtcTicks -and
                (Test-ScoutNewsProcessIdentity $parent)) {
                [void]$tree.Add($childIdentity)
            }
        }
    }
    for ($index = $tree.Count - 1; $index -ge 0; $index--) {
        $member = $tree[$index]
        if (Test-ScoutNewsProcessIdentity $member) {
            try { Stop-Process -Id ([int]$member.Id) -Force -ErrorAction Stop }
            catch { if (Test-ScoutNewsProcessIdentity $member) { throw } }
        }
    }
}

function ConvertTo-ScoutNewsArgument {
    param([string]$Value)
    '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Start-ScoutNewsOwnedProcess {
    param(
        [string]$Name, [string]$FilePath, [string[]]$Arguments,
        [string]$WorkingDirectory, [string]$LogDirectory,
        [System.Collections.IList]$Owned
    )
    $stdout = Join-Path $LogDirectory "$Name.stdout.log"
    $stderr = Join-Path $LogDirectory "$Name.stderr.log"
    $options = @{
        FilePath = $FilePath
        WorkingDirectory = $WorkingDirectory
        RedirectStandardOutput = $stdout
        RedirectStandardError = $stderr
        WindowStyle = 'Hidden'
        PassThru = $true
    }
    if ($Arguments.Count -gt 0) {
        $options.ArgumentList = (@($Arguments | ForEach-Object { ConvertTo-ScoutNewsArgument $_ }) -join ' ')
    }
    $process = Start-Process @options
    # Retain the handle so Windows PowerShell can read ExitCode after Refresh().
    $null = $process.Handle
    try {
        $identity = Get-ScoutNewsProcessIdentity $process $Name
    } catch {
        throw "Could not register $Name during startup: $($_.Exception.Message) Inspect $stderr and $stdout."
    }
    $entry = [pscustomobject]@{ Identity = $identity; Process = $process; Stdout = $stdout; Stderr = $stderr }
    [void]$Owned.Add($entry)
    if ($script:ScoutNewsProcessStarted) { & $script:ScoutNewsProcessStarted }
    return $entry
}

function Assert-ScoutNewsServicesAlive {
    param([System.Collections.IList]$Services)
    foreach ($service in $Services) {
        $service.Process.Refresh()
        if ($service.Process.HasExited) {
            throw "$($service.Identity.Name) exited with code $($service.Process.ExitCode). Inspect $($service.Stderr) and $($service.Stdout)."
        }
    }
}

function Wait-ScoutNewsHttp {
    param([string]$Url, [System.Collections.IList]$Services, [int]$TimeoutSeconds = 90)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        Assert-ScoutNewsServicesAlive $Services
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch {}
        Start-Sleep -Milliseconds 300
    }
    throw "Timed out waiting for $Url. Inspect service logs."
}

function Get-ScoutNewsPostgresBin {
    param([switch]$BootstrapPostgres)
    $runtime = Join-Path $script:ScoutNewsRoot 'tmp\postgres-e2e\runtime'
    $bin = Join-Path $runtime 'pgsql\bin'
    if (-not (Test-Path -LiteralPath (Join-Path $bin 'postgres.exe'))) {
        if (-not $BootstrapPostgres) {
            throw 'PostgreSQL runtime is missing at tmp\postgres-e2e\runtime\pgsql\bin. Re-run with -BootstrapPostgres to explicitly download it, or use -Demo.'
        }
        $archive = Join-Path $script:ScoutNewsRoot 'tmp\postgres-e2e\postgres.zip'
        New-Item -ItemType Directory -Force (Split-Path $archive) | Out-Null
        Invoke-WebRequest -UseBasicParsing -Uri 'https://get.enterprisedb.com/postgresql/postgresql-17.10-2-windows-x64-binaries.zip' -OutFile $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $runtime -Force
    }
    foreach ($name in @('postgres', 'initdb', 'pg_ctl', 'pg_isready', 'psql', 'createdb', 'dropdb')) {
        if (-not (Test-Path -LiteralPath (Join-Path $bin "$name.exe"))) {
            throw "PostgreSQL runtime is incomplete: $name.exe is missing."
        }
    }
    return $bin
}

function Start-ScoutNewsPostgres {
    param(
        [string]$Bin, [string]$Data, [int]$Port, [string]$LogDirectory,
        [System.Collections.IList]$Owned
    )
    Assert-ScoutNewsPortsFree @($Port)
    if (-not (Test-Path -LiteralPath (Join-Path $Data 'PG_VERSION'))) {
        if ((Test-Path -LiteralPath $Data) -and @(Get-ChildItem -LiteralPath $Data -Force).Count -gt 0) {
            throw "PostgreSQL directory is nonempty but uninitialized: $Data. No files were removed."
        }
        New-Item -ItemType Directory -Force (Split-Path $Data) | Out-Null
        & (Join-Path $Bin 'initdb.exe') -D $Data -U scoutnews -A reject --encoding=UTF8 --locale=C
        if ($LASTEXITCODE -ne 0) { throw "initdb failed with exit code $LASTEXITCODE." }
        # No network-wide trust rule, and postgres is also explicitly bound to IPv4 loopback.
        [IO.File]::WriteAllText((Join-Path $Data 'pg_hba.conf'), "host all all 127.0.0.1/32 trust`r`n")
    }
    $entry = Start-ScoutNewsOwnedProcess -Name postgres -FilePath (Join-Path $Bin 'postgres.exe') `
        -Arguments @('-D', $Data, '-p', "$Port", '-h', '127.0.0.1') `
        -WorkingDirectory (Split-Path $Data) -LogDirectory $LogDirectory -Owned $Owned
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $deadline) {
        Assert-ScoutNewsServicesAlive $Owned
        & (Join-Path $Bin 'pg_isready.exe') -h 127.0.0.1 -p $Port -U scoutnews -d postgres -t 1 | Out-Null
        $status = $LASTEXITCODE
        if ($status -eq 0) {
            Assert-ScoutNewsServicesAlive $Owned
            $actualData = & (Join-Path $Bin 'psql.exe') -X -w -h 127.0.0.1 -p $Port -U scoutnews -d postgres -v ON_ERROR_STOP=1 -Atc 'SHOW data_directory'
            if ($LASTEXITCODE -ne 0) { throw "PostgreSQL identity query failed with exit code $LASTEXITCODE." }
            if ([IO.Path]::GetFullPath(([string]$actualData).Replace('/', '\')).TrimEnd('\') -ne
                [IO.Path]::GetFullPath($Data).TrimEnd('\')) {
                throw 'PostgreSQL data directory does not match this run; refusing to use it.'
            }
            return $entry
        }
        if ($status -notin @(1, 2)) { throw "pg_isready failed with exit code $status." }
        Start-Sleep -Milliseconds 300
    }
    throw "PostgreSQL did not become ready. Inspect $($entry.Stderr)."
}

function Stop-ScoutNewsPostgres {
    param([string]$Bin, [string]$Data, $Identity)
    if (-not (Test-ScoutNewsProcessIdentity $Identity)) { return }
    $pidFile = Join-Path $Data 'postmaster.pid'
    if (-not (Test-Path -LiteralPath $pidFile) -or
        ([IO.File]::ReadAllLines($pidFile)[0] -ne [string]$Identity.Id)) {
        throw 'Refusing PostgreSQL shutdown: data directory PID does not match the owned process.'
    }
    & (Join-Path $Bin 'pg_ctl.exe') -D $Data -w -t 30 stop -m fast
    if ($LASTEXITCODE -ne 0) { throw "Owned PostgreSQL shutdown failed with exit code $LASTEXITCODE." }
}

function Build-ScoutNews {
    $npm = Get-Command npm.cmd -ErrorAction Stop
    Push-Location $script:ScoutNewsRoot
    try {
        & $npm.Source run build
        if ($LASTEXITCODE -ne 0) { throw "npm build failed with exit code $LASTEXITCODE." }
        & (Join-Path $PSScriptRoot 'rust.ps1') -CargoArgs @('build')
    } finally { Pop-Location }
}

function Start-ScoutNewsApplication {
    param([int]$WebPort, [string]$LogDirectory, [System.Collections.IList]$Owned, [string]$ApiExecutable)
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $api = if ($ApiExecutable) {
        (Resolve-Path -LiteralPath $ApiExecutable -ErrorAction Stop).Path
    } else {
        Join-Path $script:ScoutNewsRoot 'services\api\target\debug\scoutnews-api.exe'
    }
    $gateway = Join-Path $script:ScoutNewsRoot 'services\copilot-gateway\dist\index.js'
    $vite = Join-Path $script:ScoutNewsRoot 'node_modules\vite\bin\vite.js'
    foreach ($path in @($api, $gateway, $vite)) {
        if (-not (Test-Path -LiteralPath $path)) {
            throw "Required runtime file is missing: $path. Install project dependencies yourself if missing, then start without -SkipBuild."
        }
    }
    $null = Start-ScoutNewsOwnedProcess -Name gateway -FilePath $node -Arguments @($gateway) `
        -WorkingDirectory (Join-Path $script:ScoutNewsRoot 'services\copilot-gateway') -LogDirectory $LogDirectory -Owned $Owned
    Wait-ScoutNewsHttp "$($env:COPILOT_GATEWAY_URL)/health" $Owned
    $null = Start-ScoutNewsOwnedProcess -Name api -FilePath $api -Arguments @() `
        -WorkingDirectory (Join-Path $script:ScoutNewsRoot 'services\api') -LogDirectory $LogDirectory -Owned $Owned
    $previousCI = $env:CI
    try {
        # Hidden Vite servers must not attach readline to a Windows console that can close.
        $env:CI = 'true'
        $null = Start-ScoutNewsOwnedProcess -Name web -FilePath $node `
            -Arguments @($vite, '--host', '127.0.0.1', '--port', "$WebPort", '--strictPort') `
            -WorkingDirectory (Join-Path $script:ScoutNewsRoot 'apps\web') -LogDirectory $LogDirectory -Owned $Owned
    } finally { $env:CI = $previousCI }
    Wait-ScoutNewsHttp "$($env:SCOUTNEWS_API_URL)/health" $Owned
    Wait-ScoutNewsHttp "$($env:WEB_ORIGIN)/" $Owned
}
