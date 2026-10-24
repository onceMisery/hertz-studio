param([int]$OffSeconds = 6)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MonitorPower {
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
"@
$hwndBroadcast = [IntPtr]0xffff
$sysCommand = 0x0112
$monitorPower = 0xF170
$abortIfHung = 0x0002
function Send-MonitorPower([int]$argument) {
  $result = [IntPtr]::Zero
  [MonitorPower]::SendMessageTimeout(
    $hwndBroadcast, $sysCommand, [IntPtr]$monitorPower, [IntPtr]$argument,
    $abortIfHung, 1000, [ref]$result) | Out-Null
}
$position = [System.Windows.Forms.Cursor]::Position
Send-MonitorPower 2
"monitor_off=$(Get-Date -Format o)"
try {
  Start-Sleep -Seconds $OffSeconds
} finally {
  Send-MonitorPower (-1)
  [MonitorPower]::SetCursorPos($position.X + 1, $position.Y) | Out-Null
  [MonitorPower]::SetCursorPos($position.X, $position.Y) | Out-Null
  "monitor_on=$(Get-Date -Format o)"
}
