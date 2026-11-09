// SPDX-License-Identifier: MIT
// First G3-S stopping point only. This never qualifies author Web selection.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const root = path.resolve(__dirname, '..');
const options = process.argv.slice(2);
const value = (flag) => {
  const index = options.indexOf(flag);
  if (index < 0) return undefined;
  if (!options[index + 1] || options[index + 1].startsWith('--')) throw new Error(`Missing ${flag} value`);
  return options[index + 1];
};
const candidate = path.resolve(value('--output-dir') || path.join(root, 'output/a05-g3s-20261108/current-candidate'));
const executable = path.resolve(value('--exe') || path.join(candidate, 'target/debug/hertz-desktop.exe'));
const build = options.includes('--build');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const run = (file, args, timeout = 60000) => {
  const result = cp.spawnSync(file, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 });
  return { exitCode: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error ? String(result.error) : null };
};
const sources = [
  'build-support/desktop-build.rs', 'crates/hertz-desktop/build.rs', 'crates/hertz-desktop/Cargo.toml',
  'crates/hertz-desktop/src/main.rs', 'crates/hertz-desktop/src/lib.rs', 'crates/hertz-desktop/src/native.rs',
  'crates/hertz-desktop/src/component.rs', 'crates/hertz-desktop/src/wallpaper/mod.rs',
  'crates/hertz-desktop/src/wallpaper/worker.rs', 'crates/hertz-desktop/src/wallpaper/worker_protocol.rs',
  'crates/hertz-desktop/src/wallpaper/worker_sandbox.rs', 'crates/hertz-desktop/src/wallpaper/worker_webview.rs',
  'scripts/check-wallpaper-sandbox-native.js', 'Cargo.lock'
];
const sourceRoots = ['crates/hertz-desktop/src', 'crates/hertz-desktop/assets', 'crates/hertz-desktop/migrations',
  'crates/hertz-wallpaper/src', 'crates/hertz-wallpaper/contracts', 'crates/hertz-wallpaper/Cargo.toml', 'crates/hertz-sqlite-lifecycle/src',
  'crates/hertz-sqlite-lifecycle/Cargo.toml', 'crates/hertz-desktop-ipc/src', 'crates/hertz-desktop-ipc/Cargo.toml',
  'Cargo.toml', 'plugin/ui/stage-resource-budget.js', 'plugin/ui/vendor/stage-runtime.js', 'plugin/ui/vendor/zodiac-stage.js'];
const collect = (relative) => {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return;
  if (fs.statSync(absolute).isDirectory()) {
    for (const name of fs.readdirSync(absolute)) if (!['target', 'node_modules', 'output', '.git'].includes(name)) collect(path.join(relative, name));
  } else sources.push(relative.replaceAll('\\', '/'));
};
sourceRoots.forEach(collect);
const snapshot = () => {
  // A concurrent integration can add source files while a build runs. Rewalk
  // the inventory so an omitted new input cannot falsely preserve binding.
  sourceRoots.forEach(collect);
  return Object.fromEntries([...new Set(sources)].sort().map((file) => [file, digest(fs.readFileSync(path.join(root, file)))]));
};

if (process.platform !== 'win32') throw new Error('G3-S native qualification requires Windows. No fixture substitutes for this run.');
fs.mkdirSync(candidate, { recursive: true });
const started = new Date().toISOString();
const receiptFile = path.join(candidate, 'build-receipt.json');
// A failed attempt must not expose a previous qualification as this run.
fs.rmSync(path.join(candidate, 'candidate-evidence.json'), { force: true });
if (build) {
  fs.rmSync(receiptFile, { force: true });
  fs.rmSync(path.join(candidate, 'build-input-hashes.json'), { force: true });
  const produced = path.join(candidate, 'target/debug/hertz-desktop.exe');
  if (executable.toLowerCase() !== produced.toLowerCase()) {
    throw new Error('--build requires --exe to select the actual dedicated build output.');
  }
  const buildInputs = snapshot();
  // A separate target directory never overwrites the user's running debug executable.
  const built = run('cargo', ['build', '-p', 'hertz-desktop', '--locked', '--target-dir', path.join(candidate, 'target')], 20 * 60 * 1000);
  fs.writeFileSync(path.join(candidate, 'build.log'), built.stdout + '\n' + built.stderr);
  if (built.exitCode !== 0) throw new Error(`Dedicated candidate build failed: ${built.error || built.exitCode}`);
  if (JSON.stringify(buildInputs) !== JSON.stringify(snapshot())) throw new Error('Source changed during dedicated build.');
  const receipt = { schemaVersion: 1, buildSucceeded: true, sourceBuildBinding: true,
    binary: produced, binarySha256: digest(fs.readFileSync(produced)), sourceHashes: buildInputs, features: [] };
  const pendingReceipt = receiptFile + '.pending';
  fs.writeFileSync(pendingReceipt, JSON.stringify(receipt, null, 2) + '\n');
  fs.renameSync(pendingReceipt, receiptFile);
}
if (!fs.existsSync(executable)) throw new Error(`Candidate executable missing: ${executable}`);
const parentHash = digest(fs.readFileSync(executable));
if (!fs.existsSync(receiptFile)) throw new Error('Candidate has no successful build receipt; rebuild before native qualification.');
const receipt = readJson(receiptFile);
const sourceHashes = snapshot();
const sameSources = receipt.sourceHashes && typeof receipt.sourceHashes === 'object' && !Array.isArray(receipt.sourceHashes)
  && Object.keys(receipt.sourceHashes).length === Object.keys(sourceHashes).length
  && Object.entries(sourceHashes).every(([file, sha256]) => receipt.sourceHashes[file] === sha256);
