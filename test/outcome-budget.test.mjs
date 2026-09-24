import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.mjs';
import { collectOutcomeSamples, dueOutcomeJobs, selectOutcomeJobs, horizons } from '../src/outcomes.mjs';
import { Scanner, updateOutcomeTracking, upsertOutcome } from '../src/scanner.mjs';

const AT = 1800000000000;
const ca = n => '0x' + n.toString(16).padStart(40, '0');
function history(changes = {}) {
  return { address: ca(1), chain: 'bsc', baselineProvider: 'AVE', baselineAt: AT - 1900000,
    baselinePrice: 1, initialDecision: 'X_REVIEW', samples: {}, ...changes };
}
function memoryState(outcomes = []) {
  return { value: { activeChain: 'bsc', candidates: [], auditQueue: [], outcomes, events: [], riskExclusions: {}, chainStates: {}, sourceHealth: {} },
    save(next = this.value) { this.value = structuredClone(next); } };
}
function provider(changes = {}) {
  return { keyEpoch: 0, configured: async () => true, discover: async () => [], metrics: {},
    lastDiscoveryHealth: { complete: true, checkedAt: AT }, ...changes };
}

test('default scanner spends no CU on a large historical backlog and preserves records', async t => {
  t.mock.method(Date, 'now', () => AT);
  assert.equal(config.outcomeReadsPerCycle, 0);
  const records = Array.from({ length: 100 }, (_, i) => history({ address: ca(i + 1) }));
  const state = memoryState(records);
  state.value.chainStates.eth = { outcomes: [history({ chain: 'eth' })] };
  let reads = 0;
  const scanner = new Scanner({ provider: provider({ priceAt: async () => { reads++; return null; } }), state, settings: { ...config, chain: 'bsc' } });
  await scanner.cycle(); scanner.stop();
  assert.equal(reads, 0);
  assert.equal(state.value.outcomes.length, 100);
  assert.equal(state.value.chainStates.eth.outcomes.length, 1);
  assert.deepEqual(state.value.outcomes[0].samples, {});
});

test('opt-in paid backfill only selects enabled chains and matching baseline providers', () => {
  const scopes = { bsc: [history({ baselineProvider: undefined }), history({ address: ca(2) }), history({ chain: 'eth' })], eth: [history({ chain: 'eth' })] };
  const jobs = selectOutcomeJobs(scopes, { enabledChains: ['bsc'], provider: 'AVE', limit: 4, now: AT });
  assert.equal(jobs.length, 3);
  assert.ok(jobs.every(job => job.chain === 'bsc' && job.row.address === ca(2)));
  assert.deepEqual(selectOutcomeJobs(scopes, { enabledChains: ['bsc'], provider: 'AVE', limit: 0, now: AT }), []);
});

test('failed historical windows stop after three attempts without fabricated prices', async () => {
  const rows = [history()]; let now = AT, calls = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    await collectOutcomeSamples(rows, { priceAt: async () => { calls++; return null; } }, 'bsc', { onlyKey: 'm5', now: () => now });
    now += 3600000;
  }
  assert.equal(calls, 3);
  assert.equal(rows[0].sampleRetries.m5.attempts, 3);
  assert.equal(rows[0].samples.m5, undefined);
  assert.ok(!dueOutcomeJobs(rows, now).some(job => job.key === 'm5'));
});

test('expired missed windows are not repeatedly purchased, and exact selected window is respected', async () => {
  const rows = [history()]; const calls = [];
  await collectOutcomeSamples(rows, { priceAt: async (_, at) => { calls.push(at); return { at, price: 2 }; } }, 'bsc', { limit: 1, onlyKey: 'm30', now: () => AT });
  assert.deepEqual(calls, [rows[0].baselineAt + horizons.m30]);
  assert.equal(rows[0].samples.m5, undefined);
  assert.equal(rows[0].samples.m30.return, 1);
  assert.deepEqual(dueOutcomeJobs([history({ baselineAt: AT - 3 * 86400000 })], AT), []);
});

