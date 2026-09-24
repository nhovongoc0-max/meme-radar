import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AveClient, AVE_LIMITS, createAveBudgetStore } from '../src/ave.mjs';

const AT = Date.UTC(2026, 8, 22, 12, 15), CA = '0x' + '1'.repeat(40), KEY = 'public-v2-fixture';
const hour = at => Math.floor(at / 3600000) * 3600000;
const utcDay = at => new Date(at).toISOString().slice(0, 10);
const legacy = (used = 2000, at = AT) => ({ day: utcDay(at), used, blockedUntil: 0, quotaUntil: 0, nextRequestAt: at - 1000 });
const v2 = (changes = {}) => ({ budgetVersion: 2, day: utcDay(AT), dailyUsed: 0, hourStartedAt: hour(AT), hourlyUsed: 0,
  totalUsed: 0, periodStartedAt: AT - 86400000, legacyUsageIncluded: false, legacySnapshot: null,
  blockedUntil: 0, quotaUntil: 0, nextRequestAt: 0, ...changes });

function fixture({ initial = null, options = {}, fetchResponse } = {}) {
  let stored = structuredClone(initial), at = AT, key = KEY;
  const calls = [], writes = [], now = () => at;
  const read = () => structuredClone(stored);
  const token = chain => ({ chain, token: CA, current_price_usd: '1', market_cap: '40000', updated_at: Math.floor(at / 1000) - 1 });
  const config = { apiKeyProvider: () => key, now, pause: async ms => { at += ms; }, enrichLimit: 0,
    readBudget: read, saveBudget: value => { stored = structuredClone(value); writes.push(structuredClone(value)); },
    fetchImpl: async (url, init) => {
      calls.push({ url, init, at });
      if (fetchResponse) return fetchResponse(url, init);
      const chain = url.includes('/trending?') ? new URL(url).searchParams.get('chain') : new URL(url).pathname.split('-').at(-1);
      return Response.json(url.includes('/trending?') ? { tokens: [token(chain)] } : { status: 1, data: { token: token(chain), pairs: [] } });
    }, ...options };
  return { client: new AveClient(config), config, calls, writes, read, now, advance: ms => { at += ms; }, setTime: value => { at = value; }, setKey: value => { key = value; } };
}

test('new defaults are local lifetime total, daily cap, fixed UTC-hour cap, and ten-percent discovery reserve', () => {
  const f = fixture(), s = f.client.snapshot();
  assert.equal(AVE_LIMITS.dailyCu, 30000); assert.equal(AVE_LIMITS.totalCu, 1000000); assert.equal(AVE_LIMITS.hourlyCu, 1250);
  assert.equal(s.dailyLimit, 30000); assert.equal(s.totalLimit, 1000000); assert.equal(s.hourlyLimit, 1250);
  assert.equal(s.discoveryReserveCu, 3000); assert.equal(s.manualResetRequired, false); assert.equal(f.calls.length, 0);
});

test('legacy 2000 CU is durably included even when conservative current-hour migration denies the first request', async () => {
  const old = legacy(), f = fixture({ initial: old });
  await assert.rejects(f.client.trending('bsc'), error => error.code === 'AVE_HOURLY_BUDGET' && error.retryAt === hour(AT) + 3600000);
  const saved = f.read(), s = f.client.snapshot();
  assert.equal(saved.budgetVersion, 2); assert.equal(Object.hasOwn(saved, 'used'), false);
  assert.equal(saved.dailyUsed, 2000); assert.equal(saved.totalUsed, 2000); assert.equal(saved.hourlyUsed, 2000);
  assert.equal(saved.periodStartedAt, AT); assert.equal(saved.legacyUsageIncluded, true); assert.deepEqual(saved.legacySnapshot, old);
  assert.equal(s.budget.used, 2000); assert.equal(s.budget.totalRemaining, 998000);
  assert.equal(s.budget.historyComplete, false); assert.equal(s.budget.hourUsed, 2000); assert.equal(s.budget.hourRemaining, 0);
  assert.equal(s.pauseCode, 'AVE_HOURLY_BUDGET'); assert.equal(s.manualResetRequired, false); assert.equal(s.nextAllowedAt, hour(AT) + 3600000);
  assert.equal(f.calls.length, 0); assert.equal(f.client.metrics.estimatedCu, 0);
  f.setTime(hour(AT) + 3600000);
  const restarted = new AveClient(f.config); await restarted.trending('bsc');
  assert.equal(f.read().totalUsed, 2005); assert.equal(f.read().dailyUsed, 2005); assert.equal(f.read().hourlyUsed, 5);
  assert.equal(f.read().periodStartedAt, AT); assert.deepEqual(f.read().legacySnapshot, old);
});

