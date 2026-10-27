Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MonitorProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
  [DllImport("Shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hMonitor, int dpiType, out uint dpiX, out uint dpiY);
}
"@
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
  $center = [MonitorProbe+POINT]::new()
  $center.X = [int]($screen.Bounds.Left + $screen.Bounds.Width / 2)
  $center.Y = [int]($screen.Bounds.Top + $screen.Bounds.Height / 2)
  $hmon = [MonitorProbe]::MonitorFromPoint($center, 2)
  $info = [MonitorProbe+MONITORINFOEX]::new()
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]([MonitorProbe+MONITORINFOEX]))
  [MonitorProbe]::GetMonitorInfo($hmon, [ref]$info) | Out-Null
  $dpiX = 0; $dpiY = 0
  $hr = [MonitorProbe]::GetDpiForMonitor($hmon, 0, [ref]$dpiX, [ref]$dpiY)
  "screen=$($screen.DeviceName) primary=$($screen.Primary) bounds=$($screen.Bounds) working=$($screen.WorkingArea) hmon=$hmon device=$($info.szDevice) monitorRect=$($info.rcMonitor.Left),$($info.rcMonitor.Top),$($info.rcMonitor.Right),$($info.rcMonitor.Bottom) dpi=$dpiX/$dpiY hr=$hr"
}
