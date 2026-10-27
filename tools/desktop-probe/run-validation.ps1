[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Out,
  [Parameter(Mandatory = $true)][ValidateSet('Explorer', 'Soak')][string]$Mode,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Source,
  [string]$Wallpaper,
  [ValidateRange(120, 2147483647)][int]$DurationSeconds = 28800,
  [ValidateRange(41, 2147483647)][int]$IntervalSeconds = 50,
  [ValidateRange(1, 2147483647)][int]$Count = 10,
  [ValidateRange(0, 2147483647)][int]$MonitorIndex = 2
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# Synchronous worker: callers may launch powershell.exe -File ... with Start-Process.
# A hard-killed worker can leave "running", which is never evidence of a pass.
$startedUtc = [DateTime]::UtcNow
$Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
if (-not $Wallpaper) { $Wallpaper = Join-Path $PSScriptRoot 'target/release/wallpaper.exe' }
$Wallpaper = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Wallpaper)
$probeLog = Join-Path $Out 'probe.log'
$resultPath = Join-Path $Out 'result.json'
$runnerLog = Join-Path $Out 'runner.log'
$restartScript = Join-Path $PSScriptRoot 'restart-explorer.ps1'
$powershell = Join-Path $env:WINDIR 'System32/WindowsPowerShell/v1.0/powershell.exe'
$effectiveInterval = [Math]::Max(50, $IntervalSeconds)
$nativeSeconds = if ($Mode -eq 'Soak') { [long]$DurationSeconds } else { [long]$Count * $effectiveInterval }
$durationMs = $nativeSeconds * 1000L

