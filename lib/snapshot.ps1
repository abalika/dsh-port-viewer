# dsh-port-viewer :: raw snapshot collector (Windows PowerShell 5.1).
#
# Writes ONE UTF-8 (no BOM) JSON file into -OutFile. stdout / stderr are not part
# of the contract: lib/collect.js only reads the file (stderr is used for errors).
#
# THIS FILE MUST STAY PURE ASCII, COMMENTS INCLUDED. Windows PowerShell 5.1
# decodes BOM-less script files with the active ANSI/OEM code page, so any
# non-ASCII byte in this source would be mojibake before it ever runs. Chinese
# paths still survive because they only exist at RUNTIME: the JSON is produced
# by ConvertTo-Json and written with UTF8Encoding($false).
#
# Payload shape (docs/CONTRACT.md section 5.1):
#   { schemaVersion, generatedAt, computerName, powershell,
#     timingsMs { compile, netstat, processes, cwd, total },
#     listeners[], processes[], errors[] }
#
# - listeners : rows of "netstat -ano -p TCP" whose state is LISTENING.
#               IPv6 bindings keep their brackets, e.g. "[::]".
# - processes : the WHOLE Win32_Process table. lib/projects.js needs it for
#               parent-chain lookups and for orphan ("parent already gone")
#               detection, so it must not be filtered down to listening PIDs.
# - cwd       : read through the target process PEB. Only listening PIDs and
#               their ancestors (<= 6 hops) are attempted; system or elevated
#               processes simply yield null, which is normal, not an error.
#
# The PEB reader below is the C# block already verified in
# .verify/proto-snapshot.ps1 (~550 ms per full snapshot on this machine).
# The offsets are the x64 PEB / RTL_USER_PROCESS_PARAMETERS layout.
#
# Reliability contract: every stage is guarded. A failing stage appends one
# ASCII line to "errors" and leaves its own slice empty, but a JSON file is
# always written so the Node side can degrade instead of crashing.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [switch]$SkipCwd
)

$ErrorActionPreference = 'Stop'
$maxCmdLineLength = 4000
$ancestorDepth = 6

$problems = New-Object System.Collections.ArrayList
function Add-Problem([string]$text) { [void]$problems.Add($text) }

$sw = [System.Diagnostics.Stopwatch]::StartNew()

# --- stage 0: compile the PEB working-directory reader -----------------------
$csharpSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PortViewerCwd {
  [StructLayout(LayoutKind.Sequential)]
  public struct PBI {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr Reserved3;
  }

  [DllImport("ntdll.dll")]
  private static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, ref PBI pbi, int cb, out int retLen);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int read);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr h);

  public static string GetCwd(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      PBI pbi = new PBI();
      int len;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PBI)), out len) != 0) return null;
      long peb = pbi.PebBaseAddress.ToInt64();
      byte[] buf = new byte[8];
      if (!ReadProcessMemory(h, new IntPtr(peb + 0x20), buf, 8, out len)) return null;
      long parameters = BitConverter.ToInt64(buf, 0);
      if (parameters == 0) return null;
      byte[] cd = new byte[16];
      if (!ReadProcessMemory(h, new IntPtr(parameters + 0x38), cd, 16, out len)) return null;
      int strLen = BitConverter.ToUInt16(cd, 0);
      long bufPtr = BitConverter.ToInt64(cd, 8);
      if (strLen <= 0 || strLen > 4096 || bufPtr == 0) return null;
      byte[] raw = new byte[strLen];
      if (!ReadProcessMemory(h, new IntPtr(bufPtr), raw, strLen, out len)) return null;
      return Encoding.Unicode.GetString(raw, 0, strLen);
    } finally {
      CloseHandle(h);
    }
  }
}
'@

$cwdReady = $false
if (-not $SkipCwd) {
  # The offsets below are the x64 PEB layout (PEB+0x20 / ProcessParameters+0x38).
  # Under 32-bit PowerShell they read unrelated memory, so skip instead of guessing.
  if ([IntPtr]::Size -ne 8) {
    Add-Problem 'cwd-reader-skipped: only the x64 PEB layout is supported'
  }
  else {
    try {
      Add-Type -TypeDefinition $csharpSource -Language CSharp -ErrorAction Stop | Out-Null
      $cwdReady = $true
    } catch {
      Add-Problem ('cwd-reader-unavailable: ' + $_.Exception.Message)
    }
  }
}
$tCompile = $sw.ElapsedMilliseconds

# --- stage 1: listeners (TCP, LISTENING only) --------------------------------
$listeners = New-Object System.Collections.ArrayList
$seenBinding = @{}
try {
  $netstatLines = @(& netstat.exe -ano -p TCP 2>$null)
} catch {
  $netstatLines = @()
  Add-Problem ('netstat-failed: ' + $_.Exception.Message)
}

