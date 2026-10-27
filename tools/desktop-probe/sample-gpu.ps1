param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [string]$Out = 'gpu.csv',
  [int]$IntervalMs = 2000,
  [int]$MaxSeconds = 120
)
$start = Get-Date
"timestamp,root_pid,total_percent,max_percent,engines,active_processes" | Set-Content $Out
while (((Get-Date) - $start).TotalSeconds -lt $MaxSeconds) {
  if (-not (Get-Process -Id $RootPid -ErrorAction SilentlyContinue)) { break }
  $all = Get-CimInstance Win32_Process
  $ids = @{}
  $ids[$RootPid] = $true
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
  $samples = @()
  try {
    $samples = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -MaxSamples 1 -ErrorAction Stop).CounterSamples
  } catch {}
  $total = 0.0
  $max = 0.0
  $engines = 0
  $active = @{}
  foreach ($sample in $samples) {
    if ($sample.InstanceName -match '^pid_(\d+)_' -and $ids.ContainsKey([int]$Matches[1])) {
      $value = [double]$sample.CookedValue
      if ($value -gt 0.05) {
        $total += $value
        $engines++
        $active[[int]$Matches[1]] = $true
        if ($value -gt $max) { $max = $value }
      }
    }
  }
  "$(Get-Date -Format o),$RootPid,$([math]::Round($total, 2)),$([math]::Round($max, 2)),$engines,$($active.Count)" |
    Add-Content $Out
  Start-Sleep -Milliseconds $IntervalMs
}
