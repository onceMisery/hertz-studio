#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real NSIS current-user installation in owned output paths, after implementation.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const os=require('node:os');
const {spawn,execFileSync}=require('node:child_process');
const {packageStandalone}=require('./package-standalone-windows');
const root=path.resolve(__dirname,'..');
const binary=path.resolve(process.env.HERTZ_BIN||path.join(root,'target/release/hertz-studio.exe'));
const installer=process.env.HERTZ_INSTALLER;
const output=path.join(root,'output/nsis-installer-native-'+Date.now());
const install=path.join(output,"安装 & player's $ space");
const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const checks=[],owned=new Set();
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const mark=message=>{checks.push(message);console.log('PASS '+message);};
let installerManifest,portable;
async function until(read,label,timeout=30000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await read();if(value)return value;await delay(100);}throw Error('Timed out: '+label);}
function command(script,env={}){return execFileSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command','[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ErrorActionPreference="Stop"; '+script],{encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,...env},stdio:['pipe','pipe','pipe']}).trim();}
function child(file,args,extra={},verbatim=false){const processChild=spawn(file,args,{cwd:output,windowsHide:true,windowsVerbatimArguments:verbatim,stdio:['ignore','pipe','pipe'],env:{...process.env,VMUSIC_BACKEND:'null',VMUSIC_SECRETS:'memory',VMUSIC_LOG:'error',HERTZ_DESKTOP_CONFIG_DIR:path.join(output,'desktop'),...extra}});owned.add(processChild);processChild.out='';processChild.err='';processChild.stdout.on('data',chunk=>processChild.out+=chunk);processChild.stderr.on('data',chunk=>processChild.err+=chunk);processChild.on('error',error=>processChild.failure=error);return processChild;}
async function exited(processChild,timeout=90000){await until(()=>{if(processChild.failure)throw processChild.failure;return processChild.exitCode!==null||processChild.signalCode!==null;},'owned process exit',timeout);owned.delete(processChild);return processChild.exitCode;}
async function setupResult(action,target,started){
  return until(()=>{
    for(const name of fs.readdirSync(os.tmpdir()).filter(name=>/^Hertz-Setup-\d+-\d+\.log$/.test(name))){
      const file=path.join(os.tmpdir(),name);if(fs.statSync(file).mtimeMs<started)continue;
      const text=fs.readFileSync(file).toString('utf16le').replace(/^\uFEFF/,'');
      const lines=text.split(/\r?\n/);if(lines[0]!=='Action:'+action||lines[1].slice('InstallDir:'.length).toLowerCase()!==target.toLowerCase())continue;
      if(!lines[2]?.startsWith('Exit:'))continue;
      const diagnostic=path.join(output,name);fs.copyFileSync(file,diagnostic);
      return {code:Number(lines[2].slice(5)),text,diagnostic};
    }return null;
  },'actual NSIS '+action+' completion receipt',90000);
}
async function setup(expected=0,target=install){
  // NSIS requires /D as an unquoted final command-line remainder, including spaces.
  const started=Date.now();const processChild=child(installer,['/S','/D='+target],{},true);
  const code=await exited(processChild);const result=await setupResult('Install',target,started);
  assert.equal(result.code,expected,result.text);assert.equal(code,expected,processChild.err||'NSIS installation exit');
}
async function uninstall(target=install,expected=0){const started=Date.now();const processChild=child(path.join(target,'Uninstall-Hertz.exe'),['/S']);await exited(processChild);const result=await setupResult('Uninstall',target,started);assert.equal(result.code,expected,result.text);if(expected===0)await until(()=>!fs.existsSync(path.join(target,'hertz-setup.json')),'real uninstaller finishes');}
function registration(){return JSON.parse(command('$a=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\HertzStudioFull"); $b=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\HertzStudio\\Desktop"); try { @{ uninstallKey=($null-ne $a);appKey=($null-ne $b);location=$(if($a){$a.GetValue("InstallLocation")});version=$(if($a){$a.GetValue("DisplayVersion")});appDir=$(if($b){$b.GetValue("InstallDir")});menu=[Environment]::GetFolderPath("Programs") }|ConvertTo-Json -Compress } finally { if($a){$a.Dispose()};if($b){$b.Dispose()} }'));}
function snapshot(directory){return Object.fromEntries(fs.readdirSync(directory).sort().filter(name=>fs.statSync(path.join(directory,name)).isFile()).map(name=>[name,sha(path.join(directory,name))]));}
function snapshotTree(directory){const result={};const visit=current=>{for(const entry of fs.readdirSync(current,{withFileTypes:true})){const full=path.join(current,entry.name);if(entry.isDirectory())visit(full);else if(entry.isFile())result[path.relative(directory,full)]=sha(full);}};visit(directory);return result;}
async function service(data,target=install){const processChild=child(path.join(target,'hertz-studio.exe'),['--bind','127.0.0.1','--port','0','--data-dir',data]);const discovery=await until(()=>{assert.equal(processChild.exitCode,null,processChild.err);try{const value=JSON.parse(fs.readFileSync(path.join(data,'vmusicd.json'),'utf8'));return value.pid===processChild.pid&&value;}catch{return null;}},'installed real service',60000);return {processChild,discovery,data};}
async function shutdown(live){const response=await fetch('http://127.0.0.1:'+live.discovery.port+'/v1/system/shutdown',{method:'POST',headers:{Authorization:'Bearer '+live.discovery.token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(12000)});assert.ok([200,202].includes(response.status));assert.equal(await exited(live.processChild),0,live.processChild.err);}
function injected(script,target,extra={}){return command('. $env:HERTZ_SETUP_HELPER -InstallDir $env:HERTZ_SETUP_TARGET; '+script,{HERTZ_SETUP_HELPER:path.join(output,'helper/Install-Hertz.ps1'),HERTZ_SETUP_TARGET:target,HERTZ_SETUP_PACKAGE:path.join(output,'package'),HERTZ_SETUP_UNINSTALL:path.join(output,'owned-uninstaller.exe'),...extra});}
function rejection(action,pattern){let failure;try{action();}catch(error){failure=error;}assert(failure,'Expected setup rejection');assert.match(String(failure.stderr||failure.message),pattern);}

async function main(){
  assert.equal(process.platform,'win32');assert(installer&&fs.existsSync(installer),'Supply HERTZ_INSTALLER with the final compiled candidate.');
  fs.mkdirSync(output,{recursive:true});
  installerManifest=JSON.parse(fs.readFileSync(installer+'.json','utf8'));
  assert.equal(sha(installer),installerManifest.installerSha256);
  assert.equal(sha(binary),installerManifest.package.files['hertz-studio.exe'].sha256);
  for(const[file,hash]of Object.entries(installerManifest.sourceSha256))assert.equal(sha(path.join(root,file)),hash,'current compiled installer source: '+file);
  const before=registration();assert.equal(before.uninstallKey,false,'Preserve existing user installation');assert.equal(before.appKey,false,'Preserve existing user app registration');
  for(const name of ['Hertz Studio.lnk','Uninstall Hertz Studio.lnk'])assert(!fs.existsSync(path.join(before.menu,'Hertz Studio',name)),'Preserve existing user shortcuts');
  mark('actual unsigned NSIS candidate and Full/native release payload match current source identities; original registration is absent');
  portable=packageStandalone(binary,path.join(output,'packages'));
  command('Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:HERTZ_TEST_ZIP,$env:HERTZ_TEST_PACKAGE)',{HERTZ_TEST_ZIP:portable.archive,HERTZ_TEST_PACKAGE:path.join(output,'package')});
}

async function checksAfterPackage(){
  const helper=path.join(output,'helper');fs.mkdirSync(helper);
  fs.copyFileSync(path.join(root,'scripts/windows/Install-Hertz.ps1'),path.join(helper,'Install-Hertz.ps1'));
  fs.copyFileSync(path.join(root,'scripts/windows/Update-Hertz.ps1'),path.join(helper,'PackageOwner.ps1'));
  fs.mkdirSync(install);fs.writeFileSync(path.join(install,'user-kept.txt'),'Keep this user file.');
  await setup();
  let current=registration();assert.equal(current.location.toLowerCase(),install.toLowerCase());assert.equal(current.appDir.toLowerCase(),install.toLowerCase());
  assert.equal(current.version,installerManifest.package.version);
  assert(!fs.existsSync(path.join(install,'hertz-setup-incomplete.json')));
  const links=JSON.parse(command('$s=New-Object -ComObject WScript.Shell; @{target=$s.CreateShortcut((Join-Path $env:HERTZ_TEST_MENU "Hertz Studio.lnk")).TargetPath;arguments=$s.CreateShortcut((Join-Path $env:HERTZ_TEST_MENU "Hertz Studio.lnk")).Arguments}|ConvertTo-Json -Compress',{HERTZ_TEST_MENU:path.join(current.menu,'Hertz Studio')}));
  assert.equal(links.target.toLowerCase(),path.join(install,'hertz-studio.exe').toLowerCase());assert.equal(links.arguments,'--window');
  fs.copyFileSync(path.join(install,'Uninstall-Hertz.exe'),path.join(output,'owned-uninstaller.exe'));
  const initial=snapshot(install);
  mark('real silent current-user installation preserves an extra file and correctly registers Chinese/space/ampersand/apostrophe/dollar paths and startup shortcut');

  const a=await service(path.join(output,'profile A')),b=await service(path.join(output,'profile B'));
  await setup(1);assert.deepEqual(snapshot(install),initial);
  await uninstall(install,1);assert.deepEqual(snapshot(install),initial);assert.equal(registration().location.toLowerCase(),install.toLowerCase());
  await shutdown(a);await setup(1);await shutdown(b);
  mark('two real installed profiles prevent installation/update/uninstallation; the remaining profile continues to block after the first exits');
  await setup();assert(!fs.existsSync(path.join(install,'hertz-update-incomplete.json')));
  const afterUpdate=snapshot(install);assert.equal(afterUpdate['hertz-studio.exe'],initial['hertz-studio.exe']);assert.equal(afterUpdate['user-kept.txt'],initial['user-kept.txt']);
  const live=await service(path.join(output,'profile A'));await shutdown(live);
  mark('same-directory NSIS reinstallation runs the original guarded updater and the installed player still starts and exits normally');

  const fixtureCandidate=path.join(output,'package');
  fs.appendFileSync(path.join(fixtureCandidate,'NOTICE'),'\nNSIS rollback fixture.\n');
  const candidateManifest=JSON.parse(fs.readFileSync(path.join(fixtureCandidate,'standalone-build.json'),'utf8'));
  candidateManifest.files.NOTICE={size:fs.statSync(path.join(fixtureCandidate,'NOTICE')).size,sha256:sha(path.join(fixtureCandidate,'NOTICE'))};
  fs.writeFileSync(path.join(fixtureCandidate,'standalone-build.json'),JSON.stringify(candidateManifest,null,2));
  rejection(()=>injected('$savedSet=(Get-Item function:Set-HertzSetupRegistration).ScriptBlock; function Set-HertzSetupRegistration($Directory,$Manifest,$UninstallSource){&$savedSet $Directory $Manifest $UninstallSource;throw "fixture-registration-failure"}; Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',install),/fixture-registration-failure/);
  assert.deepEqual(snapshot(install),afterUpdate);assert.equal(registration().location.toLowerCase(),install.toLowerCase());
  mark('a commit-callback registration failure restores original program files, uninstaller, receipt, registry and shortcut projections');
  const profilesBeforeRemoval=[snapshotTree(a.data),snapshotTree(b.data)];
  await uninstall();assert(!registration().uninstallKey);assert(!registration().appKey);assert.equal(fs.readFileSync(path.join(install,'user-kept.txt'),'utf8'),'Keep this user file.');
  assert.deepEqual(snapshotTree(a.data),profilesBeforeRemoval[0]);assert.deepEqual(snapshotTree(b.data),profilesBeforeRemoval[1]);
  mark('real NSIS uninstallation removes only owned program/registration/shortcut artifacts and preserves both profiles and extra files');

  const absent=path.join(output,'runtime-missing');
  rejection(()=>injected('function Get-HertzWebViewVersion{return $null}; Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',absent),/webview2_required/);
  assert(!fs.existsSync(absent));assert(!registration().uninstallKey);
  mark('missing-WebView2 failure injection refuses before creating a program directory or user registration');
  const partial=path.join(output,'initial-registration-failure');
  rejection(()=>injected('function Set-HertzSetupRegistration{throw "fixture-initial-registration-failure"}; Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',partial),/fixture-initial-registration-failure/);
  assert(fs.existsSync(path.join(partial,'hertz-setup-incomplete.json')));
  const blockedData=path.join(output,'blocked-initial-data');
  const blocked=child(path.join(partial,'hertz-studio.exe'),['--bind','127.0.0.1','--port','0','--data-dir',blockedData]);assert.notEqual(await exited(blocked),0);assert.match(blocked.err,/install_recovery_required/);assert(!fs.existsSync(blockedData));
  injected('Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',partial);
  assert(!fs.existsSync(path.join(partial,'hertz-setup-incomplete.json')));assert.equal(registration().location.toLowerCase(),partial.toLowerCase());
  await uninstall(partial);
  mark('initial registration failure retains a recoverable marker; actual native startup rejects it before DataDir creation, and the same installer payload resumes registration');
  await setup();await uninstall();assert.equal(fs.readFileSync(path.join(install,'user-kept.txt'),'utf8'),'Keep this user file.');
  assert(!registration().uninstallKey);assert(!registration().appKey);
  mark('installation after removal works in the original directory while preserving its retained user file');
  await reviewedBoundaryChecks();
  for(const[file,hash]of Object.entries(installerManifest.sourceSha256))assert.equal(sha(path.join(root,file)),hash);
  assert.equal(sha(installer),installerManifest.installerSha256);assert.equal(sha(binary),installerManifest.package.files['hertz-studio.exe'].sha256);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:true,checks,installer,installerSha256:sha(installer),binary,binarySha256:sha(binary),sourceSha256:installerManifest.sourceSha256,signatureStatus:installerManifest.signatureStatus,qualificationScope:'actual current-user NSIS install/update/uninstall on one existing Windows11/WebView2 host, null audio and controlled failure injection; no signing/remote update/clean OS or physical power-loss qualification'},null,2));
  console.log(output);
}

