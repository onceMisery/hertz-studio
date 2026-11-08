# SPDX-License-Identifier: MIT
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [string]$Candidate,
    [switch]$Recover,
    [switch]$AllowDebug
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Management/Microsoft.PowerShell.Management.psd1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')
$hertzPackageNames = @('Apache-2.0.txt', 'Hertz Studio.cmd', 'INSTALL.md', 'LICENSE', 'Launch-Hertz.ps1', 'NOTICE', 'Update-Hertz.ps1', 'hertz-install.lock', 'hertz-studio.exe', 'stage-fluid-LICENSE.md')
$hertzEmptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function Get-HertzDirectory([string]$Path, [bool]$AllowRoot = $false) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'An existing program directory is required.' }
    $item = Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force
    if (-not $item.PSIsContainer -or ($null -eq $item.Parent -and -not $AllowRoot)) { throw 'A drive root is not a program directory.' }
    $cursor = $item
    while ($null -ne $cursor) {
        if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse-point directories are not supported for package replacement.' }
        $cursor = $cursor.Parent
    }
    return $item.FullName.TrimEnd('\')
}

function Assert-HertzFile([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Expected an ordinary package file: $Path" }
    return $item
}

function Get-HertzHash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Read-HertzPackage([string]$Directory, [bool]$Development, [bool]$OwnsCarrier = $false, [bool]$AllowMissing = $false) {
    $manifestPath = Join-Path $Directory 'standalone-build.json'
    $manifestItem = Assert-HertzFile $manifestPath
    if ($manifestItem.Length -gt 524288) { throw 'Package manifest is too large.' }
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.kind -cne 'hertz-studio' -or $manifest.edition -cne 'full' -or $manifest.target -cne 'x86_64-pc-windows-msvc' -or
        $manifest.version -cnotmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$' -or
        ($manifest.profile -cne 'release' -and -not ($Development -and $manifest.profile -ceq 'debug')) -or
        $manifest.capabilities.windowsInstallGuard -ne $true -or $manifest.capabilities.nativeWindow -ne $true -or
        $manifest.capabilities.windowsSystemMedia -ne $true -or $manifest.capabilities.embeddedDesktop -ne $true) {
        throw 'Expected a Full Windows native package with installation guard support. Older installations require a separate-directory migration.'
    }
    foreach ($name in @('buildId', 'uiSha256', 'desktopBuildId')) { if ($manifest.$name -cnotmatch '^[a-f0-9]{64}$') { throw "Invalid content identity: $name" } }
    $names = @($manifest.files.PSObject.Properties.Name | Sort-Object)
    if (($names -join "`n") -cne (($hertzPackageNames | Sort-Object) -join "`n")) { throw 'Unexpected or missing package files.' }
    foreach ($name in $names) {
        $expected = $manifest.files.$name
        if ($expected.sha256 -cnotmatch '^[a-f0-9]{64}$' -or -not ($expected.size -is [int] -or $expected.size -is [long]) -or $expected.size -lt 0) { throw "Invalid file identity: $name" }
        $file = Join-Path $Directory $name
        if ($OwnsCarrier -and $name -ceq 'hertz-install.lock') {
            # The exclusive handle intentionally prevents another read handle.
            if ($expected.size -ne 0 -or $expected.sha256 -cne $hertzEmptyHash) { throw 'Invalid installation carrier.' }
        } else {
            # A guarded uninstaller can resume removal of an already validated
            # manifest. Update/installation callers still require every file.
            if ($AllowMissing -and -not (Test-Path -LiteralPath $file)) { continue }
            $item = Assert-HertzFile $file
            if ($item.Length -ne $expected.size -or (Get-HertzHash $file) -cne $expected.sha256) { throw "Package file hash mismatch: $name" }
        }
    }
    return [pscustomobject]@{ Manifest = $manifest; Names = @($names | Where-Object { $_ -cne 'hertz-install.lock' }) + @('standalone-build.json') }
}

