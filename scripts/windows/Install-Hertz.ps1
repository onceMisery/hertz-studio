# SPDX-License-Identifier: MIT
[CmdletBinding()]
param(
    [ValidateSet('Install','Uninstall','Inspect')][string]$Action = 'Install',
    [Parameter(Mandatory=$true)][string]$InstallDir,
    [string]$PackageDir,
    [string]$Uninstaller,
    [switch]$AllowDebug,
    [switch]$AnsiConsole
)
$ErrorActionPreference='Stop'
# This owner is extracted from the trusted installer, not loaded from a chosen
# install directory or arbitrary package before its integrity is checked.
. (Join-Path $PSScriptRoot 'PackageOwner.ps1') -InstallDir $InstallDir
# NSIS nsExec decodes its pipe using the Windows ANSI code page. Keep UTF-8
# for direct/Node callers, and match that decoder only at the NSIS boundary.
[Console]::OutputEncoding=if($AnsiConsole){[Text.Encoding]::Default}else{[Text.UTF8Encoding]::new($false)}
$hertzSetupKey='Software\Microsoft\Windows\CurrentVersion\Uninstall\HertzStudioFull'
$hertzAppKey='Software\HertzStudio\Desktop'
$hertzSetupReceipt='hertz-setup.json'
$hertzUninstallerName='Uninstall-Hertz.exe'
$hertzInitialMarker='hertz-setup-incomplete.json'
$hertzRemovingMarker='hertz-uninstall-incomplete.json'
$hertzSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$hertzMenu=Join-Path ([Environment]::GetFolderPath('Programs')) 'Hertz Studio'
# Known-folder lookup follows OneDrive/redirected desktops; never guess %USERPROFILE%\Desktop.
$hertzDesktop=[Environment]::GetFolderPath('Desktop')

