param(
  [Parameter(Mandatory = $true)][string]$UserData,
  [string]$Marker,
  [int]$TimeoutSeconds = 15
)
$markerPath = [System.IO.Path]::GetFullPath($UserData).TrimEnd('\')
if ($Marker) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while (-not (Test-Path $Marker)) {
    if ((Get-Date) -gt $deadline) { "marker_timeout=$Marker"; exit 3 }
    Start-Sleep -Milliseconds 100
  }
  "marker_ready=$(Get-Date -Format o)"
}

$all = Get-CimInstance Win32_Process
$roots = @($all | Where-Object {
    $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -and
    $_.CommandLine.IndexOf($markerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
if ($roots.Count -eq 0) { "webview_root_not_found=$markerPath"; exit 1 }

$ids = @{}
foreach ($root in $roots) { $ids[[int]$root.ProcessId] = $true }
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($process in $all) {
    if ($ids.ContainsKey([int]$process.ParentProcessId) -and
      -not $ids.ContainsKey([int]$process.ProcessId)) {
      $ids[[int]$process.ProcessId] = $true
      $changed = $true
    }
  }
}

"kill_at=$(Get-Date -Format o) root_pids=$($roots.ProcessId -join ',') tree=$($ids.Count)"
foreach ($id in $ids.Keys) {
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
$after = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -and
    $_.CommandLine.IndexOf($markerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
"after_2s_matching_webview=$($after.Count) pids=$($after.ProcessId -join ',')"
exit 0
