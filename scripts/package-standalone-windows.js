#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function validateDescription(value, allowDebug = false) {
  if (!value || value.schemaVersion !== 1 || value.kind !== 'hertz-studio'
    || value.edition !== 'full' || value.target !== 'x86_64-pc-windows-msvc'
    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version || '')
    || !['release', ...(allowDebug ? ['debug'] : [])].includes(value.profile)
    || typeof value.compiler !== 'string' || !value.compiler.startsWith('rustc ')
    || value.capabilities?.nativeWindow !== true || value.capabilities?.windowsSystemMedia !== true
    || value.capabilities?.embeddedDesktop !== true
    || value.capabilities?.windowsInstallGuard !== true
    || ['buildId', 'uiSha256', 'desktopBuildId'].some(key => !/^[a-f0-9]{64}$/.test(value[key] || ''))) {
    throw new Error('Expected a Full Windows x64 native-window release build with valid content identity.');
  }
}

function validatePe(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not a PE executable.');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset + 26 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0'
    || bytes.readUInt16LE(offset + 4) !== 0x8664 || bytes.readUInt16LE(offset + 24) !== 0x20b) {
    throw new Error('Expected an x64 PE32+ executable.');
  }
}

function validateDescriptionProtocol(bytes) {
  // Earlier Hertz binaries silently ignore unknown flags and could start a
  // service when asked for --describe. Admit our known description format
  // before execution. This is compatibility detection, not code authentication.
  if (!['--describe', 'uiSha256', 'windowsSystemMedia'].every(marker => bytes.includes(Buffer.from(marker)))) {
    throw new Error('Binary does not advertise the standalone description protocol; rebuild before packaging.');
  }
}

function powershell(script, env) {
  return execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ErrorActionPreference="Stop"; ' + script], {
    windowsHide: true, timeout: 60000, encoding: 'utf8', maxBuffer: 64 * 1024, env: { ...process.env, ...env },
  }).trim();
}

function removeStage(stage, output) {
  // A generated directory is the only recursive cleanup target. Validate the
  // resolved parent and prefix before deletion, including on failure paths.
  const resolved = fs.realpathSync(stage);
  if (path.dirname(resolved) !== fs.realpathSync(output) || !path.basename(resolved).startsWith('.hertz-standalone-')) {
    throw new Error('Refusing to clean a directory outside the package staging root.');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function packageStandalone(binary, output, { allowDebug = false } = {}) {
  if (process.platform !== 'win32') throw new Error('Package Windows builds on Windows.');
  binary = fs.realpathSync(binary);
  output = path.resolve(output);
  fs.mkdirSync(output, { recursive: true });
  const stage = fs.mkdtempSync(path.join(output, '.hertz-standalone-'));
  const published = [];
  try {
    const content = path.join(stage, 'content'); fs.mkdirSync(content);
    const stagedBinary = path.join(content, 'hertz-studio.exe');
    fs.copyFileSync(binary, stagedBinary);
    const binaryBytes = fs.readFileSync(stagedBinary);
    validatePe(binaryBytes);
    validateDescriptionProtocol(binaryBytes);
    const description = JSON.parse(execFileSync(stagedBinary, ['--describe'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024,
    }));
    validateDescription(description, allowDebug);
    const signatureStatus = powershell('Import-Module (Join-Path $PSHOME "Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1"); (Get-AuthenticodeSignature -LiteralPath $env:HERTZ_PACKAGE_BINARY).Status.ToString()', {
      HERTZ_PACKAGE_BINARY: stagedBinary,
    });
    if (!['Valid', 'NotSigned', 'UnknownError', 'NotTrusted', 'HashMismatch', 'NotSupportedFileFormat', 'Incompatible'].includes(signatureStatus)) {
      throw new Error('Unknown Authenticode status.');
    }
    if (['HashMismatch', 'NotSupportedFileFormat'].includes(signatureStatus)) throw new Error('Invalid executable signature: ' + signatureStatus);
    for (const [source, destination] of [
      ['scripts/windows/Hertz Studio.cmd', 'Hertz Studio.cmd'],
      ['scripts/windows/Launch-Hertz.ps1', 'Launch-Hertz.ps1'],
      ['scripts/windows/Update-Hertz.ps1', 'Update-Hertz.ps1'],
      ['docs/windows-portable.md', 'INSTALL.md'], ['LICENSE', 'LICENSE'], ['NOTICE', 'NOTICE'],
      ['licenses/Apache-2.0.txt', 'Apache-2.0.txt'],
      ['tools/stage-fluid/LICENSE.md', 'stage-fluid-LICENSE.md'],
    ]) fs.copyFileSync(path.join(root, source), path.join(content, destination));
    fs.writeFileSync(path.join(content, 'hertz-install.lock'), '');
    const files = Object.fromEntries(fs.readdirSync(content).sort().map(name => {
      const bytes = fs.readFileSync(path.join(content, name));
      return [name, { size: bytes.length, sha256: sha256(bytes) }];
    }));
    const manifest = { ...description, signatureStatus,
      qualification: description.profile === 'release' ? 'release-candidate' : 'development-only',
      launch: { file: 'Hertz Studio.cmd', binary: 'hertz-studio.exe', arguments: ['--window'] }, files };
    const name = `hertz-studio-full-${description.version}-${description.target}${description.profile === 'debug' ? '-debug' : ''}`;
    const manifestText = JSON.stringify(manifest, null, 2) + '\n';
    fs.writeFileSync(path.join(content, 'standalone-build.json'), manifestText);
    const zip = path.join(stage, name + '.zip');
    powershell('Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:HERTZ_PACKAGE_CONTENT, $env:HERTZ_PACKAGE_ZIP)', {
      HERTZ_PACKAGE_CONTENT: content, HERTZ_PACKAGE_ZIP: zip,
    });
    const checksum = sha256(fs.readFileSync(zip));
    const checksumFile = zip + '.sha256', manifestFile = path.join(stage, name + '.json');
    fs.writeFileSync(checksumFile, `${checksum}  ${name}.zip\n`); fs.writeFileSync(manifestFile, manifestText);
    // COPYFILE_EXCL is the no-overwrite boundary even if another packager races
    // after validation. Roll back only files successfully created by this call.
    for (const file of [zip, checksumFile, manifestFile]) {
      const destination = path.join(output, path.basename(file));
      fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL); published.push(destination);
    }
    return { archive: path.join(output, name + '.zip'), sha256: checksum, manifest };
  } catch (error) {
    for (const file of published) fs.unlinkSync(file);
    throw error;
  } finally { removeStage(stage, output); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3 || (args[2] && args[2] !== '--allow-debug')) {
    throw new Error('Usage: node scripts/package-standalone-windows.js <binary> <output> [--allow-debug]');
  }
  console.log(JSON.stringify(packageStandalone(args[0], args[1], { allowDebug: args[2] === '--allow-debug' }), null, 2));
}
module.exports = { packageStandalone, validateDescription, validatePe, validateDescriptionProtocol };
