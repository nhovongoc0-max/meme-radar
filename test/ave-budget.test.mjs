import test from 'node:test';
import assert from 'node:assert/strict';
import { AveClient } from '../src/ave.mjs';

const AT = Date.UTC(2026, 8, 22, 12);
const KEY = 'public-budget-test-key';
const ca = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const CA = ca(1), OTHER = ca(2), POOL = ca(101);
const ledger = (used, at = AT) => ({ day: new Date(at).toISOString().slice(0, 10), used, blockedUntil: 0, quotaUntil: 0, nextRequestAt: 0 });

function fixture({ at = AT, used = 0, tokens = [CA], options = {}, fetchResponse } = {}) {
  let time = at, stored = ledger(used, at), key = KEY;
  const calls = [], saved = [], now = () => time;
  const token = (chain, address) => ({ chain, token: address, current_price_usd: '1', market_cap: '40000', updated_at: at / 1000 - 1 });
  const response = url => {
    const parsed = new URL(url), chain = parsed.searchParams.get('chain') || parsed.pathname.split('-').at(-1);
    if (parsed.pathname.endsWith('/trending')) return { tokens: tokens.map(address => token(chain, address)) };
    if (parsed.pathname.includes('/klines/')) return { status: 1, data: { interval: 1, points: [
      { time: Math.floor(at / 60000) * 60 - 60, open: '1', high: '1.1', low: '.9', close: '1', volume: '20' }
    ] } };
    const address = parsed.pathname.split('/').at(-1).split('-')[0];
    if (parsed.pathname.includes('/pairs/')) {
      const target = ca(BigInt(address) - 100n);
      return { chain, pair: address, amm: 'pancakeswap', token0_address: target, token1_address: ca(99), target_token: target,
        token0_price_usd: '1', token1_price_usd: '2', tvl: '12000', market_cap: '40000', updated_at: at / 1000 - 1,
        created_at: at / 1000 - 3600, first_trade_at: at / 1000 - 3500, last_trade_at: at / 1000 - 1,
        volume_u_5m: '200', buy_volume_u_5m: '110', sell_volume_u_5m: '90' };
    }
    return { status: 1, data: { token: token(chain, address), pairs: [{ chain, pair: ca(BigInt(address) + 100n), amm: 'pancakeswap' }] } };
  };
  const config = { apiKeyProvider: () => key, now, pause: async ms => { time += ms; }, enrichLimit: 0,
    dailyBudgetCu: 2000, hourlyBudgetCu: 2000, discoveryReserveCu: Math.floor((options.dailyBudgetCu ?? 2000) * .4 / 5) * 5,
    readBudget: () => structuredClone(stored), saveBudget: value => { saved.push(structuredClone(value)); stored = structuredClone(value); },
    fetchImpl: async (url, init) => { calls.push({ url, init, at: time }); return fetchResponse ? fetchResponse(url, init) : Response.json(response(url)); }, ...options };
  const client = new AveClient(config);
  return { client, calls, saved, config, now, advance: ms => { time += ms; }, setKey: value => { key = value; },
    stored: () => ({ ...structuredClone(stored), used: stored.dailyUsed ?? stored.used }) };
}

test('40 percent reserve blocks supplementary requests without pausing trending or charging denied work', async () => {
  const f = fixture({ used: 1195 });
  await f.client.details('bsc', CA);
  assert.equal(f.stored().used, 1200);
  await assert.rejects(f.client.tokenKlines('bsc', CA), error => error.code === 'AVE_DISCOVERY_RESERVE' && error.retryAt > f.now());
  assert.equal(f.calls.length, 1); assert.equal(f.client.nextAllowedAt, 0);
  assert.equal(f.client.snapshot().pauseCode, null);
  assert.equal(f.client.snapshot().discoveryReserveCu, 800);
  assert.equal(f.client.snapshot().budget.nonTrendingRemaining, 0);
  assert.ok(f.client.snapshot().nonTrendingPausedUntil > f.now());
  await assert.rejects(f.client.details('bsc', CA), { code: 'AVE_DISCOVERY_RESERVE' });
  assert.equal(f.calls.length, 1, 'the sixty-second lane can expire details, but denied work still never dispatches');
  await f.client.trending('bsc');
  assert.equal(f.calls.length, 2); assert.equal(f.stored().used, 1205);
  assert.equal(f.client.snapshot().metrics.estimatedCu, 10);
  assert.equal(f.client.snapshot().metrics.byKind.klines.estimatedCu, 0);
});

