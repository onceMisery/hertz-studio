param([int]$WaitSeconds = 10)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ShellWindow {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(string className, string windowName);
}
"@
$before = @(Get-Process explorer -ErrorAction SilentlyContinue)
"before_pids=$($before.Id -join ',') at=$(Get-Date -Format o)"
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) {
  Start-Process explorer.exe | Out-Null
}
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  $running = Get-Process explorer -ErrorAction SilentlyContinue
  $tray = [ShellWindow]::FindWindow('Shell_TrayWnd', $null)
  if ($running -and $tray -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 250
}
$after = @(Get-Process explorer -ErrorAction SilentlyContinue)
$trayHandle = [ShellWindow]::FindWindow('Shell_TrayWnd', $null)
"after_pids=$($after.Id -join ',') taskbar=$trayHandle at=$(Get-Date -Format o)"
if (-not $after -or $trayHandle -eq [IntPtr]::Zero) { exit 1 }