test('older-day legacy consumption remains in total but does not fabricate today or this-hour usage', async () => {
  const old = legacy(2000, AT - 86400000), f = fixture({ initial: old });
  await f.client.trending('bsc');
  assert.equal(f.read().totalUsed, 2005); assert.equal(f.read().dailyUsed, 5); assert.equal(f.read().hourlyUsed, 5);
  assert.equal(f.read().legacyUsageIncluded, true); assert.deepEqual(f.read().legacySnapshot, old);
});

test('same-day previous-hour legacy total is preserved without claiming it was consumed this hour', async () => {
  const f = fixture({ initial: legacy(2000, AT - 3600000) });
  await f.client.trending('bsc');
  assert.equal(f.read().totalUsed, 2005); assert.equal(f.read().dailyUsed, 2005); assert.equal(f.read().hourlyUsed, 5);
});

test('total exhaustion survives time, restart and key changes and never schedules an automatic renewal', async () => {
  const f = fixture({ initial: v2({ totalUsed: 999995 }) });
  await f.client.trending('bsc');
  assert.equal(f.read().totalUsed, 1000000);
  let s = f.client.snapshot();
  assert.equal(s.manualResetRequired, true); assert.equal(s.pauseCode, 'AVE_TOTAL_BUDGET'); assert.equal(s.nextAllowedAt, 0);
  assert.equal(s.budget.totalRemaining, 0);
  f.setKey('rotated-public-v2-key'); f.client.resetCredentials();
  await assert.rejects(f.client.details('bsc', CA), error => error.code === 'AVE_TOTAL_BUDGET' && !Object.hasOwn(error, 'retryAt'));
  f.advance(31 * 86400000);
  const restarted = new AveClient(f.config);
  await assert.rejects(restarted.trending('bsc'), error => error.code === 'AVE_TOTAL_BUDGET' && !Object.hasOwn(error, 'retryAt'));
  s = restarted.snapshot();
  assert.equal(s.budget.used, 0); assert.equal(s.budget.hourlyUsed, 0); assert.equal(s.budget.totalUsed, 1000000);
  assert.equal(s.pauseCode, 'AVE_TOTAL_BUDGET'); assert.equal(s.manualResetRequired, true);
  assert.ok(Number.isFinite(s.nextAllowedAt)); assert.equal(s.nextAllowedAt, 0); assert.equal(f.calls.length, 1);
});

test('a 10 CU read cannot spend or globally pause the final affordable 5 CU of total budget', async () => {
  const f = fixture({ initial: v2({ totalUsed: 999995 }) });
  await assert.rejects(f.client.tokenKlines('bsc', CA), { code: 'AVE_TOTAL_BUDGET' });
  assert.equal(f.client.snapshot().manualResetRequired, false); assert.equal(f.client.nextAllowedAt, 0); assert.equal(f.calls.length, 0);
  await f.client.trending('bsc'); assert.equal(f.read().totalUsed, 1000000); assert.equal(f.calls.length, 1);
});

