import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GmgnClient, gmgnChildEnvironment, discoveryRequestArgs } from '../src/gmgn.mjs';
import { executeReadOnly } from '../src/gmgn-readonly-worker.mjs';
import { GmgnConnection } from '../src/gmgn-connection.mjs';
import { GmgnKeyStore, legacyGmgnApiKey } from '../src/gmgn-key-store.mjs';
import { supportedNode } from '../scripts/setup.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const fakeKey = letter => `gmgn_${letter.repeat(32)}`;

test('UI key overrides both legacy configuration and environment, with no mutation of either', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-credentials-'));
  try {
    const file = path.join(temporary, 'legacy.env');
    const old = `GMGN_API_KEY="${fakeKey('a')}"\nGMGN_PRIVATE_KEY=never-forward\n`;
    fs.writeFileSync(file, old);
    const source = { GMGN_API_KEY: fakeKey('b') };
    assert.equal(legacyGmgnApiKey({}, file), fakeKey('a'));
    assert.equal(legacyGmgnApiKey(source, file), fakeKey('b'));
    const store = new GmgnKeyStore(path.join(temporary, 'state'));
    const client = new GmgnClient({ apiKeyProvider: () => store.get(), legacyKeyProvider: () => legacyGmgnApiKey(source, file) });
    assert.equal(client.apiKey(), fakeKey('b'));
    store.save(fakeKey('c'));
    assert.equal(client.apiKey(), fakeKey('c'));
    assert.equal(client.childEnvironment().GMGN_PRIVATE_KEY, undefined);
    assert.equal(fs.readFileSync(file, 'utf8'), old);
    assert.equal(source.GMGN_API_KEY, fakeKey('b'));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('production GMGN worker ignores project/global dotenv and sends exactly the submitted key', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-worker-'));
  const key = fakeKey('c');
  try {
    fs.writeFileSync(path.join(temporary, '.env'), `GMGN_API_KEY=${fakeKey('a')}\nGMGN_DEBUG=1\nGMGN_PRIVATE_KEY=old-private\n`);
    const args = ['--import', pathToFileURL(path.join(root, 'scripts/testing/gmgn-fixture.mjs')).href, path.join(root, 'src/gmgn-readonly-worker.mjs'),
      'market', 'trending', '--chain', 'bsc', '--interval', '5m', '--limit', '1', '--raw'];
    const env = { ...gmgnChildEnvironment({}, key), RADAR_TEST_EXPECTED_KEY: key };
    const result = await exec(process.execPath, args, { cwd: temporary, env });
    assert.deepEqual(JSON.parse(result.stdout).rank[0], { keyMatches: true, noPrivateKey: true, noDebug: true, path: '/v1/market/rank' });
    assert.equal(result.stderr, '');
    await assert.rejects(exec(process.execPath, args, { cwd: temporary, env: { ...env, RADAR_TEST_REJECT: '1' } }), error => {
      assert.equal(JSON.parse(error.stderr).code, 'GMGN_AUTH_FAILED');
      assert.equal(error.stderr.includes(key), false);
      assert.equal(error.stdout.includes(key), false);
      return true;
    });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('adapter preserves discovery filters and candle milliseconds while forbidding trading', async () => {
  const calls = [];
  const client = new Proxy({}, { get: (_, method) => async (...args) => { calls.push({ method, args }); return {}; } });
  const spec = discoveryRequestArgs('bsc');
  await executeReadOnly(client, spec.trenches);
  await executeReadOnly(client, spec.trending);
  const address = '0x' + '1'.repeat(40);
  await executeReadOnly(client, ['market', 'kline', '--chain', 'bsc', '--address', address, '--resolution', '1m', '--from', '100', '--to', '200', '--raw']);
  await executeReadOnly(client, ['auth', 'verify-read', '--raw']);
  assert.deepEqual(calls[0], { method: 'getTrenches', args: ['bsc', ['completed'], undefined, 80, {
    max_rug_ratio: .3, max_bundler_rate: .3, max_insider_ratio: .3,
    min_created: '5m', max_created: '10080m', min_marketcap: 10000, max_marketcap: 150000, min_liquidity: 3000
  }] });
  assert.equal(calls[1].method, 'getTrendingSwaps');
  assert.deepEqual(calls[2].args, ['bsc', address, '1m', 100000, 200000]);
  assert.deepEqual(calls[3], { method: 'getUserInfo', args: [] });
  await assert.rejects(executeReadOnly(client, ['swap', 'buy', '--chain', 'bsc']));
  await assert.rejects(executeReadOnly(client, ['token', 'info', '--chain', 'bsc', '--address', address, '--host', 'https://invalid.example']));
  assert.equal(calls.length, 4);
});

test('API connection verifies read access without consuming signed follow-wallet quota', async () => {
  const gmgn = new GmgnClient({ privateKeyProvider: () => 'pending-local-key', legacyKeyProvider: () => '' });
  let captured;
  gmgn.run = async (args, options) => { captured = { args, options }; return { verified: true }; };
  assert.deepEqual(await gmgn.verifyApiKey(fakeKey('v')), { verified: true });
  assert.deepEqual(captured.args, ['auth', 'verify-read', '--raw']);
  assert.equal(captured.options.apiKey, fakeKey('v'));
  assert.equal(captured.options.privateKey, undefined);
});

test('first launch stays unconfigured; failed validation preserves key and successful validation requests a scan', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-connect-'));
  try {
    const keyStore = new GmgnKeyStore(temporary);
    let scans = 0;
    const scanner = { activeChain: 'sol', requestCycle() { scans++; } };
    const gmgn = new GmgnClient({ apiKeyProvider: () => keyStore.get(), legacyKeyProvider: () => '' });
    const connection = new GmgnConnection({ gmgn, keyStore, scanner });
    assert.deepEqual(connection.snapshot(), { configured: false, status: 'UNCONFIGURED' });
    assert.equal(await gmgn.configured(), false);
    gmgn.verifyApiKey = async () => { throw Object.assign(new Error('bad'), { code: 'GMGN_AUTH_FAILED' }); };
    await assert.rejects(connection.apply(fakeKey('a')), { code: 'GMGN_AUTH_FAILED' });
    assert.equal(keyStore.get(), '');
    keyStore.save(fakeKey('b'));
    await assert.rejects(connection.apply(fakeKey('a')));
    assert.equal(keyStore.get(), fakeKey('b'));
    assert.equal(scans, 0);
    gmgn.verifyApiKey = async key => {
      gmgn.lastVerifiedKey = key;
      return { verified: true };
    };
    keyStore.onboarding();
    await connection.apply(fakeKey('c'));
    assert.equal(keyStore.get(), fakeKey('c'));
    assert.equal(scans, 1);
    assert.deepEqual(connection.snapshot(), { configured: true, status: 'VERIFIED' });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('concurrent key submissions cannot overwrite a key under validation', async () => {
  let finish;
  let saved = '';
  const connection = new GmgnConnection({
    gmgn: { verifyApiKey: () => new Promise(resolve => { finish = resolve; }) },
    keyStore: { activatePending: () => true, save: key => { saved = key; } }, scanner: { activeChain: 'bsc', requestCycle() {} }
  });
  const first = connection.apply(fakeKey('a'));
  await assert.rejects(connection.apply(fakeKey('b')), { code: 'GMGN_CHECK_BUSY' });
  finish({ verified: true });
  await first;
  assert.equal(saved, fakeKey('a'));
});

test('runtime check rejects Node versions without the proxy flag used by the scanner', () => {
  for (const version of ['20.20.0', '22.22.0', '23.0.0', '24.4.0']) assert.equal(supportedNode(version), false);
  for (const version of ['22.23.0', '22.23.1', '24.5.0', '25.0.0']) assert.equal(supportedNode(version), true);
});

test('an authenticated empty discovery is an empty scan, not a connection failure', async () => {
  const gmgn = new GmgnClient({ legacyKeyProvider: () => '' });
  gmgn.run = async () => [];
  assert.deepEqual(await gmgn.discover('sol'), []);
  assert.equal(gmgn.lastDiscoveryHealth.complete, true);
});
