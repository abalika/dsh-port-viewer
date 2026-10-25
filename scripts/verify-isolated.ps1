<#
.SYNOPSIS
  Boot an isolated dsh web instance with dsh-port-viewer linked and run the E2E driver.

.DESCRIPTION
  This is the verification harness required by docs/CONTRACT.md section 8. It
  never touches the user's running desktop instance or the real desktop profile.

  Steps:
    1. resolve the Desktop installation (exe + asar CLI) and `node`
    2. make sure the isolated profile exists under <repo>\.verify\home
       (created once from the shipped `web` template via --from-default-profile)
    3. link this plugin into that profile with scripts\install-desktop.ps1
       (-DshHome / -ProfileName / -PluginDir / -BackupRoot are all isolated here)
    4. fail fast if the port is already taken, then boot
       `dsh --profile <name> --port <port> --host 127.0.0.1 --no-open`
       with DSH_HOME pointing at the isolated home
    5. poll the redirected stdout for the `dsh web: http://127.0.0.1:<port>/?token=...`
       line (no fixed sleep); on timeout print both log tails and the port owner
    6. run test\e2e\e2e.mjs against that token URL
    7. always clean up: kill the instance tree, wait for the port to be released,
       clear the sacrificial listener port, then report leftover processes

  Exit code is 0 only when the E2E driver passed and cleanup left nothing behind.

.PARAMETER Port
  Isolated instance port. Default 3099.

.PARAMETER ProfileName
  Isolated profile name. Default portverify.

.PARAMETER DshHome
  Isolated DSH_HOME. Default %TEMP%\dsh-port-viewer-verify\home; never your real dsh home.

.PARAMETER PluginRoot
  Plugin checkout to link. Default: the repository root (or test\e2e\shell-plugin
  with -UseShellPlugin).

.PARAMETER InstallRoot
  Desktop installation root holding "DeepSeek Harness.exe". Default: auto-detected
  from $env:DSH_DESKTOP_INSTALL_ROOT, then the usual install locations.

.PARAMETER Phase
  smoke (harness only) | api | ui (screenshots only) | full (api + screenshots). Default full.

.PARAMETER EdgePath
  Headless browser executable for screenshots. Auto-detected when empty.

.PARAMETER TimeoutSec
  How long to wait for the token URL line. Default 120.

.PARAMETER UseShellPlugin
  Link test\e2e\shell-plugin instead of the repository (phase A only, before lib/ exists).

.PARAMETER KeepInstance
  Do not kill the instance at the end (debugging only; leftover check still runs).

.PARAMETER BootOnly
  Boot, print the token URL, and stop (no E2E driver).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\verify-isolated.ps1 -UseShellPlugin -Phase smoke
  powershell -ExecutionPolicy Bypass -File scripts\verify-isolated.ps1 -Phase full
#>
[CmdletBinding()]
param(
  [int]$Port = 3099,
  [string]$ProfileName = 'portverify',
  [string]$DshHome = '',
  [string]$PluginRoot = '',
  [string]$InstallRoot = '',
  [ValidateSet('smoke', 'api', 'ui', 'full')]
  [string]$Phase = 'full',
  [string]$EdgePath = '',
  [int]$TimeoutSec = 120,
  [switch]$UseShellPlugin,
  [switch]$KeepInstance,
  [switch]$BootOnly
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Note([string]$Text) { Write-Host "   $Text" -ForegroundColor DarkGray }

function Assert-Path([string]$Path, [string]$What) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "$What not found: $Path" }
}

function Get-PortListeners([int]$LocalPort) {
  # Parse netstat instead of Get-NetTCPConnection: netstat is stable here (addresses and
  # pids are numeric) and does not depend on the NetTCPIP module in the host running this.
  # Only real listeners count: a closed connection leaves a 127.0.0.1:<port> TIME_WAIT row
  # with pid 0, which must not be mistaken for a listener.
  $rows = @()
  try {
    $pattern = '^\s*TCP\s+\S+:' + $LocalPort + '\s+(\S+)\s+(\S+)\s+(\d+)\s*$'
    foreach ($line in @(netstat -ano -p TCP)) {
      if ($line -notmatch $pattern) { continue }
      $foreign = $Matches[1]
      $state = $Matches[2]
      $ownerPid = [int]$Matches[3]
      if (($state -notmatch 'LISTEN') -and ($ownerPid -le 4)) { continue }
      $rows += [pscustomobject]@{
        OwningProcess = $ownerPid
        LocalPort     = $LocalPort
        LocalAddress  = '127.0.0.1'
        Foreign       = $foreign
        State         = $state
      }
    }
  } catch {
    $rows = @()
  }
  return $rows
}