test('budget, rate and credential pauses stop the batch without consuming retry attempts', async () => {
  for (const code of ['AVE_DISCOVERY_RESERVE', 'AVE_BUDGET', 'AVE_QUOTA', 'AVE_RATE_LIMITED', 'AVE_CHANGED']) {
    const rows = [history()]; let calls = 0;
    await collectOutcomeSamples(rows, { priceAt: async () => { calls++; throw Object.assign(new Error('mock'), { code, retryAt: AT + 999999 }); } }, 'bsc', { now: () => AT });
    assert.equal(calls, 1); assert.equal(rows[0].sampleRetries.m5.attempts, 0);
    assert.equal(rows[0].sampleRetries.m5.nextAt, AT + 999999);
  }
});

test('cancelled paid sampling forwards the signal and never records a late result', async () => {
  const controller = new AbortController(), rows = [history()]; let calls = 0;
  await collectOutcomeSamples(rows, { priceAt: async (_, at, chain, options) => {
    assert.equal(options.signal, controller.signal); calls++; controller.abort(); return { at, price: 2 };
  } }, 'bsc', { now: () => AT, signal: controller.signal });
  assert.equal(calls, 1); assert.deepEqual(rows[0].samples, {}); assert.equal(rows[0].sampleRetries, undefined);
});

test('passive observations remain free but never mix old GMGN and AVE baselines', () => {
  const row = { chain: 'bsc', address: ca(1), marketProvider: 'AVE', price: 2,
    capturedAt: AT, sourceUpdatedAt: AT, expiresAt: AT + 30000, stale: false };
  const older = history({ baselineAt: AT - horizons.m5, baselineProvider: undefined });
  assert.deepEqual(updateOutcomeTracking([older], new Map([[ca(1), row]]), AT, config.outcomeRetentionMs)[0].samples, {});
  const matched = { ...older, baselineProvider: 'AVE' };
  assert.equal(updateOutcomeTracking([matched], new Map([[ca(1), row]]), AT, config.outcomeRetentionMs)[0].samples.m5.return, 1);
  const created = [];
  upsertOutcome(created, { ...row, symbol: 'MOCK', status: 'X_REVIEW' }, AT);
  assert.equal(created[0].baselineProvider, 'AVE');
});

test('cache-only cycles preserve the upstream success clock', async t => {
  let now = AT; t.mock.method(Date, 'now', () => now);
  const state = memoryState(), market = provider();
  const scanner = new Scanner({ provider: market, state, settings: { ...config, chain: 'bsc' } });
  await scanner.cycle(); assert.equal(state.value.lastSuccessAt, AT);
  now += 120000; await scanner.cycle(); assert.equal(state.value.lastSuccessAt, AT);
  assert.equal(state.value.lastAttemptAt, now);
  market.lastDiscoveryHealth.checkedAt = now;
  await scanner.cycle(); assert.equal(state.value.lastSuccessAt, now); scanner.stop();
});

test('scanner rechecks enabled chains between historical requests', async t => {
  t.mock.method(Date, 'now', () => AT);
  const samples = Object.fromEntries(Object.keys(horizons).filter(key => key !== 'm5').map(key => [key, { price: 1, return: 0 }]));
  const state = memoryState([history({ samples: structuredClone(samples), baselineAt: AT - 2000000 })]);
  state.value.chainStates.eth = { outcomes: [history({ chain: 'eth', samples: structuredClone(samples) })] };
  const controls = { value: { enabledChains: ['bsc', 'eth'], annotations: {} } }, calls = [];
  const market = provider({ priceAt: async (_, at, chain) => { calls.push(chain); controls.value.enabledChains = ['bsc']; return { at, price: 2 }; } });
  const scanner = new Scanner({ provider: market, state, controls, settings: { ...config, chain: 'bsc', outcomeReadsPerCycle: 4 } });
  await scanner.cycle(); scanner.stop(); assert.deepEqual(calls, ['bsc']);
});
