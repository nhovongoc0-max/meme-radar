import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { archiveFiles, releaseAssetName, UPDATE_LIMITS } from '../src/updater.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['.git', '.runtime', 'node_modules']);
const forbiddenEntries = new Set(['state', 'logs', '.local-data', '.env', '.npmrc']);
const textExtensions = new Set(['', '.bat', '.command', '.css', '.html', '.js', '.json', '.md', '.mjs', '.sh', '.txt']);
const telegramToken = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/;
export const requiredUpdaterFiles = Object.freeze(['src/updater.mjs', 'scripts/update-worker.mjs', 'public/update-ui.mjs']);
const requiredCommonFiles = Object.freeze([
  'package.json', 'package-lock.json', 'src/main.mjs', 'scripts/supervise.mjs', 'public/index.html', ...requiredUpdaterFiles,
]);
const requiredPlatformFiles = Object.freeze({
  darwin: ['安装并启动.command', 'start-radar.command'],
  win32: ['MemeRadar-OpenSource.exe', 'OPEN-MEME-RADAR.bat', 'runtime/node.exe'],
});
const validVersion = value => typeof value === 'string' && /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(value);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (root, name) => path.join(root, ...name.split('/'));

function localSecrets(root) {
  const values = [];
  const add = value => {
    if (typeof value === 'string' && value.trim() === value && value.length >= 12 && value.length <= 1024) values.push(Buffer.from(value));
  };
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'state', 'ave-credentials.json'), 'utf8'));
    for (const key of ['key', 'token', 'secret']) add(stored?.[key]);
  } catch { /* A clean release source has no local credentials. */ }
  for (const name of ['gmgn-api-key', 'telegram-bot-token', 'agent-private-key', 'gmgn-pending-signing-key.pem']) {
    try { add(fs.readFileSync(path.join(root, 'state', name), 'utf8').trim()); } catch { /* Optional legacy/local secret. */ }
  }
  return [...new Map(values.map(value => [sha256(value), value])).values()];
}

function localPrivatePaths(root) {
  const values = new Set([path.resolve(root), os.homedir()].filter(Boolean));
  for (const value of [...values]) {
    values.add(value.replaceAll('\\', '/'));
    values.add(value.replaceAll('/', '\\'));
  }
  return [...values].filter(value => value.length >= 4).map(value => Buffer.from(value));
}

function inspectContent(data, name, findings, scope, secrets, privatePaths) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (secrets.some(secret => bytes.includes(secret))) findings.push(`${scope}包含本机凭证：${name}`);
  if (privatePaths.some(prefix => bytes.includes(prefix))) {
    findings.push(`${scope}包含个人电脑绝对路径：${name}`);
  }
  if (!textExtensions.has(path.extname(name).toLowerCase()) || bytes.length > UPDATE_LIMITS.metadata) return;
  const content = bytes.toString('utf8');
  if (telegramToken.test(content)) findings.push(`${scope}疑似包含 Telegram Bot Token：${name}`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/]{40,}/.test(content)) findings.push(`${scope}疑似包含私钥：${name}`);
  if (!/(^|\/)(?:node_modules|runtime)(\/|$)/.test(name) && /gmgn_[a-z0-9]{20,}/i.test(content)) {
    findings.push(`${scope}疑似包含 GMGN API Key：${name}`);
  }
}

function plainFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 ? stat : null;
  } catch { return null; }
}

function readJson(file, findings, label) {
  const stat = plainFile(file);
  if (!stat || stat.size > UPDATE_LIMITS.metadata) { findings.push(`${label}缺失、不是普通文件或过大`); return null; }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { findings.push(`${label}不是有效 JSON`); return null; }
}

function validateManifest(manifest, lock, expectedVersion, findings, scope) {
  if (!manifest || manifest.name !== 'meme-radar-open-source' || manifest.private !== true || !validVersion(manifest.version)) {
    findings.push(`${scope} package.json 名称、private 或三段版本无效`);
    return null;
  }
  if (expectedVersion && manifest.version !== expectedVersion) findings.push(`${scope} package.json 版本 ${manifest.version} 与期望 ${expectedVersion} 不一致`);
  if (!lock || lock.name !== manifest.name || lock.version !== manifest.version
    || lock.packages?.['']?.name !== manifest.name || lock.packages?.['']?.version !== manifest.version) {
    findings.push(`${scope} package-lock.json 根版本与 package.json 不一致`);
  }
  return manifest.version;
}

