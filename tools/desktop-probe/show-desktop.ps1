Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DesktopKeys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void Toggle() {
    keybd_event(0x5B, 0, 0, UIntPtr.Zero);
    keybd_event(0x44, 0, 0, UIntPtr.Zero);
    keybd_event(0x44, 0, 2, UIntPtr.Zero);
    keybd_event(0x5B, 0, 2, UIntPtr.Zero);
  }
}
"@
[DesktopKeys]::Toggle()
Start-Sleep -Milliseconds 800
