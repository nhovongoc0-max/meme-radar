import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createUpdater, archiveFiles, compareVersions, releaseAssetName, verifyLocalRelease, runUpdateWorker, copyTree } from '../src/updater.mjs';

const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const repo = 'nhovongoc0-max/meme-radar', current = '0.1.8', target = '0.1.9';
const pkg = (version, dependency = '1.5.7') => JSON.stringify({ name: 'meme-radar-open-source', version, private: true, dependencies: { 'gmgn-cli': dependency } });
const lock = (version, dependency = '1.5.7') => JSON.stringify({ name: 'meme-radar-open-source', version, lockfileVersion: 3, requires: true,
  packages: { '': { name: 'meme-radar-open-source', version, dependencies: { 'gmgn-cli': dependency } },
    'node_modules/gmgn-cli': { version: dependency } } });
const files = (version, dependency = '1.5.7') => ({ 'package.json': pkg(version, dependency), 'package-lock.json': lock(version, dependency), 'src/main.mjs': `// fixture ${version}`,
  'src/updater.mjs': '// updater fixture', 'scripts/update-worker.mjs': '// worker fixture', 'scripts/supervise.mjs': '// supervisor fixture', 'public/index.html': '<h1>Fixture</h1>' });
function zip(input, { platform = 'darwin', modes = {}, names = {} } = {}) {
  const prefix = platform === 'darwin' ? 'MemeRadar-OpenSource-macOS/' : 'MemeRadar-OpenSource-Windows/';
  const chunks = [], directory = []; let offset = 0;
  for (const [relative, contents] of Object.entries(input)) {
    const name = Buffer.from(names[relative] || prefix + relative), data = Buffer.from(contents);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((modes[relative] ?? 0o100644) * 65536) >>> 0, 38); central.writeUInt32LE(offset, 42);
    chunks.push(local, name, data); directory.push(central, name); offset += local.length + name.length + data.length;
  }
  const tail = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10); end.writeUInt32LE(tail.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, tail, end]);
}
function writeTree(root, values) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [name, data] of Object.entries(values)) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, data, { mode: 0o600 }); }
}
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'community-update-test-')), root = path.join(parent, 'radar');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  writeTree(root, files(current)); writeTree(root, { 'node_modules/gmgn-cli/package.json': '{"version":"1.5.7"}', 'state/gmgn-api-key': 'PUBLIC_SYNTHETIC_KEY', 'state/preferences.json': '{"note":"synthetic"}' });
  return { parent, root };
}
function upstream({ override, versions = { [current]: files(current), [target]: files(target) } } = {}) {
  const calls = [], bodies = new Map();
  for (const [version, source] of Object.entries(versions)) {
    const name = releaseAssetName(version, 'darwin', 'arm64'), archive = zip(source), sumsName = `SHA256SUMS-${version}.txt`, sums = Buffer.from(`${sha(archive)}  ${name}\n`);
    const asset = (name, data) => ({ name, state: 'uploaded', size: data.length, digest: `sha256:${sha(data)}`, browser_download_url: `https://github.com/${repo}/releases/download/v${version}/${name}` });
    bodies.set(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, { tag_name: `v${version}`, prerelease: false, draft: false, assets: [asset(name, archive), asset(sumsName, sums)] });
    bodies.set(`https://github.com/${repo}/releases/download/v${version}/${name}`, archive);
    bodies.set(`https://github.com/${repo}/releases/download/v${version}/${sumsName}`, sums);
  }
  bodies.set(`https://api.github.com/repos/${repo}/releases/latest`, bodies.get(`https://api.github.com/repos/${repo}/releases/tags/v${target}`));
  return { calls, bodies, async fetchImpl(url, options) {
    calls.push(url); assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit'); assert.equal(options.headers.Authorization, undefined);
    if (override) { const response = await override(url, options, bodies); if (response) return response; }
    assert.ok(bodies.has(url), 'No URL outside fixed mock release assets is allowed');
    const value = bodies.get(url); return Buffer.isBuffer(value) ? new Response(value) : Response.json(value);
  } };
}
function mockSpawn(calls = []) {
  return (executable, args, options) => {
    calls.push({ executable, args, options }); assert.equal(options.shell, false);
    const child = new EventEmitter(); Object.assign(child, { pid: 234567, exitCode: null, unref() {}, kill() { this.exitCode = 0; } });
    queueMicrotask(() => child.emit('spawn')); return child;
  };
}
function workerFixture(t, extra = {}) {
  const f = fixture(t), work = fs.mkdtempSync(path.join(f.parent, '.meme-radar-update-'));
  writeTree(path.join(work, 'next'), files(target));
  const expected = Object.entries(files(current)).map(([name, data]) => ({ name, sha256: sha(data) }));
  const staged = Object.entries(files(target)).map(([name, data]) => ({ name, sha256: sha(data) }));
  const lockFile = path.join(f.parent, `.meme-radar-update-${sha(f.root).slice(0,16)}.lock`); fs.writeFileSync(lockFile, '', { mode: 0o600 });
  const plan = { schema: 1, root: f.root, work, port: 3791, platform: 'darwin', arch: 'arm64', parentPid: 123456, oldVersion: current, version: target, execPath: process.execPath, expected, staged, lockFile, ...extra };
  const planFile = path.join(work, 'plan.json'); fs.writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
  return { ...f, work, plan, planFile, lockFile };
}