test('small budgets reserve whole request units and stop globally only below the 5 CU minimum', async () => {
  const f = fixture({ options: { dailyBudgetCu: 15 } });
  assert.equal(f.client.snapshot().discoveryReserveCu, 5);
  await f.client.tokenKlines('bsc', CA); assert.equal(f.stored().used, 10);
  await assert.rejects(f.client.details('bsc', CA), { code: 'AVE_DISCOVERY_RESERVE' });
  assert.equal(f.client.nextAllowedAt, 0);
  await f.client.trending('bsc'); assert.equal(f.stored().used, 15);
  await assert.rejects(f.client.trending('eth'), { code: 'AVE_BUDGET' });
  assert.equal(f.client.snapshot().pauseCode, 'AVE_BUDGET'); assert.ok(f.client.nextAllowedAt > f.now());
  assert.equal(f.calls.length, 2);
});

test('an unaffordable 10 CU Kline leaves the final affordable 5 CU trending request available', async () => {
  const f = fixture({ used: 5, options: { dailyBudgetCu: 10 } });
  assert.equal(f.client.snapshot().discoveryReserveCu, 0);
  await assert.rejects(f.client.tokenKlines('bsc', CA), { code: 'AVE_DISCOVERY_RESERVE' });
  assert.equal(f.client.nextAllowedAt, 0); assert.equal(f.calls.length, 0);
  await f.client.trending('bsc'); assert.equal(f.stored().used, 10); assert.equal(f.calls.length, 1);
});

test('reserve respects persisted consumption across restart and credential changes; new day does not reuse old usage', async () => {
  const f = fixture({ used: 1200 });
  await assert.rejects(f.client.details('bsc', CA), { code: 'AVE_DISCOVERY_RESERVE' });
  f.setKey('another-public-key'); f.client.resetCredentials();
  await assert.rejects(f.client.details('bsc', CA), { code: 'AVE_DISCOVERY_RESERVE' });
  const restarted = new AveClient(f.config);
  await assert.rejects(restarted.tokenKlines('bsc', CA), { code: 'AVE_DISCOVERY_RESERVE' });
  assert.equal(f.stored().used, 1200); assert.equal(f.calls.length, 0);
  await restarted.trending('bsc'); assert.equal(f.stored().used, 1205);
  f.advance(86400000);
  assert.equal(restarted.snapshot().budget.used, 0); assert.equal(restarted.snapshot().nonTrendingPausedUntil, 0);
  await restarted.details('bsc', CA); assert.equal(f.stored().used, 5);
});

test('already exhausted daily ledger is never cleared by new credentials or reserve logic', async () => {
  const f = fixture({ used: 2000 });
  await assert.rejects(f.client.trending('bsc'), { code: 'AVE_BUDGET' });
  f.client.resetCredentials(); f.setKey('rotated-public-key');
  await assert.rejects(f.client.details('bsc', CA), { code: 'AVE_BUDGET' });
  const restarted = new AveClient(f.config);
  await assert.rejects(restarted.trending('bsc'), { code: 'AVE_BUDGET' });
  assert.equal(f.stored().used, 2000); assert.equal(f.calls.length, 0);
});

test('cache-only midnight snapshot shows today without writing, refunding, or refreshing source clocks', async () => {
  const at = Date.UTC(2026, 8, 22, 23, 59, 55), f = fixture({ at });
  const [first] = await f.client.discover('bsc'), stored = f.stored(), writeCount = f.saved.length;
  f.advance(10000);
  const [cached] = await f.client.discover('bsc'), snapshot = f.client.snapshot();
  assert.equal(snapshot.budget.day, '2026-09-23'); assert.equal(snapshot.budget.used, 0);
  assert.equal(snapshot.budget.remaining, 2000); assert.equal(snapshot.budget.nonTrendingRemaining, 1200);
  assert.deepEqual(f.stored(), stored); assert.equal(f.saved.length, writeCount); assert.equal(f.calls.length, 1);
  assert.equal(cached.capturedAt, first.capturedAt); assert.equal(cached.sourceUpdatedAt, first.sourceUpdatedAt);
  assert.equal(snapshot.metrics.estimatedCu, 5, 'session accounting is not silently reset at midnight');
  await f.client.details('bsc', CA);
  assert.equal(f.stored().day, '2026-09-23'); assert.equal(f.stored().used, 5);
});

