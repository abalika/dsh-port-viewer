<#
.SYNOPSIS
  Install dsh-port-viewer into a dsh profile (desktop by default).

.DESCRIPTION
  Three reversible steps:
    1. back up the profile's package.json / cordis.patch.yml to a backup folder
       (default <plugin>\.backups\<profile>-before-port-viewer-<stamp>)
    2. register the bundle and the file: dependency with scripts\patch-profile.mjs
    3. create a directory junction in the profile's node_modules pointing at this repo

  The existing pnpm install and cordis.patch.yml are left untouched: this package
  ships its own bundle patch, so the loader inserts its row from the bundle layer.

  A restart of the dsh desktop app is required afterwards; the cordis profile
  tree is composed when the process starts.

  This script is idempotent: running it twice leaves the same end state
  (a fresh backup folder is written per run).

.PARAMETER ProfileName
  Profile name. Default: desktop.

.PARAMETER DshHome
  dsh data root. Default: $env:DSH_HOME, otherwise ~\.dsh (the same default dsh itself uses).

.PARAMETER PluginDir
  Plugin checkout to link. Default: this repository (two levels above scripts\).

.PARAMETER BackupRoot
  Root folder for profile backups. Default: <plugin>\.backups (git-ignored).

.PARAMETER DryRun
  Print what would happen and exit without writing anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-desktop.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-desktop.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$ProfileName = 'desktop',
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [string]$PluginDir = '',
  [string]$BackupRoot = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$PluginName  = 'dsh-port-viewer'
# $PSCommandPath is not reliable inside param default expressions; $PSScriptRoot is,
# and it is set as soon as the script body runs.
if ($PluginDir -eq '') { $PluginDir = Split-Path -Parent $PSScriptRoot }
$PluginDir   = [System.IO.Path]::GetFullPath($PluginDir)
if ($BackupRoot -eq '') { $BackupRoot = Join-Path $PluginDir '.backups' }
$FileSpec    = 'file:' + ($PluginDir -replace '\\', '/')
$ProfileDir  = Join-Path $DshHome "profiles\$ProfileName"
$Manifest    = Join-Path $ProfileDir 'package.json'
$Patch       = Join-Path $ProfileDir 'cordis.patch.yml'
$Modules     = Join-Path $ProfileDir 'node_modules'
$Link        = Join-Path $Modules $PluginName
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir   = Join-Path $BackupRoot "profile-$ProfileName-before-port-viewer-$Stamp"
$PatchScript = Join-Path $PSScriptRoot 'patch-profile.mjs'

function Assert-Path([string]$Path, [string]$What) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "$What not found: $Path" }
}

Assert-Path $Manifest "profile manifest (resolved DSH home = $DshHome). If your launcher sets DSH_HOME, export it first or pass -DshHome <dir>"
Assert-Path (Join-Path $PluginDir 'lib\index.js') 'plugin host half (lib\index.js)'
Assert-Path (Join-Path $PluginDir 'lib\client.js') 'plugin client half (lib\client.js)'
Assert-Path $PatchScript 'patch-profile.mjs'

$node = (Get-Command node -ErrorAction SilentlyContinue)
if ($null -eq $node) { throw 'node is required on PATH' }

Write-Host "plugin : $PluginDir"
Write-Host "profile: $ProfileDir"
Write-Host "spec   : $FileSpec"

if ($DryRun) {
  Write-Host "[dry-run] would back up  : $Manifest -> $BackupDir"
  if (Test-Path -LiteralPath $Patch) { Write-Host "[dry-run] would back up  : $Patch -> $BackupDir" }
  Write-Host "[dry-run] would register : $PluginName in dsh.profile.bundles + dependencies"
  Write-Host "[dry-run] would junction : $Link -> $PluginDir"
  exit 0
}

# --- 1. backup -------------------------------------------------------------
if (-not (Test-Path -LiteralPath $BackupDir)) { New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null }
Copy-Item -LiteralPath $Manifest -Destination (Join-Path $BackupDir 'package.json') -Force
if (Test-Path -LiteralPath $Patch) {
  Copy-Item -LiteralPath $Patch -Destination (Join-Path $BackupDir 'cordis.patch.yml') -Force
}
Write-Host "backup : $BackupDir"

# --- 2. manifest -----------------------------------------------------------
$result = & $node.Source $PatchScript add $Manifest $PluginName $FileSpec
if ($LASTEXITCODE -ne 0) { throw "patch-profile.mjs failed (exit $LASTEXITCODE)" }
Write-Host "manifest: $result"

# --- 3. junction -----------------------------------------------------------
if (-not (Test-Path -LiteralPath $Modules)) { New-Item -ItemType Directory -Force -Path $Modules | Out-Null }
if (Test-Path -LiteralPath $Link) {
  $item = Get-Item -LiteralPath $Link -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Write-Host 'junction: already linked, replacing'
    # Remove the link only, never its target: rmdir on a junction is safe.
    # Never use Remove-Item -Recurse here.
    & cmd /c rmdir "$Link" | Out-Null
  } else {
    throw "$Link exists and is not a junction; refusing to touch it"
  }
}
& New-Item -ItemType Junction -Path $Link -Target $PluginDir | Out-Null
Write-Host "junction: $Link -> $PluginDir"

# --- 4. sanity: the profile can now see the package ------------------------
if (-not (Test-Path -LiteralPath (Join-Path $Link 'lib\index.js'))) {
  throw "junction created but $Link\lib\index.js is not reachable"
}
$manifestNow = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$bundlesNow = @($manifestNow.dsh.profile.bundles)
if ($bundlesNow -notcontains $PluginName) {
  throw "manifest does not list $PluginName in dsh.profile.bundles after patching"
}
Write-Host "check  : bundle registered and $Link\lib\index.js is reachable"

Write-Host ''
Write-Host 'DONE. Restart the dsh desktop app; the port pill appears in the Web GUI.'
Write-Host "Rollback: powershell -ExecutionPolicy Bypass -File $(Join-Path $PSScriptRoot 'uninstall-desktop.ps1')"
Write-Host "Backup  : $BackupDir"
