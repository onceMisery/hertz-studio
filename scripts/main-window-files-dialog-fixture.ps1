# SPDX-License-Identifier: MIT
# Inspect and control only common dialogs belonging to the native test child.
param(
    [Parameter(Mandatory = $true)][int]$OwnerPid,
    [ValidateSet('read', 'fill', 'save', 'cancel', 'yes', 'no', 'ok')][string]$Action = 'read',
    [long]$Handle = 0,
    [string]$SavePath
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public sealed class HertzFileControl {
    public long handle; public long parent; public int id; public string title; public string kind;
    public bool visible; public bool enabled;
}
public sealed class HertzFileWindow {
    public long handle; public long owner; public string title; public string kind;
    public bool visible; public bool enabled; public List<HertzFileControl> controls;
}
public static class HertzFileDialogs {
    public delegate bool Callback(IntPtr hwnd, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, Callback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int size);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out IntPtr result);
    static string Text(IntPtr hwnd, bool kind) {
        var text = new StringBuilder(2048);
        if (kind) GetClassName(hwnd, text, text.Capacity); else GetWindowText(hwnd, text, text.Capacity);
        return text.ToString();
    }
    static string EditText(IntPtr hwnd) {
        var value = new StringBuilder(2048); IntPtr result;
        if (SendMessageTimeout(hwnd, 13, new IntPtr(value.Capacity), value, 2, 3000, out result) == IntPtr.Zero) throw new InvalidOperationException("File-name edit did not answer WM_GETTEXT");
        return value.ToString();
    }
    public static List<HertzFileWindow> Read(uint owner) {
        var windows = new List<HertzFileWindow>();
        EnumWindows((hwnd, parameter) => {
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            if (pid != owner) return true;
            var window = new HertzFileWindow { handle = hwnd.ToInt64(), owner = GetWindow(hwnd, 4).ToInt64(), title = Text(hwnd, false), kind = Text(hwnd, true), visible = IsWindowVisible(hwnd), enabled = IsWindowEnabled(hwnd), controls = new List<HertzFileControl>() };
            if (window.kind == "#32770") EnumChildWindows(hwnd, (control, ignored) => {
                var kind = Text(control, true); var id = GetDlgCtrlID(control); var visible = IsWindowVisible(control);
                window.controls.Add(new HertzFileControl { handle = control.ToInt64(), parent = GetParent(control).ToInt64(), id = id, title = kind == "Edit" && id == 1001 && visible ? EditText(control) : Text(control, false), kind = kind, visible = visible, enabled = IsWindowEnabled(control) });
                return true;
            }, IntPtr.Zero);
            windows.Add(window); return true;
        }, IntPtr.Zero);
        return windows;
    }
    public static void Check(uint owner, IntPtr hwnd) {
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        if (hwnd == IntPtr.Zero || pid != owner) throw new InvalidOperationException("Refusing a handle outside the owned test process");
    }
    public static void Fill(uint owner, IntPtr dialog, string value) {
        Check(owner, dialog);
        IntPtr edit = GetDlgItem(dialog, 1152);
        if (edit == IntPtr.Zero) EnumChildWindows(dialog, (control, ignored) => {
            if (Text(control, true) == "Edit" && (GetDlgCtrlID(control) == 1001 || GetDlgCtrlID(GetParent(control)) == 1148)) { edit = control; return false; }
            return true;
        }, IntPtr.Zero);
        if (edit == IntPtr.Zero) throw new InvalidOperationException("File-name edit control missing");
        Check(owner, edit); IntPtr result;
        if (SendMessageTimeout(edit, 12, IntPtr.Zero, value, 2, 3000, out result) == IntPtr.Zero) throw new InvalidOperationException("File-name edit did not accept WM_SETTEXT");
    }
    public static void Button(uint owner, IntPtr dialog, int id) {
        Check(owner, dialog); var button = GetDlgItem(dialog, id);
        if (button == IntPtr.Zero) EnumChildWindows(dialog, (control, ignored) => {
            var text = Text(control, false).Replace("&", "");
            var matches = id == 6 ? (text.StartsWith("Yes", StringComparison.OrdinalIgnoreCase) || text.StartsWith("\u662f"))
                : id == 7 ? (text.StartsWith("No", StringComparison.OrdinalIgnoreCase) || text.StartsWith("\u5426"))
                : id == 2 ? (text.StartsWith("Cancel", StringComparison.OrdinalIgnoreCase) || text.StartsWith("\u53d6\u6d88"))
                : (text.StartsWith("OK", StringComparison.OrdinalIgnoreCase) || text.StartsWith("\u786e\u5b9a"));
            if (Text(control, true) == "Button" && IsWindowVisible(control) && matches) { button = control; return false; }
            return true;
        }, IntPtr.Zero);
        Check(owner, button);
        if (!IsWindowEnabled(button)) throw new InvalidOperationException("Requested native button is disabled");
        if (!PostMessage(button, 245, IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException("Native button click failed");
    }
}
'@
$ownedWindows = [HertzFileDialogs]::Read([uint32]$OwnerPid)
$saveTitle = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('3U9YW/xb+lGHZfZO'))
if ($Action -ne 'read') {
    $dialogHandle = [IntPtr]$Handle
    if ($Handle -eq 0) {
        $saveWindow = $ownedWindows | Where-Object { $_.visible -and $_.kind -eq '#32770' -and $_.title -eq $saveTitle -and ($_.controls | Where-Object { $_.kind -eq 'Edit' -and $_.id -eq 1001 }) } | Select-Object -First 1
        if (!$saveWindow) { throw 'Owned native save dialog missing' }
        $dialogHandle = [IntPtr]$saveWindow.handle
    }
    if ($Action -eq 'fill') {
        if ([string]::IsNullOrEmpty($SavePath)) { throw 'SavePath is required' }
        [HertzFileDialogs]::Fill([uint32]$OwnerPid, $dialogHandle, $SavePath)
    } else {
        $buttonId = switch ($Action) { 'cancel' { 2 }; 'yes' { 6 }; 'no' { 7 }; default { 1 } }
        [HertzFileDialogs]::Button([uint32]$OwnerPid, $dialogHandle, $buttonId)
    }
}
ConvertTo-Json -InputObject @([HertzFileDialogs]::Read([uint32]$OwnerPid)) -Depth 6 -Compress