function Assert-HertzExecutable([string]$Directory, $Manifest) {
    $executable = Join-Path $Directory 'hertz-studio.exe'
    $bytes = [IO.File]::ReadAllBytes($executable)
    if ($bytes.Length -lt 64 -or [BitConverter]::ToUInt16($bytes, 0) -ne 0x5a4d) { throw 'Not a PE executable.' }
    $offset = [BitConverter]::ToInt32($bytes, 0x3c)
    if ($offset -lt 0 -or $offset -gt ($bytes.Length - 26) -or [BitConverter]::ToUInt32($bytes, $offset) -ne 0x00004550 -or [BitConverter]::ToUInt16($bytes, $offset + 4) -ne 0x8664 -or [BitConverter]::ToUInt16($bytes, $offset + 24) -ne 0x20b) { throw 'Expected an x64 PE32+ executable.' }
    # Historical binaries ignored unknown arguments and could start a service.
    # Detect our supported descriptor before execution; this is compatibility,
    # not publisher authentication. Compare the real descriptor with the manifest.
    $markers = [Text.Encoding]::ASCII.GetString($bytes)
    foreach ($marker in @('--describe', 'uiSha256', 'windowsInstallGuard')) { if (-not $markers.Contains($marker)) { throw 'Binary lacks the guarded standalone description protocol.' } }
    $bytes = $null; $markers = $null
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $executable; $start.Arguments = '--describe'; $start.WorkingDirectory = $Directory
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000)) { $process.Kill(); $null = $process.WaitForExit(1000); throw 'Binary descriptor timed out.' }
        if ($process.ExitCode -ne 0 -or $stdout.Result.Length -gt 65536 -or $stderr.Result.Length -gt 65536) { throw 'Binary descriptor failed or exceeded its output limit.' }
        $description = $stdout.Result | ConvertFrom-Json
        foreach ($name in @('schemaVersion', 'kind', 'version', 'edition', 'target', 'profile', 'compiler', 'buildId', 'uiSha256', 'desktopBuildId')) {
            if ($description.$name -cne $Manifest.$name) { throw "Binary descriptor mismatch: $name" }
        }
        foreach ($name in @('nativeWindow', 'windowsSystemMedia', 'embeddedDesktop', 'windowsInstallGuard')) {
            if ($description.capabilities.$name -ne $true) { throw "Binary capability mismatch: $name" }
        }
    } finally { $process.Dispose() }
}

function Move-HertzInstallFile([string]$Source, [string]$Destination) { [IO.File]::Move($Source, $Destination) }

