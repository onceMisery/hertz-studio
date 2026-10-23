param(
  [string]$Name = 'Hertz DESK-W0 probe',
  [int]$ItemIndex = 0,
  [string]$Marker,
  [int]$TimeoutSeconds = 15
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TrayMenuNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string windowName);
  public static void RightClick(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0008, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero);
  }
  public static void Key(byte vk) {
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    keybd_event(vk, 0, 2, UIntPtr.Zero);
  }
}
"@
$root = [System.Windows.Automation.AutomationElement]::RootElement
function Find-ByName([string]$text) {
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $text)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
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
  [TrayMenuNative]::SetCursorPos([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2)) | Out-Null
  [TrayMenuNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [TrayMenuNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  return $true
}
if ($Marker) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while (-not (Test-Path $Marker)) {
    if ((Get-Date) -gt $deadline) { "marker_timeout=$Marker"; exit 3 }
    Start-Sleep -Milliseconds 100
  }
}
$saved = [System.Windows.Forms.Cursor]::Position
$icon = Find-ByName $Name
if ($null -eq $icon) {
  Open-Overflow | Out-Null
  Start-Sleep -Milliseconds 900
  $icon = Find-ByName $Name
}
if ($null -eq $icon) { "icon_not_found=$Name"; exit 2 }
$rect = $icon.Current.BoundingRectangle
"icon_rect=$rect"
[TrayMenuNative]::RightClick([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
Start-Sleep -Milliseconds 700
$menu = [TrayMenuNative]::FindWindow('#32768', $null)
"menu_window=$menu"
if ($menu -eq [IntPtr]::Zero) {
  [TrayMenuNative]::SetCursorPos($saved.X, $saved.Y) | Out-Null
  exit 4
}
for ($i = 0; $i -le $ItemIndex; $i++) { [TrayMenuNative]::Key(0x28) }
[TrayMenuNative]::Key(0x0D)
Start-Sleep -Milliseconds 500
[TrayMenuNative]::SetCursorPos($saved.X, $saved.Y) | Out-Null
"menu_selected_index=$ItemIndex at=$(Get-Date -Format o)"
exit 0