test('session by-kind counters distinguish reservations, dispatches, endpoint cache and assembled discovery cache', async () => {
  const f = fixture();
  await f.client.discover('bsc'); await f.client.trending('bsc'); await f.client.discover('bsc');
  await f.client.details('bsc', CA); await f.client.pairDetails('bsc', POOL);
  await f.client.tokenKlines('bsc', CA); await f.client.tokenKlines('bsc', CA);
  await f.client.verifyApiKey('candidate-public-key');
  const snapshot = f.client.snapshot(), metrics = snapshot.metrics;
  assert.equal(metrics.scope, 'session'); assert.equal(metrics.requests, 5); assert.equal(metrics.estimatedCu, 30);
  assert.equal(metrics.cacheHits, 3); assert.equal(metrics.discoveryCacheHits, 1);
  assert.deepEqual(metrics.byKind, {
    trending: { requests: 1, cacheHits: 1, estimatedCu: 5 }, details: { requests: 2, cacheHits: 0, estimatedCu: 10 },
    pair: { requests: 1, cacheHits: 0, estimatedCu: 5 }, klines: { requests: 1, cacheHits: 1, estimatedCu: 10 }
  });
  metrics.byKind.trending.requests = 999;
  assert.equal(f.client.snapshot().metrics.byKind.trending.requests, 1, 'public snapshots cannot mutate internal counters');
  assert.doesNotMatch(JSON.stringify(snapshot), /public-key|public-budget-test-key|0x/);
  assert.ok(f.calls.slice(1).every((call, i) => call.at - f.calls[i].at >= 1000));
});

test('failed dispatched request remains charged and reported without a retry or leaked error body', async () => {
  const f = fixture({ fetchResponse: () => new Response(KEY, { status: 500 }) });
  await assert.rejects(f.client.tokenKlines('bsc', CA), error => error.code === 'AVE_UPSTREAM' && !error.message.includes(KEY));
  assert.deepEqual(f.client.snapshot().metrics.byKind.klines, { requests: 1, cacheHits: 0, estimatedCu: 10 });
  assert.equal(f.stored().used, 10); assert.equal(f.calls.length, 1);
});

test('audit and historical reads propagate reserve while discovery preserves raw unknown leads', async () => {
  const f = fixture({ used: 1200, options: { enrichLimit: 1 } });
  await assert.rejects(f.client.audit(CA, AT / 1000, 'bsc'), { code: 'AVE_DISCOVERY_RESERVE' });
  await assert.rejects(f.client.priceAt(CA, AT - 60000, 'bsc'), { code: 'AVE_DISCOVERY_RESERVE' });
  const [row] = await f.client.discover('bsc');
  assert.equal(f.calls.length, 1); assert.equal(f.stored().used, 1205);
  assert.equal(row.liquidity, null); assert.equal(row.is_honeypot, null); assert.equal(row.volume_5m, null);
  assert.equal(f.client.lastDiscoveryHealth.enrichment.pausedCode, 'AVE_DISCOVERY_RESERVE');
  assert.ok(f.client.lastDiscoveryHealth.enrichment.pausedUntil > f.now());
  assert.equal(f.client.lastDiscoveryHealth.enrichment.complete, false);
  assert.deepEqual(f.client.lastDiscoveryHealth.enrichment.errors, []);
  assert.equal(f.client.lastDiscoveryHealth.complete, true, 'local scheduling pause is not a transport failure');
  assert.equal(f.client.snapshot().pauseCode, null); assert.equal(f.client.nextAllowedAt, 0);
});

test('audit stops immediately when reserve is reached between info, pool, and candles', async () => {
  for (const used of [1195, 1190]) {
    const f = fixture({ used });
    await assert.rejects(f.client.audit(CA, AT / 1000, 'bsc'), { code: 'AVE_DISCOVERY_RESERVE' });
    assert.equal(f.calls.length, used === 1195 ? 1 : 2);
    assert.equal(f.stored().used, 1200); assert.equal(f.client.nextAllowedAt, 0);
  }
});

