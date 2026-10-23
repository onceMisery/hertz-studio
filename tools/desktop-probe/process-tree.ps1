param([string]$Out)
$root = Get-Process desktop-probe -ErrorAction SilentlyContinue | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $root) { "probe process not found" | Set-Content $Out; exit 1 }
$all = Get-CimInstance Win32_Process
$rows = New-Object System.Collections.Generic.List[object]
function Add-Row($process) {
  $rows.Add([pscustomobject]@{
    Name = $process.Name
    PID = $process.ProcessId
    Parent = $process.ParentProcessId
    WorkingSetMB = [math]::Round($process.WorkingSetSize / 1MB, 1)
    PrivateMB = [math]::Round($process.PagefileUsage / 1MB, 1)
    CpuMs = [math]::Round(($process.UserModeTime + $process.KernelModeTime) / 10000, 0)
  })
}
$rootCim = $all | Where-Object { $_.ProcessId -eq $root.Id } | Select-Object -First 1
if ($rootCim) { Add-Row $rootCim }
function Add-Children([int]$parent) {
  foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $parent }) {
    Add-Row $child
    Add-Children $child.ProcessId
  }
}
Add-Children $root.Id
"captured_at=$(Get-Date -Format o)" | Set-Content $Out
"root_pid=$($root.Id)" | Add-Content $Out
$rows | Format-Table -AutoSize | Out-String -Width 240 | Add-Content $Out