function Remove-HertzTransaction([string]$Directory, [string]$Installation) {
    $resolved = Get-HertzDirectory $Directory
    if ([IO.Path]::GetDirectoryName($resolved) -ine $Installation -or [IO.Path]::GetFileName($resolved) -cnotmatch '^\.hertz-update-[a-f0-9]{32}$') { throw 'Refusing cleanup outside the installation transaction.' }
    # Only our two flat directories and ordinary files can be removed recursively.
    foreach ($item in @(Get-ChildItem -LiteralPath $resolved -Recurse -Force)) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing cleanup of a reparse point.' }
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Restore-HertzInstallation([string]$Installation, [bool]$Development, [scriptblock]$BeforeCommit = $null) {
    $marker = Join-Path $Installation 'hertz-update-incomplete.json'
    $item = Assert-HertzFile $marker
    if ($item.Length -gt 16384) { throw 'Recovery marker is too large.' }
    $journal = [IO.File]::ReadAllText($marker) | ConvertFrom-Json
    if ($journal.schemaVersion -ne 1 -or $journal.transaction -cnotmatch '^\.hertz-update-[a-f0-9]{32}$' -or $journal.backupManifestSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid recovery marker; preserve backups for manual recovery.' }
    $transaction = Get-HertzDirectory (Join-Path $Installation $journal.transaction)
    if ([IO.Path]::GetDirectoryName($transaction) -ine $Installation) { throw 'Recovery transaction escaped the installation.' }
    $backup = Get-HertzDirectory (Join-Path $transaction 'backup')
    if ((Get-HertzHash (Join-Path $backup 'standalone-build.json')) -cne $journal.backupManifestSha256) { throw 'Recovery manifest hash mismatch; preserve backups.' }
    $original = Read-HertzPackage $backup $Development
    # Originals are retained until *every* restored file verifies. If another
    # program blocks recovery, leave the marker and complete backups in place.
    foreach ($name in $original.Names) {
        $destination = Join-Path $Installation $name
        if (Test-Path -LiteralPath $destination) { $null = Assert-HertzFile $destination }
        [IO.File]::Copy((Join-Path $backup $name), $destination, $true)
    }
    $null = Read-HertzPackage $Installation $Development $true
    if ((Get-HertzHash (Join-Path $Installation 'standalone-build.json')) -cne $journal.backupManifestSha256) { throw 'Restored manifest mismatch.' }
    if ($null -ne $BeforeCommit) { & $BeforeCommit $original.Manifest $Installation }
    Remove-Item -LiteralPath $marker
    try { Remove-HertzTransaction $transaction $Installation } catch { Write-Warning "Program restored; retained transaction: $transaction" }
    return [pscustomobject]@{ status = 'restored'; buildId = $original.Manifest.buildId; installDir = $Installation }
}

function Invoke-HertzPackageUpdate([string]$Installation, [string]$Source, [bool]$Recovery, [bool]$Development, [scriptblock]$BeforeCommit = $null) {
    $installationPath = Get-HertzDirectory $Installation
    $carrierPath = Join-Path $installationPath 'hertz-install.lock'
    $null = Assert-HertzFile $carrierPath
    try { $owner = [IO.FileStream]::new($carrierPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None) }
    catch {
        $cause = $_.Exception.GetBaseException()
        if (($cause.HResult -band 0xffff) -in @(32, 33)) { throw "install_dir_busy: Close all players/adapters using this program directory, or wait for its current update. $($cause.Message)" }
        throw
    }
    $transaction = $null
    $journalPublished = $false
    $marker = Join-Path $installationPath 'hertz-update-incomplete.json'
    try {
        if ($owner.Length -ne 0) { throw 'Invalid installation carrier.' }
        if ($Recovery) { return Restore-HertzInstallation $installationPath $Development $BeforeCommit }
        if (Test-Path -LiteralPath $marker) { throw 'install_recovery_required: Use -Recover before attempting another update.' }
        $sourcePath = Get-HertzDirectory $Source
        if ($sourcePath -ieq $installationPath -or $sourcePath.StartsWith($installationPath + '\', [StringComparison]::OrdinalIgnoreCase) -or $installationPath.StartsWith($sourcePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Candidate and installation must be separate, non-nested directories.' }
        $candidatePackage = Read-HertzPackage $sourcePath $Development
        $candidateManifestHash = Get-HertzHash (Join-Path $sourcePath 'standalone-build.json')
        $current = Read-HertzPackage $installationPath $Development $true
        Assert-HertzExecutable $installationPath $current.Manifest
        if ([version]($candidatePackage.Manifest.version.Split('-')[0]) -lt [version]($current.Manifest.version.Split('-')[0])) { throw 'Program downgrade requires explicit data compatibility review and a separate directory.' }
        # Probe every target before changing any file, including uncooperative
        # external users of the executable/resources. Never terminate them.
        $probes = @()
        try {
            foreach ($name in $current.Names) { $probes += [IO.FileStream]::new((Join-Path $installationPath $name), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        } finally { foreach ($probe in $probes) { $probe.Dispose() } }
        $transaction = Join-Path $installationPath ('.hertz-update-' + [guid]::NewGuid().ToString('N'))
        $stage = Join-Path $transaction 'stage'
        $backup = Join-Path $transaction 'backup'
        [IO.Directory]::CreateDirectory($stage) | Out-Null
        [IO.Directory]::CreateDirectory($backup) | Out-Null
        foreach ($name in $candidatePackage.Names) { [IO.File]::Copy((Join-Path $sourcePath $name), (Join-Path $stage $name)) }
        [IO.File]::WriteAllText((Join-Path $stage 'hertz-install.lock'), '')
        $null = Read-HertzPackage $stage $Development
        if ((Get-HertzHash (Join-Path $stage 'standalone-build.json')) -cne $candidateManifestHash) { throw 'Candidate changed during staging.' }
        Assert-HertzExecutable $stage $candidatePackage.Manifest
        foreach ($name in $current.Names) { [IO.File]::Copy((Join-Path $installationPath $name), (Join-Path $backup $name)) }
        [IO.File]::WriteAllText((Join-Path $backup 'hertz-install.lock'), '')
        $null = Read-HertzPackage $backup $Development
        $journal = @{ schemaVersion = 1; transaction = [IO.Path]::GetFileName($transaction); backupManifestSha256 = Get-HertzHash (Join-Path $backup 'standalone-build.json') } | ConvertTo-Json -Compress
        # Flush a complete journal privately, then publish it with a same-volume
        # atomic rename. A crash before publication leaves the original package
        # runnable; every visible marker is complete before any replacement.
        $journalBytes = [Text.UTF8Encoding]::new($false).GetBytes($journal)
        $journalTemporary = Join-Path $transaction 'journal.json'
        $journalFile = [IO.FileStream]::new($journalTemporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $journalFile.Write($journalBytes, 0, $journalBytes.Length); $journalFile.Flush($true) } finally { $journalFile.Dispose() }
        Move-HertzInstallFile $journalTemporary $marker
        $journalPublished = $true
        foreach ($name in $candidatePackage.Names) {
            Move-HertzInstallFile (Join-Path $installationPath $name) (Join-Path $transaction ('old-' + $name))
            Move-HertzInstallFile (Join-Path $stage $name) (Join-Path $installationPath $name)
        }
        $verified = Read-HertzPackage $installationPath $Development $true
        if ((Get-HertzHash (Join-Path $installationPath 'standalone-build.json')) -cne $candidateManifestHash) { throw 'Installed manifest differs from candidate.' }
        if ($null -ne $BeforeCommit) { & $BeforeCommit $verified.Manifest $installationPath }
        Remove-Item -LiteralPath $marker
        try { Remove-HertzTransaction $transaction $installationPath } catch { Write-Warning "Update completed; retained transaction: $transaction" }
        return [pscustomobject]@{ status = 'updated'; buildId = $verified.Manifest.buildId; installDir = $installationPath }
    } catch {
        $failure = $_
        if (-not $Recovery -and $null -ne $transaction) {
            if ($journalPublished) {
                try { $null = Restore-HertzInstallation $installationPath $Development }
                catch { throw "install_recovery_required: Update failed and recovery was blocked. Preserve $transaction and run -Recover. $($_.Exception.Message)" }
            } else {
                try { Remove-HertzTransaction $transaction $installationPath } catch { Write-Warning "Retained uncommitted staging: $transaction" }
            }
        }
        throw $failure
    } finally { $owner.Dispose() }
}

if ($MyInvocation.InvocationName -ne '.') {
    if ($Recover -and -not [string]::IsNullOrWhiteSpace($Candidate)) { throw '-Recover does not accept a candidate.' }
    if (-not $Recover -and [string]::IsNullOrWhiteSpace($Candidate)) { throw 'Supply -Candidate with a complete extracted local package.' }
    Invoke-HertzPackageUpdate $InstallDir $Candidate ([bool]$Recover) ([bool]$AllowDebug) | ConvertTo-Json -Compress
}