test('hourly cap is a persisted fixed UTC hour and does not erase daily or lifetime totals', async () => {
  const f = fixture({ initial: v2({ dailyUsed: 1245, hourlyUsed: 1245, totalUsed: 5000 }) });
  await assert.rejects(f.client.tokenKlines('bsc', CA), error => error.code === 'AVE_HOURLY_BUDGET' && error.retryAt === hour(AT) + 3600000);
  assert.equal(f.client.nextAllowedAt, 0, 'five remaining CU can still fund trending');
  await f.client.trending('bsc');
  assert.equal(f.client.snapshot().pauseCode, 'AVE_HOURLY_BUDGET'); assert.equal(f.client.nextAllowedAt, hour(AT) + 3600000);
  const restarted = new AveClient(f.config);
  await assert.rejects(restarted.details('bsc', CA), { code: 'AVE_HOURLY_BUDGET' }); assert.equal(f.calls.length, 1);
  f.setTime(hour(AT) + 3600000);
  await restarted.details('bsc', CA);
  assert.equal(f.read().hourlyUsed, 5); assert.equal(f.read().dailyUsed, 1255); assert.equal(f.read().totalUsed, 5010);
  assert.equal(restarted.snapshot().pauseCode, null);
});

test('daily rollover clears only daily and hourly counters, never the accumulated total', async () => {
  const f = fixture({ initial: v2({ dailyUsed: 29995, totalUsed: 90000 }) });
  await f.client.trending('bsc'); assert.equal(f.client.snapshot().pauseCode, 'AVE_BUDGET');
  f.advance(3600000);
  await assert.rejects(f.client.trending('eth'), { code: 'AVE_BUDGET' });
  f.setTime(Date.UTC(2026, 8, 23));
  const before = f.read(); assert.equal(f.client.snapshot().budget.used, 0); assert.deepEqual(f.read(), before);
  await f.client.trending('eth');
  assert.equal(f.read().dailyUsed, 5); assert.equal(f.read().hourlyUsed, 5); assert.equal(f.read().totalUsed, 90010);
});

test('raising local daily limit removes stale in-memory daily pause without changing recorded consumption', async () => {
  const f = fixture({ options: { dailyBudgetCu: 5, discoveryReserveCu: 0 } });
  await f.client.trending('bsc'); await assert.rejects(f.client.details('bsc', CA), { code: 'AVE_BUDGET' });
  assert.ok(f.client.nextAllowedAt > f.now());
  f.client.dailyBudgetCu = 30000; f.client.discoveryReserveCu = 3000;
  const s = f.client.snapshot(); assert.equal(s.pauseCode, null); assert.equal(s.nextAllowedAt, 0); assert.equal(s.budget.totalUsed, 5);
  await f.client.details('bsc', CA); assert.equal(f.read().totalUsed, 10); assert.equal(f.read().dailyUsed, 10);
});

test('default reserve protects 3000 daily CU independently of hourly and total allowances', async () => {
  const f = fixture({ initial: v2({ dailyUsed: 26995, totalUsed: 26995 }) });
  await f.client.details('bsc', CA); f.advance(31000);
  await assert.rejects(f.client.details('bsc', CA), { code: 'AVE_DISCOVERY_RESERVE' });
  assert.equal(f.client.snapshot().budget.nonTrendingRemaining, 0); assert.equal(f.client.nextAllowedAt, 0);
  await f.client.trending('bsc'); assert.equal(f.read().dailyUsed, 27005); assert.equal(f.read().totalUsed, 27005);
});

test('v2 file rejects old-writer format and preserves legacy snapshot under the original lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ave-v2-guard-')), store = createAveBudgetStore(directory), old = legacy(2000, AT - 3600000);
  store.transact(() => old);
  const f = fixture({ options: { budgetStore: store } }); await f.client.trending('bsc');
  const path = join(directory, 'ave-read-budget.json'), before = readFileSync(path, 'utf8');
  assert.equal(JSON.parse(before).totalUsed, 2005); assert.deepEqual(JSON.parse(before).legacySnapshot, old);
  // This is the old client's mandatory validation: missing top-level used
  // fails before the old writer can replace the ledger with a v1 object.
  assert.throws(() => store.transact(previous => {
    if (!Number.isSafeInteger(previous.used)) throw new Error('old-client-validation');
    return { ...old, used: previous.used + 5 };
  }), { code: 'AVE_BUDGET_STORE' });
  assert.throws(() => store.transact(() => old), { code: 'AVE_BUDGET_STORE' });
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('multiple file-backed instances share monotonically increasing total/hour/day counters', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ave-v2-shared-')), f = fixture({ options: { directory, budgetStore: createAveBudgetStore(directory) } });
  const second = new AveClient(f.config);
  await f.client.details('bsc', CA); await second.trending('bsc');
  f.advance(31000); await f.client.details('bsc', CA);
  const persisted = JSON.parse(readFileSync(join(directory, 'ave-read-budget.json'), 'utf8'));
  assert.equal(persisted.totalUsed, 15); assert.equal(persisted.dailyUsed, 15); assert.equal(persisted.hourlyUsed, 15);
  assert.equal(persisted.legacyUsageIncluded, false); assert.equal(persisted.legacySnapshot, null);
  assert.equal(f.client.snapshot().budget.historyComplete, true);
});