test('stable versions and platform asset names are strict; prerelease or downgrade cannot masquerade as an update', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1); assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  for (const value of ['v0.1.9', '0.1.9-beta', '01.2.3', '../../bad', '1.0']) assert.throws(() => compareVersions(value, current));
  assert.equal(releaseAssetName(target, 'win32', 'x64'), 'MemeRadar-OpenSource-Windows-x64-0.1.9.zip');
  assert.throws(() => releaseAssetName(target, 'linux', 'x64'), { code: 'UPDATE_PLATFORM' });
});
test('archive parser accepts only one exact root and rejects traversal, links, private state, collisions and malformed bounds', () => {
  assert.equal(archiveFiles(zip(files(target)), 'darwin').length, Object.keys(files(target)).length);
  const bad = [zip({ ...files(target), '../escape': 'x' }), zip({ ...files(target), 'state/key': 'x' }),
    zip({ ...files(target), 'src/link': 'x' }, { modes: { 'src/link': 0o120777 } }), zip({ ...files(target), 'SRC/MAIN.MJS': 'x' }),
    zip({ ...files(target), 'src\\outside': 'x' }), zip({ ...files(target), 'aux.txt': 'x' }),
    zip(files(target), { names: { 'src/main.mjs': '/absolute.mjs' } }), Buffer.alloc(5)];
  for (const bytes of bad) assert.throws(() => archiveFiles(bytes, 'darwin'), { code: 'UPDATE_ARCHIVE' });
  const truncated = zip(files(target)); truncated.writeUInt32LE(99999999, truncated.length - 6); assert.throws(() => archiveFiles(truncated, 'darwin'));
});
test('current released files must match exactly; state and keys are not read or compared', t => {
  const f = fixture(t), expected = archiveFiles(zip(files(current)), 'darwin');
  verifyLocalRelease(f.root, expected);
  fs.writeFileSync(path.join(f.root, 'src/main.mjs'), '// local unreleased modification');
  assert.throws(() => verifyLocalRelease(f.root, expected), { code: 'UPDATE_LOCAL' });
  fs.writeFileSync(path.join(f.root, 'src/main.mjs'), files(current)['src/main.mjs']);
  fs.writeFileSync(path.join(f.root, 'my-custom-code.mjs'), 'x'); assert.throws(() => verifyLocalRelease(f.root, expected), { code: 'UPDATE_LOCAL' });
});
test('source checkout is reported blocked even when an official higher release exists', async t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.root, '.git')); const network = upstream();
  const updater = createUpdater({ root: f.root, platform: 'darwin', arch: 'arm64', fetchImpl: network.fetchImpl });
  const result = await updater.check(); assert.equal(result.phase, 'blocked'); assert.equal(result.code, 'UPDATE_LOCAL'); assert.equal(result.canInstall, false); assert.equal(result.availableVersion, target);
  await assert.rejects(updater.install({ version: target, confirm: 'INSTALL_UPDATE' }), { code: 'UPDATE_LOCAL' });
  assert.equal(network.calls.length, 1); assert.equal(fs.readFileSync(path.join(f.root, 'state/gmgn-api-key'), 'utf8'), 'PUBLIC_SYNTHETIC_KEY');
});
test('metadata validation rejects prerelease, alternate host, missing digest agreement and same-version install', async t => {
  for (const transform of [value => { value.prerelease = true; }, value => { value.assets[0].browser_download_url = 'https://evil.invalid/update.zip'; }, value => { value.assets.push(value.assets[0]); }]) {
    const f = fixture(t), network = upstream(); transform(network.bodies.get(`https://api.github.com/repos/${repo}/releases/latest`));
    const updater = createUpdater({ root: f.root, platform: 'darwin', arch: 'arm64', fetchImpl: network.fetchImpl });
    await assert.rejects(updater.check()); assert.equal(updater.snapshot().phase, 'blocked');
  }
  const f = fixture(t), updater = createUpdater({ root: f.root, platform: 'darwin', arch: 'arm64', fetchImpl: async () => assert.fail('no metadata needed') });
  await assert.rejects(updater.install({ version: current, confirm: 'INSTALL_UPDATE' }), { code: 'UPDATE_VERSION' });
});
test('install verifies both release checksums, preserves live state, stages privately and hands off without shell or secrets', async t => {
  const f = fixture(t), network = upstream(), calls = [];
  assert.notEqual(files(current)['package-lock.json'], files(target)['package-lock.json'],
    'the fixture must reproduce npm changing only the root app version during a normal release');
  const updater = createUpdater({ root: f.root, platform: 'darwin', arch: 'arm64', fetchImpl: network.fetchImpl, spawnImpl: mockSpawn(calls) });
  assert.equal((await updater.check()).phase, 'available');
  const result = await updater.install({ version: target, confirm: 'INSTALL_UPDATE' });
  assert.equal(result.phase, 'handoff'); assert.equal(result.restartRequired, true); assert.equal(calls.length, 1);
  const plan = JSON.parse(fs.readFileSync(calls[0].args[1], 'utf8'));
  assert.equal(plan.version, target); assert.equal(plan.parentPid, process.pid);
  assert.equal(fs.existsSync(path.join(plan.work, 'next/state')), false, 'Live state is not copied before shutdown');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, current);
  assert.ok(!JSON.stringify(result).includes(f.root)); assert.ok(!JSON.stringify(result).includes('PUBLIC_SYNTHETIC_KEY'));
  assert.equal(calls[0].options.env.GMGN_API_KEY, undefined); assert.equal(calls[0].options.env.NODE_OPTIONS, undefined);
  assert.equal(fs.statSync(plan.work).mode & 0o777, 0o700);
  await assert.rejects(updater.install({ version: target, confirm: 'INSTALL_UPDATE' }), { code: 'UPDATE_BUSY' });
});
test('corrupt digest, redirect to arbitrary host and changed dependencies fail without stopping or changing the original', async t => {
  for (const mode of ['digest', 'redirect', 'dependencies']) {
    const f = fixture(t), source = mode === 'dependencies' ? files(target, '1.5.8') : files(target);
    const network = upstream({ versions: { [current]: files(current), [target]: source }, override: (url, options, bodies) => {
      if (!url.endsWith(`macOS-${target}.zip`)) return;
      if (mode === 'digest') return new Response(Buffer.concat([bodies.get(url), Buffer.from('tampered')]));
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.invalid/package.zip' } });
    } });
    const updater = createUpdater({ root: f.root, platform: 'darwin', arch: 'arm64', fetchImpl: network.fetchImpl, spawnImpl: () => assert.fail('must not hand off') });
    await assert.rejects(updater.install({ version: target, confirm: 'INSTALL_UPDATE' }));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, current);
    assert.equal(fs.readFileSync(path.join(f.root, 'state/gmgn-api-key'), 'utf8'), 'PUBLIC_SYNTHETIC_KEY');
  }
});
test('copying private state refuses symbolic links and preserves private file permissions', t => {
  const f = fixture(t), out = path.join(f.parent, 'state-copy'); copyTree(path.join(f.root, 'state'), out, { privateData: true });
  assert.equal(fs.readFileSync(path.join(out, 'gmgn-api-key'), 'utf8'), 'PUBLIC_SYNTHETIC_KEY');
  assert.equal(fs.statSync(path.join(out, 'gmgn-api-key')).mode & 0o777, 0o600);
  fs.symlinkSync(path.join(f.root, 'package.json'), path.join(f.root, 'state/not-a-key'));
  assert.throws(() => copyTree(path.join(f.root, 'state'), path.join(f.parent, 'bad-copy'), { privateData: true }));
});
test('worker waits for the exact old PID; timeout never renames the original or copies live data', async t => {
  const f = workerFixture(t), calls = []; let waits = 0;
  await assert.rejects(runUpdateWorker(f.planFile, { isAlive: pid => { assert.equal(pid, f.plan.parentPid); return true; }, pause: async () => { waits++; }, spawnImpl: mockSpawn(calls) }), { code: 'UPDATE_HANDOFF' });
  assert.equal(waits, 120); assert.equal(calls.length, 0); assert.equal(fs.existsSync(path.join(f.work, 'previous')), false);
  assert.equal(fs.existsSync(path.join(f.work, 'next/state')), false); assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, current);
});
test('worker swaps after exit, preserves state and backup, verifies version/instance, then exposes safe completion', async t => {
  const f = workerFixture(t), calls = [];
  const result = await runUpdateWorker(f.planFile, { isAlive: () => false, portFreeImpl: async () => true, pause: async () => {}, spawnImpl: mockSpawn(calls), healthImpl: async (port, instance, version) => {
    assert.equal(port, 3791); assert.equal(instance, sha(path.join(f.root, 'public')).slice(0,16)); assert.equal(version, target); return true;
  } });
  assert.equal(result.phase, 'complete'); assert.equal(calls.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, target);
  for (const base of [f.root, path.join(f.work, 'previous')]) assert.equal(fs.readFileSync(path.join(base, 'state/gmgn-api-key'), 'utf8'), 'PUBLIC_SYNTHETIC_KEY');
  assert.equal(fs.existsSync(f.lockFile), false);
  const updater = createUpdater({ root: f.root, platform: 'darwin', arch: 'arm64', fetchImpl: async () => assert.fail('no network') });
  assert.equal(updater.snapshot().phase, 'complete'); assert.ok(!JSON.stringify(updater.snapshot()).includes('PUBLIC_SYNTHETIC_KEY'));
});
test('failed new startup stops only its own child, restores old code and data, and retains failed-version for recovery', async t => {
  const f = workerFixture(t), calls = [];
  await assert.rejects(runUpdateWorker(f.planFile, { isAlive: () => false, portFreeImpl: async () => true, pause: async () => {}, spawnImpl: mockSpawn(calls), healthImpl: async (_port, _instance, version) => version === current }), { code: 'UPDATE_START' });
  assert.equal(calls.length, 2); assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, current);
  assert.equal(fs.readFileSync(path.join(f.root, 'state/gmgn-api-key'), 'utf8'), 'PUBLIC_SYNTHETIC_KEY');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.work, 'failed-version/package.json'))).version, target);
  const updater = createUpdater({ root: f.root, platform: 'darwin', arch: 'arm64', fetchImpl: async () => assert.fail('no network') });
  assert.equal(updater.snapshot().phase, 'rolled_back');
});
test('tampering after staging is detected again before any directory rename', async t => {
  const f = workerFixture(t); fs.writeFileSync(path.join(f.work, 'next/src/main.mjs'), 'tampered staged code');
  await assert.rejects(runUpdateWorker(f.planFile, { isAlive: () => false, portFreeImpl: async () => true, pause: async () => {}, spawnImpl: () => assert.fail('no launch') }), { code: 'UPDATE_LOCAL' });
  assert.equal(fs.existsSync(path.join(f.work, 'previous')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, current);
});

test('another listener after the old PID exits prevents swapping and no unrelated process is killed', async t => {
  const f = workerFixture(t);
  await assert.rejects(runUpdateWorker(f.planFile, { isAlive: () => false, portFreeImpl: async () => false,
    pause: async () => {}, spawnImpl: () => assert.fail('no spawn'), healthImpl: async () => assert.fail('no health') }), { code: 'UPDATE_HANDOFF' });
  assert.equal(fs.existsSync(path.join(f.work, 'previous')), false); assert.equal(fs.existsSync(path.join(f.work, 'next/state')), false);
});
test('spawn error without a child PID rolls back safely and old startup failure is not reported as success', async t => {
  const f = workerFixture(t); let launches = 0;
  const spawnImpl = () => {
    launches++; const child = new EventEmitter(); Object.assign(child, { pid: undefined, exitCode: undefined, unref() {}, kill() { assert.fail('Never kill an unknown PID'); } });
    queueMicrotask(() => child.emit('error', new Error('synthetic spawn error'))); return child;
  };
  await assert.rejects(runUpdateWorker(f.planFile, { isAlive: () => false, portFreeImpl: async () => true,
    pause: async () => {}, spawnImpl, healthImpl: async () => false }), { code: 'UPDATE_START' });
  assert.equal(launches, 2); assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, current);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'state/update-result.json'))).phase, 'rollback_blocked');
});
test('Windows worker launches only the verified bundled executable after directory swap', async t => {
  const f = workerFixture(t, { platform: 'win32', arch: 'x64' }), calls = [];
  writeTree(f.root, { 'runtime/node.exe': 'OLD_PUBLIC_FIXTURE_BINARY' }); writeTree(path.join(f.work, 'next'), { 'runtime/node.exe': 'NEW_PUBLIC_FIXTURE_BINARY' });
  f.plan.expected.push({ name: 'runtime/node.exe', sha256: sha('OLD_PUBLIC_FIXTURE_BINARY') });
  f.plan.staged.push({ name: 'runtime/node.exe', sha256: sha('NEW_PUBLIC_FIXTURE_BINARY') });
  fs.writeFileSync(f.planFile, JSON.stringify(f.plan), { mode: 0o600 });
  await runUpdateWorker(f.planFile, { isAlive: () => false, portFreeImpl: async () => true, pause: async () => {}, spawnImpl: mockSpawn(calls), healthImpl: async () => true });
  assert.equal(calls[0].executable, path.join(f.root, 'runtime/node.exe')); assert.equal(calls[0].options.shell, false);
  assert.equal(fs.readFileSync(path.join(f.work, 'previous/runtime/node.exe'), 'utf8'), 'OLD_PUBLIC_FIXTURE_BINARY');
});
test('metadata digest must independently agree with SHA256SUMS; no handoff on disagreement', async t => {
  const f = fixture(t), network = upstream();
  network.bodies.get(`https://api.github.com/repos/${repo}/releases/latest`).assets[0].digest = 'sha256:' + '0'.repeat(64);
  const updater = createUpdater({ root: f.root, platform: 'darwin', arch: 'arm64', fetchImpl: network.fetchImpl, spawnImpl: () => assert.fail('no spawn') });
  await assert.rejects(updater.install({ version: target, confirm: 'INSTALL_UPDATE' }), { code: 'UPDATE_CHECKSUM' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, current);
});
test('stop cancels a pending check and concurrent operations cannot bypass the update lock', async t => {
  const f = fixture(t); let started;
  const entering = new Promise(resolve => { started = resolve; });
  const updater = createUpdater({ root: f.root, platform: 'darwin', arch: 'arm64', fetchImpl: (_url, { signal }) => {
    started(); return new Promise((resolve, reject) => { void resolve; signal.addEventListener('abort', () => reject(new Error('synthetic cancelled')), { once: true }); });
  } });
  const check = updater.check(); await entering;
  await assert.rejects(updater.check(), { code: 'UPDATE_BUSY' }); updater.stop();
  await assert.rejects(check, { code: 'UPDATE_NETWORK' }); assert.equal(updater.snapshot().phase, 'blocked');
});