if (receipt.schemaVersion !== 1 || receipt.buildSucceeded !== true || receipt.sourceBuildBinding !== true
    || receipt.binarySha256 !== parentHash || !sameSources) {
  throw new Error('Candidate build receipt does not bind the selected executable to the current source.');
}
const sourceBuildBinding = true;
const described = run(executable, ['--describe'], 10000);
if (described.exitCode !== 0) throw new Error(`Candidate description failed: ${described.stderr}`);
const component = JSON.parse(described.stdout);
const machine = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '$os=Get-CimInstance Win32_OperatingSystem; $cpu=Get-CimInstance Win32_ComputerSystem; $revision=Get-ItemProperty -LiteralPath "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" -Name UBR; $gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,PNPDeviceID); [pscustomobject]@{osVersion=$os.Version;buildNumber=$os.BuildNumber;osRevision=$revision.UBR;logicalProcessors=$cpu.NumberOfLogicalProcessors;gpu=$gpu}|ConvertTo-Json -Depth 5 -Compress'], 20000);
const direct = run(executable, ['--wallpaper-worker'], 10000);
// A crashed current run must never borrow a previous run's native report.
if (fs.existsSync(path.join(candidate, 'startup-report.json'))) fs.rmSync(path.join(candidate, 'startup-report.json'));
const invocation = ['--wallpaper-sandbox-probe', '--worker-exe', executable, '--worker-sha256', parentHash, '--output-dir', candidate];
const actual = run(executable, invocation, 90000);
fs.writeFileSync(path.join(candidate, 'harness.stdout.log'), actual.stdout);
fs.writeFileSync(path.join(candidate, 'harness.stderr.log'), actual.stderr);
let startup = null;
try { startup = readJson(path.join(candidate, 'startup-report.json')); } catch (error) { startup = { passed: false, error: actual.error || `Current native report absent: ${error}` }; }
const facts = {
  schemaVersion: 1, gate: 'G3-S-stop-1', started, completed: new Date().toISOString(),
  executable, executableSha256: parentHash, executableHashAfter: digest(fs.readFileSync(executable)),
  component, sourceHashes, sourceBuildBinding, buildReceipt: receipt,
  git: run('git', ['status', '--short'], 10000).stdout,
  environment: machine.exitCode === 0 ? JSON.parse(machine.stdout) : { error: machine.stderr || machine.error },
  directWorkerInvocation: { ...direct, rejected: direct.exitCode !== 0 && direct.exitCode !== null },
  harness: { exitCode: actual.exitCode, signal: actual.signal, error: actual.error },
  startup, protectedUserProcesses: [6428, 35216], webEnabled: false,
  passed: actual.exitCode === 0 && startup.passed === true && direct.exitCode !== 0 && direct.exitCode !== null
};
facts.passed = facts.passed && sourceBuildBinding && facts.executableSha256 === facts.executableHashAfter
  && JSON.stringify(sourceHashes) === JSON.stringify(snapshot());
fs.writeFileSync(path.join(candidate, 'candidate-evidence.json'), JSON.stringify(facts, null, 2) + '\n');
console.log(JSON.stringify({ passed: facts.passed, webEnabled: false, report: path.join(candidate, 'candidate-evidence.json'), error: startup.error || actual.error || null }, null, 2));
process.exitCode = facts.passed ? 0 : 1;
