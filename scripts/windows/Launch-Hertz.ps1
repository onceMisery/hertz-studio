# SPDX-License-Identifier: MIT
[CmdletBinding()]
param(
    [string]$DataDir,
    [ValidateRange(0, 65534)]
    [int]$Port,
    [switch]$PassThru
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# Use this PowerShell installation's built-ins even when launched from pwsh
# with a module search path inherited from another version.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Management/Microsoft.PowerShell.Management.psd1')
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1')
$hertzExecutable = Join-Path $PSScriptRoot 'hertz-studio.exe'
if (-not (Test-Path -LiteralPath $hertzExecutable -PathType Leaf)) { throw 'hertz-studio.exe is missing. Extract the complete package first.' }

# Start-Process joins ArgumentList into one Windows command line. Quote data as
# a CommandLineToArgvW argument, including trailing backslashes, never as code.
function ConvertTo-HertzArgument([string]$Value) {
    return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}
$hertzArguments = @('--window')
if ($PSBoundParameters.ContainsKey('DataDir')) {
    if ([string]::IsNullOrWhiteSpace($DataDir)) { throw 'DataDir cannot be empty.' }
    $hertzArguments += @('--data-dir', (ConvertTo-HertzArgument ([IO.Path]::GetFullPath($DataDir))))
}
if ($PSBoundParameters.ContainsKey('Port')) { $hertzArguments += @('--port', [string]$Port) }
try {
    $hertzInstallReader = [IO.FileStream]::new((Join-Path $PSScriptRoot 'hertz-install.lock'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
} catch { throw 'Program directory is updating or the package is incomplete. Wait for the update or extract the complete package.' }
try {
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'hertz-update-incomplete.json')) { throw 'The previous update was interrupted. Run Update-Hertz.ps1 from the new extracted package with -InstallDir pointing here and -Recover.' }
    $hertzProcess = Start-Process -FilePath $hertzExecutable -ArgumentList ($hertzArguments -join ' ') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    if ($hertzProcess.WaitForExit(500) -and $hertzProcess.ExitCode -ne 0) { throw 'Player startup failed. Check the program package and close conflicting services before retrying.' }
    if ($PassThru) { @{ pid = $hertzProcess.Id } | ConvertTo-Json -Compress }
} finally { $hertzInstallReader.Dispose() }