function Test-PortListening([int]$LocalPort) {
  # Direct TCP connect probe: fast, dependency-free and accurate for a local listener.
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $LocalPort, $null, $null)
    if ($async.AsyncWaitHandle.WaitOne(500)) {
      $client.EndConnect($async)
      return $true
    }
    return $false
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch { }
  }
}

function Get-ListenerOwners([int]$LocalPort) {
  $rows = @()
  foreach ($listener in (Get-PortListeners $LocalPort)) {
    $owner = $null
    try { $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue } catch { $owner = $null }
    $name = 'unknown'
    if ($null -ne $owner) { $name = $owner.ProcessName }
    $rows += ("pid=$($listener.OwningProcess) name=$name state=$($listener.State) foreign=$($listener.Foreign)")
  }
  return $rows
}

function Get-LogTail([string]$Path, [int]$Lines = 40) {
  if (-not (Test-Path -LiteralPath $Path)) { return '(log file missing)' }
  try {
    $all = @(Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction Stop)
    if ($all.Count -eq 0) { return '(log file empty)' }
    $start = [Math]::Max(0, $all.Count - $Lines)
    return ($all[$start..($all.Count - 1)] -join "`n")
  } catch {
    return "(could not read log: $($_.Exception.Message))"
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if ($DshHome -eq '') {
  # Keep the isolated home OUTSIDE the repo: the repo itself is linked into that profile,
  # so an in-repo home would nest into a recursive directory tree.
  $DshHome = Join-Path $env:TEMP 'dsh-port-viewer-verify\home'
}
$DshHome = [System.IO.Path]::GetFullPath($DshHome)

# Install root: explicit -InstallRoot / env var first, then probe the usual locations.
if ($InstallRoot -eq '') {
  $candidates = @()
  if ($env:DSH_DESKTOP_INSTALL_ROOT) { $candidates += $env:DSH_DESKTOP_INSTALL_ROOT }
  # A running app is the most reliable hint about where it is installed.
  $running = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath } | Select-Object -First 1
  if ($running) { $candidates += (Split-Path -Parent $running.ExecutablePath) }
  $candidates += @(
    (Join-Path $env:LOCALAPPDATA 'Programs\deepseek-harness'),
    (Join-Path $env:LOCALAPPDATA 'deepseek-harness'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
    (Join-Path $env:USERPROFILE 'deepseek-harness')
  ) | Where-Object { $_ -and $_.Trim() -ne '' }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $candidate 'DeepSeek Harness.exe')) { $InstallRoot = $candidate; break }
  }
  if ($InstallRoot -eq '') {
    throw 'Could not find the dsh desktop installation. Pass -InstallRoot <dir> (the folder containing "DeepSeek Harness.exe"), or set $env:DSH_DESKTOP_INSTALL_ROOT.'
  }
}
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'DeepSeek Harness.exe'))) {
  throw "No 'DeepSeek Harness.exe' under InstallRoot: $InstallRoot"
}

if ($PluginRoot -eq '') {
  if ($UseShellPlugin) { $PluginRoot = Join-Path $repoRoot 'test\e2e\shell-plugin' }
  else { $PluginRoot = $repoRoot }
}
$PluginRoot = [System.IO.Path]::GetFullPath($PluginRoot)

$exe       = Join-Path $InstallRoot 'DeepSeek Harness.exe'
$asar      = Join-Path $InstallRoot 'resources\app.asar'
$cli       = Join-Path $InstallRoot 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$e2eScript = Join-Path $repoRoot 'test\e2e\e2e.mjs'
$installer = Join-Path $PSScriptRoot 'install-desktop.ps1'
$profileDir = Join-Path $DshHome "profiles\$ProfileName"
$manifest   = Join-Path $profileDir 'package.json'
$runDir     = Join-Path $repoRoot '.verify\run'
$outLog     = Join-Path $runDir "web-$ProfileName.out.log"
$errLog     = Join-Path $runDir "web-$ProfileName.err.log"
$pidFile    = Join-Path $runDir "web-$ProfileName.pid"
$reportPath = Join-Path $repoRoot 'test\e2e\report.json'
$shotsDir   = Join-Path $repoRoot 'test\e2e\shots'
$backupRoot = Join-Path $repoRoot '.verify\profile-backups'

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) { throw 'node is required on PATH (Node.js 22+; the E2E driver uses the built-in WebSocket)' }
$nodeExe = $nodeCommand.Source