foreach ($line in $netstatLines) {
  # e.g. "  TCP    0.0.0.0:135    0.0.0.0:0    LISTENING    2084"
  #      "  TCP    [::]:5173     [::]:0       LISTENING    1234"
  if ($line -notmatch '^\s*(TCPv6|TCP6|TCP)\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\S+)\s+(\d+)\s*$') { continue }
  if ($Matches[6] -ne 'LISTENING') { continue }
  $localAddress = $Matches[2]
  $localPort = 0
  $ownerPid = 0
  try {
    $localPort = [int]$Matches[3]
    $ownerPid = [int]$Matches[7]
  } catch {
    continue
  }
  if ($localPort -le 0 -or $ownerPid -lt 0) { continue }
  $dedupeKey = ('{0}|{1}|{2}' -f $localAddress, $localPort, $ownerPid)
  if ($seenBinding.ContainsKey($dedupeKey)) { continue }
  $seenBinding[$dedupeKey] = $true
  [void]$listeners.Add([pscustomobject]@{
    protocol     = 'TCP'
    localAddress = $localAddress
    port         = $localPort
    pid          = $ownerPid
  })
}
$tNetstat = $sw.ElapsedMilliseconds

# --- stage 2: whole process table -------------------------------------------
$allProcesses = @()
try {
  $allProcesses = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
} catch {
  $allProcesses = @()
  Add-Problem ('cim-query-failed: ' + $_.Exception.Message)
}
$tProcesses = $sw.ElapsedMilliseconds

$parentOf = @{}
foreach ($p in $allProcesses) {
  try { $parentOf[[int]$p.ProcessId] = [int]$p.ParentProcessId } catch { }
}

# --- stage 3: PEB cwd for listening PIDs plus their ancestors ---------------
$needCwd = @{}
foreach ($item in $listeners) {
  if ($item.pid -gt 0) { $needCwd[[int]$item.pid] = $true }
}
if ($cwdReady) {
  foreach ($startPid in @($needCwd.Keys)) {
    $cursor = [int]$startPid
    $hop = 0
    while ($hop -lt $ancestorDepth) {
      if (-not $parentOf.ContainsKey($cursor)) { break }
      $nextPid = [int]$parentOf[$cursor]
      if ($nextPid -le 0 -or $nextPid -eq $cursor) { break }
      $needCwd[$nextPid] = $true
      $cursor = $nextPid
      $hop = $hop + 1
    }
  }
}

$processes = New-Object System.Collections.ArrayList
foreach ($p in $allProcesses) {
  $procId = 0
  try { $procId = [int]$p.ProcessId } catch { continue }
  if ($procId -le 0) { continue }

  $cwd = $null
  if ($cwdReady -and $needCwd.ContainsKey($procId)) {
    try {
      $rawCwd = [PortViewerCwd]::GetCwd($procId)
      if ($null -ne $rawCwd) {
        $rawCwd = $rawCwd.Trim()
        if ($rawCwd.Length -eq 0) {
          $cwd = $null
        } elseif ($rawCwd.Length -gt 3 -and ($rawCwd.EndsWith('\') -or $rawCwd.EndsWith('/'))) {
          $cwd = $rawCwd.TrimEnd('\', '/')
        } else {
          $cwd = $rawCwd
        }
      }
    } catch {
      $cwd = $null
    }
  }

  $procName = $null
  $exePath = $null
  $cmdText = $null
  $parentId = 0
  $startedAt = $null
  $workingSet = 0
  try { $procName = [string]$p.Name } catch { }
  try { $exePath = [string]$p.ExecutablePath } catch { }
  try { $cmdText = [string]$p.CommandLine } catch { }
  try { $parentId = [int]$p.ParentProcessId } catch { }
  try {
    if ($null -ne $p.CreationDate) { $startedAt = ([datetime]$p.CreationDate).ToString('o') }
  } catch { }
  try {
    if ($null -ne $p.WorkingSetSize) { $workingSet = [int64]$p.WorkingSetSize }
  } catch { }

  if ($null -ne $procName -and $procName.Length -eq 0) { $procName = $null }
  if ($null -ne $exePath -and $exePath.Length -eq 0) { $exePath = $null }
  if ($null -ne $cmdText -and $cmdText.Length -eq 0) { $cmdText = $null }
  if ($null -ne $cmdText -and $cmdText.Length -gt $maxCmdLineLength) {
    $cmdText = $cmdText.Substring(0, $maxCmdLineLength)
  }

  [void]$processes.Add([pscustomobject]@{
    pid             = $procId
    ppid            = $parentId
    name            = $procName
    exe             = $exePath
    cmdLine         = $cmdText
    startedAt       = $startedAt
    workingSetBytes = $workingSet
    cwd             = $cwd
  })
}
$tCwd = $sw.ElapsedMilliseconds

# --- stage 4: serialize ------------------------------------------------------
$payload = [pscustomobject]@{
  schemaVersion = 1
  generatedAt   = (Get-Date).ToString('o')
  computerName  = $env:COMPUTERNAME
  powershell    = $PSVersionTable.PSVersion.ToString()
  timingsMs     = [pscustomobject]@{
    compile   = [int]$tCompile
    netstat   = [int]($tNetstat - $tCompile)
    processes = [int]($tProcesses - $tNetstat)
    cwd       = [int]($tCwd - $tProcesses)
    total     = [int]$sw.ElapsedMilliseconds
  }
  listeners     = @($listeners)
  processes     = @($processes)
  errors        = @($problems)
}

$targetPath = [System.IO.Path]::GetFullPath($OutFile)
$utf8 = New-Object System.Text.UTF8Encoding($false)

try {
  $json = $payload | ConvertTo-Json -Depth 6 -Compress
} catch {
  $json = '{"schemaVersion":1,"listeners":[],"processes":[],"errors":["serialize-failed"]}'
}
[System.IO.File]::WriteAllText($targetPath, $json, $utf8)
exit 0
