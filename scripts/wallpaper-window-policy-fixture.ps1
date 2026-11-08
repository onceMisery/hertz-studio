# SPDX-License-Identifier: MIT
# A test-owned real foreground window; all commands are read from its isolated directory.
param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WallpaperPolicyWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
}
'@
$form = New-Object Windows.Forms.Form
$form.Text = 'Hertz window policy verification'
$form.Width = 600
$form.Height = 360
$form.StartPosition = 'CenterScreen'
$label = New-Object Windows.Forms.Label
$label.Text = 'Window policy verification in progress'
$label.Dock = 'Fill'
$label.TextAlign = 'MiddleCenter'
$form.Controls.Add($label)
$commandFile = Join-Path $OutputDirectory 'window-command.json'
$stateFile = Join-Path $OutputDirectory 'window-state.json'
$script:lastSequence = -1
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 50
$timer.Add_Tick({
  if (-not (Test-Path -LiteralPath $commandFile)) { return }
  try { $command = [IO.File]::ReadAllText($commandFile) | ConvertFrom-Json } catch { return }
  if ($command.sequence -eq $script:lastSequence) { return }
  $script:lastSequence = $command.sequence
  if ($command.mode -eq 'close') { $form.Close(); return }
  $form.WindowState = 'Normal'
  $form.FormBorderStyle = 'Sizable'
  $form.Size = New-Object Drawing.Size(600,360)
  $area = [Windows.Forms.Screen]::FromControl($form).WorkingArea
  $form.Location = New-Object Drawing.Point(($area.Left + [int](($area.Width - 600) / 2)), ($area.Top + [int](($area.Height - 360) / 2)))
  if ($command.title) { $form.Text = $command.title }
  switch ($command.mode) {
    'maximized' { $form.WindowState = 'Maximized' }
    'fullscreen' { $form.FormBorderStyle = 'None'; $form.Bounds = [Windows.Forms.Screen]::FromControl($form).Bounds }
    'minimized' { $form.WindowState = 'Minimized' }
  }
  if ($command.mode -ne 'minimized') {
    $form.Activate()
    [void][WallpaperPolicyWindow]::SetForegroundWindow($form.Handle)
  }
  $state = @{
    sequence = $command.sequence
    mode = $command.mode
    pid = $PID
    executable = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    hwnd = $form.Handle.ToInt64()
    foreground = [WallpaperPolicyWindow]::GetForegroundWindow() -eq $form.Handle
    maximized = [WallpaperPolicyWindow]::IsZoomed($form.Handle)
    minimized = [WallpaperPolicyWindow]::IsIconic($form.Handle)
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($stateFile, $state, [Text.UTF8Encoding]::new($false))
})
$form.Add_Shown({ $timer.Start() })
try { [void]$form.ShowDialog() } finally { $timer.Dispose(); $form.Dispose() }
