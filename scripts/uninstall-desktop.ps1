<#
.SYNOPSIS
  Uninstall dsh-port-viewer from a dsh profile (desktop by default).

.DESCRIPTION
  Reverses install-desktop.ps1:
    1. remove the directory junction under the profile's node_modules
       (only the link is removed; the plugin checkout is never touched)
    2. drop the package from dsh.profile.bundles and dependencies
    3. tell the operator to restart dsh

  Idempotent: a profile that is already clean reports "already absent" and
  succeeds. Backups under the backup root are kept on purpose.

.PARAMETER ProfileName
  Profile name. Default: desktop.

.PARAMETER DshHome
  dsh data root. Default: $env:DSH_HOME, otherwise ~\.dsh.

.PARAMETER DryRun
  Print what would happen and exit without writing anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\uninstall-desktop.ps1
  powershell -ExecutionPolicy Bypass -File scripts\uninstall-desktop.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$ProfileName = 'desktop',
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$PluginName  = 'dsh-port-viewer'
$ProfileDir  = Join-Path $DshHome "profiles\$ProfileName"
$Manifest    = Join-Path $ProfileDir 'package.json'
$Link        = Join-Path $ProfileDir "node_modules\$PluginName"
$PatchScript = Join-Path $PSScriptRoot 'patch-profile.mjs'

if (-not (Test-Path -LiteralPath $Manifest)) { throw "profile manifest not found: $Manifest" }
if (-not (Test-Path -LiteralPath $PatchScript)) { throw "patch-profile.mjs not found: $PatchScript" }

Write-Host "profile: $ProfileDir"

if ($DryRun) {
  Write-Host "[dry-run] would remove junction: $Link"
  Write-Host "[dry-run] would drop '$PluginName' from dsh.profile.bundles and dependencies"
  exit 0
}

# --- 1. junction -----------------------------------------------------------
if (Test-Path -LiteralPath $Link) {
  $item = Get-Item -LiteralPath $Link -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    & cmd /c rmdir "$Link" | Out-Null
    Write-Host "junction: removed $Link"
  } else {
    Write-Warning "$Link is not a junction (looks like a real package); leaving it alone"
  }
} else {
  Write-Host 'junction: already absent'
}

# --- 2. manifest -----------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue)
if ($null -eq $node) { throw 'node is required on PATH' }
$result = & $node.Source $PatchScript remove $Manifest $PluginName
if ($LASTEXITCODE -ne 0) { throw "patch-profile.mjs failed (exit $LASTEXITCODE)" }
Write-Host "manifest: $result"

# --- 3. sanity -------------------------------------------------------------
$manifestNow = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$bundlesNow = @($manifestNow.dsh.profile.bundles)
if ($bundlesNow -contains $PluginName) {
  throw "manifest still lists $PluginName in dsh.profile.bundles"
}
Write-Host "check  : $PluginName is no longer registered"

Write-Host ''
Write-Host 'DONE. Restart the dsh desktop app; the port pill is gone.' -ForegroundColor Green
Write-Host 'Profile backups are kept on purpose (this script never deletes them).' 
