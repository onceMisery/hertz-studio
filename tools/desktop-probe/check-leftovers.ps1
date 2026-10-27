param(
  [Parameter(Mandatory = $true)][string]$UserData,
  [string]$Out,
  [int]$WaitSeconds = 10
)
$marker = [System.IO.Path]::GetFullPath($UserData).TrimEnd('\')
$deadline = (Get-Date).AddSeconds($WaitSeconds)

function Get-ProbeWebViewIds {
  $all = Get-CimInstance Win32_Process
  $matched = @{}
  foreach ($process in $all) {
    if ($process.Name -eq 'msedgewebview2.exe' -and $process.CommandLine -and
      $process.CommandLine.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $matched[[int]$process.ProcessId] = $true
    }
  }
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in $all) {
      if ($matched.ContainsKey([int]$process.ParentProcessId) -and
        -not $matched.ContainsKey([int]$process.ProcessId)) {
        $matched[[int]$process.ProcessId] = $true
        $changed = $true
      }
    }
  }
  return @($matched.Keys)
}

do {
  $ids = @(Get-ProbeWebViewIds)
  if ($ids.Count -eq 0) {
    $line = "leftover=0 user_data=$marker checked_at=$(Get-Date -Format o)"
    if ($Out) { $line | Set-Content $Out }
    $line
    exit 0
  }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

$line = "leftover=$($ids.Count) pids=$($ids -join ',') user_data=$marker checked_at=$(Get-Date -Format o)"
if ($Out) { $line | Set-Content $Out }
$line
exit 1
