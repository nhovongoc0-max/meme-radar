import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeLiveLeads, LIVE_LEAD_RETENTION_MS, reconcileLiveLeads, sanitizeLiveLead } from '../src/live-leads.mjs';
import { RadarState } from '../src/state.mjs';

const ADDRESS = '0x' + 'a'.repeat(40);
const OTHER = '0x' + 'b'.repeat(40);
const AT = 1_800_000_000_000;
const lead = (address = ADDRESS, extra = {}) => ({
  chain: 'bsc', address, marketProvider: 'AVE', symbol: 'SAFE', name: 'Safe lead',
  marketCap: 45_000, liquidity: 12_000, price: 0.01,
  createdAt: AT / 1000 - 900, ageBasis: 'trade',
  capturedAt: AT - 1_000, sourceUpdatedAt: AT - 2_000, expiresAt: AT + 20_000,
  volume5m: 700, buys5m: 12, sells5m: 4, priorityBand: true,
  firstSeenAt: AT, newAt: AT, secret: 'must-not-persist', ...extra
});

test('durable live leads preserve evidence clocks across page rotation and expire after one full multi-chain window', () => {
  const first = reconcileLiveLeads([], [{ address: ADDRESS, eligible: true, lead: lead() }], {
    chain: 'bsc', confirmedAt: AT, retentionMs: LIVE_LEAD_RETENTION_MS
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].sourceUpdatedAt, AT - 2_000);
  assert.equal(first[0].expiresAt, AT + 20_000);
  assert.equal(first[0].lastConfirmedAt, AT);
  assert.equal(first[0].displayUntil, AT + LIVE_LEAD_RETENTION_MS);
  assert.equal(Object.hasOwn(first[0], 'secret'), false);

  const missingFromRotatedPage = reconcileLiveLeads(first, [{ address: OTHER, eligible: true, lead: lead(OTHER) }], {
    chain: 'bsc', confirmedAt: AT + 10 * 60_000, retentionMs: LIVE_LEAD_RETENTION_MS
  });
  assert.equal(missingFromRotatedPage.length, 2);
  const retained = missingFromRotatedPage.find(row => row.address === ADDRESS);
  assert.equal(retained.sourceUpdatedAt, AT - 2_000, 'retention must not refresh the quote clock');
  assert.equal(retained.displayUntil, AT + LIVE_LEAD_RETENTION_MS, 'page absence must not extend retention');
  assert.equal(activeLiveLeads(missingFromRotatedPage, 'bsc', AT + 29 * 60_000).length, 2);
  assert.equal(activeLiveLeads(missingFromRotatedPage, 'bsc', AT + 31 * 60_000).some(row => row.address === ADDRESS), false);
});

test('a current failure or hard-risk veto removes a retained lead immediately', () => {
  const previous = reconcileLiveLeads([], [{ address: ADDRESS, eligible: true, lead: lead() }], {
    chain: 'bsc', confirmedAt: AT
  });
  assert.equal(reconcileLiveLeads(previous, [{ address: ADDRESS, eligible: false }], {
    chain: 'bsc', confirmedAt: AT + 5 * 60_000
  }).length, 0);
  assert.equal(reconcileLiveLeads(previous, [{ address: ADDRESS, eligible: true, hardRejected: true, lead: lead() }], {
    chain: 'bsc', confirmedAt: AT + 5 * 60_000
  }).length, 0);
});

test('persisted display receipts cannot extend themselves beyond the one-hour safety bound', () => {
  const valid = reconcileLiveLeads([], [{ address: ADDRESS, eligible: true, lead: lead() }], {
    chain: 'bsc', confirmedAt: AT
  })[0];
  assert.ok(sanitizeLiveLead(valid, 'bsc'));
  assert.equal(sanitizeLiveLead({ ...valid, displayUntil: valid.lastConfirmedAt + 60 * 60_000 + 1 }, 'bsc'), null);
});

test('persisted live leads are allowlisted during state migration', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-live-leads-'));
  try {
    const persisted = reconcileLiveLeads([], [{ address: ADDRESS, eligible: true, lead: lead() }], {
      chain: 'bsc', confirmedAt: AT
    })[0];
    fs.writeFileSync(path.join(directory, 'radar.json'), JSON.stringify({
      activeChain: 'bsc', liveLeads: [{ ...persisted, raw: { private: true }, apiKey: 'private-key' }],
      chainStates: { bsc: { liveLeads: [{ ...persisted, bearer: 'private' }] } }
    }));
    const state = new RadarState(directory);
    assert.equal(state.value.liveLeads.length, 1);
    assert.equal(state.value.chainStates.bsc.liveLeads.length, 1);
    assert.doesNotMatch(JSON.stringify(state.value.liveLeads), /private|apiKey|bearer|raw/);
    assert.deepEqual(sanitizeLiveLead(state.value.liveLeads[0], 'bsc'), state.value.liveLeads[0]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
