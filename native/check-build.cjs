// Development/build check only. The portable application's runtime never invokes a compiler.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const appRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(appRoot, 'dist-native');
const executable = path.join(outputRoot, 'VisikiAudioHost.exe');
const recordFile = path.join(outputRoot, 'build-info.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function listFiles(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const next = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Native source must be a regular file: ${next}`);
    return entry.isDirectory() ? listFiles(root, next) : [next.replaceAll('\\', '/')];
  }).sort();
}
function currentInputs() {
  const files = ['native/CMakeLists.txt', 'native/build.ps1', 'native/check-build.cjs',
    ...fs.readdirSync(path.join(appRoot, 'native'), { withFileTypes: true }).filter(entry => entry.isFile() && /\.(?:h|cpp)$/.test(entry.name)).map(entry => `native/${entry.name}`),
    ...listFiles(path.join(appRoot, 'native/vendor')).map(file => `native/vendor/${file}`)];
  const inputs = Object.fromEntries(files.sort().map(file => [file, sha(fs.readFileSync(path.join(appRoot, file)))]));
  return { inputs, sourceSha256: sha(JSON.stringify(inputs)) };
}
function checkBuild() {
  if (!fs.existsSync(executable) || !fs.existsSync(recordFile)) return 'Native audio executable or build-info.json is missing.';
  let record;
  try { record = JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch { return 'Native build-info.json is invalid.'; }
  if (record.schema !== 1 || record.platform !== 'win32' || record.arch !== 'x64') return 'Native audio build must target Windows x64.';
  if (record.sourceSha256 !== currentInputs().sourceSha256) return 'Native audio sources changed after the last successful build.';
  if (record.binarySha256 !== sha(fs.readFileSync(executable))) return 'Native audio executable does not match build-info.json.';
  return null;
}
function recordBuild() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native audio builds require Windows x64.');
  const record = { schema: 1, platform: 'win32', arch: 'x64', target: 'VisikiAudioHost.exe',
    ...currentInputs(), binarySha256: sha(fs.readFileSync(executable)), builtAt: new Date().toISOString() };
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n');
  process.stdout.write(`Native audio build recorded: ${record.binarySha256}\n`);
}
function main() {
  const mode = process.argv[2] || '--check';
  if (!['--check', '--ensure', '--record'].includes(mode)) throw new Error('Usage: node native/check-build.cjs [--check|--ensure|--record]');
  if (mode === '--record') return recordBuild();
  const problem = checkBuild();
  if (!problem) { process.stdout.write('Native audio build is current.\n'); return; }
  if (mode === '--check') throw new Error(`${problem} Run npm run build:native.`);
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error(`${problem} This native host currently requires Windows x64.`);
  process.stdout.write(`${problem} Building native audio host…\n`);
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'build.ps1')], {
    cwd: appRoot, stdio: 'inherit', env: { ...process.env, VISIKI_BUILD_NODE: process.execPath }, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Native audio build failed. Check the build log and ensure MSVC, the Windows SDK and CMake 3.25+ are installed.');
  const remaining = checkBuild();
  if (remaining) throw new Error(remaining);
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { checkBuild, currentInputs };