function Resolve-HertzSetupDirectory([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Choose a program directory.' }
    $full=[IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full -ieq [IO.Path]::GetPathRoot($full).TrimEnd('\')) { throw 'A drive root is not a program directory.' }
    $parent=$full
    while (-not (Test-Path -LiteralPath $parent)) { $parent=[IO.Path]::GetDirectoryName($parent) }
    $null=Get-HertzDirectory $parent $true
    if (Test-Path -LiteralPath $full) { return Get-HertzDirectory $full }
    return $full
}

function Get-HertzWebViewVersion {
    $client='{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
            $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
            try {
                $key=$base.OpenSubKey('SOFTWARE\Microsoft\EdgeUpdate\Clients\'+$client)
                if ($null -ne $key) {
                    try { $version=$key.GetValue('pv'); if ($version -is [string] -and $version -match '^\d+\.\d+\.\d+\.\d+$' -and [version]$version -gt [version]'0.0.0.0') { return $version } }
                    finally { $key.Dispose() }
                }
            } finally { $base.Dispose() }
        }
    }
    return $null
}

function Read-HertzSetupJson([string]$Path,[int]$MaximumBytes=16384) {
    $file=Assert-HertzFile $Path
    if ($file.Length -gt $MaximumBytes) { throw 'Setup receipt is too large.' }
    return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json)
}

function Get-HertzSetupBytesHash([byte[]]$Bytes) {
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Get-HertzSetupRegistryNames([string]$Name) {
    if($Name -ceq $hertzAppKey){return @('InstallDir')}
    return @('DisplayName','DisplayVersion','Publisher','InstallLocation','DisplayIcon','UninstallString','QuietUninstallString','NoModify','NoRepair')
}

function Remove-HertzSetupRegistry([string]$Name,[string]$Directory) {
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Name,$true)
    if($null -eq $key){return}
    $empty=$false
    try {
        $locationName=if($Name -ceq $hertzAppKey){'InstallDir'}else{'InstallLocation'}
        $location=$key.GetValue($locationName)
        if($null -ne $location -and $location -ine $Directory){throw 'Registration changed to a different installation; preserve it.'}
        foreach($valueName in @(Get-HertzSetupRegistryNames $Name)){$key.DeleteValue($valueName,$false)}
        $empty=$key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0
    } finally {$key.Dispose()}
    if($empty){[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($Name,$false)}
}

function Read-HertzSetupReceipt([string]$Directory,[bool]$RecoveredUpdate = $false) {
    $receipt=Read-HertzSetupJson (Join-Path $Directory $hertzSetupReceipt)
    if ($receipt.schemaVersion -ne 1 -or $receipt.product -cne 'hertz-studio-full' -or
        $receipt.userSid -cne $hertzSid -or $receipt.installDir -ine $Directory -or
        $receipt.uninstaller -cne $hertzUninstallerName -or $receipt.uninstallerSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'This directory does not belong to this user installation.' }
    $uninstallPath=Join-Path $Directory $hertzUninstallerName
    if (Test-Path -LiteralPath $uninstallPath) {
        $null=Assert-HertzFile $uninstallPath
        # A recovered program transaction may have stopped between replacing the
        # owned uninstaller and publishing its receipt. Only that recovery path
        # repairs the projection from this trusted installer; ordinary edits fail.
        if (-not $RecoveredUpdate -and (Get-HertzHash $uninstallPath) -cne $receipt.uninstallerSha256) { throw 'Uninstaller was changed; repair this installation first.' }
    }
    return $receipt
}

function Assert-HertzSetupMenu {
    $null=Resolve-HertzSetupDirectory $hertzMenu
}

function Assert-HertzSetupDesktop {
    $null=Resolve-HertzSetupDirectory $hertzDesktop
}

function Assert-HertzSetupRegistration([string]$Directory,[bool]$OwnedInstallation = $false) {
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($hertzSetupKey)
    if ($null -ne $key) {
        try {
            $location=$key.GetValue('InstallLocation')
            if ($null -ne $location -and $location -ine $Directory) { throw 'Another Hertz installation is registered. Use its existing location or uninstall it first.' }
            if ($null -eq $location -and -not $OwnedInstallation) {
                $managed=Get-HertzSetupRegistryNames $hertzSetupKey
                if (@($key.GetValueNames()|Where-Object {$_ -in $managed}).Count -ne 0) { throw 'Registration is incomplete. Repair its owned installation before choosing another program directory.' }
            }
        }
        finally { $key.Dispose() }
    }
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($hertzAppKey)
    if ($null -ne $key) {
        try { $existing=$key.GetValue('InstallDir'); if ($null -ne $existing -and $existing -ine $Directory) { throw 'Another Hertz program directory is already registered.' } }
        finally { $key.Dispose() }
    }
    Assert-HertzSetupMenu
    $shell=New-Object -ComObject WScript.Shell
    foreach ($pair in @(@('Hertz Studio.lnk','hertz-studio.exe'),@('Uninstall Hertz Studio.lnk',$hertzUninstallerName))) {
        $link=Join-Path $hertzMenu $pair[0]
        if (Test-Path -LiteralPath $link) {
            $null=Assert-HertzFile $link
            $shortcut=$shell.CreateShortcut($link)
            if ($shortcut.TargetPath -ine (Join-Path $Directory $pair[1])) { throw 'A shortcut belongs to another program; choose a different installation or remove that shortcut yourself.' }
        }
    }
    Assert-HertzSetupDesktop
    $link=Join-Path $hertzDesktop 'Hertz Studio.lnk'
    if (Test-Path -LiteralPath $link) {
        $null=Assert-HertzFile $link
        $shortcut=$shell.CreateShortcut($link)
        if ($shortcut.TargetPath -ine (Join-Path $Directory 'hertz-studio.exe')) { throw 'A shortcut belongs to another program; choose a different installation or remove that shortcut yourself.' }
    }
}

function Write-HertzSetupFile([string]$Path,[byte[]]$Bytes) {
    if (Test-Path -LiteralPath $Path) { $null=Assert-HertzFile $Path }
    $temporary=Join-Path ([IO.Path]::GetDirectoryName($Path)) ('.hertz-setup-file-'+[guid]::NewGuid().ToString('N'))
    try {
        $file=[IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $file.Write($Bytes,0,$Bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,[NullString]::Value) }
        else { [IO.File]::Move($temporary,$Path) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
}

function Set-HertzSetupRegistration([string]$Directory,$Manifest,[string]$UninstallSource,[bool]$OwnedInstallation = $false) {
    Assert-HertzSetupRegistration $Directory $OwnedInstallation
    $null=Assert-HertzFile $UninstallSource
    $receipt=@{schemaVersion=1;product='hertz-studio-full';userSid=$hertzSid;installDir=$Directory;
        uninstaller=$hertzUninstallerName;uninstallerSha256=Get-HertzHash $UninstallSource}
    # Publish ownership before introducing an uninstaller into a portable
    # installation. Its existing transaction/initial marker guards both writes.
    Write-HertzSetupFile (Join-Path $Directory $hertzSetupReceipt) ([Text.UTF8Encoding]::new($false).GetBytes(($receipt|ConvertTo-Json -Compress)))
    Write-HertzSetupFile (Join-Path $Directory $hertzUninstallerName) ([IO.File]::ReadAllBytes($UninstallSource))
    $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($hertzSetupKey)
    try {
        foreach ($entry in @{
            DisplayName='Hertz Studio Full';DisplayVersion=$Manifest.version;Publisher='hertz-studio contributors';
            InstallLocation=$Directory;DisplayIcon=(Join-Path $Directory 'hertz-studio.exe')+',0';
            UninstallString='"'+(Join-Path $Directory $hertzUninstallerName)+'"';
            QuietUninstallString='"'+(Join-Path $Directory $hertzUninstallerName)+'" /S'
        }.GetEnumerator()) { $key.SetValue($entry.Key,$entry.Value,[Microsoft.Win32.RegistryValueKind]::String) }
        $key.SetValue('NoModify',1,[Microsoft.Win32.RegistryValueKind]::DWord)
        $key.SetValue('NoRepair',1,[Microsoft.Win32.RegistryValueKind]::DWord)
    } finally { $key.Dispose() }
    $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($hertzAppKey)
    try { $key.SetValue('InstallDir',$Directory,[Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
    [IO.Directory]::CreateDirectory($hertzMenu)|Out-Null
    Assert-HertzSetupMenu
    $shell=New-Object -ComObject WScript.Shell
    foreach ($pair in @(@('Hertz Studio.lnk','hertz-studio.exe','--window'),@('Uninstall Hertz Studio.lnk',$hertzUninstallerName,''))) {
        $shortcut=$shell.CreateShortcut((Join-Path $hertzMenu $pair[0]))
        $shortcut.TargetPath=Join-Path $Directory $pair[1];$shortcut.Arguments=$pair[2]
        $shortcut.WorkingDirectory=$Directory;$shortcut.IconLocation=(Join-Path $Directory 'hertz-studio.exe')+',0';$shortcut.Save()
    }
    [IO.Directory]::CreateDirectory($hertzDesktop)|Out-Null
    Assert-HertzSetupDesktop
    $shortcut=$shell.CreateShortcut((Join-Path $hertzDesktop 'Hertz Studio.lnk'))
    $shortcut.TargetPath=Join-Path $Directory 'hertz-studio.exe';$shortcut.Arguments='--window'
    $shortcut.WorkingDirectory=$Directory;$shortcut.IconLocation=(Join-Path $Directory 'hertz-studio.exe')+',0';$shortcut.Save()
}

function Get-HertzSetupProjection([string]$Directory) {
    Assert-HertzSetupMenu
    Assert-HertzSetupDesktop
    $files=@{}
    foreach ($file in @((Join-Path $Directory $hertzUninstallerName),(Join-Path $Directory $hertzSetupReceipt),
        (Join-Path $hertzMenu 'Hertz Studio.lnk'),(Join-Path $hertzMenu 'Uninstall Hertz Studio.lnk'),
        (Join-Path $hertzDesktop 'Hertz Studio.lnk'))) {
        if (Test-Path -LiteralPath $file) { $null=Assert-HertzFile $file;$files[$file]=[IO.File]::ReadAllBytes($file) }
        else { $files[$file]=$null }
    }
    $keys=@{}
    foreach ($name in @($hertzSetupKey,$hertzAppKey)) {
        $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($name)
        if ($null -eq $key) { $keys[$name]=$null;continue }
        try {
            $values=@{}
            $present=$key.GetValueNames()
            foreach ($valueName in @(Get-HertzSetupRegistryNames $name)) {
                if ($present -contains $valueName) { $values[$valueName]=@{value=$key.GetValue($valueName,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);kind=$key.GetValueKind($valueName)} }
            }
            $keys[$name]=$values
        } finally { $key.Dispose() }
    }
    return @{files=$files;keys=$keys;directory=$Directory}
}

function Restore-HertzSetupProjection($Projection) {
    Assert-HertzSetupMenu
    Assert-HertzSetupDesktop
    foreach ($entry in $Projection.files.GetEnumerator()) {
        if ($null -eq $entry.Value) { if (Test-Path -LiteralPath $entry.Key) { $null=Assert-HertzFile $entry.Key;Remove-Item -LiteralPath $entry.Key } }
        else {
            if((Test-Path -LiteralPath $entry.Key) -and (Get-HertzHash $entry.Key) -ceq (Get-HertzSetupBytesHash $entry.Value)){continue}
            Write-HertzSetupFile $entry.Key $entry.Value
        }
    }
    foreach ($entry in $Projection.keys.GetEnumerator()) {
        if ($null -eq $entry.Value) { Remove-HertzSetupRegistry $entry.Key $Projection.directory;continue }
        $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($entry.Key)
        try {
            foreach ($name in @(Get-HertzSetupRegistryNames $entry.Key)) { if (-not $entry.Value.ContainsKey($name)) { $key.DeleteValue($name,$false) } }
            foreach ($value in $entry.Value.GetEnumerator()) { $key.SetValue($value.Key,$value.Value.value,$value.Value.kind) }
        } finally { $key.Dispose() }
    }
}

function Open-HertzSetupOwner([string]$Directory,[bool]$Create) {
    $carrier=Join-Path $Directory 'hertz-install.lock'
    if (Test-Path -LiteralPath $carrier) { $null=Assert-HertzFile $carrier }
    $exists=Test-Path -LiteralPath $carrier
    try { $owner=[IO.FileStream]::new($carrier,$(if($Create -and -not $exists){[IO.FileMode]::CreateNew}else{[IO.FileMode]::Open}),$(if($exists){[IO.FileAccess]::Read}else{[IO.FileAccess]::ReadWrite}),[IO.FileShare]::None) }
    catch { throw 'install_dir_busy: Close all Hertz players/adapters using this program directory and wait for any current installation.' }
    if ($owner.Length -ne 0) { $owner.Dispose();throw 'Invalid installation carrier.' }
    return $owner
}

function Invoke-HertzSetupInstall([string]$Directory,[string]$Source,[string]$UninstallSource,[bool]$Development) {
    $runtime=Get-HertzWebViewVersion
    if ($null -eq $runtime) { throw 'webview2_required: Install Microsoft Edge WebView2 Evergreen Runtime from https://developer.microsoft.com/microsoft-edge/webview2/ and run this installer again.' }
    $installation=Resolve-HertzSetupDirectory $Directory
    Assert-HertzSetupMenu
    Assert-HertzSetupDesktop
    $sourcePath=Get-HertzDirectory $Source
    if ($sourcePath -ieq $installation -or $sourcePath.StartsWith($installation+'\',[StringComparison]::OrdinalIgnoreCase) -or $installation.StartsWith($sourcePath+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Package and installation must be separate non-nested directories.' }
    $candidate=Read-HertzPackage $sourcePath $Development
    Assert-HertzExecutable $sourcePath $candidate.Manifest
    $null=Assert-HertzFile $UninstallSource
    $marker=Join-Path $installation $hertzInitialMarker
    if (Test-Path -LiteralPath (Join-Path $installation $hertzRemovingMarker)) { $null=Invoke-HertzSetupUninstall $installation $Development }
    if (Test-Path -LiteralPath (Join-Path $installation 'hertz-update-incomplete.json')) {
        # The updater invokes this only after verifying/restoring its backup,
        # while its writer and recovery marker still protect every projection
        # write. A failed repair keeps that marker and backup for the next retry.
        $repairProjection={param($manifest,$target)
            $owned=Test-Path -LiteralPath (Join-Path $target $hertzSetupReceipt)
            if ($owned) { $null=Read-HertzSetupReceipt $target $true }
            elseif (Test-Path -LiteralPath (Join-Path $target $hertzUninstallerName)) { throw 'An uninstaller already exists without an owned setup receipt.' }
            Set-HertzSetupRegistration $target $manifest $UninstallSource $owned
        }.GetNewClosure()
        $null=Invoke-HertzPackageUpdate $installation $null $true $Development $repairProjection
    }
    if ((Test-Path -LiteralPath (Join-Path $installation 'standalone-build.json')) -and -not (Test-Path -LiteralPath $marker)) {
        $ownsSetup=Test-Path -LiteralPath (Join-Path $installation $hertzSetupReceipt)
        if ($ownsSetup) { $null=Read-HertzSetupReceipt $installation }
        elseif ((Test-Path -LiteralPath (Join-Path $installation $hertzUninstallerName))) { throw 'An uninstaller already exists without an owned setup receipt.' }
        Assert-HertzSetupRegistration $installation $ownsSetup
        $projection=Get-HertzSetupProjection $installation
        $callback={param($manifest,$target)
            try { Set-HertzSetupRegistration $target $manifest $UninstallSource $ownsSetup }
            catch { $setupFailure=$_;Restore-HertzSetupProjection $projection;throw $setupFailure }
        }.GetNewClosure()
        $null=Invoke-HertzPackageUpdate $installation $sourcePath $false $Development $callback
        return @{status='updated';installDir=$installation;version=$candidate.Manifest.version;webview2=$runtime}
    }
    if (-not (Test-Path -LiteralPath $marker)) { Assert-HertzSetupRegistration $installation }
    [IO.Directory]::CreateDirectory($installation)|Out-Null
    $installation=Get-HertzDirectory $installation
    $owner=Open-HertzSetupOwner $installation $true
    try {
        $manifestHash=Get-HertzHash (Join-Path $sourcePath 'standalone-build.json')
        $uninstallerHash=Get-HertzHash $UninstallSource
        if (Test-Path -LiteralPath $marker) {
            $pending=Read-HertzSetupJson $marker
            if ($pending.schemaVersion -ne 1 -or $pending.product -cne 'hertz-studio-full' -or $pending.userSid -cne $hertzSid -or
                $pending.installDir -ine $installation -or $pending.manifestSha256 -cne $manifestHash -or $pending.uninstallerSha256 -cne $uninstallerHash) { throw 'Initial installation is incomplete. Retry the same installer to finish it.' }
            Assert-HertzSetupRegistration $installation $true
        } else {
            foreach ($name in @($candidate.Names)+@($hertzSetupReceipt,$hertzUninstallerName,'hertz-update-incomplete.json')) {
                if (Test-Path -LiteralPath (Join-Path $installation $name)) { throw "A file already exists in the chosen program directory: $name" }
            }
            $pending=@{schemaVersion=1;product='hertz-studio-full';userSid=$hertzSid;installDir=$installation;manifestSha256=$manifestHash;uninstallerSha256=$uninstallerHash}
            Write-HertzSetupFile $marker ([Text.UTF8Encoding]::new($false).GetBytes(($pending|ConvertTo-Json -Compress)))
        }
        foreach ($name in $candidate.Names) {
            $destination=Join-Path $installation $name
            if (Test-Path -LiteralPath $destination) { $null=Assert-HertzFile $destination }
            [IO.File]::Copy((Join-Path $sourcePath $name),$destination,$true)
        }
        $null=Read-HertzPackage $installation $Development $true
        if ((Get-HertzHash (Join-Path $installation 'standalone-build.json')) -cne $manifestHash) { throw 'Package changed during initial installation.' }
        Set-HertzSetupRegistration $installation $candidate.Manifest $UninstallSource $true
        Remove-Item -LiteralPath $marker
        return @{status='installed';installDir=$installation;version=$candidate.Manifest.version;webview2=$runtime}
    } finally { $owner.Dispose() }
}

function Invoke-HertzSetupUninstall([string]$Directory,[bool]$Development) {
    $installation=Get-HertzDirectory $Directory
    Assert-HertzSetupMenu
    Assert-HertzSetupDesktop
    if ((Test-Path -LiteralPath (Join-Path $installation $hertzInitialMarker)) -or (Test-Path -LiteralPath (Join-Path $installation 'hertz-update-incomplete.json'))) { throw 'Installation/update is incomplete. Run its installer or recovery before uninstalling.' }
    $owner=Open-HertzSetupOwner $installation $false
    try {
        $marker=Join-Path $installation $hertzRemovingMarker
        $pending=$null
        $restoreFiles=@()
        if(Test-Path -LiteralPath $marker){
            $pending=Read-HertzSetupJson $marker 1048576
            if($pending.schemaVersion -ne 1 -or $pending.product -cne 'hertz-studio-full' -or $pending.userSid -cne $hertzSid -or $pending.installDir -ine $installation){throw 'Invalid uninstallation marker; preserve it for recovery.'}
            foreach($pair in @(@('standalone-build.json','manifestBase64','manifestSha256'),@($hertzSetupReceipt,'receiptBase64','receiptSha256'))){
                $bytes=[Convert]::FromBase64String($pending.($pair[1]))
                if($bytes.Length -gt 524288 -or (Get-HertzSetupBytesHash $bytes) -cne $pending.($pair[2])){throw 'Uninstallation recovery metadata is invalid.'}
                $file=Join-Path $installation $pair[0]
                if(Test-Path -LiteralPath $file){$null=Assert-HertzFile $file;if((Get-HertzHash $file) -cne $pending.($pair[2])){throw 'Uninstallation recovery metadata was changed.'}}
                else{$restoreFiles+=@{path=$file;bytes=$bytes}}
            }
        }
        Assert-HertzSetupRegistration $installation ($null -ne $pending)
        foreach($restoreFile in $restoreFiles){Write-HertzSetupFile $restoreFile.path $restoreFile.bytes}
        $null=Read-HertzSetupReceipt $installation
        $package=Read-HertzPackage $installation $Development $true $true
        $names=@($package.Names|Where-Object {$_ -cne 'standalone-build.json'})
        $probes=@()
        try {
            foreach ($name in $names+@($hertzUninstallerName)) { $file=Join-Path $installation $name;if(Test-Path -LiteralPath $file){$null=Assert-HertzFile $file;$probes+=[IO.FileStream]::new($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)} }
        } finally { foreach($probe in $probes){$probe.Dispose()} }
        $manifestBytes=[IO.File]::ReadAllBytes((Join-Path $installation 'standalone-build.json'))
        $receiptBytes=[IO.File]::ReadAllBytes((Join-Path $installation $hertzSetupReceipt))
        $pending=@{schemaVersion=1;product='hertz-studio-full';userSid=$hertzSid;installDir=$installation;
            manifestBase64=[Convert]::ToBase64String($manifestBytes);manifestSha256=Get-HertzSetupBytesHash $manifestBytes;
            receiptBase64=[Convert]::ToBase64String($receiptBytes);receiptSha256=Get-HertzSetupBytesHash $receiptBytes}
        Write-HertzSetupFile $marker ([Text.UTF8Encoding]::new($false).GetBytes(($pending|ConvertTo-Json -Compress)))
        foreach ($name in $names) { $file=Join-Path $installation $name;if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file} }
        Assert-HertzSetupMenu
        foreach ($name in @('Hertz Studio.lnk','Uninstall Hertz Studio.lnk')) { $file=Join-Path $hertzMenu $name;if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file} }
        if ((Test-Path -LiteralPath $hertzMenu) -and @(Get-ChildItem -LiteralPath $hertzMenu -Force).Count -eq 0) { Remove-Item -LiteralPath $hertzMenu }
        Assert-HertzSetupDesktop
        $file=Join-Path $hertzDesktop 'Hertz Studio.lnk';if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file}
        Remove-HertzSetupRegistry $hertzSetupKey $installation
        Remove-HertzSetupRegistry $hertzAppKey $installation
        foreach ($name in @('standalone-build.json',$hertzSetupReceipt)) { Remove-Item -LiteralPath (Join-Path $installation $name) }
        $uninstallFile=Join-Path $installation $hertzUninstallerName
        if(Test-Path -LiteralPath $uninstallFile){Remove-Item -LiteralPath $uninstallFile}
        Remove-Item -LiteralPath $marker
        return @{status='uninstalled';installDir=$installation;dataPreserved=$true}
    } finally { $owner.Dispose() }
}

if ($MyInvocation.InvocationName -ne '.') {
    switch ($Action) {
        'Inspect' { @{webview2=Get-HertzWebViewVersion;dataDir=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'hertz-studio'}|ConvertTo-Json -Compress }
        'Install' { Invoke-HertzSetupInstall $InstallDir $PackageDir $Uninstaller ([bool]$AllowDebug)|ConvertTo-Json -Compress }
        'Uninstall' { Invoke-HertzSetupUninstall $InstallDir ([bool]$AllowDebug)|ConvertTo-Json -Compress }
    }
}
