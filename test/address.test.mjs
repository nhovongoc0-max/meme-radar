import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePoolAddress, normalizeTokenAddress, validTokenAddress } from '../src/address.mjs';
import { RadarControls } from '../src/local-store.mjs';
import { normalizeLiveRows } from '../src/live-discovery.mjs';
import { SecondaryValidator } from '../src/secondary.mjs';

const sol = 'So11111111111111111111111111111111111111112';
const evm = '0x1234567890abcdef1234567890abcdef12345678';

test('one strict address validator is shared by chain-facing layers', async t => {
  assert.equal(normalizeTokenAddress('sol', sol), sol);
  assert.equal(normalizeTokenAddress('bsc', evm.toUpperCase().replace(/^0X/, '0x')), evm);
  assert.equal(normalizePoolAddress('bsc', `0x${'12'.repeat(32)}`), `0x${'12'.repeat(32)}`);

  const invalidSol = '2'.repeat(32); // Matches the old text regex but is not a 32-byte public key.
  for (const [chain, address] of [
    ['sol', invalidSol],
    ['bsc', `0x${'0'.repeat(40)}`],
    ['eth', `0x${'e'.repeat(40)}`]
  ]) assert.equal(validTokenAddress(chain, address), false);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-address-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const controls = new RadarControls(directory, ['sol', 'bsc'], 'sol');
  assert.throws(() => controls.annotate({ chain: 'sol', address: invalidSol, favorite: true, note: '' }), /invalid_annotation/);
  assert.deepEqual(normalizeLiveRows([{ chain: 'sol', address: invalidSol, marketProvider: 'AVE' }], 'sol'), []);

  let requests = 0;
  const secondary = await new SecondaryValidator({ fetchImpl: async () => { requests++; return Response.json({}); } })
    .validate({ chain: 'sol', tokenAddress: invalidSol });
  assert.equal(requests, 0);
  assert.equal(secondary.sources.dexScreener.errorCode, 'INVALID_ADDRESS');
  assert.equal(secondary.sources.goPlus.errorCode, 'INVALID_ADDRESS');
});
