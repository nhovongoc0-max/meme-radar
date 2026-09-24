#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { deflateRawSync } from 'node:zlib';
import { archiveFiles, compareVersions, releaseAssetName, UPDATE_LIMITS } from '../../src/updater.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../..');
const repository = 'nhovongoc0-max/meme-radar';
const api = `https://api.github.com/repos/${repository}/releases`;
const download = `https://github.com/${repository}/releases/download/`;
const oldRequiredVersion = '0.1.9';
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const fail = message => { throw new Error(message); };

function plainFile(file, label, maximum = Number.MAX_SAFE_INTEGER) {
  file = path.resolve(file || '');
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(`${label}不存在：${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maximum) {
    fail(`${label}必须是大小受限的普通文件`);
  }
  return file;
}

function manifestFromArchive(bytes, platform) {
  const files = archiveFiles(bytes, platform), manifestFile = files.find(file => file.name === 'package.json');
  let manifest;
  try { manifest = JSON.parse(manifestFile.data); } catch { fail('发布包 package.json 无效'); }
  if (manifest?.name !== 'meme-radar-open-source' || manifest.private !== true || typeof manifest.version !== 'string') {
    fail('发布包身份或版本无效');
  }
  return { files, manifest };
}

export function checksumForAsset(contents, assetName) {
  const matches = String(contents).split(/\r?\n/).map(line => /^([a-fA-F0-9]{64}) [ *]([^\r\n]+)$/.exec(line))
    .filter(match => match?.[2] === assetName);
  if (matches.length !== 1) fail(`SHA256 文件必须恰好包含一行 ${assetName}`);
  return matches[0][1].toLowerCase();
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// The failure fixture is intentionally rebuilt in-process so the same test is
// usable on clean macOS and Windows runners without PowerShell/Info-ZIP
// differences. Every candidate file is retained byte-for-byte except main.mjs.
export function deriveStartupFailureArchive(candidateBytes, platform) {
  const source = archiveFiles(candidateBytes, platform);
  const files = source.map(file => file.name === 'src/main.mjs'
    ? { ...file, data: Buffer.from('throw new Error("synthetic package-update-e2e startup failure");\n') }
    : { ...file, data: Buffer.from(file.data) });
  if (!files.some(file => file.name === 'src/main.mjs')) fail('候选包缺少 src/main.mjs');
  const prefix = platform === 'win32' ? 'MemeRadar-OpenSource-Windows/' : 'MemeRadar-OpenSource-macOS/';
  const body = [], central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(`${prefix}${file.name}`, 'utf8'), data = Buffer.from(file.data), crc = crc32(data);
    const compressed = deflateRawSync(data, { level: 9 });
    const packed = compressed.length < data.length ? compressed : data, method = packed === data ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(packed.length, 20);
    directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((((file.mode === 0o755 ? 0o100755 : 0o100644) << 16) >>> 0), 38);
    directory.writeUInt32LE(offset, 42);
    body.push(local, name, packed); central.push(directory, name); offset += local.length + name.length + packed.length;
  }
  const directoryBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  const result = Buffer.concat([...body, directoryBytes, end]);
  const derived = archiveFiles(result, platform), original = new Map(source.map(file => [file.name, file.sha256]));
  assert.deepEqual(derived.map(file => file.name), source.map(file => file.name));
  for (const file of derived) {
    if (file.name === 'src/main.mjs') assert.notEqual(file.sha256, original.get(file.name));
    else assert.equal(file.sha256, original.get(file.name), `故障包意外改动了 ${file.name}`);
  }
  return result;
}

function writeArchiveTree(root, files) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = path.join(root, ...file.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, file.data, { flag: 'wx', mode: file.mode });
    if (process.platform !== 'win32') fs.chmodSync(target, file.mode);
  }
}

function verifyArchiveTree(root, files, label) {
  for (const file of files) {
    const target = path.join(root, ...file.name.split('/'));
    let stat;
    try { stat = fs.lstatSync(target); } catch { fail(`${label}缺少 ${file.name}`); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || sha256(fs.readFileSync(target)) !== file.sha256) {
      fail(`${label}内容不完整：${file.name}`);
    }
  }
}

function safeChildEnvironment(extra = {}) {
  const output = { ...extra };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL']) {
    if (process.env[key]) output[key] = process.env[key];
  }
  return output;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function readHealth(port) {
  return new Promise(resolve => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 1500 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 32768) request.destroy(); });
      response.on('end', () => {
        try { resolve(response.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); }
      });
    });
    request.on('error', () => resolve(null)); request.on('timeout', () => { request.destroy(); resolve(null); });
  });
}

async function waitFor(description, fn, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await pause(250);
  }
  fail(`${description}超时${last instanceof Error ? `：${last.message}` : ''}`);
}

async function stopService(root, port) {
  let pids = [];
  if (process.platform === 'win32') {
    try {
      const { stdout } = await exec('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^\s*TCP\s+\S+:([0-9]+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
        if (match && Number(match[1]) === port) pids.push(Number(match[2]));
      }
    } catch { /* A failed health assertion remains the primary error. */ }
    for (const pid of new Set(pids)) {
      try { await exec('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch { /* Already exited. */ }
    }
  } else {
    try {
      const { stdout } = await exec('ps', ['-axo', 'pid=,command='], { maxBuffer: 4 * 1024 * 1024 });
      pids = stdout.split(/\r?\n/).map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
        .filter(match => match[2].includes(path.join(root, 'src/main.mjs'))).map(match => Number(match[1]));
    } catch { /* Already exited. */ }
    for (const pid of new Set(pids)) { try { process.kill(pid, 'SIGTERM'); } catch { /* Already exited. */ } }
    await pause(300);
    for (const pid of new Set(pids)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
  }
  await waitFor('更新测试服务停止', async () => !(await readHealth(port)), 10_000).catch(() => {});
}

function updateDirectories(parent, before) {
  return fs.readdirSync(parent).filter(name => name.startsWith('.meme-radar-update-'))
    .map(name => path.join(parent, name)).filter(file => !before.has(path.basename(file)) && fs.lstatSync(file).isDirectory());
}

function writeDriverConfig(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
}

async function runDriver(configFile) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--driver', configFile], {
    cwd: path.dirname(configFile), env: safeChildEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL'); reject(new Error('旧版 createUpdater 驱动 180 秒超时'));
    }, 180_000);
    timer.unref();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', value => { clearTimeout(timer); resolve(value); });
  });
  if (code !== 0) fail(`旧版 createUpdater 驱动失败 (exit ${code})\n${stderr || stdout}`);
  let result;
  try { result = JSON.parse(stdout.trim()); } catch { fail(`旧版 createUpdater 未返回有效结果：${stdout || stderr}`); }
  if (result.phase !== 'handoff' || result.restartRequired !== true) fail('旧版 createUpdater 未进入真实交接阶段');
}

function prepareInstall({ parent, oldArchive, oldFiles, platform, nodeModules }) {
  const root = path.join(parent, 'MemeRadar-OpenSource');
  writeArchiveTree(root, oldFiles);
  assert.equal(fs.existsSync(path.join(root, '.git')), false, '旧版安装不得含 .git');
  if (platform === 'darwin') {
    const modules = path.resolve(nodeModules || path.join(sourceRoot, 'node_modules'));
    if (!fs.existsSync(path.join(modules, 'gmgn-cli', 'package.json'))) fail('macOS 演练需要 --node-modules 指向 npm ci 后的依赖目录');
    fs.cpSync(modules, path.join(root, 'node_modules'), {
      recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true,
    });
  }
  const marker = { schema: 1, id: crypto.randomUUID(), oldArchiveSha256: sha256(oldArchive) };
  fs.mkdirSync(path.join(root, 'state'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'state/package-update-e2e-marker.json'), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  return { root, marker };
}

async function exerciseScenario({ temporary, label, oldArchive, oldFiles, oldVersion, candidateArchive, candidateVersion, candidateChecksums,
  oldChecksums, platform, arch, nodeModules, expectRollback }) {
  const parent = path.join(temporary, label); fs.mkdirSync(parent, { mode: 0o700 });
  const { root, marker } = prepareInstall({ parent, oldArchive, oldFiles, platform, nodeModules });
  const oldPath = path.join(parent, path.basename(releaseAssetName(oldVersion, platform, arch)));
  const candidateName = releaseAssetName(candidateVersion, platform, arch), candidatePath = path.join(parent, candidateName);
  const checksumsPath = path.join(parent, `SHA256SUMS-${candidateVersion}.txt`);
  const oldChecksumsPath = path.join(parent, `SHA256SUMS-${oldVersion}.txt`);
  fs.writeFileSync(oldPath, oldArchive, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(candidatePath, candidateArchive, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(checksumsPath, candidateChecksums, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(oldChecksumsPath, oldChecksums, { flag: 'wx', mode: 0o600 });
  const port = await freePort(), before = new Set(fs.readdirSync(parent));
  const configFile = path.join(parent, 'driver.json');
  writeDriverConfig(configFile, { root, oldPath, candidatePath, checksumsPath, oldChecksumsPath,
    oldVersion, candidateVersion, platform, arch, port });
  try {
    await runDriver(configFile);
    const expectedVersion = expectRollback ? oldVersion : candidateVersion;
    const health = await waitFor(`${label} /health`, async () => {
      const value = await readHealth(port);
      return value?.service === 'meme-radar' && value.execution === false && (value.version || value.appVersion) === expectedVersion ? value : null;
    });
    assert.equal(health.version || health.appVersion, expectedVersion);
    const result = await waitFor(`${label} update-result`, async () => {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(root, 'state/update-result.json'), 'utf8'));
        return ['complete', 'rolled_back', 'rollback_blocked'].includes(value.phase) ? value : null;
      } catch { return null; }
    });
    assert.equal(result.phase, expectRollback ? 'rolled_back' : 'complete');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, expectedVersion);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'state/package-update-e2e-marker.json'), 'utf8')), marker);
    assert.equal(fs.existsSync(path.join(root, '.git')), false);
    const work = await waitFor(`${label} 更新工作目录`, async () => updateDirectories(parent, before)[0] || null);
    if (expectRollback) {
      verifyArchiveTree(root, oldFiles, '回滚后的 v0.1.9 根目录');
      assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'failed-version/package.json'), 'utf8')).version, candidateVersion);
      assert.equal(fs.existsSync(path.join(work, 'previous')), false, '回滚后旧目录已恢复原位');
    } else {
      const previous = path.join(work, 'previous');
      verifyArchiveTree(previous, oldFiles, 'previous 完整备份');
      assert.equal(JSON.parse(fs.readFileSync(path.join(previous, 'package.json'), 'utf8')).version, oldVersion);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(previous, 'state/package-update-e2e-marker.json'), 'utf8')), marker);
    }
    return { label, phase: result.phase, version: expectedVersion };
  } finally { await stopService(root, port); }
}

export function parseCli(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!value || !['--old', '--candidate', '--checksums', '--sha256', '--old-checksums', '--old-sha256', '--platform', '--arch', '--node-modules'].includes(flag)
      || Object.hasOwn(output, flag)) fail('用法：node scripts/testing/package-update-e2e.mjs --old <v0.1.9 ZIP> --candidate <候选 ZIP> (--checksums <SHA256SUMS> | --sha256 <hash>) [--old-checksums <SHA256SUMS> | --old-sha256 <hash>]');
    output[flag] = value;
  }
  if (!output['--old'] || !output['--candidate'] || Boolean(output['--checksums']) === Boolean(output['--sha256'])) {
    fail('必须提供旧版 ZIP、候选 ZIP，且在 --checksums / --sha256 中二选一');
  }
  if (Boolean(output['--old-checksums']) === Boolean(output['--old-sha256'])) {
    fail('必须在 --old-checksums / --old-sha256 中二选一，不允许对未信任旧包现场生成哈希');
  }
  return {
    old: output['--old'], candidate: output['--candidate'], checksums: output['--checksums'], sha256: output['--sha256'],
    oldChecksums: output['--old-checksums'], oldSha256: output['--old-sha256'], platform: output['--platform'] || process.platform,
    arch: output['--arch'] || process.arch, nodeModules: output['--node-modules'],
  };
}

export async function runPackageUpdateE2E(options) {
  const platform = options.platform || process.platform, arch = options.arch || process.arch;
  if (!['darwin', 'win32'].includes(platform) || platform === 'win32' && arch !== 'x64' || platform === 'darwin' && !['arm64', 'x64'].includes(arch)) {
    fail('真实更新演练仅支持 macOS arm64/x64 与 Windows x64');
  }
  if (platform !== process.platform) fail(`必须在目标系统实测：当前 ${process.platform}，目标 ${platform}`);
  if (Boolean(options.oldChecksums) === Boolean(options.oldSha256)) {
    fail('必须且只能提供一个官方旧版信任源');
  }
  const oldPath = plainFile(options.old, '官方旧版 ZIP', UPDATE_LIMITS.archive);
  const candidatePath = plainFile(options.candidate, '候选 ZIP', UPDATE_LIMITS.archive);
  const oldArchive = fs.readFileSync(oldPath), candidateArchive = fs.readFileSync(candidatePath);
  const oldParsed = manifestFromArchive(oldArchive, platform), candidateParsed = manifestFromArchive(candidateArchive, platform);
  const oldVersion = oldParsed.manifest.version, candidateVersion = candidateParsed.manifest.version;
  if (oldVersion !== oldRequiredVersion || compareVersions(candidateVersion, oldVersion) <= 0) fail('必须从官方 v0.1.9 演练升级到更高稳定版');
  const oldName = releaseAssetName(oldVersion, platform, arch), candidateName = releaseAssetName(candidateVersion, platform, arch);
  if (path.basename(oldPath) !== oldName || path.basename(candidatePath) !== candidateName) fail('发布 ZIP 文件名与版本/平台不一致');
  const candidateHash = options.checksums
    ? checksumForAsset(fs.readFileSync(plainFile(options.checksums, 'SHA256SUMS', UPDATE_LIMITS.checksums), 'utf8'), candidateName)
    : String(options.sha256 || '').toLowerCase();
  if (!validHash(candidateHash) || sha256(candidateArchive) !== candidateHash) fail('候选 ZIP 的 SHA-256 校验失败');
  const providedOldChecksums = options.oldChecksums
    ? fs.readFileSync(plainFile(options.oldChecksums, '旧版 SHA256SUMS', UPDATE_LIMITS.checksums)) : null;
  const oldHash = providedOldChecksums
    ? checksumForAsset(providedOldChecksums.toString('utf8'), oldName)
    : options.oldSha256 ? String(options.oldSha256).toLowerCase() : null;
  if (oldHash && (!validHash(oldHash) || sha256(oldArchive) !== oldHash)) fail('官方旧版 ZIP 的 SHA-256 校验失败');
  const brokenArchive = deriveStartupFailureArchive(candidateArchive, platform);
  const candidateChecksums = options.checksums
    ? fs.readFileSync(plainFile(options.checksums, 'SHA256SUMS', UPDATE_LIMITS.checksums))
    : Buffer.from(`${candidateHash}  ${candidateName}\n`);
  const oldChecksums = providedOldChecksums || Buffer.from(`${oldHash}  ${oldName}\n`);
  const brokenChecksums = Buffer.from(`${sha256(brokenArchive)}  ${candidateName}\n`);
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'meme-radar-package-update-e2e-'));
  fs.chmodSync(temporary, 0o700);
  try {
    const success = await exerciseScenario({ temporary, label: 'success', oldArchive, oldFiles: oldParsed.files, oldVersion,
      candidateArchive, candidateVersion, candidateChecksums, oldChecksums,
      platform, arch, nodeModules: options.nodeModules, expectRollback: false });
    const rollback = await exerciseScenario({ temporary, label: 'rollback', oldArchive, oldFiles: oldParsed.files, oldVersion,
      candidateArchive: brokenArchive, candidateVersion, candidateChecksums: brokenChecksums, oldChecksums,
      platform, arch, nodeModules: options.nodeModules, expectRollback: true });
    return { oldVersion, candidateVersion, platform, arch, success, rollback };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

async function driver(configFile) {
  const config = JSON.parse(fs.readFileSync(plainFile(configFile, '驱动配置', UPDATE_LIMITS.metadata), 'utf8'));
  const oldArchive = fs.readFileSync(plainFile(config.oldPath, '驱动旧版 ZIP', UPDATE_LIMITS.archive));
  const candidateArchive = fs.readFileSync(plainFile(config.candidatePath, '驱动候选 ZIP', UPDATE_LIMITS.archive));
  const candidateChecksums = fs.readFileSync(plainFile(config.checksumsPath, '驱动 SHA256SUMS', UPDATE_LIMITS.checksums));
  const oldChecksums = fs.readFileSync(plainFile(config.oldChecksumsPath, '驱动旧版 SHA256SUMS', UPDATE_LIMITS.checksums));
  const oldName = releaseAssetName(config.oldVersion, config.platform, config.arch);
  const candidateName = releaseAssetName(config.candidateVersion, config.platform, config.arch);
  const oldSumsName = `SHA256SUMS-${config.oldVersion}.txt`, candidateSumsName = `SHA256SUMS-${config.candidateVersion}.txt`;
  const redirected = (version, name) => `https://release-assets.githubusercontent.com/e2e/${version}/${encodeURIComponent(name)}?fixture=1`;
  const asset = (version, name, data) => ({ name, state: 'uploaded', size: data.length, digest: `sha256:${sha256(data)}`,
    browser_download_url: `${download}v${version}/${name}` });
  const release = (version, name, archive, sumsName, sums) => ({ tag_name: `v${version}`, draft: false, prerelease: false,
    assets: [asset(version, name, archive), asset(version, sumsName, sums)] });
  const routes = new Map([
    [`${api}/latest`, release(config.candidateVersion, candidateName, candidateArchive, candidateSumsName, candidateChecksums)],
    [`${api}/tags/v${config.oldVersion}`, release(config.oldVersion, oldName, oldArchive, oldSumsName, oldChecksums)],
    [`${download}v${config.oldVersion}/${oldName}`, { location: redirected(config.oldVersion, oldName) }],
    [`${download}v${config.oldVersion}/${oldSumsName}`, { location: redirected(config.oldVersion, oldSumsName) }],
    [`${download}v${config.candidateVersion}/${candidateName}`, { location: redirected(config.candidateVersion, candidateName) }],
    [`${download}v${config.candidateVersion}/${candidateSumsName}`, { location: redirected(config.candidateVersion, candidateSumsName) }],
    [redirected(config.oldVersion, oldName), oldArchive], [redirected(config.oldVersion, oldSumsName), oldChecksums],
    [redirected(config.candidateVersion, candidateName), candidateArchive], [redirected(config.candidateVersion, candidateSumsName), candidateChecksums],
  ]);
  const fetchImpl = async (url, options) => {
    if (!routes.has(url) || options?.redirect !== 'manual' || options?.credentials !== 'omit') fail(`更新器试图访问未授权地址：${url}`);
    const value = routes.get(url);
    if (value?.location) return new Response(null, { status: 302, headers: { Location: value.location } });
    return Buffer.isBuffer(value) ? new Response(value) : Response.json(value);
  };
  const module = await import(`${pathToFileURL(path.join(config.root, 'src/updater.mjs')).href}?e2e=${crypto.randomUUID()}`);
  const updater = module.createUpdater({ root: config.root, port: config.port, platform: config.platform, arch: config.arch, fetchImpl });
  const checked = await updater.check();
  if (checked.phase !== 'available' || checked.availableVersion !== config.candidateVersion) fail('旧版更新器未识别候选版本');
  const result = await updater.install({ version: config.candidateVersion, confirm: 'INSTALL_UPDATE' });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function cli() {
  try {
    if (process.argv[2] === '--driver') return await driver(process.argv[3]);
    const result = await runPackageUpdateE2E(parseCli(process.argv.slice(2)));
    console.log(`一键更新真实演练通过：v${result.oldVersion} → v${result.candidateVersion} (${result.platform}/${result.arch})`);
    console.log('升级完成、/health 版本、state 保留、previous 备份、启动失败回滚均已验证。');
  } catch (error) {
    const code = typeof error?.code === 'string' ? ` [${error.code}]` : '';
    console.error(`一键更新真实演练失败${code}：${error.message}`);
    if (process.argv[2] === '--driver' && error?.stack) console.error(error.stack);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) await cli();