async function reviewedBoundaryChecks(){
  const readUnknown=()=>JSON.parse(injected('$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($hertzSetupKey);$s=$k.OpenSubKey("HertzFixtureChild");try{@{value=$k.GetValue("HertzFixtureUnknown");child=$s.GetValue("Owner")}|ConvertTo-Json -Compress}finally{$s.Dispose();$k.Dispose()}',install));
  await setup();
  injected('$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($hertzSetupKey,$true);try{$k.SetValue("HertzFixtureUnknown","before-failure")}finally{$k.Dispose()};$s=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($hertzSetupKey+"\\HertzFixtureChild");try{$s.SetValue("Owner",$env:HERTZ_FIXTURE_OWNER)}finally{$s.Dispose()}',install,{HERTZ_FIXTURE_OWNER:output});
  const beforeRollback=snapshot(install);
  rejection(()=>injected('$originalSetter=(Get-Item function:Set-HertzSetupRegistration).ScriptBlock;function Set-HertzSetupRegistration($Directory,$Manifest,$UninstallSource,$OwnedInstallation){&$originalSetter $Directory $Manifest $UninstallSource $OwnedInstallation;$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($hertzSetupKey,$true);try{$k.SetValue("HertzFixtureUnknown","after-failure")}finally{$k.Dispose()};throw "fixture-unknown-projection-failure"};Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',install),/fixture-unknown-projection-failure/);
  assert.deepEqual(snapshot(install),beforeRollback);assert.deepEqual(readUnknown(),{value:'after-failure',child:output});
  await uninstall();assert(registration().uninstallKey);assert.equal(registration().location,null);assert(!registration().appKey);assert.deepEqual(readUnknown(),{value:'after-failure',child:output});
  await setup();assert.deepEqual(readUnknown(),{value:'after-failure',child:output});await uninstall();assert.deepEqual(readUnknown(),{value:'after-failure',child:output});
  injected('$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($hertzSetupKey,$true);$s=$k.OpenSubKey("HertzFixtureChild",$true);try{if($k.GetValue("HertzFixtureUnknown") -cne "after-failure" -or $s.GetValue("Owner") -cne $env:HERTZ_FIXTURE_OWNER -or $s.ValueCount -ne 1 -or $s.SubKeyCount -ne 0){throw "Preserve changed fixture registry state"};$s.DeleteValue("Owner");$k.DeleteValue("HertzFixtureUnknown")}finally{$s.Dispose();$k.Dispose()};$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($hertzSetupKey,$true);try{$k.DeleteSubKey("HertzFixtureChild",$false)}finally{$k.Dispose()};Remove-HertzSetupRegistry $hertzSetupKey $InstallDir',install,{HERTZ_FIXTURE_OWNER:output});
  assert(!registration().uninstallKey);
  mark('rollback preserves later unknown registry changes, and uninstall/reinstall preserves unknown values and subkeys without treating them as another installation');

  const unowned=path.join(output,'unowned-partial-registration');
  injected('$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($hertzSetupKey);try{$k.SetValue("DisplayName","fixture-unowned")}finally{$k.Dispose()}',unowned);
  rejection(()=>injected('Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',unowned),/Registration is incomplete/);
  assert(!fs.existsSync(unowned));
  injected('Remove-HertzSetupRegistry $hertzSetupKey $InstallDir',unowned);
  assert(!registration().uninstallKey);
  mark('known partial registration without an owned receipt or valid pending marker rejects before creating the requested directory');

  const partial=path.join(output,'partial-known-registration');
  rejection(()=>injected('function Set-HertzSetupRegistration{$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($hertzSetupKey);try{$k.SetValue("DisplayName","fixture-partial")}finally{$k.Dispose()};throw "fixture-partial-registration"};Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',partial),/fixture-partial-registration/);
  const marker=path.join(partial,'hertz-setup-incomplete.json'),markerBytes=fs.readFileSync(marker);
  const invalid=JSON.parse(markerBytes.toString('utf8'));invalid.userSid='S-1-0-0';fs.writeFileSync(marker,JSON.stringify(invalid));const invalidSnapshot=snapshot(partial);
  rejection(()=>injected('Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',partial),/Initial installation is incomplete/);
  assert.deepEqual(snapshot(partial),invalidSnapshot);fs.writeFileSync(marker,markerBytes);
  injected('Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',partial);
  assert(!fs.existsSync(marker));assert.equal(registration().location.toLowerCase(),partial.toLowerCase());
  await shutdown(await service(path.join(output,'partial-restored-profile'),partial));await uninstall(partial);
  mark('a valid initial marker repairs partially written known registry fields; a mismatched user marker cannot admit or overwrite them');

  await setup();
  rejection(()=>injected('function Remove-HertzSetupRegistry($RegistryPath,$ProgramDirectory){$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RegistryPath,$true);try{$k.DeleteValue("InstallLocation",$false)}finally{$k.Dispose()};throw "fixture-removal-after-location"};Invoke-HertzSetupUninstall $InstallDir $false',install),/fixture-removal-after-location/);
  assert(fs.existsSync(path.join(install,'hertz-uninstall-incomplete.json')));assert.equal(registration().location,null);
  fs.copyFileSync(binary,path.join(install,'hertz-studio.exe'));
  const removalData=path.join(output,'blocked-removal-data');
  const removed=child(path.join(install,'hertz-studio.exe'),['--bind','127.0.0.1','--port','0','--data-dir',removalData]);assert.notEqual(await exited(removed),0);assert.match(removed.err,/install_recovery_required/);assert(!fs.existsSync(removalData));
  await uninstall();assert(!registration().uninstallKey);assert(!registration().appKey);assert(!fs.existsSync(path.join(install,'hertz-uninstall-incomplete.json')));
  mark('partial removal after deleting InstallLocation retains its owned marker, blocks actual startup, and the real NSIS uninstaller resumes safely');

  await setup();
  const uninstallFile=path.join(install,'Uninstall-Hertz.exe');fs.appendFileSync(uninstallFile,Buffer.from([0]));const edited=snapshot(install);
  rejection(()=>injected('Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',install),/Uninstaller was changed/);assert.deepEqual(snapshot(install),edited);
  fs.copyFileSync(path.join(output,'owned-uninstaller.exe'),uninstallFile);
  let crash;
  try{injected('function Set-HertzSetupRegistration($Directory,$Manifest,$UninstallSource,$OwnedInstallation){$bytes=[IO.File]::ReadAllBytes($UninstallSource);Write-HertzSetupFile (Join-Path $Directory $hertzUninstallerName) ($bytes+[byte]0);[Environment]::Exit(47)};Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',install);}catch(error){crash=error;}
  assert.equal(crash?.status,47);assert(fs.existsSync(path.join(install,'hertz-update-incomplete.json')));
  injected('Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',install);
  assert(!fs.existsSync(path.join(install,'hertz-update-incomplete.json')));assert.equal(sha(uninstallFile),sha(path.join(output,'owned-uninstaller.exe')));
  await shutdown(await service(path.join(output,'update-restored-profile')));await uninstall();
  mark('ordinary uninstaller edits reject; a real precommit process exit recovers the original program before repairing the interrupted uninstaller projection');

  await setup();
  let missingManifestCrash;
  try{injected('$originalMove=(Get-Item function:Move-HertzInstallFile).ScriptBlock;function Move-HertzInstallFile($Source,$Destination){&$originalMove $Source $Destination;if($Source -ieq (Join-Path $InstallDir "standalone-build.json")){[Environment]::Exit(48)}};Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',install);}catch(error){missingManifestCrash=error;}
  assert.equal(missingManifestCrash?.status,48);assert(fs.existsSync(path.join(install,'hertz-update-incomplete.json')));assert(!fs.existsSync(path.join(install,'standalone-build.json')));
  injected('Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',install);
  assert(!fs.existsSync(path.join(install,'hertz-update-incomplete.json')));assert.equal(sha(path.join(install,'NOTICE')),sha(path.join(output,'package/NOTICE')));
  await shutdown(await service(path.join(output,'missing-manifest-restored-profile')));await uninstall();
  mark('a real exit between moving the old manifest and installing its replacement resumes recovery from the retained marker before choosing the installation path');

  await setup();const beforeRepair=snapshot(install);
  let interruptedProjection;
  try{injected('function Set-HertzSetupRegistration($Directory,$Manifest,$UninstallSource,$OwnedInstallation){$bytes=[IO.File]::ReadAllBytes($UninstallSource);Write-HertzSetupFile (Join-Path $Directory $hertzUninstallerName) ($bytes+[byte]0);[Environment]::Exit(47)};Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',install);}catch(error){interruptedProjection=error;}
  assert.equal(interruptedProjection?.status,47);
  const repairReady=path.join(output,'projection-lock.ready'),repairRelease=path.join(output,'projection-lock.release');
  const projectionLock=child(ps,['-NoProfile','-NonInteractive','-Command','$ErrorActionPreference="Stop";$handle=[IO.FileStream]::new($env:HERTZ_FIXTURE_LOCKED,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[IO.File]::WriteAllText($env:HERTZ_FIXTURE_READY,"ready");while(-not (Test-Path -LiteralPath $env:HERTZ_FIXTURE_RELEASE)){Start-Sleep -Milliseconds 100}}finally{$handle.Dispose()}'],{HERTZ_FIXTURE_LOCKED:uninstallFile,HERTZ_FIXTURE_READY:repairReady,HERTZ_FIXTURE_RELEASE:repairRelease});
  await until(()=>fs.existsSync(repairReady),'owned projection lock');
  rejection(()=>injected('Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',install),/Replace|使用|访问|access|process/i);
  assert(fs.existsSync(path.join(install,'hertz-update-incomplete.json')));assert.equal(sha(path.join(install,'standalone-build.json')),beforeRepair['standalone-build.json']);
  const repairBlockedData=path.join(output,'blocked-projection-repair-data');
  const repairBlocked=child(path.join(install,'hertz-studio.exe'),['--bind','127.0.0.1','--port','0','--data-dir',repairBlockedData]);assert.notEqual(await exited(repairBlocked),0);assert.match(repairBlocked.err,/install_recovery_required/);assert(!fs.existsSync(repairBlockedData));
  fs.writeFileSync(repairRelease,'release');assert.equal(await exited(projectionLock),0,projectionLock.err);
  injected('Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',install);
  assert(!fs.existsSync(path.join(install,'hertz-update-incomplete.json')));assert.equal(sha(uninstallFile),sha(path.join(output,'owned-uninstaller.exe')));
  await shutdown(await service(path.join(output,'projection-retried-profile')));await uninstall();
  mark('a locked uninstaller after program recovery retains the marker and backup, blocks actual startup, and retries projection repair successfully after release');

  for(const name of fs.readdirSync(path.join(output,'package')))fs.copyFileSync(path.join(output,'package',name),path.join(install,name));
  let portableReceiptCrash;
  try{injected('$originalWriter=(Get-Item function:Write-HertzSetupFile).ScriptBlock;function Write-HertzSetupFile($Path,$Bytes){&$originalWriter $Path $Bytes;if($Path -ieq (Join-Path $InstallDir $hertzSetupReceipt)){[Environment]::Exit(49)}};Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',install);}catch(error){portableReceiptCrash=error;}
  assert.equal(portableReceiptCrash?.status,49);assert(fs.existsSync(path.join(install,'hertz-setup.json')));assert(!fs.existsSync(uninstallFile));assert(fs.existsSync(path.join(install,'hertz-update-incomplete.json')));
  injected('Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',install);
  assert(!fs.existsSync(path.join(install,'hertz-update-incomplete.json')));assert.equal(sha(uninstallFile),sha(path.join(output,'owned-uninstaller.exe')));assert.equal(registration().location.toLowerCase(),install.toLowerCase());
  await shutdown(await service(path.join(output,'portable-adopted-profile')));await uninstall();
  mark('portable adoption interrupted after publishing ownership and before writing the uninstaller recovers through the same program transaction and completes actual NSIS uninstall');

  const menuTarget=path.join(output,'menu-target'),menuLink=path.join(output,'menu-junction'),rejected=path.join(output,'menu-reparse-install');
  fs.mkdirSync(menuTarget);fs.writeFileSync(path.join(menuTarget,'keep.txt'),'Preserve junction target.');fs.symlinkSync(menuTarget,menuLink,'junction');const targetBefore=snapshotTree(menuTarget);
  for(const location of [menuLink,path.join(menuLink,'nested')]){
    rejection(()=>injected('$hertzMenu=$env:HERTZ_TEST_MENU;Invoke-HertzSetupInstall $InstallDir $env:HERTZ_SETUP_PACKAGE $env:HERTZ_SETUP_UNINSTALL $false',rejected,{HERTZ_TEST_MENU:location}),/Reparse-point/);
    assert(!fs.existsSync(rejected));assert.deepEqual(snapshotTree(menuTarget),targetBefore);
    rejection(()=>injected('$hertzMenu=$env:HERTZ_TEST_MENU;Get-HertzSetupProjection $InstallDir',install,{HERTZ_TEST_MENU:location}),/Reparse-point/);
  }
  await setup();const installedBefore=snapshot(install);
  rejection(()=>injected('$hertzMenu=$env:HERTZ_TEST_MENU;Invoke-HertzSetupUninstall $InstallDir $false',install,{HERTZ_TEST_MENU:menuLink}),/Reparse-point/);
  assert.deepEqual(snapshot(install),installedBefore);assert.deepEqual(snapshotTree(menuTarget),targetBefore);await uninstall();
  assert(fs.lstatSync(menuLink).isSymbolicLink());assert.equal(fs.realpathSync(menuLink),fs.realpathSync(menuTarget));fs.unlinkSync(menuLink);
  assert(!registration().uninstallKey);assert(!registration().appKey);
  mark('menu junctions and linked ancestors reject before installation, projection reads or uninstall deletion; redirected data stays byte-identical');
}

main().then(checksAfterPackage).catch(async error=>{console.error(error);fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({passed:false,error:error.stack,checks,installer,binary,install},null,2));console.error(output);process.exitCode=1;}).finally(async()=>{for(const processChild of owned){try{processChild.kill();}catch{}}});
