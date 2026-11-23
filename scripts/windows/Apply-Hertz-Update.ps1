# SPDX-License-Identifier: MIT
# One-shot helper. Program replacement remains owned by Update-Hertz.ps1/NSIS.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Plan,
    [switch]$AllowDebug,
    [switch]$NoRestart,
    [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Management/Microsoft.PowerShell.Management.psd1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$maximumPackage = 268435456
$job = $null
$logPath = $null
$committed = $false
$finished = $false

function Write-UpdateLog([string]$Message) {
    if ($null -ne $logPath) {
        [IO.File]::AppendAllText($logPath, ([DateTime]::UtcNow.ToString('o') + ' ' + $Message + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    }
}

function Read-UpdateJson([string]$Path, [long]$Maximum = 16384) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt $Maximum) { throw 'Invalid update metadata file.' }
    return ([IO.File]::ReadAllText($item.FullName) | ConvertFrom-Json)
}

function Write-UpdateResult([string]$Status, [string]$Message) {
    if ($null -eq $job -or $null -eq $logPath) { return }
    $root = Get-HertzDirectory ([IO.Path]::GetDirectoryName($logPath))
    $destination = Join-Path $root 'last-install.json'
    if (Test-Path -LiteralPath $destination) { $null = Assert-HertzFile $destination }
    $temporary = Join-Path $root ('result-' + $job.token + '.new')
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes((@{ status = $Status; version = $job.version; fromVersion = $job.fromVersion; message = $Message; log = $logPath; completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress))
    $file = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
    # PowerShell's method binder turns $null into an empty string here. NullString
    # keeps the optional backup path null, so repeat updates remain atomic.
    if (Test-Path -LiteralPath $destination) { [IO.File]::Replace($temporary, $destination, [System.Management.Automation.Language.NullString]::Value) }
    else { [IO.File]::Move($temporary, $destination) }
}

function ConvertTo-WindowsArgument([string]$Value) {
    # ProcessStartInfo passes this directly to CreateProcess, never to a shell.
    $quoted = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $quoted = [regex]::Replace($quoted, '(\\+)$', '$1$1')
    return '"' + $quoted + '"'
}

function Start-UpdatedPlayer {
    if ($NoRestart -or $null -eq $job) { return }
    $directory = Get-HertzDirectory $job.installDir
    foreach ($marker in @('hertz-update-incomplete.json', 'hertz-setup-incomplete.json', 'hertz-uninstall-incomplete.json')) {
        if (Test-Path -LiteralPath (Join-Path $directory $marker)) { return }
    }
    $executable = Join-Path $directory 'hertz-studio.exe'
    $null = Assert-HertzFile $executable
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $executable
    $start.WorkingDirectory = $directory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.Arguments = '--window --bind 127.0.0.1 --data-dir ' + (ConvertTo-WindowsArgument $job.dataDir) + ' --port ' + [string]$job.port
    $process = [Diagnostics.Process]::Start($start)
    $process.Dispose()
}

function Expand-UpdatePackage([string]$Archive, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archiveFile = Assert-HertzFile $Archive
    if ($archiveFile.Length -gt $maximumPackage) { throw 'Update archive exceeds the package limit.' }
    $zip = [IO.Compression.ZipFile]::OpenRead($archiveFile.FullName)
    try {
        if ($zip.Entries.Count -lt 1 -or $zip.Entries.Count -gt 32) { throw 'Unexpected archive entry count.' }
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $total = [long]0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            if ([IO.Path]::GetFileName($name) -cne $name -or $name.Contains('/') -or $name.Contains('\') -or
                $name -notin ($hertzPackageNames + @('standalone-build.json')) -or -not $names.Add($name) -or
                (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960 -or $entry.Length -lt 0 -or $entry.Length -gt $maximumPackage) {
                throw 'Unexpected or unsafe archive entry.'
            }
            $total += $entry.Length
            if ($total -gt $maximumPackage) { throw 'Extracted package exceeds the package limit.' }
        }
        [IO.Directory]::CreateDirectory($Destination) | Out-Null
        $destinationPath = Get-HertzDirectory $Destination
        foreach ($entry in $zip.Entries) {
            $entryInput = $entry.Open()
            $output = [IO.FileStream]::new((Join-Path $destinationPath $entry.FullName), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $buffer = [byte[]]::new(65536)
                $written = [long]0
                while (($read = $entryInput.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $written += $read
                    if ($written -gt $entry.Length) { throw 'Archive entry exceeds its declared size.' }
                    $output.Write($buffer, 0, $read)
                }
                if ($written -ne $entry.Length) { throw 'Archive entry is incomplete.' }
                $output.Flush($true)
            } finally { $entryInput.Dispose(); $output.Dispose() }
        }
    } finally { $zip.Dispose() }
}

try {
    $planPath = [IO.Path]::GetFullPath($Plan)
    $job = Read-UpdateJson $planPath
    if ($job.schemaVersion -ne 1 -or $job.token -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or
        $job.kind -cnotin @('portable', 'installer') -or $job.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $job.version -cnotmatch '^\d+\.\d+\.\d+$' -or $job.parentPid -lt 1 -or $job.port -lt 0 -or $job.port -gt 65535 -or
        $job.size -lt 1 -or $job.size -gt $maximumPackage) { throw 'Invalid update plan.' }
    $stagePath = [IO.Path]::GetFullPath($job.stageDir).TrimEnd('\')
    $handoffPath = [IO.Path]::GetDirectoryName($planPath)
    if ([IO.Path]::GetDirectoryName($handoffPath) -ine $stagePath -or
        [IO.Path]::GetFileName($handoffPath) -cne ('handoff-' + $job.token) -or
        $PSScriptRoot -ine $stagePath -or [IO.Path]::GetFileName($stagePath) -cnotmatch '^[a-f0-9-]{36}$') { throw 'Update plan escaped its private staging directory.' }
    # The trusted updater is embedded in the running player, not taken from an unverified archive.
    # Dot-sourcing binds the updater's same-named switch in this scope.
    . (Join-Path $stagePath 'Update-Hertz.ps1') -InstallDir $job.installDir -AllowDebug:$AllowDebug
    $stagePath = Get-HertzDirectory $stagePath
    $handoffPath = Get-HertzDirectory $handoffPath
    $installPath = Get-HertzDirectory $job.installDir
    $dataPath = Get-HertzDirectory $job.dataDir
    $cacheRoot = Get-HertzDirectory (Join-Path $dataPath 'cache\updates')
    if ([IO.Path]::GetDirectoryName($stagePath) -ine $cacheRoot -or
        $stagePath.StartsWith($installPath + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $installPath.StartsWith($stagePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Program and update staging directories overlap.' }
    $logPath = Join-Path $cacheRoot ('update-' + $job.token + '.log')
    $null = [IO.FileStream]::new($logPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read).Dispose()
    Write-UpdateLog 'Waiting for the exact player process and approved shutdown.'
    $parent = [Diagnostics.Process]::GetProcessById([int]$job.parentPid)
    try {
        if ([IO.Path]::GetFullPath($parent.MainModule.FileName) -ine (Join-Path $installPath 'hertz-studio.exe')) { throw 'Update parent is not this installation.' }
        $readyBytes = [Text.UTF8Encoding]::new($false).GetBytes((@{ token = $job.token } | ConvertTo-Json -Compress))
        $readyFile = [IO.FileStream]::new((Join-Path $handoffPath 'ready.new'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $readyFile.Write($readyBytes, 0, $readyBytes.Length); $readyFile.Flush($true) } finally { $readyFile.Dispose() }
        [IO.File]::Move((Join-Path $handoffPath 'ready.new'), (Join-Path $handoffPath 'ready.json'))
        $deadline = [DateTime]::UtcNow.AddMinutes(3)
        while (-not $parent.WaitForExit(200)) {
            if (Test-Path -LiteralPath (Join-Path $handoffPath 'cancel')) { Write-UpdateLog 'Installation cancelled by the player.'; exit 0 }
            if ([DateTime]::UtcNow -gt $deadline) { Write-UpdateLog 'Player remains active; installation cancelled.'; exit 0 }
        }
    } finally { $parent.Dispose() }
    if (Test-Path -LiteralPath (Join-Path $handoffPath 'cancel')) { Write-UpdateLog 'Installation cancelled.'; exit 0 }
    $approval = Join-Path $handoffPath 'apply.json'
    if (-not (Test-Path -LiteralPath $approval)) { Write-UpdateLog 'No approved shutdown marker; no program files changed.'; exit 0 }
    if ((Read-UpdateJson $approval 1024).token -cne $job.token) { throw 'Shutdown approval does not match this update.' }
    $committed = $true
    $packagePath = [IO.Path]::GetFullPath($job.packagePath)
    $suffix = if ($job.kind -ceq 'installer') { '-setup.exe' } else { '.zip' }
    $expectedName = '^hertz-studio-(?:full-)?' + [regex]::Escape($job.version) + '-x86_64-pc-windows-msvc' + [regex]::Escape($suffix) + '$'
    if ([IO.Path]::GetDirectoryName($packagePath) -ine $stagePath -or [IO.Path]::GetFileName($packagePath) -cnotmatch $expectedName) { throw 'Unexpected update package path.' }
    $packageFile = Assert-HertzFile $packagePath
    if ($packageFile.Length -ne $job.size -or (Get-HertzHash $packagePath) -cne $job.sha256) { throw 'Downloaded update package changed; download it again.' }
    # Wait briefly for other profiles; never kill any player or external process.
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ($true) {
        try { $probe = [IO.FileStream]::new((Join-Path $installPath 'hertz-install.lock'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None); $probe.Dispose(); break }
        catch {
            if ([DateTime]::UtcNow -gt $deadline) { throw 'Other players still use this program directory. Close them before installing the update.' }
            Start-Sleep -Milliseconds 250
        }
    }
    Write-UpdateLog ('Applying ' + $job.kind + ' update ' + $job.version)
    if ($job.kind -ceq 'portable') {
        $candidate = Join-Path $handoffPath 'candidate'
        Expand-UpdatePackage $packagePath $candidate
        $package = Read-HertzPackage $candidate ([bool]$AllowDebug)
        if ($package.Manifest.version -cne $job.version) { throw 'Extracted version does not match the selected release.' }
        $result = Invoke-HertzPackageUpdate $installPath $candidate $false ([bool]$AllowDebug)
        if ($result.status -cne 'updated') { throw 'Package transaction did not complete.' }
    } else {
        if (-not (Test-Path -LiteralPath (Join-Path $installPath 'hertz-setup.json'))) { throw 'The installed application receipt is missing.' }
        $signature = Get-AuthenticodeSignature -LiteralPath $packagePath
        if ($signature.Status.ToString() -notin @('Valid', 'NotSigned')) { throw 'Installer signature is invalid or untrusted.' }
        $installer = Start-Process -FilePath $packagePath -ArgumentList @('/S', ('/D=' + $installPath)) -WindowStyle Hidden -PassThru -Wait
        try { if ($installer.ExitCode -ne 0) { throw ('Installer failed with exit code ' + $installer.ExitCode + '. Run the installer again to recover.') } }
        finally { $installer.Dispose() }
    }
    $installed = Read-HertzPackage $installPath ([bool]$AllowDebug)
    if ($installed.Manifest.version -cne $job.version) { throw 'Installed version does not match the selected release.' }
    $finished = $true
    Write-UpdateLog 'Update verified; reopening the same music profile.'
    Write-UpdateResult 'updated' ('已更新到 ' + $job.version)
    Start-UpdatedPlayer
    # Only remove the fully checked private stage after a successful transaction.
    try {
        $resolvedStage = Get-HertzDirectory $stagePath
        if ([IO.Path]::GetDirectoryName($resolvedStage) -ine $cacheRoot -or [IO.Path]::GetFileName($resolvedStage) -cnotmatch '^[a-f0-9-]{36}$') { throw 'Unsafe update cleanup target.' }
        foreach ($item in @(Get-ChildItem -LiteralPath $resolvedStage -Recurse -Force)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing update cleanup through a link.' }
        }
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    } catch { Write-UpdateLog ('Update complete; retained downloaded files: ' + $_.Exception.Message) }
} catch {
    $message = $_.Exception.Message
    try {
        Write-UpdateLog ('FAILED: ' + $message)
        if ($committed) {
            if ($finished) { Write-UpdateResult 'updated' ('更新已安装，请手动重新打开播放器：' + $message) }
            else { Write-UpdateResult 'failed' ('更新未完成：' + $message) }
        }
    } catch { }
    if ($committed -and -not $Quiet) {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            $null = [Windows.Forms.MessageBox]::Show(('更新未完成，请根据日志处理后重试。' + [Environment]::NewLine + $message + [Environment]::NewLine + $logPath), 'Hertz Studio 更新', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Warning)
        } catch { }
    }
    if ($committed -and -not $finished) { try { Start-UpdatedPlayer } catch { } }
    exit 1
}
