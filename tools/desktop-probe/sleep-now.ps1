Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SuspendControl {
  [DllImport("powrprof.dll")] public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);
}
"@
$ok = [SuspendControl]::SetSuspendState($false, $false, $false)
"suspend_returned=$ok at=$(Get-Date -Format o)"
