[CmdletBinding()]
param(
  [ValidateRange(1, 2147483647)][int]$WaitSeconds = 10,
  [switch]$InspectOnly
)
$ErrorActionPreference = 'Stop'

if (-not ('DesktopProbeShellWindow' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DesktopProbeShellWindow {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
"@
}

function Get-CurrentShell {
  $tray = [DesktopProbeShellWindow]::FindWindow('Shell_TrayWnd', $null)
  if ($tray -eq [IntPtr]::Zero) { return $null }
  [uint32]$shellProcessId = 0
  [void][DesktopProbeShellWindow]::GetWindowThreadProcessId($tray, [ref]$shellProcessId)
  if ($shellProcessId -eq 0) { return $null }
  $shell = Get-Process -Id $shellProcessId -ErrorAction SilentlyContinue
  if (-not $shell -or $shell.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) {
    return $null
  }
  if ($shell.ProcessName -ne 'explorer') { throw 'Shell_TrayWnd is not owned by explorer.' }
  [pscustomobject]@{ Pid = $shell.Id; Taskbar = $tray.ToInt64(); SessionId = $shell.SessionId }
}

# Read-only inspection also lets the runner use exactly the same shell identity check.
if ($InspectOnly) { Get-CurrentShell; return }

$before = Get-CurrentShell
"before_pids=$($before.Pid) at=$([DateTime]::UtcNow.ToString('o'))"
$after = $null
try {
  if (-not $before) { throw 'No taskbar shell in the current session; nothing was stopped.' }
  Stop-Process -Id $before.Pid -Force -ErrorAction Stop
  "stopped_pid=$($before.Pid) at=$([DateTime]::UtcNow.ToString('o'))"
  $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
  $launchAfter = [DateTime]::UtcNow.AddSeconds(2)
  $launched = $false
  do {
    $after = Get-CurrentShell
    if ($after -and $after.Pid -ne $before.Pid) { break }
    # Allow Windows to relaunch its shell first; never stop unrelated Explorer windows.
    if (-not $after -and -not $launched -and [DateTime]::UtcNow -ge $launchAfter) {
      Start-Process -FilePath (Join-Path $env:WINDIR 'explorer.exe') | Out-Null
      $launched = $true
    }
    $remaining = ($deadline - [DateTime]::UtcNow).TotalMilliseconds
    if ($remaining -le 0) { break }
    Start-Sleep -Milliseconds ([int][Math]::Min(250, [Math]::Ceiling($remaining)))
  } while ([DateTime]::UtcNow -lt $deadline)
  $after = Get-CurrentShell
  if (-not $after -or $after.Pid -eq $before.Pid) {
    throw 'Timed out waiting for a new shell PID and Shell_TrayWnd.'
  }
} catch {
  $afterId = if ($after) { $after.Pid } else { '' }
  $taskbar = if ($after) { $after.Taskbar } else { 0 }
  "after_pids=$afterId taskbar=$taskbar at=$([DateTime]::UtcNow.ToString('o'))"
  Write-Error $_ -ErrorAction Continue
  exit 1
}
"after_pids=$($after.Pid) taskbar=$($after.Taskbar) at=$([DateTime]::UtcNow.ToString('o'))"