test('unknown versions, malformed totals and clock rollback fail closed without dispatch', async () => {
  for (const initial of [v2({ budgetVersion: 3 }), v2({ used: 0 }), v2({ totalUsed: -1 }),
    v2({ dailyUsed: 10, totalUsed: 5 }), v2({ hourStartedAt: AT }), v2({ legacyUsageIncluded: true }),
    v2({ periodStartedAt: AT + 1 })]) {
    const f = fixture({ initial });
    await assert.rejects(f.client.trending('bsc'), { code: 'AVE_BUDGET_STORE' }); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); await f.client.trending('bsc'); f.advance(-3600000);
  await assert.rejects(f.client.details('bsc', CA), { code: 'AVE_BUDGET_STORE' }); assert.equal(f.calls.length, 1);
});

test('failed persistence cannot dispatch or silently refund an existing cumulative ledger', async () => {
  const initial = v2({ dailyUsed: 2000, totalUsed: 5000 });
  const f = fixture({ initial, options: { saveBudget: () => { throw new Error('test write denied'); } } });
  await assert.rejects(f.client.trending('bsc'), { code: 'AVE_BUDGET_STORE' });
  assert.deepEqual(f.read(), initial); assert.equal(f.calls.length, 0); assert.equal(f.client.metrics.estimatedCu, 0);
});

test('cache-only live with no snapshot issues no request and does not read credentials or change health', async () => {
  const f = fixture({ options: { apiKeyProvider: () => { throw new Error('must not access credentials'); } } });
  const oldHealth = f.client.lastDiscoveryHealth;
  assert.deepEqual(await f.client.live('bsc', { refresh: false }), { tokens: [], capturedAt: null, interval: null, coverage: 'trending_sample' });
  assert.equal(f.client.lastDiscoveryHealth, oldHealth); assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});

test('cache-only live preserves chain-specific capture clocks, marks expiry, and never steals refresh ownership', async () => {
  const f = fixture(); const first = await f.client.discover('bsc');
  await f.client.discover('eth'); const health = structuredClone(f.client.lastDiscoveryHealth), before = f.read();
  f.advance(11 * 60000);
  const live = await f.client.live('bsc', { refresh: false });
  assert.equal(live.tokens[0].chain, 'bsc'); assert.equal(live.tokens[0].stale, true);
  assert.equal(live.capturedAt, first[0].capturedAt); assert.equal(live.tokens[0].capturedAt, first[0].capturedAt);
  assert.equal(live.tokens[0].sourceUpdatedAt, first[0].sourceUpdatedAt); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.client.lastDiscoveryHealth, health); assert.deepEqual(f.read(), before);
  live.tokens[0].name = 'mutated'; assert.notEqual((await f.client.live('bsc', { refresh: false })).tokens[0].name, 'mutated');
  await f.client.discover('bsc'); assert.equal(f.calls.length, 3);
});

test('invalid limits and cancelled passive reads are rejected before network or ledger access', async () => {
  for (const options of [{ totalBudgetCu: 1000001 }, { hourlyBudgetCu: 0 }, { dailyBudgetCu: 30001 }, { discoveryReserveCu: 30001 }, { discoveryReserveCu: 1 }]) {
    assert.throws(() => fixture({ options }), { code: 'AVE_INPUT' });
  }
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.live('bsc', { refresh: false, signal: controller.signal }), { code: 'AVE_ABORTED' });
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});
