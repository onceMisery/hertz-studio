param([ValidateSet('internal', 'extend')][string]$Mode)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DisplayConfigNative {
  [DllImport("user32.dll")]
  public static extern int SetDisplayConfig(
    uint numPathArrayElements, IntPtr pathArray,
    uint numModeInfoArrayElements, IntPtr modeInfoArray,
    uint flags);
}
"@
$apply = 0x80
$topology = if ($Mode -eq 'internal') { 0x1 } else { 0x4 }
$result = [DisplayConfigNative]::SetDisplayConfig(
  0, [IntPtr]::Zero, 0, [IntPtr]::Zero, ($topology -bor $apply))
"mode=$Mode result=$result at=$(Get-Date -Format o)"
