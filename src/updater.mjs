import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { inflateRawSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const UPDATE_REPOSITORY = 'nhovongoc0-max/meme-radar';
export const UPDATE_LIMITS = Object.freeze({ archive: 200_000_000, expanded: 700_000_000, file: 150_000_000, entries: 20000, metadata: 262144, checksums: 65536 });
const API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases`;
const RELEASE = `https://github.com/${UPDATE_REPOSITORY}/releases/download/`;
const privateRoots = new Set(['state', 'logs', '.runtime', '.env', '.npmrc']);
const ignoredLocal = new Set([...privateRoots, 'node_modules', 'runtime', '.DS_Store']);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validVersion = value => typeof value === 'string' && /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(value);
export class UpdateError extends Error { constructor(code, message) { super(message); this.code = code; this.statusCode = 409; } }
const fail = (code, message) => { throw new UpdateError(code, message); };
const errors = {
  UPDATE_NETWORK: '更新服务连接未完成；当前版本没有改变', UPDATE_STORAGE: '更新暂存或文件检查失败；请保留原目录',
  UPDATE_LOCAL: '当前目录含本机未发布修改或源码工作区，不允许自动覆盖；请保留此测试版',
  UPDATE_CHECKSUM: '发布文件校验未通过，已停止更新', UPDATE_ARCHIVE: '发布包结构不安全或不受支持',
  UPDATE_BUSY: '已有更新正在进行，请勿重复提交', UPDATE_VERSION: '只允许更新到明确发布的更高稳定版本',
  UPDATE_PLATFORM: '仅支持 Windows x64 便携包及 macOS arm64/x64 发布源码包',
  UPDATE_DEPENDENCIES: '新版本依赖发生变化或未安装，当前版本保留；本轮自动更新只支持已验证的相同依赖',
  UPDATE_HANDOFF: '旧进程未正常退出，未替换当前版本', UPDATE_START: '新版本健康检查失败，已尝试恢复原版本',
};
const fixed = error => error instanceof UpdateError ? error : new UpdateError('UPDATE_STORAGE', errors.UPDATE_STORAGE);
export function compareVersions(a, b) {
  if (!validVersion(a) || !validVersion(b)) fail('UPDATE_VERSION', errors.UPDATE_VERSION);
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}
export function releaseAssetName(version, platform, arch) {
  if (!validVersion(version)) fail('UPDATE_VERSION', errors.UPDATE_VERSION);
  if (platform === 'win32' && arch === 'x64') return `MemeRadar-OpenSource-Windows-x64-${version}.zip`;
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return `MemeRadar-OpenSource-macOS-${version}.zip`;
  fail('UPDATE_PLATFORM', errors.UPDATE_PLATFORM);
}
function relativeName(name) {
  if (typeof name !== 'string' || !name || name.length > 500 || name.includes('\\') || /[\x00-\x1f\x7f:]/.test(name)) return false;
  const parts = name.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function plain(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('UPDATE_STORAGE', errors.UPDATE_STORAGE);
  return stat;
}
function within(root, name) {
  if (!relativeName(name)) fail('UPDATE_STORAGE', errors.UPDATE_STORAGE);
  const parts = name.split('/'); let current = root; plain(root, true);
  for (const part of parts.slice(0, -1)) { current = path.join(current, part); plain(current, true); }
  return plain(path.join(root, name));
}
function json(file, limit = UPDATE_LIMITS.metadata) {
  if (plain(file).size > limit) fail('UPDATE_STORAGE', errors.UPDATE_STORAGE);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function atomic(file, data) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`, fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function manifest(root) {
  const value = json(path.join(root, 'package.json'));
  if (value.name !== 'meme-radar-open-source' || !validVersion(value.version) || value.private !== true) fail('UPDATE_LOCAL', errors.UPDATE_LOCAL);
  return value;
}
function dependencyLockFingerprint(root) {
  let value;
  try { value = json(path.join(root, 'package-lock.json')); }
  catch { fail('UPDATE_DEPENDENCIES', errors.UPDATE_DEPENDENCIES); }
  if (!object(value) || !Number.isInteger(value.lockfileVersion) || !object(value.packages) || !object(value.packages[''])) {
    fail('UPDATE_DEPENDENCIES', errors.UPDATE_DEPENDENCIES);
  }
  // npm repeats the application version in these two places. A normal app
  // upgrade changes both even when the dependency graph is byte-for-byte the
  // same, so compare the lock after removing only those version fields.
  value = structuredClone(value);
  delete value.version;
  delete value.packages[''].version;
  return sha(Buffer.from(JSON.stringify(value)));
}

// In-process ZIP extraction: no shell, external archiver, links, ZIP64 or path
// traversal. The complete archive SHA-256 is verified BEFORE this parser runs.
export function archiveFiles(bytes, platform) {
  if (!Buffer.isBuffer(bytes) || bytes.length > UPDATE_LIMITS.archive) fail('UPDATE_ARCHIVE', errors.UPDATE_ARCHIVE);
  try {
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
    if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw Error();
    const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
    if (!count || count > UPDATE_LIMITS.entries || count !== bytes.readUInt16LE(end + 8) || start + size !== end) throw Error();
    const prefix = platform === 'win32' ? 'MemeRadar-OpenSource-Windows/' : platform === 'darwin' ? 'MemeRadar-OpenSource-macOS/' : '';
    if (!prefix) throw Error();
    const names = new Set(), files = [], ranges = []; let offset = start, expanded = 0;
    for (let i = 0; i < count; i++) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50) throw Error();
      const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), packed = bytes.readUInt32LE(offset + 20), length = bytes.readUInt32LE(offset + 24);
      const nameSize = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), disk = bytes.readUInt16LE(offset + 34);
      const mode = bytes.readUInt32LE(offset + 38) >>> 16, local = bytes.readUInt32LE(offset + 42);
      if (flags & ~0x808 || ![0, 8].includes(method) || disk || length > UPDATE_LIMITS.file || (expanded += length) > UPDATE_LIMITS.expanded) throw Error();
      const rawName = bytes.subarray(offset + 46, offset + 46 + nameSize), name = rawName.toString('utf8');
      if (!rawName.equals(Buffer.from(name)) || !name.startsWith(prefix)) throw Error();
      const isDirectory = name.endsWith('/'), relative = name.slice(prefix.length).replace(/\/$/, '');
      offset += 46 + nameSize + extra + comment;
      if (offset > end || mode && ![0, 0o100000, 0o040000].includes(mode & 0o170000)) throw Error();
      if (!relative && name === prefix && isDirectory) continue;
      if (!relativeName(relative) || privateRoots.has(relative.split('/')[0]) || ['.git', '.local-data'].includes(relative.split('/')[0])) throw Error();
      const key = relative.normalize('NFC').toLowerCase(); if (names.has(key)) throw Error(); names.add(key);
      if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw Error();
      const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), dataStart = local + 30 + localName + localExtra;
      if (!bytes.subarray(local + 30, local + 30 + localName).equals(rawName) || dataStart + packed > start) throw Error();
      ranges.push([local, dataStart + packed]);
      if (isDirectory) { if (length || packed) throw Error(); continue; }
      if ((mode & 0o170000) === 0o040000) throw Error();
      const compressed = bytes.subarray(dataStart, dataStart + packed);
      const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(1, length) });
      if (data.length !== length) throw Error();
      files.push({ name: relative, data, mode: mode & 0o111 ? 0o755 : 0o644, sha256: sha(data) });
    }
    if (offset !== end) throw Error();
    ranges.sort((a, b) => a[0] - b[0]); if (ranges.some((range, i) => i && range[0] < ranges[i - 1][1])) throw Error();
    const fileNames = new Set(files.map(file => file.name.toLowerCase()));
    for (const file of files) { const parts = file.name.split('/'); parts.pop(); while (parts.length) { if (fileNames.has(parts.join('/').toLowerCase())) throw Error(); parts.pop(); } }
    if (!['package.json', 'package-lock.json', 'src/main.mjs', 'scripts/supervise.mjs', 'public/index.html'].every(name => fileNames.has(name))) throw Error();
    if (platform === 'win32' && !fileNames.has('runtime/node.exe')) throw Error();
    return files;
  } catch { fail('UPDATE_ARCHIVE', errors.UPDATE_ARCHIVE); }
}
export function verifyLocalRelease(root, expected) {
  if (fs.existsSync(path.join(root, '.git'))) fail('UPDATE_LOCAL', errors.UPDATE_LOCAL);
  const wanted = new Map(expected.map(file => [file.name, file.sha256]));
  for (const [name, hash] of wanted) {
    if (!relativeName(name) || !/^[a-f0-9]{64}$/.test(hash) || privateRoots.has(name.split('/')[0])) fail('UPDATE_LOCAL', errors.UPDATE_LOCAL);
    const file = path.join(root, name);
    let actual; try { actual = within(root, name); } catch { fail('UPDATE_LOCAL', errors.UPDATE_LOCAL); }
    if (actual.size > UPDATE_LIMITS.file || sha(fs.readFileSync(file)) !== hash) fail('UPDATE_LOCAL', errors.UPDATE_LOCAL);
  }
  const walk = (directory, relative = '') => {
    for (const name of fs.readdirSync(directory)) {
      if ((!relative && ignoredLocal.has(name)) || name === '.DS_Store') continue;
      const next = relative ? `${relative}/${name}` : name, absolute = path.join(directory, name), stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('UPDATE_LOCAL', errors.UPDATE_LOCAL);
      if (stat.isDirectory()) walk(absolute, next);
      else if (!stat.isFile() || !wanted.has(next)) fail('UPDATE_LOCAL', errors.UPDATE_LOCAL);
    }
  };
  walk(root);
}
function extract(files, root) {
  fs.mkdirSync(root, { mode: 0o700 });
  for (const file of files) {
    const target = path.join(root, file.name); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, file.data, { flag: 'wx', mode: file.mode });
  }
}
function publicStatus(value) {
  return { phase: value.phase, code: value.code || null, message: value.message || '', currentVersion: value.currentVersion,
    availableVersion: value.availableVersion || null, assetName: value.assetName || null, checkedAt: value.checkedAt || null,
    canInstall: value.canInstall === true, restartRequired: value.phase === 'handoff', repository: UPDATE_REPOSITORY };
}
function safeEnvironment(port) {
  const result = { RADAR_PORT: String(port) };
  for (const key of ['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','HOME','USERPROFILE','LANG','LC_ALL','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy']) if (process.env[key]) result[key] = process.env[key];
  return result;
}
async function getBytes(fetchImpl, url, limit, signal, redirects = false) {
  let response;
  try {
    for (let count = 0; count < 4; count++) {
      response = await fetchImpl(url, { headers: { Accept: url.startsWith(API) ? 'application/vnd.github+json' : 'application/octet-stream', 'User-Agent': 'MemeRadar-Community-Updater' }, redirect: 'manual', credentials: 'omit', signal });
      if ([301, 302, 303, 307, 308].includes(response.status) && redirects) {
        const next = new URL(response.headers.get('location'), url);
        await response.body?.cancel();
        if (next.protocol !== 'https:' || next.port || next.username || next.password || next.hash || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname)) throw Error();
        url = next.href; continue;
      }
      if (response.status !== 200 || response.redirected || Number(response.headers.get('content-length')) > limit || !response.body?.getReader) throw Error();
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; if ((size += part.value.byteLength) > limit) throw Error(); chunks.push(Buffer.from(part.value)); } }
      finally { await reader.cancel().catch(() => {}); }
      return Buffer.concat(chunks, size);
    }
  } catch { try { await response?.body?.cancel(); } catch {} fail('UPDATE_NETWORK', errors.UPDATE_NETWORK); }
  fail('UPDATE_NETWORK', errors.UPDATE_NETWORK);
}
function releaseData(value, version, platform, arch) {
  if (!object(value) || value.draft !== false || value.prerelease !== false || value.tag_name !== `v${version}` || !Array.isArray(value.assets)) fail('UPDATE_VERSION', errors.UPDATE_VERSION);
  const names = [releaseAssetName(version, platform, arch), `SHA256SUMS-${version}.txt`];
  return names.map((name, index) => {
    const assets = value.assets.filter(item => item?.name === name); const item = assets[0];
    if (assets.length !== 1 || item.state !== 'uploaded' || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > (index ? UPDATE_LIMITS.checksums : UPDATE_LIMITS.archive)
      || item.browser_download_url !== `${RELEASE}v${version}/${name}` || item.digest != null && !/^sha256:[a-f0-9]{64}$/.test(item.digest)) fail('UPDATE_CHECKSUM', errors.UPDATE_CHECKSUM);
    return { name, size: item.size, url: item.browser_download_url, digest: item.digest || null };
  });
}
export function createUpdater({ root, port = 3791, fetchImpl = fetch, now = Date.now, platform = process.platform, arch = process.arch, spawnImpl = spawn } = {}) {
  root = path.resolve(root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  plain(root, true); if (fs.realpathSync(root) !== root || !Number.isInteger(port) || port < 1024 || port > 65535) fail('UPDATE_STORAGE', errors.UPDATE_STORAGE);
  const currentVersion = manifest(root).version;
  let status = { phase: 'idle', currentVersion }, busy = false, stopped = false, controller;
  const snapshot = () => {
    if (status.phase === 'idle') {
      try {
        within(root, 'state/update-result.json'); const result = json(path.join(root, 'state/update-result.json'), 4096);
        if (result.installedVersion === currentVersion && validVersion(result.version) && ['complete','rolled_back','rollback_blocked'].includes(result.phase)) return publicStatus({ ...status, phase: result.phase,
          availableVersion: result.version, code: Object.hasOwn(errors, result.code) ? result.code : null,
          message: result.phase === 'complete' ? '更新完成；旧目录完整保留。本次后台运行不含守护，后续仍可用原启动入口' : result.phase === 'rolled_back' ? '更新未完成，已恢复并启动原版本；本机数据保留' : '自动回滚未完成；旧目录保留，请先停止异常进程后检查' });
      } catch { /* Only updater-owned bounded status is read; no state or key contents. */ }
    }
    return publicStatus(status);
  };
  const set = value => { status = { ...status, ...value }; return publicStatus(status); };
  const metadata = async version => {
    const bytes = await getBytes(fetchImpl, version ? `${API}/tags/v${version}` : `${API}/latest`, UPDATE_LIMITS.metadata, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]));
    try { return JSON.parse(bytes); } catch { fail('UPDATE_NETWORK', errors.UPDATE_NETWORK); }
  };
  const checked = async () => {
    releaseAssetName(currentVersion, platform, arch);
    const value = await metadata(), version = typeof value?.tag_name === 'string' ? value.tag_name.slice(1) : '';
    if (!validVersion(version)) fail('UPDATE_VERSION', errors.UPDATE_VERSION);
    const assets = releaseData(value, version, platform, arch);
    if (compareVersions(version, currentVersion) <= 0) return { version, assets, available: false };
    return { version, assets, available: true };
  };
  async function checkedArchive(version, assets) {
    const [asset, checksums] = assets, signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
    const sums = await getBytes(fetchImpl, checksums.url, UPDATE_LIMITS.checksums, signal, true);
    if (sums.length !== checksums.size || checksums.digest && `sha256:${sha(sums)}` !== checksums.digest) fail('UPDATE_CHECKSUM', errors.UPDATE_CHECKSUM);
    const lines = sums.toString('utf8').split(/\r?\n/).map(line => /^([a-fA-F0-9]{64}) [ *]([^\r\n]+)$/.exec(line)).filter(line => line?.[2] === asset.name);
    if (lines.length !== 1) fail('UPDATE_CHECKSUM', errors.UPDATE_CHECKSUM);
    const bytes = await getBytes(fetchImpl, asset.url, UPDATE_LIMITS.archive, signal, true), hash = sha(bytes);
    if (bytes.length !== asset.size || hash !== lines[0][1].toLowerCase() || asset.digest && asset.digest !== `sha256:${hash}`) fail('UPDATE_CHECKSUM', errors.UPDATE_CHECKSUM);
    const files = archiveFiles(bytes, platform), packageFile = files.find(file => file.name === 'package.json');
    let pkg; try { pkg = JSON.parse(packageFile.data); } catch { fail('UPDATE_ARCHIVE', errors.UPDATE_ARCHIVE); }
    if (pkg.name !== 'meme-radar-open-source' || pkg.version !== version || pkg.private !== true) fail('UPDATE_VERSION', errors.UPDATE_VERSION);
    return files;
  }
  async function operation(fn) {
    if (busy || stopped || status.phase === 'handoff') fail('UPDATE_BUSY', errors.UPDATE_BUSY);
    busy = true; controller = new AbortController();
    try { return await fn(); }
    catch (error) { const e = fixed(error); set({ phase: 'blocked', code: e.code, message: e.message, canInstall: false }); throw e; }
    finally { busy = false; }
  }
  return {
    snapshot,
    check: () => operation(async () => {
      set({ phase: 'checking', code: null, message: '正在检查官方稳定版本', canInstall: false });
      const result = await checked(), local = fs.existsSync(path.join(root, '.git'));
      return set({ phase: local ? 'blocked' : result.available ? 'available' : 'current', code: local ? 'UPDATE_LOCAL' : null,
        message: local ? errors.UPDATE_LOCAL : result.available ? '发现新稳定版本；确认后下载并校验，成功后重启' : '暂无更高的稳定版本；不会降级或重装当前版本',
        availableVersion: result.available ? result.version : null, assetName: result.assets[0].name, checkedAt: now(), canInstall: result.available && !local });
    }),
    install: input => operation(async () => {
      if (!object(input) || Object.keys(input).some(key => !['version', 'confirm'].includes(key)) || input.confirm !== 'INSTALL_UPDATE' || !validVersion(input.version)
        || compareVersions(input.version, currentVersion) <= 0) fail('UPDATE_VERSION', errors.UPDATE_VERSION);
      if (fs.existsSync(path.join(root, '.git'))) fail('UPDATE_LOCAL', errors.UPDATE_LOCAL);
      const parent = path.dirname(root); plain(parent, true);
      const lockFile = path.join(parent, `.meme-radar-update-${sha(root).slice(0, 16)}.lock`); let lock, work, handed = false;
      try {
        try { lock = fs.openSync(lockFile, 'wx', 0o600); } catch { fail('UPDATE_BUSY', errors.UPDATE_BUSY); }
        set({ phase: 'verifying', code: null, message: '校验目标版本与当前安装；暂不停止扫描', canInstall: false });
        const latest = await checked(); if (!latest.available || latest.version !== input.version) fail('UPDATE_VERSION', errors.UPDATE_VERSION);
        const baselineMeta = await metadata(currentVersion), baseline = await checkedArchive(currentVersion, releaseData(baselineMeta, currentVersion, platform, arch));
        verifyLocalRelease(root, baseline);
        const files = await checkedArchive(latest.version, latest.assets);
        if (stopped || controller.signal.aborted) fail('UPDATE_HANDOFF', errors.UPDATE_HANDOFF);
        work = fs.mkdtempSync(path.join(parent, '.meme-radar-update-')); fs.chmodSync(work, 0o700);
        const next = path.join(work, 'next'); extract(files, next);
        if (platform === 'darwin') {
          let dependency; try { within(root, 'node_modules/gmgn-cli/package.json'); dependency = json(path.join(root, 'node_modules/gmgn-cli/package.json')); } catch { fail('UPDATE_DEPENDENCIES', errors.UPDATE_DEPENDENCIES); }
          if (dependencyLockFingerprint(root) !== dependencyLockFingerprint(next)
            || dependency.version !== manifest(next).dependencies?.['gmgn-cli']) fail('UPDATE_DEPENDENCIES', errors.UPDATE_DEPENDENCIES);
          copyTree(path.join(root, 'node_modules'), path.join(next, 'node_modules'), { links: true });
        }
        const expected = baseline.map(({ name, sha256 }) => ({ name, sha256 }));
        const plan = { schema: 1, root, work, port, platform, arch, parentPid: process.pid, oldVersion: currentVersion, version: latest.version,
          execPath: process.execPath, expected, staged: files.map(({ name, sha256 }) => ({ name, sha256 })), lockFile };
        fs.mkdirSync(path.join(work, 'src')); fs.mkdirSync(path.join(work, 'scripts'));
        for (const [source, target] of [['src/updater.mjs','src/updater.mjs'], ['scripts/update-worker.mjs','scripts/update-worker.mjs']]) {
          plain(path.join(root, source)); fs.copyFileSync(path.join(root, source), path.join(work, target));
        }
        // Windows locks running executables. macOS can rename the running image;
        // retain its existing path so system Node's dynamic libraries still work.
        let workerNode = process.execPath;
        if (platform === 'win32') { workerNode = path.join(work, 'worker-node.exe'); fs.copyFileSync(process.execPath, workerNode); fs.chmodSync(workerNode, 0o700); }
        atomic(path.join(work, 'plan.json'), plan);
        const child = spawnImpl(workerNode, [path.join(work, 'scripts/update-worker.mjs'), path.join(work, 'plan.json')], {
          cwd: work, env: safeEnvironment(port), detached: true, windowsHide: true, stdio: 'ignore', shell: false });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref(); handed = true;
        return set({ phase: 'handoff', availableVersion: latest.version, assetName: latest.assets[0].name, message: '校验完成，等待旧进程正常退出后安装；失败保留旧目录并回滚', canInstall: false });
      } finally { if (lock !== undefined) fs.closeSync(lock); if (!handed && lock !== undefined) fs.unlinkSync(lockFile); }
    }),
    stop() { stopped = true; controller?.abort(); },
  };
}

// This copies local data only AFTER the old server exits. Never follow links in
// state/config; relative dependency/runtime links must stay within that tree.
export function copyTree(source, target, { links = false, privateData = false } = {}) {
  const origin = fs.realpathSync(source); let total = 0, count = 0;
  const copy = (from, to) => {
    if (++count > 50000) fail('UPDATE_STORAGE', errors.UPDATE_STORAGE);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(from), resolved = fs.realpathSync(from);
      if (!links || path.isAbsolute(link) || resolved !== origin && !resolved.startsWith(origin + path.sep)) fail('UPDATE_STORAGE', errors.UPDATE_STORAGE);
      fs.symlinkSync(link, to); return;
    }
    if (stat.isDirectory()) { fs.mkdirSync(to, { mode: 0o700 }); for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name)); return; }
    if (!stat.isFile() || stat.nlink !== 1 || (total += stat.size) > 2_000_000_000) fail('UPDATE_STORAGE', errors.UPDATE_STORAGE);
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, privateData ? 0o600 : stat.mode & 0o777);
  };
  copy(source, target);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const portFree = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port }); socket.setTimeout(1500);
  const end = free => { socket.destroy(); resolve(free); };
  socket.once('connect', () => end(false)); socket.once('timeout', () => end(false)); socket.once('error', error => end(error.code === 'ECONNREFUSED'));
});
async function health(port, expected, version) {
  return new Promise(resolve => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 1500 }, response => {
      let body = ''; response.on('data', data => { body += data; if (body.length > 32768) request.destroy(); });
      response.on('end', () => { try { const value = JSON.parse(body); resolve(response.statusCode === 200 && value.service === 'meme-radar' && value.execution === false && value.instanceId === expected && (value.version || value.appVersion) === version); } catch { resolve(false); } });
    });
    request.on('error', () => resolve(false)); request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}
export async function runUpdateWorker(planFile, { isAlive = alive, pause = sleep, spawnImpl = spawn, healthImpl = health, portFreeImpl = portFree } = {}) {
  const work = path.dirname(path.resolve(planFile)); plain(work, true);
  if (fs.realpathSync(work) !== work || path.basename(planFile) !== 'plan.json' || !path.basename(work).startsWith('.meme-radar-update-')) fail('UPDATE_STORAGE', errors.UPDATE_STORAGE);
  const plan = json(planFile, 8_000_000), root = plan.root, next = path.join(work, 'next'), backup = path.join(work, 'previous');
  if (plan.schema !== 1 || plan.work !== work || typeof root !== 'string' || path.dirname(root) !== path.dirname(work) || root === work || !Number.isSafeInteger(plan.parentPid) || plan.parentPid <= 0
    || !Number.isInteger(plan.port) || plan.port < 1024 || plan.port > 65535 || compareVersions(plan.version, plan.oldVersion) <= 0
    || plan.lockFile !== path.join(path.dirname(root), `.meme-radar-update-${sha(root).slice(0,16)}.lock`)
    || !Array.isArray(plan.expected) || !Array.isArray(plan.staged)) fail('UPDATE_STORAGE', errors.UPDATE_STORAGE);
  releaseAssetName(plan.version, plan.platform, plan.arch); plain(root, true); plain(next, true);
  let swapped = false, renamed = false, verifiedOld = false, child;
  const write = (phase, code = null) => atomic(path.join(work, 'result.json'), { phase, code, version: plan.version, at: Date.now() });
  const visible = (phase, code = null) => {
    write(phase, code);
    fs.mkdirSync(path.join(root, 'state'), { recursive: true, mode: 0o700 }); plain(path.join(root, 'state'), true);
    atomic(path.join(root, 'state/update-result.json'), { phase, code, version: plan.version, installedVersion: manifest(root).version });
  };
  const launch = () => {
    const executable = plan.platform === 'win32' ? path.join(root, 'runtime/node.exe')
      : plan.execPath.startsWith(root + path.sep) ? path.join(root, path.relative(root, plan.execPath)) : plan.execPath;
    plain(executable); fs.mkdirSync(path.join(root, 'logs'), { recursive: true, mode: 0o700 }); plain(path.join(root, 'logs'), true);
    const log = path.join(root, 'logs/update-launch.log'); if (fs.existsSync(log)) plain(log);
    const fd = fs.openSync(log, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { const proc = spawnImpl(executable, ['--use-env-proxy', path.join(root, 'src/main.mjs')], { cwd: root, env: safeEnvironment(plan.port), detached: true, windowsHide: true, stdio: ['ignore', fd, fd], shell: false }); proc.on('error', () => { proc.updateSpawnFailed = true; }); proc.unref(); return proc; }
    finally { fs.closeSync(fd); }
  };
  const waitHealthy = async (proc, version) => {
    const expectedId = sha(path.join(root, 'public')).slice(0, 16);
    for (let i = 0; i < 60; i++) {
      if (proc.updateSpawnFailed || proc.exitCode !== null && proc.exitCode !== undefined) return false;
      if (await healthImpl(plan.port, expectedId, version)) return true;
      await pause(1000);
    }
    return false;
  };
  try {
    write('waiting_exit');
    for (let i = 0; isAlive(plan.parentPid) && i < 120; i++) await pause(1000);
    if (isAlive(plan.parentPid)) fail('UPDATE_HANDOFF', errors.UPDATE_HANDOFF);
    if (!await portFreeImpl(plan.port)) fail('UPDATE_HANDOFF', errors.UPDATE_HANDOFF);
    if (manifest(root).version !== plan.oldVersion || manifest(next).version !== plan.version) fail('UPDATE_VERSION', errors.UPDATE_VERSION);
    verifyLocalRelease(root, plan.expected); verifyLocalRelease(next, plan.staged); verifiedOld = true;
    write('copying_state');
    for (const name of privateRoots) if (fs.existsSync(path.join(root, name))) copyTree(path.join(root, name), path.join(next, name), { links: name === '.runtime', privateData: name !== '.runtime' });
    write('installing');
    for (let i = 0; ; i++) { try { fs.renameSync(root, backup); renamed = true; break; } catch { if (i >= 30) fail('UPDATE_STORAGE', errors.UPDATE_STORAGE); await pause(1000); } }
    fs.renameSync(next, root); swapped = true;
    child = launch();
    if (await waitHealthy(child, plan.version)) { visible('complete'); return { phase: 'complete', version: plan.version }; }
    fail('UPDATE_START', errors.UPDATE_START);
  } catch (error) {
    const e = fixed(error);
    if (child && Number.isInteger(child.pid) && child.pid > 0) {
      child.kill('SIGTERM');
      for (let i = 0; isAlive(child.pid) && i < 10; i++) await pause(1000);
      if (isAlive(child.pid)) { visible('rollback_blocked', 'UPDATE_START'); throw new UpdateError('UPDATE_START', '新进程未退出；已停止回滚，旧目录仍完整保留'); }
    }
    if (renamed) {
      if (swapped) fs.renameSync(root, path.join(work, 'failed-version'));
      fs.renameSync(backup, root);
      const restored = launch(); visible(await waitHealthy(restored, plan.oldVersion) ? 'rolled_back' : 'rollback_blocked', e.code);
    } else if (verifiedOld) { const restored = launch(); visible(await waitHealthy(restored, plan.oldVersion) ? 'rolled_back' : 'rollback_blocked', e.code); }
    else write('blocked', e.code);
    throw e;
  } finally { try { fs.unlinkSync(plan.lockFile); } catch {} }
}
