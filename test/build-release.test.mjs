import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { archiveFiles } from '../src/updater.mjs';
import { buildRelease, collectReleaseSource, loadWindowsDonor, releaseFileNames } from '../scripts/build-release.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function zip(input) {
  const prefix = 'MemeRadar-OpenSource-Windows/';
  const chunks = [], directory = []; let offset = 0;
  for (const [relative, value] of Object.entries(input).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const name = Buffer.from(prefix + relative), data = Buffer.from(value.data ?? value), mode = value.mode ?? 0o644;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((((0o100000 | mode) * 65536) >>> 0), 38); central.writeUInt32LE(offset, 42);
    chunks.push(local, name, data); directory.push(central, name); offset += local.length + name.length + data.length;
  }
  const tail = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10); end.writeUInt32LE(tail.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, tail, end]);
}

function writeTree(root, files) {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(root, ...name.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value.data ?? value); fs.chmodSync(file, value.mode ?? 0o644);
  }
}

function packageJson(version = '0.1.9') {
  return `${JSON.stringify({ name: 'meme-radar-open-source', version, private: true, dependencies: { 'gmgn-cli': '1.5.7' } }, null, 2)}\n`;
}

function packageLock(version = '0.1.9') {
  return `${JSON.stringify({ name: 'meme-radar-open-source', version, lockfileVersion: 3, requires: true, packages: {
    '': { name: 'meme-radar-open-source', version, dependencies: { 'gmgn-cli': '1.5.7' } },
    'node_modules/gmgn-cli': { version: '1.5.7' },
  } }, null, 2)}\n`;
}

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'build-release-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'source');
  writeTree(root, {
    'package.json': packageJson('0.1.10'), 'package-lock.json': packageLock('0.1.10'),
    'src/main.mjs': '// main\n', 'src/updater.mjs': '// updater\n', 'scripts/update-worker.mjs': '// worker\n',
    'scripts/supervise.mjs': '// supervise\n', 'public/index.html': '<main>radar</main>\n',
    'scripts/bootstrap-node.sh': { data: '#!/bin/sh\n', mode: 0o755 },
    'start-radar.command': { data: '#!/bin/sh\n', mode: 0o755 }, '安装并启动.command': { data: '#!/bin/sh\n', mode: 0o755 },
    'packaging/windows-portable/OPEN-MEME-RADAR.bat': '@echo off\r\n',
    'packaging/windows-portable/README-FIRST.txt': 'Start here\r\n',
    'packaging/windows-portable/launcher.cjs': 'console.log("launcher");\n',
    'README.md': 'fixture\n',
  });
  const donorInput = {
    'package.json': packageJson(), 'package-lock.json': packageLock(),
    'src/main.mjs': '// old main\n', 'scripts/supervise.mjs': '// old supervise\n', 'public/index.html': '<main>old</main>\n',
    'MemeRadar-OpenSource.exe': Buffer.from('verified launcher'), 'runtime/node.exe': Buffer.from('verified node'),
    'packaging/windows-portable/launcher.cjs': 'console.log("launcher");\n',
    'node_modules/gmgn-cli/package.json': JSON.stringify({ name: 'gmgn-cli', version: '1.5.7' }),
    'node_modules/gmgn-cli/index.js': 'export default {}\n',
  };
  const donorBytes = zip(donorInput), donorName = 'MemeRadar-OpenSource-Windows-x64-0.1.9.zip', donorPath = path.join(parent, donorName);
  fs.writeFileSync(donorPath, donorBytes);
  const policy = { version: '0.1.9', assetName: donorName, sha256: sha256(donorBytes), requiredFiles: {
    'MemeRadar-OpenSource.exe': sha256(donorInput['MemeRadar-OpenSource.exe']),
    'runtime/node.exe': sha256(donorInput['runtime/node.exe']),
  }, copiedPrefixes: ['node_modules/'] };
  policy.launcherSource = { path: 'packaging/windows-portable/launcher.cjs', sha256: sha256(donorInput['packaging/windows-portable/launcher.cjs']) };
  return { parent, root, donorPath, donorBytes, policy };
}

