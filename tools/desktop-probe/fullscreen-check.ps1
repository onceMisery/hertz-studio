param(
  [string]$Out,
  [string]$Browser = 'C:\Program Files\Google\Chrome\Application\chrome.exe',
  [int]$WaitSeconds = 4
)
if (-not $Out) { throw '-Out is required' }
if (-not (Test-Path $Browser)) { "browser_not_found=$Browser"; exit 2 }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NotifState {
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
}
"@
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$profile = Join-Path $Out 'chrome-profile'
$html = Join-Path $Out 'fullscreen.html'
@'
<!doctype html><html><body style="margin:0;background:#102030;color:#d7e3f4;font-family:Segoe UI">
<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-size:42px">REAL FULLSCREEN APP</div>
</body></html>
'@ | Set-Content -Encoding UTF8 $html
$fileUrl = 'file:///' + ($html -replace '\\', '/')
$process = Start-Process $Browser -ArgumentList @(
  "--user-data-dir=$profile",
  '--no-first-run',
  '--no-default-browser-check',
  '--start-fullscreen',
  '--new-window',
  $fileUrl
) -PassThru
Start-Sleep -Seconds $WaitSeconds
$state = 0
[NotifState]::SHQueryUserNotificationState([ref]$state) | Out-Null
"launcher_pid=$($process.Id) state=$state"

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
$bitmap.Save((Join-Path $Out 'real-fullscreen.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

$all = Get-CimInstance Win32_Process
$ids = @($all | Where-Object {
    $_.Name -eq 'chrome.exe' -and $_.CommandLine -and
    $_.CommandLine.IndexOf($profile, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } | Select-Object -ExpandProperty ProcessId)
"matching_chrome_pids=$($ids -join ',')"
foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
$stateAfter = 0
[NotifState]::SHQueryUserNotificationState([ref]$stateAfter) | Out-Null
$left = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'chrome.exe' -and $_.CommandLine -and
    $_.CommandLine.IndexOf($profile, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
"after_close_state=$stateAfter leftover=$($left.Count)"