# Never overwrite prior evidence. The exclusive reservation also handles same-Out races.
foreach ($name in @('probe.log', 'result.json', 'runner.log', 'stdout.log', 'stderr.log', 'mounted.ready', 'done.ready', 'webview2')) {
  if (Test-Path -LiteralPath (Join-Path $Out $name)) { throw "Refusing reused Out: $name already exists in $Out" }
}
[void][IO.Directory]::CreateDirectory($Out)
$reservation = [IO.File]::Open($resultPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$reservation.Dispose()
$utf8 = New-Object Text.UTF8Encoding($false)
$result = [ordered]@{
  status = 'running'; mode = $Mode; started_utc = $startedUtc.ToString('o'); updated_utc = $null
  finished_utc = $null; reason = $null; out = $Out; source = $Source
  wallpaper = $Wallpaper; binary_sha256 = $null; runner_pid = $PID; probe_pid = $null
  duration_ms = $durationMs; interval_seconds = $IntervalSeconds; effective_interval_seconds = $effectiveInterval
  count = $Count; monitor_index = $MonitorIndex; probe_started_utc = $null; deadline_utc = $null
  exit_code = $null; native_exit_utc = $null; normal_exit = $false; recovery_count = 0
  rounds = New-Object 'System.Collections.Generic.List[object]'
  shell_final = $null; leftovers = $null; tray_icons = $null; soak_verification = $null
}
$probe = $null
$reader = $null
$pendingText = ''
$lineNumber = 0
$round = $null
$allowedRecoveries = 0
$evidence = @{ acquired = $false; started = $false; mounted = $false; done = $false; scene_complete = $false
  frame = $null; recoveries = New-Object 'System.Collections.Generic.List[object]' }
$mutex = $null
$ownsMutex = $false
$validated = $false
$probeDeadline = [DateTime]::MaxValue

function Write-RunnerLog([string]$Message) {
  Add-Content -LiteralPath $runnerLog -Encoding UTF8 -Value "$([DateTime]::UtcNow.ToString('o')) status=$($result.status) $Message"
}
function Save-Result {
  $result.updated_utc = [DateTime]::UtcNow.ToString('o')
  $result.recovery_count = $evidence.recoveries.Count
  [IO.File]::WriteAllText("$resultPath.tmp", ($result | ConvertTo-Json -Depth 16), $utf8)
  Move-Item -LiteralPath "$resultPath.tmp" -Destination $resultPath -Force
}
function Wait-Poll([DateTime]$Deadline, [int]$Milliseconds = 250) {
  $remaining = ($Deadline - [DateTime]::UtcNow).TotalMilliseconds
  if ($remaining -gt 0) {
    Start-Sleep -Milliseconds ([int][Math]::Min($Milliseconds, [Math]::Ceiling($remaining)))
  }
}
function Join-NativeArguments([string[]]$Values) {
  # Start-Process joins ArgumentList on PS 5.1; quote using Windows argv escaping.
  ($Values | ForEach-Object { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }) -join ' '
}
function Read-ProbeUpdates([switch]$Final) {
  if (-not $script:reader -and (Test-Path -LiteralPath $probeLog)) {
    $stream = [IO.File]::Open($probeLog, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $script:reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
  }
  if (-not $script:reader) { return }
  # Keep partial lines between polls; do not reread an eight-hour log every second.
  $script:pendingText += $script:reader.ReadToEnd()
  if ($Final -and $script:pendingText.Length -gt 0 -and -not $script:pendingText.EndsWith("`n")) {
    $script:pendingText += "`n"
  }
  $lines = [regex]::Split($script:pendingText, '\r?\n')
  $script:pendingText = $lines[$lines.Length - 1]
  for ($index = 0; $index -lt $lines.Length - 1; $index++) {
    $line = $lines[$index]
    $script:lineNumber++
    if ($line -match '^(?:recovery_(?:terminal|fail)\b|single_instance=(?:conflict|error)\b|scene_finish_timeout\b|scene_failed\b|eval .*\berror=)') {
      throw "Probe failure at line ${lineNumber}: $line"
    }
    if ($line -match '^scene_js (\{.*\})$') {
      $sceneMessage = $Matches[1] | ConvertFrom-Json
      if ($sceneMessage.kind -match '^scene_.*error$|^scene_mount_failed$') {
        throw "Scene failure at line ${lineNumber}: $line"
      }
    }
    if ($line -eq 'single_instance=acquired') { $evidence.acquired = $true }
    if ($line -match '^probe=desk-w0 .*?\bpid=(\d+)\b') {
      if ([int]$Matches[1] -ne $probe.Id) { throw 'Probe log PID does not match the launched process.' }
      $evidence.started = $true
    }
    if ($line -match '^state tag=mounted\b') { $evidence.mounted = $true }
    if ($line -match '^state tag=done\b') { $evidence.done = $true }
    if ($line -eq 'scene_complete') { $evidence.scene_complete = $true }
    if ($line -match '^recovery_success\b') {
      $record = [pscustomobject]@{ observed_utc = [DateTime]::UtcNow.ToString('o'); line = $lineNumber; text = $line }
      $evidence.recoveries.Add($record)
      Write-RunnerLog "recovery_count=$($evidence.recoveries.Count) $line"
      if ($Mode -eq 'Explorer') {
        if ($evidence.recoveries.Count -gt $allowedRecoveries) { throw 'Unexpected additional recovery_success.' }
        if ($round) { $round.recovery = $record }
      }
    }
    if ($line -match '^js (\{.*\})$') {
      $data = $Matches[1] | ConvertFrom-Json
      if ($data.kind -eq 'frame') {
        $frame = [pscustomobject]@{ observed_utc = [DateTime]::UtcNow.ToString('o'); line = $lineNumber; data = $data }
        $evidence.frame = $frame
        # Require a post-recovery rendered frame AND reset counters, not an old page's IPC.
        if ($round -and $round.recovery -and -not $round.frame -and $lineNumber -gt $round.recovery.line -and
            $data.draws -gt 0 -and $data.raf -gt 0 -and $data.sceneTime -ge 0 -and
            $data.sceneTime -lt $round.before_frame.data.sceneTime -and $data.raf -lt $round.before_frame.data.raf) {
          $round.frame = $frame
        }
      }
    }
  }
}
function Update-Probe([switch]$RequireAlive) {
  Read-ProbeUpdates
  if ($probe.HasExited) {
    Read-ProbeUpdates -Final
    $result.exit_code = $probe.ExitCode
    if ($probe.ExitCode -ne 0) { throw "Probe exited with code $($probe.ExitCode) (3 indicates a singleton conflict)." }
    if ($RequireAlive) { throw 'Probe exited before validation rounds completed.' }
  }
}
function Get-Shell {
  $shell = & $restartScript -InspectOnly
  if (-not $shell) { throw 'Current-session Shell_TrayWnd is missing.' }
  return $shell
}
function Invoke-Helper([string]$File, [string[]]$Arguments, [string]$Stem, [int]$TimeoutSeconds, [switch]$MonitorProbe) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  if ($MonitorProbe -and $deadline -gt $probeDeadline) { $deadline = $probeDeadline }
  $stdout = Join-Path $Out "$Stem.stdout.log"
  $stderr = Join-Path $Out "$Stem.stderr.log"
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $File
  $startInfo.Arguments = Join-NativeArguments $Arguments
  $startInfo.WorkingDirectory = $PSScriptRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $child = New-Object Diagnostics.Process
  $child.StartInfo = $startInfo
  try {
    if (-not $child.Start()) { throw "Could not start $Stem." }
    $stdoutTask = $child.StandardOutput.ReadToEndAsync()
    $stderrTask = $child.StandardError.ReadToEndAsync()
    while (-not $child.HasExited -or -not $stdoutTask.IsCompleted -or -not $stderrTask.IsCompleted) {
      if ($MonitorProbe) { Update-Probe -RequireAlive }
      if ([DateTime]::UtcNow -ge $deadline) { throw "$Stem exceeded its ${TimeoutSeconds}s deadline." }
      Wait-Poll $deadline
    }
    [IO.File]::WriteAllText($stdout, $stdoutTask.Result, $utf8)
    [IO.File]::WriteAllText($stderr, $stderrTask.Result, $utf8)
    [pscustomobject]@{ exit_code = $child.ExitCode; stdout = $stdoutTask.Result; stderr = $stderrTask.Result }
  } finally {
    if (-not $child.HasExited) {
      Stop-Process -InputObject $child -Force -ErrorAction Stop
      [void]$child.WaitForExit(1000)
    }
    $child.Dispose()
  }
}
function Check-WebViewLeftovers {
  $marker = (Join-Path $Out 'webview2').Replace('/', '\')
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $remaining = ($deadline - [DateTime]::UtcNow).TotalSeconds
    if ($remaining -le 0) { break }
    $timeout = [uint32][Math]::Max(1, [Math]::Min(2, [Math]::Ceiling($remaining)))
    $ids = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -OperationTimeoutSec $timeout |
      Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\').IndexOf($marker, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
      ForEach-Object { [int]$_.ProcessId })
    $result.leftovers = [ordered]@{ count = $ids.Count; pids = $ids; user_data = $marker; checked_utc = [DateTime]::UtcNow.ToString('o') }
    if ($ids.Count -eq 0) { break }
    Wait-Poll $deadline 500
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $result.leftovers) { throw 'WebView2 residue inspection did not complete.' }
  Write-RunnerLog "leftover=$($result.leftovers.count) pids=$($result.leftovers.pids -join ',')"
  if ($result.leftovers.count -ne 0) { throw 'Dedicated WebView2 processes remain after 15s; none were killed.' }
}

