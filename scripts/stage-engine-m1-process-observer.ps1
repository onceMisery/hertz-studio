# SPDX-License-Identifier: MIT
# Read-only process/GPU observations limited to the acceptance-owned child tree.
param([Parameter(Mandatory = $true)][int]$OwnerPid)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$all = @(Get-CimInstance Win32_Process)
$taskIds = [Collections.Generic.HashSet[int]]::new()
[void]$taskIds.Add($OwnerPid)
do {
    $added = 0
    foreach ($item in $all) {
        if ($taskIds.Contains([int]$item.ParentProcessId) -and $taskIds.Add([int]$item.ProcessId)) { $added++ }
    }
} while ($added -gt 0)
$processes = @($all | Where-Object { $taskIds.Contains([int]$_.ProcessId) } | ForEach-Object {
    $details = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($details) {
        @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = $_.Name;
           commandLine = $_.CommandLine; workingSetBytes = $details.WorkingSet64;
           privateBytes = $details.PrivateMemorySize64; cpuSeconds = $details.TotalProcessorTime.TotalSeconds }
    }
})
$gpuError = $null
try {
    $gpu = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | Where-Object {
        $_.Name -match '^pid_(\d+)_' -and $taskIds.Contains([int]$Matches[1])
    } | ForEach-Object {
        @{ name = $_.Name; dedicatedUsageBytes = $_.DedicatedUsage; sharedUsageBytes = $_.SharedUsage; totalCommittedBytes = $_.TotalCommitted }
    })
} catch { $gpu = @(); $gpuError = $_.Exception.Message }
@{ capturedAt = [DateTime]::UtcNow.ToString('o'); ownerPid = $OwnerPid; processes = $processes;
   gpu = $gpu; gpuError = $gpuError; scope = 'OS process/API counters; driver cache and process memory are not exact controlled resource release' } | ConvertTo-Json -Depth 5 -Compress
