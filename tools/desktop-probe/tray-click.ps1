param(
  [string]$Marker,
  [string]$Name = 'Hertz DESK-L0 probe',
  [int]$TimeoutSeconds = 10
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
"@

function Find-Icon([string]$iconName) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $iconName)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Open-Overflow {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'SystemTrayIcon')
  $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $overflow = $null
  $minX = [double]::MaxValue
  for ($index = 0; $index -lt $buttons.Count; $index++) {
    $node = $buttons.Item($index)
    $rect = $node.Current.BoundingRectangle
    if ($rect.Width -gt 0 -and $rect.X -lt $minX) {
      $minX = $rect.X
      $overflow = $node
    }
  }
  if ($null -eq $overflow) { return $null }
  $rect = $overflow.Current.BoundingRectangle
  [NativeMouse]::Click([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
  return $overflow.Current.Name
}

if ($Marker) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while (-not (Test-Path $Marker)) {
    if ((Get-Date) -gt $deadline) { "marker_timeout=$Marker"; exit 3 }
    Start-Sleep -Milliseconds 100
  }
  "marker_ready=$(Get-Date -Format o)"
}

$saved = [System.Windows.Forms.Cursor]::Position
$icon = Find-Icon $Name
if ($null -eq $icon) {
  $overflowName = Open-Overflow
  if (-not $overflowName) { 'overflow_button_not_found'; exit 1 }
  "overflow_opened=$overflowName"
  Start-Sleep -Milliseconds 900
  $icon = Find-Icon $Name
}
if ($null -eq $icon) {
  [NativeMouse]::SetCursorPos($saved.X, $saved.Y) | Out-Null
  "icon_not_found=$Name"
  exit 2
}

$rect = $icon.Current.BoundingRectangle
"icon_found name=$($icon.Current.Name) rect=$rect offscreen=$($icon.Current.IsOffscreen)"
[NativeMouse]::Click([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
Start-Sleep -Milliseconds 400
[NativeMouse]::SetCursorPos($saved.X, $saved.Y) | Out-Null
"clicked_at=$(Get-Date -Format o)"
exit 0
