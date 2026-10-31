# SPDX-License-Identifier: MIT
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DbxSource,
    [string]$Revision = '',
    [string]$Label = 'current'
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This native DBX runtime probe requires Windows.' }
if ($Label -notmatch '^[a-zA-Z0-9-]+$') { throw 'Label must contain only letters, digits and hyphens.' }
$probeRoot = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $probeRoot '../..')).Path
$dbxRoot = (Resolve-Path -LiteralPath $DbxSource).Path
$runRoot = Join-Path $probeRoot ('output/' + $Label + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $runRoot | Out-Null
$sourceCommit = (& git -C $dbxRoot rev-parse $(if ($Revision) { $Revision } else { 'HEAD' })).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve DBX revision.' }
if ($Revision) {
    # Copy a historical source into ignored probe output; never mutate the external checkout.
    $archive = Join-Path $runRoot 'dbx-source.zip'
    & git -C $dbxRoot archive --format=zip "--output=$archive" $Revision
    if ($LASTEXITCODE -ne 0) { throw 'Cannot archive DBX revision.' }
    $snapshot = Join-Path $runRoot 'dbx-source'
    Expand-Archive -LiteralPath $archive -DestinationPath $snapshot
    $dbxRoot = $snapshot
}
if (-not (Test-Path (Join-Path $dbxRoot 'crates/dbx-plugin-runtime/Cargo.toml'))) { throw 'DBX_SOURCE lacks the real dbx-plugin-runtime crate.' }
$version = (Get-Content -Raw (Join-Path $dbxRoot 'src-tauri/tauri.conf.json') | ConvertFrom-Json).version
function TomlPath([string]$Path) { return ConvertTo-Json -Compress ($Path.Replace('\', '/')) }
$manifest = @"
[package]
name = "dbx-desktop-probe"
version = "0.1.0"
edition = "2021"
publish = false
[workspace]
[dependencies]
dbx-plugin-runtime = { path = $(TomlPath (Join-Path $dbxRoot 'crates/dbx-plugin-runtime')) }
hertz-desktop-ipc = { path = $(TomlPath (Join-Path $repoRoot 'crates/hertz-desktop-ipc')) }
tokio = { version = "1", features = ["rt-multi-thread", "macros", "time", "io-util", "io-std", "process", "sync", "net"] }
serde_json = "1"
uuid = { version = "1", features = ["v4"] }
windows-sys = { version = "=0.61.2", features = ["Win32_Foundation", "Win32_Security", "Win32_System_Threading"] }
[[bin]]
name = "dbx-desktop-probe"
path = $(TomlPath (Join-Path $probeRoot 'src/host.rs'))
[[bin]]
name = "probe-sidecar"
path = $(TomlPath (Join-Path $probeRoot 'src/sidecar.rs'))
[[bin]]
name = "probe-component"
path = $(TomlPath (Join-Path $probeRoot 'src/component.rs'))
"@
$manifestPath = Join-Path $runRoot 'Cargo.toml'
[IO.File]::WriteAllText($manifestPath, $manifest)
$inputHashes = @{}
$inputs = @((Get-ChildItem -LiteralPath (Join-Path $repoRoot 'crates/hertz-desktop-ipc') -Recurse -File), (Get-ChildItem -LiteralPath (Join-Path $probeRoot 'src') -Recurse -File), (Get-Item -LiteralPath $PSCommandPath))
foreach ($input in $inputs) {
    foreach ($file in $input) {
        $relative = [IO.Path]::GetRelativePath($repoRoot, $file.FullName).Replace('\', '/')
        $inputHashes[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$metadata = @{ label = $Label; dbxCommit = $sourceCommit; dbxVersion = $version; externalSource = (Resolve-Path -LiteralPath $DbxSource).Path; copiedRevision = $Revision; generatedManifest = $manifestPath; os = $PSVersionTable.OS; architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); sourceHashes = $inputHashes }
[IO.File]::WriteAllText((Join-Path $runRoot 'source.json'), ($metadata | ConvertTo-Json -Depth 5))
$targetRoot = Join-Path $probeRoot 'output/target'
& cargo build --manifest-path $manifestPath --target-dir $targetRoot --bins 2>&1 | Tee-Object (Join-Path $runRoot 'build.log')
if ($LASTEXITCODE -ne 0) { throw "Probe build failed; see $runRoot/build.log" }
& (Join-Path $targetRoot 'debug/dbx-desktop-probe.exe') $runRoot $version $sourceCommit 2>&1 | Tee-Object (Join-Path $runRoot 'run.log')
if ($LASTEXITCODE -ne 0) { throw "Probe failed; inspect $runRoot/evidence.json" }
Write-Output "Evidence: $runRoot/evidence.json"