export function auditSourceTree(root = defaultRoot, { secretRoot = root } = {}) {
  root = path.resolve(root);
  const findings = [];
  secretRoot = path.resolve(secretRoot);
  const secrets = localSecrets(secretRoot), privatePaths = localPrivatePaths(secretRoot);
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch { /* handled below */ }
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return { version: null, findings: ['发布源目录缺失或不安全'] };

  for (const file of requiredUpdaterFiles) if (!plainFile(inside(root, file))) findings.push(`发布源缺少必需更新文件：${file}`);
  const manifest = readJson(path.join(root, 'package.json'), findings, '发布源 package.json');
  const lock = readJson(path.join(root, 'package-lock.json'), findings, '发布源 package-lock.json');
  const version = validateManifest(manifest, lock, null, findings, '发布源');

  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!relative && excluded.has(entry.name)) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { findings.push(`发布源不允许符号链接：${next}`); continue; }
      if (forbiddenEntries.has(entry.name) || /^(?:ave-credentials\.json|gmgn-api-key|agent-private-key)$/i.test(entry.name)) {
        findings.push(`不应发布本机配置或状态：${next}`);
        continue;
      }
      if (entry.isDirectory()) { visit(absolute, next); continue; }
      if (!entry.isFile()) { findings.push(`发布源包含不受支持的文件类型：${next}`); continue; }
      if (!textExtensions.has(path.extname(entry.name).toLowerCase()) || entry.name === 'package-lock.json') continue;
      const content = fs.readFileSync(absolute, 'utf8');
      inspectContent(content, next, findings, '发布源', secrets, privatePaths);
    }
  }
  visit(root);
  return { version, findings };
}

function archiveJson(files, name, findings, label) {
  const file = files.find(row => row.name === name);
  if (!file || file.data.length > UPDATE_LIMITS.metadata) { findings.push(`${label}缺失或过大`); return null; }
  try { return JSON.parse(file.data.toString('utf8')); }
  catch { findings.push(`${label}不是有效 JSON`); return null; }
}

function readArtifact(file, limit, findings, label) {
  const stat = plainFile(file);
  if (!stat || stat.size <= 0 || stat.size > limit) { findings.push(`${label}缺失、不是普通文件或大小不合法`); return null; }
  return fs.readFileSync(file);
}

