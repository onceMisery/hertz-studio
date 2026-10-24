param(
  [string]$Name = 'Hertz DESK-W0 probe',
  [int]$TimeoutSeconds = 10
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TrayCountNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
$root = [System.Windows.Automation.AutomationElement]::RootElement
function Find-Matching([string]$text) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $text)
  return $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
function Open-Overflow {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'SystemTrayIcon')
  $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $overflow = $null
  $minX = [double]::MaxValue
  for ($index = 0; $index -lt $buttons.Count; $index++) {
    $node = $buttons.Item($index)
    $rect = $node.Current.BoundingRectangle
    if ($rect.Width -gt 0 -and $rect.X -lt $minX) { $minX = $rect.X; $overflow = $node }
  }
  if ($null -eq $overflow) { return $false }
  $rect = $overflow.Current.BoundingRectangle
  [TrayCountNative]::SetCursorPos([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2)) | Out-Null
  [TrayCountNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [TrayCountNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  return $true
}
$saved = [System.Windows.Forms.Cursor]::Position
$icons = Find-Matching $Name
if ($icons.Count -eq 0) {
  Open-Overflow | Out-Null
  Start-Sleep -Milliseconds 900
  $icons = Find-Matching $Name
}
"tray_icons=$($icons.Count) name=$Name"
[TrayCountNative]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
[TrayCountNative]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
[TrayCountNative]::SetCursorPos($saved.X, $saved.Y) | Out-Null
exit 0
