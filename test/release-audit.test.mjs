import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { auditRelease, auditSourceTree } from '../scripts/release-audit.mjs';

const version = '0.1.8';
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const pkg = value => JSON.stringify({ name: 'meme-radar-open-source', version: value, private: true });
const lock = value => JSON.stringify({ name: 'meme-radar-open-source', version: value, lockfileVersion: 3,
  packages: { '': { name: 'meme-radar-open-source', version: value } } });
const common = value => ({
  'package.json': pkg(value), 'package-lock.json': lock(value),
  'src/main.mjs': '// main', 'src/live-leads.mjs': '// retained live leads', 'src/updater.mjs': '// updater',
  'scripts/supervise.mjs': '// supervise', 'scripts/update-worker.mjs': '// worker',
  'public/index.html': '<main>radar</main>',
});

function zip(input, platform) {
  const prefix = platform === 'darwin' ? 'MemeRadar-OpenSource-macOS/' : 'MemeRadar-OpenSource-Windows/';
  const chunks = [], directory = []; let offset = 0;
  for (const [relative, content] of Object.entries(input)) {
    const name = Buffer.from(prefix + relative), data = Buffer.from(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 * 65536) >>> 0, 38); central.writeUInt32LE(offset, 42);
    chunks.push(local, name, data); directory.push(central, name); offset += local.length + name.length + data.length;
  }
  const tail = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10); end.writeUInt32LE(tail.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, tail, end]);
}

function writeTree(root, files) {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(root, ...name.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
  }
}

function fixture(t, { mac = {}, windows = {}, checksum } = {}) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'release-audit-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'source'), artifactsDir = path.join(parent, 'artifacts');
  const source = common(version); writeTree(root, source); fs.mkdirSync(artifactsDir);
  const macName = `MemeRadar-OpenSource-macOS-${version}.zip`, winName = `MemeRadar-OpenSource-Windows-x64-${version}.zip`;
  const macBytes = zip({ ...common(version), '安装并启动.command': '#!/bin/sh', 'start-radar.command': '#!/bin/sh', ...mac }, 'darwin');
  const winBytes = zip({ ...common(version), 'MemeRadar-OpenSource.exe': 'exe', 'OPEN-MEME-RADAR.bat': '@echo off',
    'README-FIRST.txt': 'Windows portable build', 'runtime/node.exe': 'node', ...windows }, 'win32');
  fs.writeFileSync(path.join(artifactsDir, macName), macBytes); fs.writeFileSync(path.join(artifactsDir, winName), winBytes);
  fs.writeFileSync(path.join(artifactsDir, `SHA256SUMS-${version}.txt`), checksum ?? `${sha(macBytes)}  ${macName}\n${sha(winBytes)}  ${winName}\n`);
  return { root, artifactsDir, macName, winName };
}

test('release audit accepts only matching two-platform packages with release files, versions and SHA256SUMS', t => {
  const value = fixture(t), result = auditRelease(value);
  assert.equal(result.version, version); assert.deepEqual(result.findings, []);
});

test('source audit requires every retained migration component and package-lock version agreement', t => {
  const value = fixture(t); fs.rmSync(path.join(value.root, 'scripts/update-worker.mjs'));
  let result = auditSourceTree(value.root);
  assert.ok(result.findings.some(row => row.includes('scripts/update-worker.mjs')));
  fs.writeFileSync(path.join(value.root, 'scripts/update-worker.mjs'), '// worker');
  fs.writeFileSync(path.join(value.root, 'package-lock.json'), lock('0.1.7'));
  result = auditSourceTree(value.root);
  assert.ok(result.findings.some(row => row.includes('package-lock.json')));
});

test('release audit rejects missing or stale updater files inside either platform package', t => {
  const missing = fixture(t, { mac: { 'scripts/update-worker.mjs': '' } });
  let result = auditRelease(missing);
  assert.ok(result.findings.some(row => row.includes(missing.macName) && row.includes('scripts/update-worker.mjs')));

  const stale = fixture(t, { windows: { 'src/updater.mjs': '// stale updater' } });
  result = auditRelease(stale);
  assert.ok(result.findings.some(row => row.includes(stale.winName) && row.includes('src/updater.mjs') && row.includes('不一致')));
});

test('release audit requires every current publish-source file in both platform packages', t => {
  const value = fixture(t);
  writeTree(value.root, {
    'src/new-production-module.mjs': '// newly added production source',
    'public/new-production-ui.mjs': '// newly added production browser source',
  });
  const result = auditRelease(value);
  for (const name of ['src/new-production-module.mjs', 'public/new-production-ui.mjs']) {
    assert.equal(result.findings.filter(row => row.includes('缺少当前发布源文件') && row.includes(name)).length, 2);
  }
});