export function auditReleaseArtifacts({ root = defaultRoot, artifactsDir, version, secretRoot = root } = {}) {
  root = path.resolve(root);
  const findings = [];
  secretRoot = path.resolve(secretRoot);
  const secrets = localSecrets(secretRoot), privatePaths = localPrivatePaths(secretRoot);
  if (!validVersion(version)) return { findings: ['无法从发布源确定有效的三段版本'] };
  if (typeof artifactsDir !== 'string' || !artifactsDir) return { findings: ['必须使用 --artifacts <目录> 指定待发布的双平台资产'] };
  artifactsDir = path.resolve(artifactsDir);
  let stat;
  try { stat = fs.lstatSync(artifactsDir); } catch { /* handled below */ }
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return { findings: ['发布资产目录缺失或不安全'] };

  const expected = [releaseAssetName(version, 'win32', 'x64'), releaseAssetName(version, 'darwin', 'arm64'), `SHA256SUMS-${version}.txt`];
  const actual = fs.readdirSync(artifactsDir, { withFileTypes: true });
  for (const name of expected) if (!actual.some(entry => entry.name === name && entry.isFile() && !entry.isSymbolicLink())) findings.push(`缺少发布资产：${name}`);
  for (const entry of actual) if (!expected.includes(entry.name) || !entry.isFile() || entry.isSymbolicLink()) findings.push(`发布资产目录含有未约定项：${entry.name}`);
  if (findings.length) return { findings };

  const checksumName = `SHA256SUMS-${version}.txt`;
  const checksumBytes = readArtifact(path.join(artifactsDir, checksumName), UPDATE_LIMITS.checksums, findings, checksumName);
  const wantedHashes = new Map();
  if (checksumBytes) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(checksumBytes); }
    catch { findings.push(`${checksumName}不是有效 UTF-8`); }
    if (text !== undefined) {
      const lines = text.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const match = /^([a-fA-F0-9]{64}) [ *]([^\r\n]+)$/.exec(line);
        if (!match || !expected.slice(0, 2).includes(match[2]) || wantedHashes.has(match?.[2])) findings.push(`${checksumName}包含无效、重复或未约定的校验行`);
        else wantedHashes.set(match[2], match[1].toLowerCase());
      }
      for (const name of expected.slice(0, 2)) if (!wantedHashes.has(name)) findings.push(`${checksumName}缺少 ${name} 的唯一 SHA-256`);
      if (lines.length !== 2) findings.push(`${checksumName}必须恰好包含两个平台包`);
    }
  }

  const packages = [
    { platform: 'darwin', name: releaseAssetName(version, 'darwin', 'arm64') },
    { platform: 'win32', name: releaseAssetName(version, 'win32', 'x64') },
  ];
  for (const item of packages) {
    const bytes = readArtifact(path.join(artifactsDir, item.name), UPDATE_LIMITS.archive, findings, item.name);
    if (!bytes) continue;
    if (wantedHashes.get(item.name) !== sha256(bytes)) findings.push(`${item.name} 与 ${checksumName} 的 SHA-256 不一致`);
    let files;
    try { files = archiveFiles(bytes, item.platform); }
    catch { findings.push(`${item.name} 根目录、ZIP 结构或平台内容不合法`); continue; }
    for (const file of files) inspectContent(file.data, file.name, findings, item.name, secrets, privatePaths);
    const names = new Set(files.map(file => file.name));
    for (const name of [...requiredCommonFiles, ...requiredPlatformFiles[item.platform]]) {
      if (!names.has(name)) findings.push(`${item.name}缺少必需内容：${name}`);
    }
    const manifest = archiveJson(files, 'package.json', findings, `${item.name} package.json`);
    const lock = archiveJson(files, 'package-lock.json', findings, `${item.name} package-lock.json`);
    validateManifest(manifest, lock, version, findings, item.name);
    for (const name of requiredUpdaterFiles) {
      const packaged = files.find(file => file.name === name), source = inside(root, name);
      if (!packaged || !plainFile(source)) continue;
      if (packaged.data.length === 0 || sha256(packaged.data) !== sha256(fs.readFileSync(source))) findings.push(`${item.name}中的 ${name} 与当前发布源不一致`);
    }
  }
  return { findings };
}

export function auditRelease({ root = defaultRoot, artifactsDir, secretRoot = root } = {}) {
  const source = auditSourceTree(root, { secretRoot });
  const assets = auditReleaseArtifacts({ root, artifactsDir, version: source.version, secretRoot });
  return { version: source.version, findings: [...new Set([...source.findings, ...assets.findings])] };
}

function cli() {
  const args = process.argv.slice(2);
  let artifactsDir, secretRoot = defaultRoot, seenSecretRoot = false, invalid = false;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!value) { invalid = true; break; }
    if (flag === '--artifacts' && !artifactsDir) artifactsDir = value;
    else if (flag === '--secret-root' && !seenSecretRoot) { secretRoot = value; seenSecretRoot = true; }
    else { invalid = true; break; }
  }
  if (invalid) {
    console.error('用法：node scripts/release-audit.mjs --artifacts <包含双平台 ZIP 与 SHA256SUMS 的目录> [--secret-root <本机配置根目录>]');
    process.exitCode = 1; return;
  }
  const result = auditRelease({ root: defaultRoot, artifactsDir, secretRoot });
  if (result.findings.length) {
    console.error('发布审计未通过：');
    for (const finding of result.findings) console.error(`- ${finding}`);
    process.exitCode = 1;
  } else {
    console.log(`发布审计通过：v${result.version} 双平台包、更新器文件、版本与 SHA-256 全部一致。`);
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) cli();
