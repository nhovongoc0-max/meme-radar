import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { archiveFiles, releaseAssetName, UPDATE_LIMITS } from '../src/updater.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixedTime = new Date('2000-01-01T00:00:00.000Z');
const validVersion = value => typeof value === 'string' && /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(value);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const excludedSegments = new Set(['.git', '.runtime', '.local-data', 'state', 'logs', 'node_modules', 'runtime']);
const credentialNames = new Set([
  '.env', '.npmrc', 'ave-credentials.json', 'gmgn-api-key', 'telegram-bot-token', 'agent-private-key',
  'gmgn-pending-signing-key.pem',
]);
const executableNames = new Set(['open-radar.command', 'start-radar.command', '安装并启动.command']);
const tokenPattern = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/;
const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{40,}/;

function fail(message) { throw new Error(message); }

function plainFile(file, label = file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(`${label}不存在`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(`${label}必须是单链接普通文件`);
  return stat;
}

function plainDirectory(directory, label = directory) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch { fail(`${label}不存在`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label}必须是普通目录`);
  return stat;
}

function safeRelative(name) {
  if (typeof name !== 'string' || !name || name.length > 500 || name.includes('\\') || /[\x00-\x1f\x7f:]/.test(name)) return false;
  return name.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function readJson(file, label = file) {
  const stat = plainFile(file, label);
  if (stat.size > UPDATE_LIMITS.metadata) fail(`${label}过大`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail(`${label}不是有效 JSON`); }
}

function normalizedLock(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.packages?.['']) fail('package-lock.json 结构无效');
  value = structuredClone(value);
  delete value.version;
  delete value.packages[''].version;
  return sha256(Buffer.from(JSON.stringify(value)));
}

function compareVersion(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return Math.sign(left[index] - right[index]);
  return 0;
}

function localSecrets(root) {
  const result = [], add = value => {
    if (typeof value === 'string' && value.trim() === value && value.length >= 12 && value.length <= 4096) result.push(Buffer.from(value));
  };
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'state', 'ave-credentials.json'), 'utf8'));
    for (const key of ['key', 'token', 'secret']) add(stored?.[key]);
  } catch { /* A release source does not need local credentials. */ }
  for (const name of ['gmgn-api-key', 'telegram-bot-token', 'agent-private-key', 'gmgn-pending-signing-key.pem']) {
    try { add(fs.readFileSync(path.join(root, 'state', name), 'utf8').trim()); } catch { /* Optional local-only credential. */ }
  }
  return [...new Map(result.map(value => [sha256(value), value])).values()];
}

function inspectSourceContent(data, name, { secrets, privatePaths }) {
  if (secrets.some(secret => data.includes(secret))) fail(`发布源包含本机凭证：${name}`);
  if (privatePaths.some(value => data.includes(value))) fail(`发布源包含个人电脑绝对路径：${name}`);
  if (data.length > UPDATE_LIMITS.metadata) return;
  const content = data.toString('utf8');
  if (tokenPattern.test(content)) fail(`发布源疑似包含 Telegram Bot Token：${name}`);
  if (privateKeyPattern.test(content)) fail(`发布源疑似包含私钥：${name}`);
}

export function collectReleaseSource(root = defaultRoot) {
  root = path.resolve(root); plainDirectory(root, '发布源');
  const secrets = localSecrets(root);
  const privatePathValues = new Set([root, os.homedir()].filter(Boolean));
  for (const value of [...privatePathValues]) {
    privatePathValues.add(value.replaceAll('\\', '/'));
    privatePathValues.add(value.replaceAll('/', '\\'));
  }
  const context = { secrets, privatePaths: [...privatePathValues].filter(value => value.length >= 4).map(value => Buffer.from(value)) };
  const files = []; let expanded = 0;
  const visit = (directory, relative = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => byteOrder(a.name, b.name));
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || excludedSegments.has(entry.name) || credentialNames.has(entry.name.toLowerCase())) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!safeRelative(name)) fail(`发布源包含不安全路径：${name}`);
      const absolute = path.join(directory, entry.name), stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`发布源不允许符号链接：${name}`);
      if (stat.isDirectory()) { visit(absolute, name); continue; }
      if (!stat.isFile() || stat.nlink !== 1) fail(`发布源包含不受支持的文件：${name}`);
      if (stat.size > UPDATE_LIMITS.file || (expanded += stat.size) > UPDATE_LIMITS.expanded) fail('发布源大小超出更新器限制');
      const data = fs.readFileSync(absolute); inspectSourceContent(data, name, context);
      const executable = executableNames.has(name) || name.endsWith('.command') || name.endsWith('.sh') || Boolean(stat.mode & 0o111);
      files.push({ name, data, mode: executable ? 0o755 : 0o644 });
      if (files.length > UPDATE_LIMITS.entries) fail('发布源文件数超出更新器限制');
    }
  };
  visit(root);
  const names = new Set(files.map(file => file.name));
  for (const required of ['package.json', 'package-lock.json', 'src/main.mjs', 'src/updater.mjs', 'scripts/update-worker.mjs', 'public/index.html']) {
    if (!names.has(required)) fail(`发布源缺少必需文件：${required}`);
  }
  return files;
}

export function releaseFileNames(version) {
  if (!validVersion(version)) fail('必须指定有效的三段版本号');
  return Object.freeze({
    mac: releaseAssetName(version, 'darwin', 'arm64'),
    windows: releaseAssetName(version, 'win32', 'x64'),
    checksums: `SHA256SUMS-${version}.txt`,
  });
}

export function readWindowsDonorPolicy(root = defaultRoot) {
  const policy = readJson(path.join(root, 'packaging', 'release-donors.json'), 'Windows donor 策略');
  const item = policy?.schema === 1 ? policy.windowsX64 : null;
  const requiredNames = item?.requiredFiles && typeof item.requiredFiles === 'object' && !Array.isArray(item.requiredFiles)
    ? Object.keys(item.requiredFiles).sort(byteOrder) : [];
  if (!item || !validVersion(item.version) || typeof item.assetName !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
    || !item.requiredFiles || typeof item.requiredFiles !== 'object' || Array.isArray(item.requiredFiles)
    || !item.launcherSource || !safeRelative(item.launcherSource.path) || !/^[a-f0-9]{64}$/.test(item.launcherSource.sha256)
    || !Array.isArray(item.copiedPrefixes) || Object.entries(item.requiredFiles).some(([name, hash]) => !safeRelative(name) || !/^[a-f0-9]{64}$/.test(hash))
    || item.copiedPrefixes.some(prefix => typeof prefix !== 'string' || !prefix.endsWith('/') || !safeRelative(prefix.slice(0, -1)))
    || item.assetName !== releaseAssetName(item.version, 'win32', 'x64')
    || requiredNames.join('\n') !== ['MemeRadar-OpenSource.exe', 'runtime/node.exe'].sort(byteOrder).join('\n')
    || item.copiedPrefixes.length !== 1 || item.copiedPrefixes[0] !== 'node_modules/') {
    fail('Windows donor 策略无效');
  }
  return item;
}

function donorDependencyFiles(files, sourceManifest, sourceLock) {
  const byName = new Map(files.map(file => [file.name, file]));
  const donorManifestFile = byName.get('package.json'), donorLockFile = byName.get('package-lock.json');
  let donorManifest, donorLock;
  try { donorManifest = JSON.parse(donorManifestFile?.data); donorLock = JSON.parse(donorLockFile?.data); }
  catch { fail('Windows donor 的依赖元数据无效'); }
  if (donorManifest.name !== sourceManifest.name || normalizedLock(donorLock) !== normalizedLock(sourceLock)) {
    fail('Windows donor 依赖与当前 package-lock.json 不一致');
  }
  for (const [name, expected] of Object.entries(sourceLock.packages || {})) {
    if (!name.startsWith('node_modules/')) continue;
    const packaged = byName.get(`${name}/package.json`);
    let value; try { value = JSON.parse(packaged?.data); } catch { fail(`Windows donor 缺少锁定依赖：${name}`); }
    if (expected?.version && value.version !== expected.version) fail(`Windows donor 依赖版本不一致：${name}`);
  }
}

export function loadWindowsDonor({ donorPath, policy, sourceManifest, sourceLock }) {
  if (!donorPath || typeof donorPath !== 'string') fail('必须提供已验证的 Windows donor ZIP');
  donorPath = path.resolve(donorPath);
  const stat = plainFile(donorPath, 'Windows donor ZIP');
  if (stat.size <= 0 || stat.size > UPDATE_LIMITS.archive || path.basename(donorPath) !== policy.assetName) fail('Windows donor ZIP 名称或大小不合法');
  const bytes = fs.readFileSync(donorPath);
  if (sha256(bytes) !== policy.sha256) fail('Windows donor ZIP 的 SHA-256 与已审核值不一致');
  const files = archiveFiles(bytes, 'win32'), byName = new Map(files.map(file => [file.name, file]));
  for (const [name, hash] of Object.entries(policy.requiredFiles)) {
    if (!byName.has(name) || byName.get(name).sha256 !== hash) fail(`Windows donor 缺少或篡改必需文件：${name}`);
  }
  if (byName.get(policy.launcherSource.path)?.sha256 !== policy.launcherSource.sha256) fail('Windows donor 与已审核启动器源码不一致');
  donorDependencyFiles(files, sourceManifest, sourceLock);
  const selected = files.filter(file => Object.hasOwn(policy.requiredFiles, file.name)
    || policy.copiedPrefixes.some(prefix => file.name.startsWith(prefix)));
  if (!selected.some(file => file.name.startsWith('node_modules/'))) fail('Windows donor 不含锁定依赖');
  return selected.map(file => ({ name: file.name, data: file.data, mode: file.mode }));
}

function versionedSource(sourceFiles, version) {
  const files = sourceFiles.map(file => ({ ...file, data: Buffer.from(file.data) })), byName = new Map(files.map(file => [file.name, file]));
  let manifest, lock;
  try { manifest = JSON.parse(byName.get('package.json').data); lock = JSON.parse(byName.get('package-lock.json').data); }
  catch { fail('发布源 package.json 或 package-lock.json 无效'); }
  if (manifest.name !== 'meme-radar-open-source' || manifest.private !== true || !validVersion(manifest.version)
    || lock.name !== manifest.name || !validVersion(lock.version) || lock.packages?.['']?.name !== manifest.name) {
    fail('发布源包名、private 或版本元数据无效');
  }
  if (lock.version !== manifest.version || lock.packages[''].version !== manifest.version) fail('发布源锁文件版本不一致');
  if (compareVersion(version, manifest.version) !== 0) fail('构建版本必须与发布源 package.json 完全一致');
  manifest.version = version; lock.version = version; lock.packages[''].version = version;
  byName.get('package.json').data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  byName.get('package-lock.json').data = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
  return { files, manifest, lock };
}

function mergeFiles(...groups) {
  const result = new Map();
  for (const files of groups) for (const file of files) {
    if (!safeRelative(file.name) || result.has(file.name)) fail(`发布包文件冲突或路径无效：${file.name}`);
    if (file.name.split('/').some(part => credentialNames.has(part.toLowerCase()) || ['.git', '.runtime', '.local-data', 'state', 'logs'].includes(part))) {
      fail(`发布包疑似包含本机数据：${file.name}`);
    }
    result.set(file.name, { name: file.name, data: Buffer.from(file.data), mode: file.mode === 0o755 ? 0o755 : 0o644 });
  }
  return [...result.values()].sort((a, b) => byteOrder(a.name, b.name));
}

function writeTree(directory, files) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  for (const file of files) {
    const target = path.join(directory, ...file.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, file.data, { flag: 'wx', mode: file.mode });
    fs.chmodSync(target, file.mode); fs.utimesSync(target, fixedTime, fixedTime);
  }
}

function createZip({ stagingParent, rootName, files, output, zipCommand = 'zip' }) {
  const root = path.join(stagingParent, rootName); writeTree(root, files);
  const names = files.map(file => `${rootName}/${file.name}`).sort(byteOrder);
  // The updater deliberately accepts only ordinary ZIP flags. Info-ZIP's -9
  // sets a deflate-tuning flag that the hardened reader rejects, so use its
  // deterministic default compression level.
  const child = spawnSync(zipCommand, ['-q', '-X', output, '-@'], {
    cwd: stagingParent, input: `${names.join('\n')}\n`, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'en_US.UTF-8' }, shell: false,
  });
  if (child.error || child.status !== 0) fail(`ZIP 构建失败：${child.error?.message || child.stderr || `exit ${child.status}`}`);
  const stat = plainFile(output, '发布 ZIP');
  if (stat.size <= 0 || stat.size > UPDATE_LIMITS.archive) fail('发布 ZIP 大小超出更新器限制');
}

function verifyArchive(file, platform, version) {
  const bytes = fs.readFileSync(file), files = archiveFiles(bytes, platform), byName = new Map(files.map(item => [item.name, item]));
  let manifest, lock;
  try { manifest = JSON.parse(byName.get('package.json')?.data); lock = JSON.parse(byName.get('package-lock.json')?.data); }
  catch { fail(`${path.basename(file)} 的版本元数据无效`); }
  if (manifest.version !== version || lock.version !== version || lock.packages?.['']?.version !== version) fail(`${path.basename(file)} 版本不一致`);
  if (files.some(item => item.name.split('/').some(part => ['.git', '.runtime', '.local-data', 'state', 'logs'].includes(part) || credentialNames.has(part.toLowerCase())))) {
    fail(`${path.basename(file)} 包含私有数据路径`);
  }
  if (platform === 'win32' && !['MemeRadar-OpenSource.exe', 'OPEN-MEME-RADAR.bat', 'runtime/node.exe', 'node_modules/gmgn-cli/package.json'].every(name => byName.has(name))) {
    fail(`${path.basename(file)} 缺少 Windows 便携运行文件`);
  }
  if (platform === 'darwin') {
    for (const name of ['安装并启动.command', 'start-radar.command', 'scripts/bootstrap-node.sh']) {
      if (byName.get(name)?.mode !== 0o755) fail(`${path.basename(file)} 未保留可执行权限：${name}`);
    }
  }
  return sha256(bytes);
}

function safeOutputDirectory(root, outDir) {
  outDir = path.resolve(outDir || '');
  if (!outDir || outDir === root || outDir.startsWith(`${root}${path.sep}`)) fail('发布输出目录必须位于源码树外');
  if (fs.existsSync(outDir)) {
    plainDirectory(outDir, '发布输出目录');
    if (fs.readdirSync(outDir).length) fail('发布输出目录必须为空，不会覆盖或混入其他资产');
  }
  else fs.mkdirSync(outDir, { recursive: true, mode: 0o755 });
  return outDir;
}

export function buildRelease({ root = defaultRoot, outDir, version, windowsDonor, donorPolicy, zipCommand = 'zip' } = {}) {
  root = path.resolve(root); plainDirectory(root, '发布源');
  const names = releaseFileNames(version), output = safeOutputDirectory(root, outDir);
  for (const name of Object.values(names)) if (fs.existsSync(path.join(output, name))) fail(`不会覆盖已有发布资产：${name}`);
  const source = versionedSource(collectReleaseSource(root), version);
  const policy = donorPolicy || readWindowsDonorPolicy(root);
  if (!windowsDonor) windowsDonor = path.resolve(root, '..', 'releases', `v${policy.version}`, policy.assetName);
  const donor = loadWindowsDonor({ donorPath: windowsDonor, policy, sourceManifest: source.manifest, sourceLock: source.lock });
  const sourceByName = new Map(source.files.map(file => [file.name, file]));
  if (sha256(sourceByName.get(policy.launcherSource.path)?.data || Buffer.alloc(0)) !== policy.launcherSource.sha256) {
    fail('Windows 启动器源码已变更，不能继续使用旧的 donor EXE');
  }
  const promoted = [
    ['packaging/windows-portable/OPEN-MEME-RADAR.bat', 'OPEN-MEME-RADAR.bat'],
    ['packaging/windows-portable/README-FIRST.txt', 'README-FIRST.txt'],
  ].map(([from, name]) => {
    const file = sourceByName.get(from); if (!file) fail(`发布源缺少 Windows 启动文件：${from}`);
    return { ...file, name };
  });
  const macFiles = mergeFiles(source.files);
  const windowsFiles = mergeFiles(source.files, donor, promoted);
  const parent = path.dirname(output), work = fs.mkdtempSync(path.join(parent, '.meme-radar-release-build-'));
  fs.chmodSync(work, 0o700);
  try {
    const macFile = path.join(work, names.mac), windowsFile = path.join(work, names.windows), checksumsFile = path.join(work, names.checksums);
    createZip({ stagingParent: work, rootName: 'MemeRadar-OpenSource-macOS', files: macFiles, output: macFile, zipCommand });
    createZip({ stagingParent: work, rootName: 'MemeRadar-OpenSource-Windows', files: windowsFiles, output: windowsFile, zipCommand });
    const macHash = verifyArchive(macFile, 'darwin', version), windowsHash = verifyArchive(windowsFile, 'win32', version);
    fs.writeFileSync(checksumsFile, `${macHash}  ${names.mac}\n${windowsHash}  ${names.windows}\n`, { flag: 'wx', mode: 0o644 });
    for (const name of [names.mac, names.windows, names.checksums]) fs.renameSync(path.join(work, name), path.join(output, name));
    return { version, outDir: output, names, sha256: { [names.mac]: macHash, [names.windows]: windowsHash } };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

function parseCli(argv) {
  let version, outDir, windowsDonor; let invalid = false;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!value) { invalid = true; break; }
    if (flag === '--version' && !version) version = value;
    else if (flag === '--out' && !outDir) outDir = value;
    else if (flag === '--windows-donor' && !windowsDonor) windowsDonor = value;
    else { invalid = true; break; }
  }
  if (invalid || !version || !outDir) fail('用法：node scripts/build-release.mjs --version 0.1.10 --out <空输出目录> [--windows-donor <已验证的 v0.1.9 Windows ZIP>]');
  return { version, outDir, windowsDonor };
}

function cli() {
  try {
    const result = buildRelease(parseCli(process.argv.slice(2)));
    console.log(`已离线构建 v${result.version} 双平台发布资产：${result.outDir}`);
    for (const [name, hash] of Object.entries(result.sha256)) console.log(`${hash}  ${name}`);
  } catch (error) { console.error(`发布构建失败：${error.message}`); process.exitCode = 1; }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) cli();