Write-RunnerLog "started_utc=$($result.started_utc) mode=$Mode"
Save-Result
try {
  $result.binary_sha256 = (Get-FileHash -LiteralPath $Wallpaper -Algorithm SHA256).Hash
  Write-RunnerLog "binary_sha256=$($result.binary_sha256) wallpaper=$Wallpaper"
  Save-Result
  $mutex = New-Object Threading.Mutex($false, 'Global\Hertz.DesktopWallpaperProbe.ValidationRunner')
  try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { throw 'Validation runner mutex conflict: Explorer and Soak cannot run concurrently.' }
  # Observe, but never acquire/create, the probe's mutex: doing so would block our own probe.
  $existing = $null
  try { $existing = [Threading.Mutex]::OpenExisting('Local\Hertz.DesktopWallpaperProbe.Singleton') }
  catch [Threading.WaitHandleCannotBeOpenedException] { }
  if ($existing) { $existing.Dispose(); throw 'Wallpaper singleton mutex conflict.' }
  $shellAtStart = Get-Shell
  if ($Mode -eq 'Soak') {
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    $parser = Join-Path $PSScriptRoot 'parse-scene.js'
    if (-not (Test-Path -LiteralPath $parser -PathType Leaf)) { throw "Missing parser: $parser" }
  }
  $arguments = @('--out', $Out, '--source', $Source, '--duration-ms', [string]$durationMs)
  if ($Mode -eq 'Explorer') { $arguments += '--restart-test' }
  else { $arguments += @('--scene-soak', '--monitor-index', [string]$MonitorIndex, '--dpi-compensate') }
  # One native duration and one absolute deadline: never refresh either after recovery.
  $launchUtc = [DateTime]::UtcNow
  $probeDeadline = $launchUtc.AddSeconds(15 + $nativeSeconds + 30)
  $result.probe_started_utc = $launchUtc.ToString('o')
  $result.deadline_utc = $probeDeadline.ToString('o')
  $probe = Start-Process -FilePath $Wallpaper -ArgumentList (Join-NativeArguments $arguments) -PassThru `
    -WorkingDirectory $PSScriptRoot -RedirectStandardOutput (Join-Path $Out 'stdout.log') -RedirectStandardError (Join-Path $Out 'stderr.log')
  $null = $probe.Handle
  $result.probe_pid = $probe.Id
  Write-RunnerLog "probe_pid=$($probe.Id) shell_pid=$($shellAtStart.Pid) duration_ms=$durationMs deadline_utc=$($result.deadline_utc)"
  Save-Result
  $startDeadline = $launchUtc.AddSeconds(15)
  while ($true) {
    Update-Probe -RequireAlive
    $ready = $evidence.acquired -and $evidence.started -and $evidence.mounted -and (Test-Path -LiteralPath (Join-Path $Out 'mounted.ready'))
    # Warm the first page enough to distinguish a subsequent new page's reset counters.
    if ($Mode -eq 'Explorer') { $ready = $ready -and $evidence.frame -and $evidence.frame.data.sceneTime -ge 2000 }
    if ($ready) { break }
    if ([DateTime]::UtcNow -ge $startDeadline) { throw 'Probe start timeout: no fresh mounted.ready/initial frame within 15s.' }
    Wait-Poll $startDeadline
  }
  Write-RunnerLog 'mounted.ready verified'
  $expectedShell = $shellAtStart.Pid
  $lastRestart = $null
  if ($Mode -eq 'Explorer') {
    for ($number = 1; $number -le $Count; $number++) {
      if ($lastRestart) {
        $nextStart = $lastRestart.AddSeconds($effectiveInterval)
        while ([DateTime]::UtcNow -lt $nextStart) {
          Update-Probe -RequireAlive
          if ([DateTime]::UtcNow -ge $probeDeadline) { throw 'Explorer total deadline reached during interval.' }
          Wait-Poll $nextStart
        }
      }
      Update-Probe -RequireAlive
      if (-not (Test-Path -LiteralPath (Join-Path $Out 'mounted.ready'))) { throw 'mounted.ready disappeared.' }
      if ($evidence.recoveries.Count -ne $number - 1) { throw 'Recovery count changed outside the requested round.' }
      $before = Get-Shell
      if ($before.Pid -ne $expectedShell) { throw 'Shell PID changed outside the requested restart.' }
      $lastRestart = [DateTime]::UtcNow
      $round = [ordered]@{
        number = $number; status = 'running'; requested_utc = $lastRestart.ToString('o')
        restart_utc = $null; stopped_utc = $null; finished_utc = $null
        probe_pid = $probe.Id; shell_before = $before; shell_after = $null
        recovery_before = $evidence.recoveries.Count; recovery_after = $null
        before_frame = $evidence.frame; recovery = $null; frame = $null; reason = $null
      }
      $result.rounds.Add($round)
      $allowedRecoveries = $number
      Write-RunnerLog "round=$number requested_utc=$($round.requested_utc) probe_pid=$($probe.Id) shell_before=$($before.Pid)"
      Save-Result
      $recoveryDeadline = $lastRestart.AddSeconds(30)
      if ($recoveryDeadline -gt $probeDeadline) { $recoveryDeadline = $probeDeadline }
      $restart = Invoke-Helper $powershell @('-NoProfile', '-NonInteractive', '-File', $restartScript, '-WaitSeconds', '10') "round-$number.restart" 15 -MonitorProbe
      if ($restart.exit_code -ne 0) { throw "restart-explorer failed: $($restart.stderr)" }
      $beforeLog = [regex]::Match($restart.stdout, '(?m)^before_pids=(\d+) at=(\S+)')
      $stoppedLog = [regex]::Match($restart.stdout, '(?m)^stopped_pid=(\d+) at=(\S+)')
      $afterLog = [regex]::Match($restart.stdout, '(?m)^after_pids=(\d+) taskbar=(\d+) at=(\S+)')
      if (-not $beforeLog.Success -or -not $stoppedLog.Success -or -not $afterLog.Success -or
          [int]$beforeLog.Groups[1].Value -ne $before.Pid -or [int]$stoppedLog.Groups[1].Value -ne $before.Pid) {
        throw 'Restart helper shell identity/log verification failed.'
      }
      $round.restart_utc = $beforeLog.Groups[2].Value
      $round.stopped_utc = $stoppedLog.Groups[2].Value
      # Anchor the next interval AFTER the actual stop, not before child startup overhead.
      $lastRestart = [DateTime]::Parse($round.stopped_utc).ToUniversalTime()
      $round.shell_after = Get-Shell
      if ($round.shell_after.Pid -eq $before.Pid -or $round.shell_after.Pid -ne [int]$afterLog.Groups[1].Value -or
          $round.shell_after.Taskbar -ne [long]$afterLog.Groups[2].Value) {
        throw 'Restart did not produce a stable new taskbar shell PID.'
      }
      while ($true) {
        Update-Probe -RequireAlive
        if ($evidence.recoveries.Count -eq $number -and $round.recovery -and $round.frame) { break }
        if ([DateTime]::UtcNow -ge $recoveryDeadline) { throw 'Recovery timeout: expected exactly one recovery_success and a new-page js frame.' }
        Wait-Poll $recoveryDeadline
      }
      $verifiedShell = Get-Shell
      if ($verifiedShell.Pid -ne $round.shell_after.Pid) { throw 'Shell changed again during recovery.' }
      $round.recovery_after = $evidence.recoveries.Count
      $round.finished_utc = [DateTime]::UtcNow.ToString('o')
      $round.status = 'passed'
      $expectedShell = $verifiedShell.Pid
      Write-RunnerLog "round=$number passed restart_utc=$($round.restart_utc) stopped_utc=$($round.stopped_utc) shell_after=$expectedShell recovery_line=$($round.recovery.line) frame_line=$($round.frame.line)"
      Save-Result
      $round = $null
    }
  }
  $result.shell_final = Get-Shell
  if ($result.shell_final.Pid -ne $expectedShell) { throw 'Post-round shell PID verification failed.' }
  Write-RunnerLog 'waiting for normal native exit (no tray quit)'
  $heartbeat = [DateTime]::UtcNow
  while (-not $probe.HasExited) {
    Update-Probe
    if ($probe.HasExited) { break }
    if ([DateTime]::UtcNow -ge $probeDeadline) { throw 'Probe normal-exit deadline exceeded.' }
    if ([DateTime]::UtcNow -ge $heartbeat) {
      Write-RunnerLog 'waiting for normal native exit'
      Save-Result
      $heartbeat = [DateTime]::UtcNow.AddSeconds(30)
    }
    Wait-Poll $probeDeadline 1000
  }
  Update-Probe
  Read-ProbeUpdates -Final
  $result.exit_code = $probe.ExitCode
  $result.native_exit_utc = [DateTime]::UtcNow.ToString('o')
  $result.normal_exit = $true
  if (-not $evidence.done -or -not (Test-Path -LiteralPath (Join-Path $Out 'done.ready'))) { throw 'Native exit lacks done evidence.' }
  $result.shell_final = Get-Shell
  if ($result.shell_final.Pid -ne $expectedShell) { throw 'Final shell PID changed unexpectedly.' }
  if ($Mode -eq 'Explorer' -and $evidence.recoveries.Count -ne $Count) { throw 'Final recovery count is not exactly Count.' }
  if ($Mode -eq 'Soak') {
    if (-not $evidence.scene_complete) { throw 'Soak lacks scene_complete.' }
    $verification = Invoke-Helper $node @($parser, $probeLog, '--verify-soak', [string]$durationMs) 'soak-parser' 30
    $result.soak_verification = $verification.stdout | ConvertFrom-Json
    if (-not $result.soak_verification) { throw 'Soak parser did not return verification JSON.' }
    if ($verification.exit_code -ne 0 -or $result.soak_verification.status -ne 'pass') {
      throw "Soak parser failed: $($verification.stdout) $($verification.stderr)"
    }
  }
  $validated = $true
} catch {
  $result.status = 'failed'
  $result.reason = $_.Exception.Message
  if ($round -and $round.status -eq 'running') {
    $round.status = 'failed'; $round.reason = $result.reason; $round.finished_utc = [DateTime]::UtcNow.ToString('o')
  }
  Write-RunnerLog "reason=$($result.reason)"
  Save-Result
} finally {
  if ($result.status -eq 'running' -and -not $validated) {
    $result.status = 'incomplete'; $result.reason = 'Runner interrupted before all checks completed.'
    if ($round -and $round.status -eq 'running') {
      $round.status = 'incomplete'; $round.reason = $result.reason; $round.finished_utc = [DateTime]::UtcNow.ToString('o')
    }
  }
  try {
    if ($probe) {
      if (-not $probe.HasExited) {
        # Only this Start-Process-owned handle may be stopped; never kill by process name.
        Write-RunnerLog "stopping owned probe_pid=$($probe.Id)"
        Stop-Process -InputObject $probe -Force -ErrorAction Stop
        if (-not $probe.WaitForExit(5000)) { throw 'Owned probe did not exit after bounded cleanup.' }
      }
      $result.exit_code = $probe.ExitCode
      if (-not $result.native_exit_utc) { $result.native_exit_utc = [DateTime]::UtcNow.ToString('o') }
      Check-WebViewLeftovers
      # Only count after exit. This script does not click the tray Quit action.
      $tray = Invoke-Helper $powershell @('-NoProfile', '-NonInteractive', '-File', (Join-Path $PSScriptRoot 'tray-count.ps1'), '-Name', 'Hertz DESK-W0 probe', '-TimeoutSeconds', '10') 'tray-count' 15
      $counts = [regex]::Matches($tray.stdout, '(?m)^tray_icons=(\d+)(?:\s|$)')
      if ($tray.exit_code -ne 0 -or $counts.Count -ne 1) { throw 'tray-count failed or produced no unambiguous tray_icons value.' }
      $result.tray_icons = [int]$counts[0].Groups[1].Value
      Write-RunnerLog "tray_icons=$($result.tray_icons) native_exit_code=$($result.exit_code)"
      if ($result.tray_icons -ne 0) { throw 'Probe tray icon remains after native exit.' }
    }
  } catch {
    $result.status = 'failed'
    $result.reason = (@($result.reason, $_.Exception.Message) | Where-Object { $_ }) -join '; '
  } finally {
    if ($reader) { $reader.Dispose() }
    if ($probe) { $probe.Dispose() }
    if ($result.status -eq 'running' -and $validated) { $result.status = 'passed' }
    $result.finished_utc = [DateTime]::UtcNow.ToString('o')
    try {
      Write-RunnerLog "finished_utc=$($result.finished_utc) exit_code=$($result.exit_code) reason=$($result.reason)"
      Save-Result
    } finally {
      if ($ownsMutex) { $mutex.ReleaseMutex() }
      if ($mutex) { $mutex.Dispose() }
    }
  }
}
"status=$($result.status) result=$resultPath"
if ($result.status -eq 'passed') { exit 0 }
if ($result.status -eq 'incomplete') { exit 2 }
exit 1