test('release audit blocks old archives that omit live-leads or contain stale arbitrary production source', t => {
  const missing = fixture(t, { mac: { 'src/live-leads.mjs': '' } });
  let result = auditRelease(missing);
  assert.ok(result.findings.some(row => row.includes(missing.macName) && row.includes('src/live-leads.mjs')));

  const stale = fixture(t, { windows: { 'src/main.mjs': '// source from an older release' } });
  result = auditRelease(stale);
  assert.ok(result.findings.some(row => row.includes(stale.winName) && row.includes('src/main.mjs') && row.includes('不一致')));
});

test('release audit permits only explicit Windows runtime and dependency extras', t => {
  const windows = fixture(t, { windows: {
    'runtime/support.dll': 'runtime dependency',
    'runtime/node_modules/npm/.npmrc': '',
    'node_modules/example/package.json': '{"name":"example"}',
    'node_modules/example/index.js': 'export default true;',
  } });
  assert.deepEqual(auditRelease(windows).findings, []);

  const mac = fixture(t, { mac: { 'node_modules/example/index.js': 'export default true;' } });
  let result = auditRelease(mac);
  assert.ok(result.findings.some(row => row.includes(mac.macName) && row.includes('node_modules/example/index.js') && row.includes('未约定文件')));

  const configuredRuntime = fixture(t, { windows: { 'runtime/node_modules/npm/.npmrc': '//registry.example/:_authToken=not-for-release' } });
  result = auditRelease(configuredRuntime);
  assert.ok(result.findings.some(row => row.includes(configuredRuntime.winName)
    && row.includes('runtime/node_modules/npm/.npmrc') && row.includes('私密路径')));
});

test('release audit rejects unapproved archive files and nested private paths', t => {
  const extra = fixture(t, { mac: { 'src/removed-legacy-module.mjs': '// no longer in current source' } });
  let result = auditRelease(extra);
  assert.ok(result.findings.some(row => row.includes(extra.macName) && row.includes('src/removed-legacy-module.mjs') && row.includes('未约定文件')));

  const privatePath = fixture(t, { windows: { 'docs/archive/state/ave-credentials.json': '{"key":"secret"}' } });
  result = auditRelease(privatePath);
  assert.ok(result.findings.some(row => row.includes(privatePath.winName)
    && row.includes('docs/archive/state/ave-credentials.json') && row.includes('私密路径')));
});

test('release audit rejects package version drift, wrong asset set and checksum mismatch', t => {
  const drift = fixture(t, { windows: { 'package.json': pkg('0.1.9'), 'package-lock.json': lock('0.1.9') } });
  let result = auditRelease(drift);
  assert.ok(result.findings.some(row => row.includes(drift.winName) && row.includes('0.1.9') && row.includes('0.1.8')));

  const checksum = fixture(t, { checksum: `${'0'.repeat(64)}  MemeRadar-OpenSource-macOS-${version}.zip\n${'1'.repeat(64)}  MemeRadar-OpenSource-Windows-x64-${version}.zip\n` });
  result = auditRelease(checksum);
  assert.equal(result.findings.filter(row => row.includes('SHA-256 不一致')).length, 2);

  const names = fixture(t); fs.renameSync(path.join(names.artifactsDir, names.macName), path.join(names.artifactsDir, `wrong-${names.macName}`));
  result = auditRelease(names);
  assert.ok(result.findings.some(row => row.includes('缺少发布资产') && row.includes(names.macName)));
  assert.ok(result.findings.some(row => row.includes('未约定项') && row.includes(`wrong-${names.macName}`)));
});

test('full audit cannot pass without an explicit built-artifact directory', t => {
  const value = fixture(t), result = auditRelease({ root: value.root });
  assert.ok(result.findings.some(row => row.includes('--artifacts')));
});

test('release audit rejects the locally configured AVE key even when hidden in an unrelated archive file', t => {
  const secret = 'AveLocalCredentialForReleaseAuditOnly1234567890ABCDEFGH';
  const value = fixture(t, { mac: { 'src/unrelated.txt': `value=${secret}` } });
  writeTree(value.root, { 'state/ave-credentials.json': JSON.stringify({ key: secret }) });
  const result = auditRelease(value);
  assert.ok(result.findings.some(row => row.includes(value.macName) && row.includes('包含本机凭证') && row.includes('src/unrelated.txt')));
});

test('release audit rejects Telegram bot token shaped text in final archives', t => {
  const fakeToken = `${'1'.repeat(10)}:${'A'.repeat(35)}`;
  const value = fixture(t, { windows: { 'README.txt': `BOT_TOKEN=${fakeToken}` } });
  const result = auditRelease(value);
  assert.ok(result.findings.some(row => row.includes(value.winName) && row.includes('Telegram Bot Token') && row.includes('README.txt')));
});
