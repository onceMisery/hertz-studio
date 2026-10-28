#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

// Prepare the optional Windows component only; never publish or install it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function packageComponent(binary, output) {
  if (process.platform !== 'win32') throw new Error('Build the Windows component on Windows.');
  binary = fs.realpathSync(binary);
  output = path.resolve(output);
  fs.mkdirSync(output, { recursive: true });
  // Stage on the output volume so completed files can be committed by rename.
  const staging = fs.mkdtempSync(path.join(output, '.hertz-desktop-package-'));
  let publishedArchive;
  let publishedChecksum;
  try {
    const content = path.join(staging, 'content');
    fs.mkdirSync(content);
    const stagedBinary = path.join(content, 'hertz-desktop.exe');
    fs.copyFileSync(binary, stagedBinary);
    // Describe the exact bytes going into the package, even if a build replaces
    // the original binary while this packaging operation is running.
    const description = JSON.parse(execFileSync(stagedBinary, ['--describe'], {
      encoding: 'utf8', windowsHide: true, timeout: 2000, maxBuffer: 64 * 1024,
    }));
    if (description.componentProtocol !== 1 || description.target !== 'windows-x64'
        || !/^[a-f0-9]{64}$/.test(description.desktopBuildId)
        || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(description.version)
        || description.launchMode !== 'manual'
        || !Number.isSafeInteger(description.managementProtocol)
        || !(description.bridgeProtocol === null || Number.isSafeInteger(description.bridgeProtocol))) {
      throw new Error('Invalid component description.');
    }
    const archiveName = `hertz-desktop-${description.version}-windows-x64.zip`;
    const archive = path.join(output, archiveName);
    if (fs.existsSync(archive) || fs.existsSync(archive + '.sha256')) {
      throw new Error(`Output already exists: ${archive}`);
    }
    const bytes = fs.readFileSync(stagedBinary);
    const manifest = {
      ...description,
      file: 'hertz-desktop.exe',
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
    fs.writeFileSync(path.join(content, 'desktop-component.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.copyFileSync(path.join(root, 'LICENSE'), path.join(content, 'LICENSE'));
    fs.copyFileSync(path.join(root, 'docs/desktop-component-install.md'), path.join(content, 'INSTALL.md'));
    const temporaryArchive = path.join(staging, archiveName);
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:HERTZ_COMPONENT_STAGE, $env:HERTZ_COMPONENT_ARCHIVE)'], {
      windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024,
      env: { ...process.env, HERTZ_COMPONENT_STAGE: content, HERTZ_COMPONENT_ARCHIVE: temporaryArchive },
    });
    const archiveBytes = fs.readFileSync(temporaryArchive);
    const checksum = crypto.createHash('sha256').update(archiveBytes).digest('hex');
    const temporaryChecksum = temporaryArchive + '.sha256';
    fs.writeFileSync(temporaryChecksum, `${checksum}  ${archiveName}\n`);
    fs.renameSync(temporaryArchive, archive);
    publishedArchive = archive;
    fs.renameSync(temporaryChecksum, archive + '.sha256');
    publishedChecksum = archive + '.sha256';
    return { archive, sha256: checksum, component: manifest };
  } catch (error) {
    if (publishedChecksum) fs.rmSync(publishedChecksum, { force: true });
    if (publishedArchive) fs.rmSync(publishedArchive, { force: true });
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/package-desktop-component.js <hertz-desktop.exe> <output-directory>');
  console.log(JSON.stringify(packageComponent(process.argv[2], process.argv[3]), null, 2));
}
module.exports = { packageComponent };