test('release builder creates deterministic v0.1.10 assets with fixed roots, checksums and executable modes', t => {
  const value = fixture(t), first = path.join(value.parent, 'first'), second = path.join(value.parent, 'second');
  const one = buildRelease({ root: value.root, outDir: first, version: '0.1.10', windowsDonor: value.donorPath, donorPolicy: value.policy });
  const two = buildRelease({ root: value.root, outDir: second, version: '0.1.10', windowsDonor: value.donorPath, donorPolicy: value.policy });
  const names = releaseFileNames('0.1.10');
  assert.deepEqual(one.names, names); assert.deepEqual(two.names, names);
  for (const name of [names.mac, names.windows, names.checksums]) {
    assert.deepEqual(fs.readFileSync(path.join(first, name)), fs.readFileSync(path.join(second, name)), `${name} must be reproducible`);
  }
  const mac = archiveFiles(fs.readFileSync(path.join(first, names.mac)), 'darwin');
  const windows = archiveFiles(fs.readFileSync(path.join(first, names.windows)), 'win32');
  const macByName = new Map(mac.map(file => [file.name, file])), winByName = new Map(windows.map(file => [file.name, file]));
  assert.equal(JSON.parse(macByName.get('package.json').data).version, '0.1.10');
  assert.equal(JSON.parse(winByName.get('package-lock.json').data).packages[''].version, '0.1.10');
  assert.equal(macByName.get('start-radar.command').mode, 0o755);
  assert.equal(macByName.get('scripts/bootstrap-node.sh').mode, 0o755);
  assert.equal(winByName.get('MemeRadar-OpenSource.exe').data.toString(), 'verified launcher');
  assert.equal(winByName.get('runtime/node.exe').data.toString(), 'verified node');
  assert.equal(winByName.get('OPEN-MEME-RADAR.bat').data.toString(), '@echo off\r\n');
  assert.equal(winByName.get('README-FIRST.txt').data.toString(), 'Start here\r\n');
  assert.equal(macByName.has('node_modules/gmgn-cli/package.json'), false);
  assert.equal(winByName.has('node_modules/gmgn-cli/package.json'), true);
  const sums = fs.readFileSync(path.join(first, names.checksums), 'utf8').trim().split('\n');
  assert.deepEqual(sums, [
    `${sha256(fs.readFileSync(path.join(first, names.mac)))}  ${names.mac}`,
    `${sha256(fs.readFileSync(path.join(first, names.windows)))}  ${names.windows}`,
  ]);
});

test('release source excludes runtime state and credentials but includes every ordinary current file', t => {
  const value = fixture(t);
  writeTree(value.root, {
    'src/new-feature.mjs': 'export const enabled = true;\n',
    'state/radar.json': '{"private":true}', 'logs/radar.log': 'private', '.runtime/lock': 'private', '.git/config': 'private',
    '.env': 'SECRET=private', '.npmrc': '//registry/:_authToken=private', 'runtime/node.exe': 'local runtime',
    'node_modules/unwanted/index.js': 'local dependency',
  });
  const names = new Set(collectReleaseSource(value.root).map(file => file.name));
  assert.equal(names.has('src/new-feature.mjs'), true);
  for (const name of ['state/radar.json', 'logs/radar.log', '.runtime/lock', '.git/config', '.env', '.npmrc', 'runtime/node.exe', 'node_modules/unwanted/index.js']) {
    assert.equal(names.has(name), false, `${name} must not be released`);
  }
});

test('release source rejects a local credential copied into an otherwise publishable file', t => {
  const value = fixture(t), secret = 'AveLocalCredentialOnlyForBuildTest123456789';
  writeTree(value.root, {
    'state/ave-credentials.json': JSON.stringify({ key: secret }),
    'docs/accidental.txt': `key=${secret}\n`,
  });
  assert.throws(() => collectReleaseSource(value.root), /本机凭证.*docs\/accidental\.txt/);
});

test('Windows donor must match the pinned archive and required binary hashes', t => {
  const value = fixture(t), sourceManifest = JSON.parse(packageJson()), sourceLock = JSON.parse(packageLock());
  const selected = loadWindowsDonor({ donorPath: value.donorPath, policy: value.policy, sourceManifest, sourceLock });
  assert.deepEqual(new Set(selected.map(file => file.name)), new Set([
    'MemeRadar-OpenSource.exe', 'runtime/node.exe', 'node_modules/gmgn-cli/package.json', 'node_modules/gmgn-cli/index.js',
  ]));
  fs.appendFileSync(value.donorPath, 'tamper');
  assert.throws(() => loadWindowsDonor({ donorPath: value.donorPath, policy: value.policy, sourceManifest, sourceLock }), /SHA-256/);
});

test('release builder refuses output inside source, any source-version mismatch and overwrite', t => {
  const value = fixture(t);
  assert.throws(() => buildRelease({ root: value.root, outDir: path.join(value.root, 'dist'), version: '0.1.10', windowsDonor: value.donorPath, donorPolicy: value.policy }), /源码树外/);
  for (const version of ['0.1.8', '0.1.11']) {
    assert.throws(() => buildRelease({ root: value.root, outDir: path.join(value.parent, `mismatch-${version}`), version,
      windowsDonor: value.donorPath, donorPolicy: value.policy }), /必须与发布源 package\.json 完全一致/);
  }
  const out = path.join(value.parent, 'release');
  buildRelease({ root: value.root, outDir: out, version: '0.1.10', windowsDonor: value.donorPath, donorPolicy: value.policy });
  assert.throws(() => buildRelease({ root: value.root, outDir: out, version: '0.1.10', windowsDonor: value.donorPath, donorPolicy: value.policy }), /必须为空.*不会覆盖/);
});
