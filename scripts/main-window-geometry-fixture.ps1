# SPDX-License-Identifier: MIT
# Read/control only the exact main-window title belonging to the owned native child.
param(
    [Parameter(Mandatory = $true)][int]$OwnerPid,
    [ValidateSet('read', 'bounds', 'maximize', 'minimize', 'restore', 'hide', 'close', 'focus', 'work-area-notify')][string]$Action = 'read',
    [long]$Handle = 0,
    [int]$X = 0,
    [int]$Y = 0,
    [int]$Width = 0,
    [int]$Height = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public sealed class HertzGeometryRect { public int x; public int y; public int width; public int height; }
public sealed class HertzGeometryMonitor {
    public long handle; public HertzGeometryRect bounds; public HertzGeometryRect workArea;
    public bool primary; public double scaleFactor;
}
public sealed class HertzGeometryWindow {
    public long handle; public uint pid; public string title; public bool visible; public bool enabled;
    public bool maximized; public bool minimized; public uint showCommand; public uint dpi; public double scaleFactor;
    public HertzGeometryRect outerBounds; public HertzGeometryRect clientBounds; public HertzGeometryRect extendedFrameBounds;
    public HertzGeometryRect normalWorkspaceBounds; public HertzGeometryRect normalScreenBounds;
    public HertzGeometryMonitor monitor; public List<HertzGeometryMonitor> monitors;
}
public static class HertzGeometryWindows {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
        public uint length, flags, showCmd; public POINT ptMinPosition, ptMaxPosition; public RECT rcNormalPosition;
    }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public uint cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }
    public delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    public delegate bool MonitorCallback(IntPtr monitor, IntPtr context, ref RECT rectangle, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rectangle);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out RECT rectangle);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref POINT point);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr window, ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr context, IntPtr clip, MonitorCallback callback, IntPtr parameter);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out RECT rectangle, int size);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    static string Title(IntPtr window) { var text = new StringBuilder(512); GetWindowText(window, text, text.Capacity); return text.ToString(); }
    static HertzGeometryRect Rect(RECT value) { return new HertzGeometryRect { x = value.left, y = value.top, width = value.right - value.left, height = value.bottom - value.top }; }
    public static void PhysicalCoordinates() {
        if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) throw new InvalidOperationException("Unable to use per-monitor physical coordinates");
    }
    public static IntPtr Find(uint owner) {
        IntPtr found = IntPtr.Zero; int count = 0;
        EnumWindows((window, parameter) => {
            uint pid; GetWindowThreadProcessId(window, out pid);
            if (pid == owner && Title(window) == "HertzStudio Music Player") { found = window; count++; }
            return true;
        }, IntPtr.Zero);
        if (count != 1) throw new InvalidOperationException("Expected one exact owned main-window title; found " + count);
        return found;
    }
    static void Check(uint owner, IntPtr window) {
        uint pid; GetWindowThreadProcessId(window, out pid);
        if (window == IntPtr.Zero || pid != owner || Title(window) != "HertzStudio Music Player") throw new InvalidOperationException("Refusing a handle outside the exact owned main window");
    }
    static HertzGeometryMonitor Monitor(IntPtr handle) {
        var info = new MONITORINFO(); info.cbSize = (uint)Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(handle, ref info)) throw new InvalidOperationException("GetMonitorInfo failed");
        uint dpiX, dpiY;
        if (GetDpiForMonitor(handle, 0, out dpiX, out dpiY) != 0 || dpiX == 0) throw new InvalidOperationException("GetDpiForMonitor failed");
        return new HertzGeometryMonitor { handle = handle.ToInt64(), bounds = Rect(info.rcMonitor), workArea = Rect(info.rcWork), primary = (info.dwFlags & 1) != 0, scaleFactor = dpiX / 96.0 };
    }
    public static HertzGeometryWindow Read(uint owner, IntPtr window) {
        Check(owner, window); RECT outer, client;
        if (!GetWindowRect(window, out outer) || !GetClientRect(window, out client)) throw new InvalidOperationException("Native rectangle read failed");
        var point = new POINT(); if (!ClientToScreen(window, ref point)) throw new InvalidOperationException("ClientToScreen failed");
        client.left += point.x; client.right += point.x; client.top += point.y; client.bottom += point.y;
        var placement = new WINDOWPLACEMENT(); placement.length = (uint)Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        if (!GetWindowPlacement(window, ref placement)) throw new InvalidOperationException("GetWindowPlacement failed");
        var monitor = Monitor(MonitorFromWindow(window, 2));
        var normal = Rect(placement.rcNormalPosition);
        var screen = new HertzGeometryRect { x = normal.x + monitor.workArea.x - monitor.bounds.x, y = normal.y + monitor.workArea.y - monitor.bounds.y, width = normal.width, height = normal.height };
        var monitors = new List<HertzGeometryMonitor>();
        MonitorCallback callback = delegate(IntPtr handle, IntPtr context, ref RECT rectangle, IntPtr parameter) { monitors.Add(Monitor(handle)); return true; };
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero)) throw new InvalidOperationException("EnumDisplayMonitors failed");
        RECT frame; HertzGeometryRect extended = DwmGetWindowAttribute(window, 9, out frame, Marshal.SizeOf(typeof(RECT))) == 0 ? Rect(frame) : null;
        uint dpi = GetDpiForWindow(window); if (dpi == 0) throw new InvalidOperationException("GetDpiForWindow failed");
        return new HertzGeometryWindow { handle = window.ToInt64(), pid = owner, title = Title(window), visible = IsWindowVisible(window), enabled = IsWindowEnabled(window), maximized = IsZoomed(window), minimized = IsIconic(window), showCommand = placement.showCmd, dpi = dpi, scaleFactor = dpi / 96.0, outerBounds = Rect(outer), clientBounds = Rect(client), extendedFrameBounds = extended, normalWorkspaceBounds = normal, normalScreenBounds = screen, monitor = monitor, monitors = monitors };
    }
    public static void Act(uint owner, IntPtr window, string action, int x, int y, int width, int height) {
        Check(owner, window);
        switch (action) {
            case "bounds":
                if (width <= 0 || height <= 0 || (long)x + width > Int32.MaxValue || (long)y + height > Int32.MaxValue) throw new InvalidOperationException("Positive bounded outer dimensions are required");
                if (!SetWindowPos(window, IntPtr.Zero, x, y, width, height, 0x0004 | 0x0010)) throw new InvalidOperationException("SetWindowPos failed: " + Marshal.GetLastWin32Error());
                break;
            case "maximize": ShowWindowAsync(window, 3); break;
            case "minimize": ShowWindowAsync(window, 6); break;
            case "restore": ShowWindowAsync(window, 9); break;
            case "hide": ShowWindowAsync(window, 0); break;
            case "focus": ShowWindowAsync(window, IsIconic(window) ? 9 : 5); SetForegroundWindow(window); break;
            case "close": if (!PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException("Owned WM_CLOSE failed"); break;
            case "work-area-notify": if (!PostMessage(window, 0x007E, IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException("Owned display/work-area notification failed: " + Marshal.GetLastWin32Error()); break;
            default: throw new InvalidOperationException("Unknown geometry action");
        }
    }
}
'@
[HertzGeometryWindows]::PhysicalCoordinates()
$main = [HertzGeometryWindows]::Find([uint32]$OwnerPid)
if ($Handle -ne 0 -and $main.ToInt64() -ne $Handle) { throw 'Requested handle does not match the owned main window' }
if ($Action -ne 'read') { [HertzGeometryWindows]::Act([uint32]$OwnerPid, $main, $Action, $X, $Y, $Width, $Height) }
ConvertTo-Json -InputObject ([HertzGeometryWindows]::Read([uint32]$OwnerPid, $main)) -Depth 6 -Compress