test('known rejection defers only bound discovery enrichment; raw leads and other tokens remain visible', async () => {
  const f = fixture({ tokens: [CA, OTHER], options: { enrichLimit: 1 } });
  assert.equal(f.client.deferEnrichment('bsc', CA, { evidenceAt: AT, until: AT + 1800000 }), true);
  await f.client.discover('bsc'); f.advance(31000);
  const rows = await f.client.discover('bsc');
  assert.equal(rows.length, 2); assert.equal(rows[0].address, CA); assert.equal(rows[0].liquidity, null);
  assert.equal(rows[0].is_honeypot, null); assert.equal(rows[1].liquidity, 12000);
  assert.equal(f.calls.length, 3); assert.equal(f.stored().used, 15);
  assert.equal(f.client.lastDiscoveryHealth.enrichment.deferred, 1);
  assert.equal(f.client.lastDiscoveryHealth.enrichment.complete, false);
  assert.equal(f.client.lastDiscoveryHealth.enrichment.attempted, 1); assert.equal(f.client.lastDiscoveryHealth.complete, true);
  // Deferral does not forbid an independently requested risk audit/details.
  await f.client.details('bsc', CA); assert.equal(f.calls.length, 4);
  await f.client.discover('robinhood'); f.advance(31000);
  const rh = await f.client.discover('robinhood');
  assert.equal(rh[0].liquidity, 12000, 'another chain with the same CA is not deferred');
});

test('deferral expires from original evidence time, does not extend on stale polling, and never refreshes cached quotes', async () => {
  const f = fixture({ options: { enrichLimit: 1 } });
  assert.equal(f.client.deferEnrichment('bsc', CA, { evidenceAt: AT, until: AT + 86400000 }), true);
  const [first] = await f.client.discover('bsc'); assert.equal(f.calls.length, 1);
  f.advance(610000);
  assert.equal(f.client.deferEnrichment('bsc', CA, { evidenceAt: AT, until: f.now() + 1800000 }), false);
  const [again] = await f.client.discover('bsc');
  assert.equal(f.calls.length, 2); assert.equal(again.stale, true); assert.equal(again.sourceUpdatedAt, first.sourceUpdatedAt);
  assert.equal(again.liquidity, null);
  f.advance(1200000);
  await f.client.discover('bsc'); f.advance(31000);
  const [resumed] = await f.client.discover('bsc');
  assert.equal(f.calls.length, 5); assert.equal(resumed.liquidity, 12000); assert.equal(resumed.stale, true);
  assert.equal(f.client.lastDiscoveryHealth.enrichment.deferred, 0);
  assert.equal(f.client.deferEnrichment('bsc', CA, { evidenceAt: AT, until: f.now() + 1800000 }), false);
});

test('invalid deferral inputs are inert and do not access credentials or spend budget', () => {
  const f = fixture();
  for (const [chain, address, evidenceAt, until] of [
    ['custom', CA, AT, AT + 1], ['bsc', '../x', AT, AT + 1], ['bsc', ca(0), AT, AT + 1],
    ['bsc', CA, AT + 1, AT + 10], ['bsc', CA, null, AT + 1], ['bsc', CA, AT, Infinity],
    ['bsc', CA, AT - 1800001, AT + 1], ['bsc', CA, AT, AT]
  ]) assert.equal(f.client.deferEnrichment(chain, address, { evidenceAt, until }), false);
  assert.equal(f.calls.length, 0); assert.equal(f.saved.length, 0); assert.equal(f.stored().used, 0);
});

test('priceAt forwards caller cancellation without reserving or dispatching a historical read', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.priceAt(CA, AT - 60000, 'bsc', { signal: controller.signal }), { code: 'AVE_ABORTED' });
  assert.equal(f.calls.length, 0); assert.equal(f.stored().used, 0);
});

test('priceAt caller can cancel an in-flight historical read; already reserved CU is not refunded', async () => {
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const f = fixture({ fetchResponse: () => { start(); return new Promise(() => {}); } });
  const controller = new AbortController(), request = f.client.priceAt(CA, AT - 60000, 'bsc', { signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(request, { code: 'AVE_ABORTED' });
  assert.equal(f.calls.length, 1); assert.equal(f.stored().used, 10);
  assert.deepEqual(f.client.snapshot().metrics.byKind.klines, { requests: 1, cacheHits: 0, estimatedCu: 10 });
});
