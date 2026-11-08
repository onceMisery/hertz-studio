#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {packageStandalone}=require('./package-standalone-windows');
const root=path.resolve(__dirname,'..');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const packagerSha256=hash(__filename);

function packageInstaller(binary,output,{makensis=process.env.HERTZ_MAKENSIS,allowDebug=false}={}) {
  if(process.platform!=='win32')throw Error('Build this Windows installer on Windows.');
  if(!makensis)throw Error('Provide HERTZ_MAKENSIS or --makensis with an installed NSIS Unicode compiler.');
  makensis=fs.realpathSync(makensis);output=path.resolve(output);fs.mkdirSync(output,{recursive:true});
  const stage=fs.mkdtempSync(path.join(output,'.hertz-installer-'));
  const published=[];
  try {
    const portable=packageStandalone(binary,path.join(stage,'portable'),{allowDebug});
    const content=path.join(stage,'content');
    const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
    execFileSync(ps,['-NoProfile','-NonInteractive','-Command','Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:HERTZ_INSTALLER_ZIP,$env:HERTZ_INSTALLER_CONTENT)'],{windowsHide:true,timeout:30000,env:{...process.env,HERTZ_INSTALLER_ZIP:portable.archive,HERTZ_INSTALLER_CONTENT:content}});
    const description=portable.manifest;
    const name=`hertz-studio-full-${description.version}-${description.target}${description.profile==='debug'?'-debug':''}-setup.exe`;
    const executable=path.join(stage,name);
    const sources=path.join(stage,'installer-source');fs.mkdirSync(sources);
    const script=path.join(sources,'Hertz-Installer.nsi');
    const helper=path.join(sources,'Install-Hertz.ps1');
    const owner=path.join(content,'Update-Hertz.ps1');
    const icon=path.join(sources,'hertz.ico');
    fs.copyFileSync(path.join(root,'scripts/windows/Hertz-Installer.nsi'),script);
    fs.copyFileSync(path.join(root,'scripts/windows/Install-Hertz.ps1'),helper);
    fs.copyFileSync(path.join(root,'crates/hertz-desktop/assets/icons/hertz-lyrics.ico'),icon);
    const sourceSha256={'scripts/windows/Hertz-Installer.nsi':hash(script),'scripts/windows/Install-Hertz.ps1':hash(helper),
      'scripts/windows/Update-Hertz.ps1':hash(owner),'scripts/package-standalone-installer.js':packagerSha256,
      'crates/hertz-desktop/assets/icons/hertz-lyrics.ico':hash(icon)};
    const compilerVersion=execFileSync(makensis,['/VERSION'],{encoding:'utf8',windowsHide:true,timeout:10000}).trim();
    if(!/^v3\./.test(compilerVersion))throw Error('A Unicode NSIS 3 compiler is required.');
    const result=execFileSync(makensis,['/V3','/INPUTCHARSET','UTF8',`/DPACKAGE_DIR=${content}`,`/DSETUP_SOURCE=${helper}`,`/DOWNER_SOURCE=${owner}`,`/DOUTPUT_EXE=${executable}`,`/DPRODUCT_VERSION=${description.version}`,`/DPRODUCT_VERSION_NUMERIC=${description.version.split('-')[0]}.0`,`/DPRODUCT_ICON=${icon}`,`/DDEVELOPMENT_ARGUMENT=${allowDebug?'-AllowDebug':''}`,script],{encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:256*1024});
    fs.writeFileSync(path.join(stage,'compiler.log'),result);
    if(!fs.existsSync(executable)||fs.statSync(executable).size<100000)throw Error('NSIS did not produce a complete installer.');
    const digest=hash(executable);
    const signatureStatus=execFileSync(ps,['-NoProfile','-NonInteractive','-Command','Import-Module (Join-Path $PSHOME "Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1"); (Get-AuthenticodeSignature -LiteralPath $env:HERTZ_SETUP_EXECUTABLE).Status.ToString()'],{encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,HERTZ_SETUP_EXECUTABLE:executable}}).trim();
    if(!['Valid','NotSigned','NotTrusted','UnknownError','Incompatible'].includes(signatureStatus))throw Error('Invalid installer Authenticode status: '+signatureStatus);
    const manifest={schemaVersion:1,kind:'hertz-studio-installer',scope:'current-user',compiler:compilerVersion,
      compilerSha256:hash(makensis),installerSha256:digest,signatureStatus,
      package:description,qualification:description.profile==='release'?'unsigned-release-candidate':'development-only',
      sourceSha256};
    fs.writeFileSync(executable+'.json',JSON.stringify(manifest,null,2)+'\n');
    fs.writeFileSync(executable+'.sha256',`${digest}  ${name}\n`);
    for(const file of [executable,executable+'.json',executable+'.sha256']) {
      const destination=path.join(output,path.basename(file));fs.copyFileSync(file,destination,fs.constants.COPYFILE_EXCL);published.push(destination);
    }
    return {installer:path.join(output,name),sha256:digest,manifest};
  } catch(error) {for(const file of published)fs.unlinkSync(file);throw error;}
  finally {
    const resolved=fs.realpathSync(stage);
    if(path.dirname(resolved)!==fs.realpathSync(output)||!path.basename(resolved).startsWith('.hertz-installer-'))throw Error('Installer stage escaped output directory.');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}

if(require.main===module) {
  const args=process.argv.slice(2);let allowDebug=false,makensis=process.env.HERTZ_MAKENSIS;
  if(args.length<2)throw Error('Usage: node scripts/package-standalone-installer.js <binary> <output> [--allow-debug] [--makensis <path>]');
  for(let i=2;i<args.length;i++){
    if(args[i]==='--allow-debug'&&!allowDebug){allowDebug=true;continue;}
    if(args[i]==='--makensis'&&args[i+1]&&!args[i+1].startsWith('--')){makensis=args[++i];continue;}
    throw Error('Unknown, duplicate or incomplete installer option: '+args[i]);
  }
  console.log(JSON.stringify(packageInstaller(args[0],args[1],{allowDebug,makensis}),null,2));
}
module.exports={packageInstaller};
