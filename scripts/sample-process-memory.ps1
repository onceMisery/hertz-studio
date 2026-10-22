# SPDX-License-Identifier: MIT
# Read-only sampler for an explicitly owned fixture PID; no process enumeration.
param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$TargetProcessId,
    [ValidateRange(100, 5000)][int]$IntervalMs = 500,
    [ValidateRange(1, 1800)][int]$MaxDurationSeconds = 900
)
$ErrorActionPreference = 'Stop'
try {
    $observedProcess = [System.Diagnostics.Process]::GetProcessById($TargetProcessId)
    $originalStart = $observedProcess.StartTime.ToUniversalTime().Ticks
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt $MaxDurationSeconds) {
        if ($observedProcess.HasExited) { break }
        $observedProcess.Refresh()
        if ($observedProcess.StartTime.ToUniversalTime().Ticks -ne $originalStart) { throw 'process identity changed' }
        $sample = @{
            pid = $observedProcess.Id
            elapsedMs = $clock.Elapsed.TotalMilliseconds
            workingSetBytes = $observedProcess.WorkingSet64
            privateBytes = $observedProcess.PrivateMemorySize64
            virtualBytes = $observedProcess.VirtualMemorySize64
            handles = $observedProcess.HandleCount
            threads = $observedProcess.Threads.Count
        }
        [Console]::Out.WriteLine(($sample | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
        if ($observedProcess.WaitForExit($IntervalMs)) { break }
    }
    $observedProcess.Dispose()
} catch {
    [Console]::Error.WriteLine('Owned process memory sampling failed.')
    exit 1
}