$script:instance = $null
$script:booted = $false
$script:failed = $false
$savedDshHome = $env:DSH_HOME
$savedElectronNode = $env:ELECTRON_RUN_AS_NODE

try {
  Write-Step "environment"
  Assert-Path $exe "dsh desktop executable"
  # The CLI entry lives inside app.asar, which Windows APIs cannot see; assert the
  # archive instead and prove the executable can reach the entry with a --version probe.
  Assert-Path $asar "dsh application archive (resources\app.asar)"
  Assert-Path $e2eScript "E2E driver (test\e2e\e2e.mjs)"
  Assert-Path $installer "scripts\install-desktop.ps1"
  Assert-Path (Join-Path $PluginRoot 'lib\index.js') "plugin host half under $PluginRoot"
  Assert-Path (Join-Path $PluginRoot 'lib\client.js') "plugin client half under $PluginRoot"
  Assert-Path (Join-Path $PluginRoot 'package.json') "plugin package.json under $PluginRoot"
  $nodeMajor = 0
  try {
    $nodeVersionText = (& $nodeExe --version) -join ''
    if ($nodeVersionText -match 'v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
  } catch {
    $nodeMajor = 0
  }
  if (($Phase -eq 'full' -or $Phase -eq 'ui') -and $nodeMajor -lt 22) {
    throw "phase full needs Node.js 22+ for the built-in WebSocket (found $nodeVersionText); run -Phase api instead"
  }
  Write-Note "repo    : $repoRoot"
  Write-Note "plugin  : $PluginRoot"
  Write-Note "dsh home: $DshHome"
  Write-Note "profile : $ProfileName"
  Write-Note "port    : $Port (phase $Phase)"
  Write-Note "node    : $nodeExe ($nodeVersionText)"

  Write-Step "dsh CLI preflight"
  if (-not (Test-Path -LiteralPath $runDir)) { New-Item -ItemType Directory -Force -Path $runDir | Out-Null }
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:DSH_HOME = $DshHome
  # The desktop exe is a GUI-subsystem binary: the call operator neither waits for
  # it nor keeps its stdout. Redirect to files through Start-Process (same launch
  # shape as the real instance below) so `dsh --version` is observable.
  $probeOut = Join-Path $runDir 'cli-version.out.log'
  $probeErr = Join-Path $runDir 'cli-version.err.log'
  if (Test-Path -LiteralPath $probeOut) { Remove-Item -LiteralPath $probeOut -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $probeErr) { Remove-Item -LiteralPath $probeErr -Force -ErrorAction SilentlyContinue }
  $cliVersion = ''
  try {
    $probe = Start-Process -FilePath $exe -ArgumentList @('--expose-internals', $cli, '--version') -PassThru -Wait `
      -RedirectStandardOutput $probeOut -RedirectStandardError $probeErr -WindowStyle Hidden
    if (Test-Path -LiteralPath $probeOut) { $cliVersion = ((Get-Content -LiteralPath $probeOut -Raw -ErrorAction SilentlyContinue) -replace '\s+$', '') }
    if ($null -eq $cliVersion) { $cliVersion = '' }
    if ($probe.ExitCode -ne 0 -or $cliVersion -notmatch '\d+\.\d+') {
      throw ("dsh CLI preflight failed (exit " + $probe.ExitCode + "): stdout=[" + $cliVersion + "] stderr=[" + (Get-LogTail $probeErr 10) + "]")
    }
  } catch {
    throw "cannot execute the dsh CLI inside app.asar ($cli): $($_.Exception.Message)"
  }
  Write-Note "cli     : $cliVersion"

  Write-Step "isolated profile"
  if (-not (Test-Path -LiteralPath $manifest)) {
    Write-Note "profile missing; creating it from the shipped 'web' template (no boot)"
    $initOut = Join-Path $runDir 'profile-init.out.log'
    $initErr = Join-Path $runDir 'profile-init.err.log'
    if (Test-Path -LiteralPath $initOut) { Remove-Item -LiteralPath $initOut -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $initErr) { Remove-Item -LiteralPath $initErr -Force -ErrorAction SilentlyContinue }
    $initProc = Start-Process -FilePath $exe -ArgumentList @('--expose-internals', $cli, '--profile', $ProfileName, '--from-default-profile', 'web', '--dump-config') `
      -PassThru -Wait -RedirectStandardOutput $initOut -RedirectStandardError $initErr -WindowStyle Hidden
    if ($initProc.ExitCode -ne 0) {
      throw ("profile creation failed (exit " + $initProc.ExitCode + ").`n--- stderr tail ---`n" + (Get-LogTail $initErr))
    }
    Assert-Path $manifest "profile manifest after creation"
    Write-Note "profile created"
  } else {
    Write-Note "profile already exists, reusing it"
  }
  $profileBundles = @((Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).dsh.profile.bundles)
  if ($profileBundles -notcontains '@deepseek-ai/dsh-web-app') {
    throw "profile '$ProfileName' does not stack @deepseek-ai/dsh-web-app; it is not a web profile. Recreate it with --from-default-profile web."
  }

  Write-Step "link plugin into the isolated profile"
  $installArgs = @{
    ProfileName = $ProfileName
    DshHome     = $DshHome
    PluginDir   = $PluginRoot
    BackupRoot  = $backupRoot
  }
  & $installer @installArgs
  $linkedHostHalf = Join-Path $profileDir "node_modules\dsh-port-viewer\lib\index.js"
  if (-not (Test-Path -LiteralPath $linkedHostHalf)) {
    throw "install-desktop.ps1 ran but the plugin is not reachable from the profile: $linkedHostHalf is missing"
  }
  Write-Note "linked: $profileDir\node_modules\dsh-port-viewer -> $PluginRoot"

  Write-Step "port $Port availability"
  $owners = @(Get-ListenerOwners $Port)
  if ($owners.Count -gt 0) {
    $diagnostic = $owners -join '; '
    throw "port $Port is already in use ($diagnostic). Stop that listener or rerun with -Port 3100. This script never kills a listener it did not start."
  }
  Write-Note "port $Port is free"

  if (-not (Test-Path -LiteralPath $runDir)) { New-Item -ItemType Directory -Force -Path $runDir | Out-Null }
  if (Test-Path -LiteralPath $outLog) { Remove-Item -LiteralPath $outLog -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $errLog) { Remove-Item -LiteralPath $errLog -Force -ErrorAction SilentlyContinue }

  Write-Step "boot isolated instance"
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:DSH_HOME = $DshHome
  $arguments = @(
    '--expose-internals', $cli,
    '--profile', $ProfileName,
    '--port', "$Port",
    '--host', '127.0.0.1',
    '--no-open'
  )
  $script:instance = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
    -WorkingDirectory $repoRoot -WindowStyle Hidden
  $script:booted = $true
  Set-Content -LiteralPath $pidFile -Value ("pid=" + $script:instance.Id) -Encoding ASCII
  Write-Note "pid $($script:instance.Id); stdout -> $outLog"

  Write-Step "wait for the token URL"
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $tokenUrl = ''
  $lastLogText = ''
  while ((Get-Date) -lt $deadline) {
    if ($script:instance.HasExited) {
      Stop-Process -Id $script:instance.Id -Force -ErrorAction SilentlyContinue
      $exitCode = ''
      try { $exitCode = $script:instance.ExitCode } catch { $exitCode = '(unknown)' }
      throw ("isolated instance exited before printing a URL (exit $exitCode).`n--- stdout tail ---`n" + (Get-LogTail $outLog) + "`n--- stderr tail ---`n" + (Get-LogTail $errLog))
    }
    $lastLogText = ''
    if (Test-Path -LiteralPath $outLog) {
      try { $lastLogText = Get-Content -LiteralPath $outLog -Raw -Encoding UTF8 -ErrorAction Stop } catch { $lastLogText = '' }
    }
    if ($null -ne $lastLogText -and $lastLogText -match 'dsh web: (http://\S+\?token=[A-Za-z0-9._~-]+)') {
      $tokenUrl = $Matches[1]
      break
    }
    Start-Sleep -Milliseconds 300
  }
  if ($tokenUrl -eq '') {
    throw ("timed out after ${TimeoutSec}s waiting for the 'dsh web: ...?token=...' line.`n--- stdout tail ---`n" + (Get-LogTail $outLog) + "`n--- stderr tail ---`n" + (Get-LogTail $errLog) + "`n--- port $Port listeners ---`n" + ((Get-ListenerOwners $Port) -join '; '))
  }
  Write-Note ("token URL: " + ($tokenUrl -replace 'token=[^&]+', 'token=<redacted>'))
  if ($Phase -ne 'smoke') {
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      if (Test-PortListening $Port) { $ready = $true; break }
      Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw "token URL was printed but nothing is listening on 127.0.0.1:$Port" }
  }

  if ($BootOnly) {
    Write-Host ''
    Write-Host "BOOTED. token URL:"
    Write-Host $tokenUrl
  } else {
    Write-Step "run E2E driver (phase $Phase)"
    if (-not (Test-Path -LiteralPath $shotsDir)) { New-Item -ItemType Directory -Force -Path $shotsDir | Out-Null }
    $e2eArgs = @(
      $e2eScript,
      '--base-url', $tokenUrl,
      '--port', "$Port",
      '--phase', $Phase,
      '--repo-root', $repoRoot,
      '--shots', $shotsDir,
      '--report', $reportPath
    )
    if ($EdgePath -ne '') { $e2eArgs += @('--edge', $EdgePath) }
if ($UseShellPlugin) { $e2eArgs += @('--shell-plugin') }
    & $nodeExe @e2eArgs
    $e2eExit = $LASTEXITCODE
    if ($e2eExit -ne 0) {
      $script:failed = $true
      Write-Host "E2E driver reported failures (exit $e2eExit). Report: $reportPath" -ForegroundColor Red
    }
  }
} catch {
  $script:failed = $true
  Write-Host ''
  Write-Host ("VERIFY FAILED: " + $_.Exception.Message) -ForegroundColor Red
} finally {
  Write-Step "cleanup"
  if ($null -ne $script:instance) {
    if (-not $script:instance.HasExited) {
      if ($KeepInstance) {
        Write-Note "-KeepInstance set: leaving pid $($script:instance.Id) running"
      } else {
        & taskkill /PID $script:instance.Id /T /F 2>&1 | Out-Null
        $script:instance.WaitForExit(15000) | Out-Null
        if (-not $script:instance.HasExited) {
          Stop-Process -Id $script:instance.Id -Force -ErrorAction SilentlyContinue
        }
        Write-Note "requested shutdown of pid $($script:instance.Id) (tree)"
      }
    } else {
      Write-Note "instance already exited"
    }
    if (-not $KeepInstance) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }
  }

  if (-not $script:booted) {
    if (Test-PortListening $Port) {
      Write-Note "port $Port was already in use before this run; that listener was never ours and was left untouched"
    }
  } elseif ($KeepInstance) {
    Write-Note "port $Port intentionally left listening (-KeepInstance)"
  } else {
    $released = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      if (-not (Test-PortListening $Port)) { $released = $true; break }
      Start-Sleep -Milliseconds 250
    }
    if ($released) {
      Write-Note "port $Port released"
    } else {
      $script:failed = $true
      Write-Host ("PORT NOT RELEASED: $Port still has listeners -> " + ((Get-ListenerOwners $Port) -join '; ')) -ForegroundColor Red
    }
  }

  # Sacrifice listener: ONLY the process this run spawned may be killed, and only by
  # the exact pid the E2E driver reported (report.json info.sacrifice.pid). Anything
  # else that happens to hold 45678 belongs to someone else and is reported, never killed.
  $sacrificePid = 0
  if (Test-Path -LiteralPath $reportPath) {
    try {
      $reportJson = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($null -ne $reportJson.info -and $null -ne $reportJson.info.sacrifice -and $null -ne $reportJson.info.sacrifice.pid) {
        $sacrificePid = [int]$reportJson.info.sacrifice.pid
      }
    } catch {
      $sacrificePid = 0
    }
  }
  if ($sacrificePid -gt 0) {
    $sacrificeAlive = Get-Process -Id $sacrificePid -ErrorAction SilentlyContinue
    if ($null -eq $sacrificeAlive) {
      Write-Note "sacrifice listener pid $sacrificePid is gone"
    } else {
      Write-Host "SACRIFICE LISTENER STILL ALIVE: killing recorded pid $sacrificePid" -ForegroundColor Yellow
      Stop-Process -Id $sacrificePid -Force -ErrorAction SilentlyContinue
      $script:failed = $true
    }
    $sacrificeListeners = @(Get-PortListeners 45678)
    $foreignListeners = @($sacrificeListeners | Where-Object { $_.OwningProcess -ne $sacrificePid })
    if ($sacrificeListeners.Count -eq 0) {
      Write-Note "sacrifice port 45678 released"
    } elseif ($foreignListeners.Count -gt 0) {
      Write-Note ("port 45678 is held by pid(s) " + (($foreignListeners | ForEach-Object { $_.OwningProcess }) -join ',') + " that this run did not start; left untouched")
    } else {
      $script:failed = $true
      Write-Host 'SACRIFICE PORT NOT RELEASED by our own listener process' -ForegroundColor Red
    }
  } else {
    Write-Note "phase $Phase spawned no sacrifice listener; port 45678 is not ours to touch"
    $foreignListeners = @(Get-PortListeners 45678)
    if ($foreignListeners.Count -gt 0) {
      Write-Note ("note: 45678 currently held by pid(s) " + (($foreignListeners | ForEach-Object { $_.OwningProcess }) -join ',') + " (not started by this run)")
    }
  }

  Write-Step "leftover process check"
  # Only claim leftovers that this harness can have created:
  #   - the isolated CLI instance: dsh-desktop-host/cli.js booted with our profile name
  #   - the E2E driver: node.exe running test\e2e\e2e.mjs
  #   - our headless browser: a throwaway dsh-port-viewer-e2e-* user-data-dir
  # Matching just the port number would also hit unrelated tooling that happens to
  # be inspecting that port (seen during development), which is a false positive.
  $leftovers = @()
  try {
    $candidates = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue)
    foreach ($candidate in $candidates) {
      if ($null -eq $candidate.CommandLine) { continue }
      if ($candidate.ProcessId -eq $PID) { continue }
      $isIsolatedCli = $candidate.CommandLine.Contains('dsh-desktop-host') -and $candidate.CommandLine.Contains("--profile $ProfileName")
      $isE2eDriver = $candidate.CommandLine.Contains('e2e.mjs')
      if ($isIsolatedCli -or $isE2eDriver) {
        $leftovers += ("pid=$($candidate.ProcessId) name=$($candidate.Name) cmd=" + ($candidate.CommandLine -replace '\s+', ' '))
      }
    }
  } catch {
    Write-Note "leftover scan warning: $($_.Exception.Message)"
  }
  $sacrificeListeners = @(Get-PortListeners 45678 | Where-Object { $sacrificePid -gt 0 -and $_.OwningProcess -eq $sacrificePid })
  if ($leftovers.Count -eq 0 -and $sacrificeListeners.Count -eq 0) {
    Write-Host '   no leftover instance, E2E driver or sacrifice listener found' -ForegroundColor Green
  } else {
    $script:failed = $true
    Write-Host '   LEFTOVER PROCESSES:' -ForegroundColor Red
    foreach ($leftover in $leftovers) { Write-Host "   $leftover" -ForegroundColor Red }
    foreach ($listener in $sacrificeListeners) { Write-Host "   sacrifice listener pid=$($listener.OwningProcess) on 45678" -ForegroundColor Red }
  }
  $leftoverEdge = @()
  try {
    $leftoverEdge = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $null -ne $_.CommandLine -and $_.CommandLine.Contains('dsh-port-viewer-e2e-')
    })
  } catch {
    $leftoverEdge = @()
  }
  if ($leftoverEdge.Count -gt 0) {
    $script:failed = $true
    Write-Host ("   LEFTOVER HEADLESS BROWSER: " + (($leftoverEdge | ForEach-Object { "pid=$($_.ProcessId)" }) -join ', ')) -ForegroundColor Red
  } else {
    Write-Note "no leftover headless browser"
  }

  $env:DSH_HOME = $savedDshHome
  $env:ELECTRON_RUN_AS_NODE = $savedElectronNode

  Write-Host ''
  if ($script:failed) {
    Write-Host 'RESULT: FAIL' -ForegroundColor Red
    exit 1
  }
  Write-Host 'RESULT: PASS (isolated instance stopped, ports released, no leftovers)' -ForegroundColor Green
  exit 0
}
