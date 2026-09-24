import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { archiveFiles } from '../src/updater.mjs';
import { checksumForAsset, deriveStartupFailureArchive, parseCli } from '../scripts/testing/package-update-e2e.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fixtureFiles = {
  'package.json': JSON.stringify({ name: 'meme-radar-open-source', version: '0.1.10', private: true }),
  'package-lock.json': JSON.stringify({ name: 'meme-radar-open-source', version: '0.1.10', lockfileVersion: 3, packages: { '': { name: 'meme-radar-open-source', version: '0.1.10' } } }),
  'src/main.mjs': 'console.log("healthy fixture");\n',
  'scripts/supervise.mjs': '// fixture\n',
  'public/index.html': '<!doctype html><title>fixture</title>\n',
};

function zip(files) {
  const prefix = 'MemeRadar-OpenSource-macOS/', body = [], central = []; let offset = 0;
  for (const [relative, contents] of Object.entries(files)) {
    const name = Buffer.from(prefix + relative), data = Buffer.from(contents);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    body.push(local, name, data); central.push(directory, name); offset += local.length + name.length + data.length;
  }
  const directoryBytes = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, directoryBytes, end]);
}

test('candidate checksum must name exactly one matching release asset', () => {
  const hash = 'a'.repeat(64), other = 'b'.repeat(64), name = 'MemeRadar-OpenSource-macOS-0.1.10.zip';
  assert.equal(checksumForAsset(`${other}  other.zip\n${hash}  ${name}\n`, name), hash);
  assert.throws(() => checksumForAsset(`${hash}  ${name}\n${hash} *${name}\n`, name));
  assert.throws(() => checksumForAsset(`${hash}  renamed.zip\n`, name));
});

test('startup-failure archive changes only src/main.mjs and remains accepted by the production ZIP parser', () => {
  const originalBytes = zip(fixtureFiles), brokenBytes = deriveStartupFailureArchive(originalBytes, 'darwin');
  const original = new Map(archiveFiles(originalBytes, 'darwin').map(file => [file.name, file]));
  const broken = archiveFiles(brokenBytes, 'darwin');
  assert.equal(broken.length, original.size);
  for (const file of broken) {
    if (file.name === 'src/main.mjs') {
      assert.notEqual(file.sha256, original.get(file.name).sha256);
      assert.match(file.data.toString('utf8'), /synthetic package-update-e2e startup failure/);
    } else assert.equal(file.sha256, original.get(file.name).sha256, file.name);
  }
  assert.equal(JSON.parse(broken.find(file => file.name === 'package.json').data).version, '0.1.10');
});

test('CLI requires old/candidate artifacts plus exactly one trusted SHA-256 source for each', () => {
  assert.deepEqual(parseCli(['--old', 'old.zip', '--candidate', 'new.zip', '--sha256', 'a'.repeat(64),
    '--old-sha256', 'b'.repeat(64), '--platform', 'darwin']), {
    old: 'old.zip', candidate: 'new.zip', checksums: undefined, sha256: 'a'.repeat(64), oldChecksums: undefined,
    oldSha256: 'b'.repeat(64), platform: 'darwin', arch: process.arch, nodeModules: undefined,
  });
  assert.throws(() => parseCli(['--old', 'old.zip', '--candidate', 'new.zip']));
  assert.throws(() => parseCli(['--old', 'old.zip', '--candidate', 'new.zip', '--sha256', 'a'.repeat(64)]));
  assert.throws(() => parseCli(['--old', 'old.zip', '--candidate', 'new.zip', '--sha256', 'a'.repeat(64),
    '--checksums', 'sums.txt', '--old-sha256', 'b'.repeat(64)]));
  assert.throws(() => parseCli(['--old', 'old.zip', '--candidate', 'new.zip', '--sha256', 'a'.repeat(64),
    '--old-sha256', 'b'.repeat(64), '--old-checksums', 'old-sums.txt']));
  assert.throws(() => parseCli(['--old', 'old.zip', '--candidate', 'new.zip', '--sha256', sha256('fixture'),
    '--old-sha256', 'b'.repeat(64), '--unknown', 'x']));
});
