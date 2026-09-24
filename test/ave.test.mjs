import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AveClient, createAveBudgetStore, AVE_LIMITS, tokenInfoPrice, normalizeList } from '../src/ave.mjs';

const ca = n => '0x' + n.toString(16).padStart(40, '0');
const CA = ca(1), POOL = ca(2), KEY = 'public-mock-key-never-live';
const AT = Date.UTC(2026, 8, 21, 12, 0, 0);
const token = (chain = 'bsc', changes = {}) => ({ token: CA, chain, name: 'Fixture', symbol: 'TEST', current_price_usd: '0.125', market_cap: '40000', holders: 25, tvl: '9000', updated_at: AT / 1000 - 10, ...changes });
const detail = (chain = 'bsc', changes = {}) => ({ status: 1, data: { is_audited: true, token: token(chain, changes), pairs: [{ chain, pair: POOL, amm: 'pancakeswap', updated_at: AT / 1000 - 20 }] } });
const pair = (changes = {}) => ({ pair: POOL, chain: 'bsc', amm: 'pancakeswap', token0_address: CA, token1_address: ca(3), target_token: CA,
  token0_price_usd: '0.126', token1_price_usd: '1', tvl: '12000', market_cap: '41000', created_at: AT / 1000 - 3600,
  first_trade_at: AT / 1000 - 3300, last_trade_at: AT / 1000 - 3, updated_at: AT / 1000 - 1,
  volume_u_5m: '500', volume_u_1h: '1500', volume_u_24h: '10000', price_change_5m: '10',
  buy_volume_u_5m: '300', sell_volume_u_5m: '200', buys_tx_24h_count: 100, sells_tx_24h_count: 80, ...changes });
const klines = (changes = {}) => ({ status: 1, data: { interval: 1, points: Array.from({ length: 7 }, (_, index) => ({ time: AT / 1000 - (6 - index) * 60, open: '1', high: '1.2', low: '0.9', close: '1.1', volume: '10' })), ...changes } });
const responseFor = url => url.includes('/trending?') ? { tokens: [token(new URL(url).searchParams.get('chain'))] } : url.includes('/klines/') ? klines() : url.includes('/pairs/') ? pair() : detail();
function fixture(options = {}) {
  let time = AT, key = KEY, stored = null;
  const calls = [], saved = [], clock = options.now || (() => time);
  const fetchImpl = options.fetchImpl || (async (url, init) => { calls.push({ url, init, at: clock() }); return Response.json(responseFor(url)); });
  const client = new AveClient({ apiKeyProvider: () => key, now: clock, pause: async ms => { time += ms; }, fetchImpl,
    dailyBudgetCu: 2000, hourlyBudgetCu: 2000, discoveryReserveCu: Math.floor((options.dailyBudgetCu ?? 2000) * .4 / 5) * 5,
    readBudget: () => structuredClone(stored), saveBudget: value => { saved.push(value); stored = structuredClone(value); }, enrichLimit: 0, ...options });
  return { client, calls, saved, now: clock, setTime: value => { time = value; }, advance: value => { time += value; }, setKey: value => { key = value; }, budget: () => stored };
}

test('fixed readonly endpoints carry only AVE key header and preserve documented token TVL without fabricating risk', async () => {
  const f = fixture(), rows = await f.client.discover('bsc'), row = rows[0];
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'https://prod.ave-api.com/v2/tokens/trending?chain=bsc&current_page=0&page_size=100');
  assert.equal(f.calls[0].init.method, 'GET'); assert.equal(f.calls[0].init.headers['X-API-KEY'], KEY);
  assert.equal(f.calls[0].init.redirect, 'error'); assert.equal(f.calls[0].init.credentials, 'omit'); assert.equal(f.calls[0].init.body, undefined);
  for (const field of ['creation_timestamp', 'volume_5m', 'buys_5m', 'sells_5m', 'rug_ratio', 'bundler_rate', 'rat_trader_amount_rate', 'is_honeypot', 'is_wash_trading']) assert.equal(row[field], null, field);
  assert.equal(row.tvl, 9000); assert.equal(row.liquidity, 9000); assert.equal(row.liquidityBasis, 'token_tvl');
  assert.equal(row.price, 0.125); assert.equal(row.sourceUpdatedAt, AT - 10000);
  assert.equal(row.capturedAt, AT); assert.equal(f.client.snapshot().budget.used, 5);
  assert.doesNotMatch(JSON.stringify([rows, f.client.snapshot(), f.client.lastDiscoveryHealth]), new RegExp(KEY));
});

test('documented AVE trending fields fill liquidity, 5m activity and launch age on the first request for every public chain', async () => {
  const chains = [['bsc', 'bsc', CA], ['eth', 'eth', CA], ['base', 'base', CA],
    ['sol', 'solana', 'So11111111111111111111111111111111111111112'], ['robinhood', 'robinhood', CA]];
  for (const [chain, apiChain, id] of chains) {
    const f = fixture({ enrichLimit: 6, fetchImpl: async () => Response.json({ tokens: [token(apiChain, {
      token: id, tvl: '13000', main_pair_tvl: '12500', launch_at: AT / 1000 - 900, created_at: AT / 1000 - 901,
      token_tx_volume_usd_5m: '987.65', token_buy_volume_u_5m: '600', token_sell_volume_u_5m: '387.65',
      token_tx_count_5m: 21, token_buy_tx_count_5m: 12, token_sell_tx_count_5m: 9, token_price_change_5m: '2.5'
    })] }) });
    const [row] = await f.client.discover(chain);
    assert.equal(f.client.snapshot().metrics.requests, 1, chain + ' must not spend a per-token enrichment read');
    assert.equal(row.liquidity, 12500); assert.equal(row.liquidityBasis, 'main_pair_tvl');
    assert.equal(row.volume_5m, 987.65); assert.equal(row.buy_volume_5m, 600); assert.equal(row.sell_volume_5m, 387.65);
    assert.equal(row.swaps_5m, 21); assert.equal(row.buys_5m, 12); assert.equal(row.sells_5m, 9);
    assert.equal(row.creation_timestamp, AT / 1000 - 900); assert.equal(row.ageBasis, 'launch');
    assert.equal(row.price_change_percent5m, .025); assert.equal(f.client.lastDiscoveryHealth.enrichment.attempted, 0);
    assert.equal(f.client.lastDiscoveryHealth.enrichment.complete, true);
  }
});

test('zero 5m activity remains a known zero and malformed optional trending facts are never displayed', async () => {
  const zero = fixture({ enrichLimit: 6, fetchImpl: async () => Response.json({ tokens: [token('bsc', {
    launch_at: AT / 1000 - 900, token_tx_volume_usd_5m: '0'
  })] }) });
  const [row] = await zero.client.discover('bsc');
  assert.equal(row.volume_5m, 0); assert.equal(zero.client.snapshot().metrics.requests, 1);
  for (const change of [{ main_pair_tvl: '-1' }, { token_tx_volume_usd_5m: 'NaN' }, { launch_at: 'yesterday' },
    { token_buy_tx_count_5m: 1.5 }]) {
    const bad = fixture({ fetchImpl: async () => Response.json({ tokens: [token('bsc', change)] }) });
    await assert.rejects(bad.client.discover('bsc'), { code: 'AVE_SCHEMA' });
  }
});

test('cache and concurrent dedupe preserve capture and upstream clocks without recharging', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.client.discover('bsc'), f.client.discover('bsc')]);
  a[0].name = 'changed'; assert.equal(b[0].name, 'Fixture'); assert.equal(f.calls.length, 1);
  f.advance(40000); const c = await f.client.discover('bsc');
  assert.equal(c[0].capturedAt, AT); assert.equal(c[0].sourceUpdatedAt, AT - 10000); assert.equal(c[0].stale, true);
  assert.equal(f.client.snapshot().budget.used, 5); assert.equal(f.calls.length, 1);
});

test('details, K lines, and candidate key verification share a sixty-second completion gap and one budget', async () => {
  const f = fixture({ fetchImpl: undefined });
  // The key test response may omit token but must still match BSC and the requested token if echoed.
  const calls = [], clock = () => f.now();
  const client = new AveClient({ apiKeyProvider: () => KEY, now: clock, pause: async ms => f.advance(ms),
    readBudget: () => null, saveBudget: () => {}, fetchImpl: async (url, init) => {
      calls.push({ url, init, at: clock() });
      const body = responseFor(url); if (url.includes('0xbb4c')) delete body.data.token.token;
      return Response.json(body);
    } });
  await Promise.all([client.details('bsc', CA), client.tokenKlines('bsc', CA), client.verifyApiKey('different-public-mock-key')]);
  assert.equal(calls.length, 3);
  assert.ok(calls[1].at - calls[0].at >= 60000); assert.ok(calls[2].at - calls[1].at >= 60000);
  assert.equal(calls[2].init.headers['X-API-KEY'], 'different-public-mock-key');
  assert.equal(client.snapshot().budget.used, 20); assert.equal(await client.configured(), true);
  assert.doesNotMatch(JSON.stringify(client.snapshot()), /different-public-mock-key/);
});

test('separate clients with one production clock share global serial dispatch', async () => {
  let time = AT; const now = () => time, calls = [];
  const options = { now, pause: async ms => { time += ms; }, apiKeyProvider: () => KEY, readBudget: () => null, saveBudget: () => {},
    fetchImpl: async url => { calls.push(time); return Response.json(responseFor(url)); } };
  const one = new AveClient(options), two = new AveClient(options);
  await Promise.all([one.details('bsc', CA), two.trending('bsc')]);
  assert.equal(calls.length, 2); assert.ok(calls[1] - calls[0] >= 60000);
});

test('durable budget survives new instances, key changes, and caches do not spend it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'community-ave-budget-'));
  let time = AT; const now = () => time, calls = [];
  const options = { directory, now, pause: async ms => { time += ms; }, apiKeyProvider: () => KEY, dailyBudgetCu: 10,
    fetchImpl: async url => { calls.push(url); return Response.json(responseFor(url)); } };
  const one = new AveClient(options); await one.details('bsc', CA); await one.details('bsc', CA);
  const two = new AveClient({ ...options, apiKeyProvider: () => 'different-mock-key' }); await two.trending('bsc');
  await assert.rejects(two.tokenKlines('bsc', CA), { code: 'AVE_BUDGET' });
  assert.equal(calls.length, 2);
  const raw = readFileSync(join(directory, 'ave-read-budget.json'), 'utf8');
  assert.equal(JSON.parse(raw).dailyUsed, 10); assert.equal(JSON.parse(raw).totalUsed, 10); assert.doesNotMatch(raw, /mock-key|0x|token/);
  if (process.platform !== 'win32') assert.equal(statSync(join(directory, 'ave-read-budget.json')).mode & 0o777, 0o600);
  time += 86400000; await two.trending('bsc'); assert.equal(two.snapshot().budget.used, 5);
});

test('missing persistence, malformed budget, symlink and active lock fail closed before fetch', async () => {
  assert.throws(() => new AveClient(), { code: 'AVE_BUDGET_STORE' });
  const f = fixture({ readBudget: () => ({ day: 'broken' }) });
  await assert.rejects(f.client.discover('bsc'), { code: 'AVE_BUDGET_STORE' }); assert.equal(f.calls.length, 0);
  for (const type of ['malformed', 'symlink', 'lock']) {
    const directory = mkdtempSync(join(tmpdir(), 'community-ave-bad-budget-'));
    if (type === 'malformed') writeFileSync(join(directory, 'ave-read-budget.json'), '{');
    if (type === 'symlink') { writeFileSync(join(directory, 'target.json'), '{}'); symlinkSync(join(directory, 'target.json'), join(directory, 'ave-read-budget.json')); }
    if (type === 'lock') writeFileSync(join(directory, 'ave-read-budget.lock'), '');
    const client = new AveClient({ directory, apiKeyProvider: () => KEY, fetchImpl: async () => { assert.fail('must not fetch'); } });
    await assert.rejects(client.discover('bsc'), { code: 'AVE_BUDGET_STORE' });
  }
});

test('budget persistence failure and clock rollback do not issue requests', async () => {
  const f = fixture({ saveBudget: () => { throw new Error(KEY); } });
  await assert.rejects(f.client.discover('bsc'), error => error.code === 'AVE_BUDGET_STORE' && !error.message.includes(KEY)); assert.equal(f.calls.length, 0);
  const good = fixture(); await good.client.discover('bsc'); good.advance(-86400000);
  await assert.rejects(good.client.details('bsc', CA), { code: 'AVE_BUDGET_STORE' }); assert.equal(good.calls.length, 1);
});

test('429 cooldown persists until an explicit request resumes; 402 stops until next UTC day', async () => {
  for (const status of [429, 402]) {
    let calls = 0, time = AT; const now = () => time;
    const directory = mkdtempSync(join(tmpdir(), 'community-ave-cooldown-'));
    const options = { directory, now, pause: async ms => { time += ms; }, apiKeyProvider: () => KEY,
      fetchImpl: async () => { calls++; return new Response(KEY, { status, headers: { 'Retry-After': '120' } }); } };
    const one = new AveClient(options);
    await assert.rejects(one.details('bsc', CA), error => error.code === (status === 429 ? 'AVE_RATE_LIMITED' : 'AVE_QUOTA') && error.retryAt > now() && !error.message.includes(KEY));
    const two = new AveClient(options);
    await assert.rejects(two.trending('bsc'), { code: status === 429 ? 'AVE_RATE_LIMITED' : 'AVE_QUOTA' });
    assert.equal(calls, status === 429 ? 2 : 1);
  }
});

test('key rotation rejects old response and cannot revive a reset cache', async () => {
  let finish; const started = new Promise(resolve => { finish = resolve; }); let release;
  const f = fixture({ fetchImpl: async () => { finish(); return await new Promise(resolve => { release = resolve; }); } });
  const request = f.client.discover('bsc'); await started; f.setKey('rotated-public-key');
  release(Response.json({ tokens: [token()] }));
  await assert.rejects(request, error => ['AVE_CHANGED', 'AVE_ABORTED'].includes(error.code));
  assert.equal(f.client.snapshot().chains.bsc.state, 'unverified'); assert.equal(f.client.snapshot().pending, 0);
});

test('reset and per-subscriber abort discard data, deduped remaining subscriber survives', async () => {
  let release, finish; const start = new Promise(resolve => { finish = resolve; });
  const f = fixture({ fetchImpl: async () => { finish(); return await new Promise(resolve => { release = resolve; }); } });
  const controller = new AbortController();
  const first = f.client.trending('bsc', { signal: controller.signal }), second = f.client.trending('bsc');
  await start; controller.abort(); await assert.rejects(first, { code: 'AVE_ABORTED' });
  release(Response.json({ tokens: [token()] })); assert.equal((await second).rows.length, 1);
  f.client.resetCredentials({ disabled: true });
  await assert.rejects(f.client.trending('bsc'), { code: 'AVE_DISABLED' });
});

test('queued reset and pre-aborted signal never issue a second fetch', async () => {
  let release, start; const ready = new Promise(resolve => { start = resolve; }); let calls = 0;
  const f = fixture({ fetchImpl: async () => { calls++; start(); return new Promise(resolve => { release = resolve; }); } });
  const one = f.client.trending('bsc'), two = f.client.details('bsc', CA); await ready;
  f.client.resetCredentials(); release(Response.json({ tokens: [token()] }));
  await assert.rejects(one, { code: 'AVE_ABORTED' }); await assert.rejects(two, { code: 'AVE_ABORTED' }); assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.trending('bsc', { signal: controller.signal }), { code: 'AVE_ABORTED' }); assert.equal(calls, 1);
});

test('strict identity rejects cross-chain, cross-token, duplicates, and non-EVM path injection', async () => {
  for (const payload of [
    { tokens: [token('eth')] }, { tokens: [token(), token('bsc', { current_price_usd: '0.5' })] }, { tokens: [token('bsc', { token: 'https://example.com' })] },
    { status: 0, data: { tokens: [token()] }, msg: KEY }, { status: 1, data: { tokens: [token()], chain: 'eth' } },
  ]) {
    const f = fixture({ fetchImpl: async () => Response.json(payload) });
    await assert.rejects(f.client.discover('bsc'), { code: 'AVE_SCHEMA' });
  }
  const f = fixture({ fetchImpl: async () => Response.json(detail('bsc', { token: ca(9) })) });
  await assert.rejects(f.client.details('bsc', CA), { code: 'AVE_SCHEMA' });
  const untouched = fixture();
  for (const [chain, id] of [['bsc', '../x'], ['custom', CA], ['bsc', ca(0)]]) await assert.rejects(untouched.client.details(chain, id), { code: 'AVE_INPUT' });
  assert.equal(untouched.calls.length, 0);
});

test('identical duplicate trending rows are collapsed without weakening conflicting identity checks', async () => {
  const same = token('bsc');
  const f = fixture({ fetchImpl: async () => Response.json({ tokens: [same, structuredClone(same)] }) });
  const result = await f.client.trending('bsc');
  assert.deepEqual(result.rows.map(row => row.token), [CA]);
  const invalidConflict = fixture({ fetchImpl: async () => Response.json({ tokens: [same, { ...same, current_price_usd: '0' }] }) });
  await assert.rejects(invalidConflict.client.trending('bsc'), { code: 'AVE_SCHEMA' });
});

test('one incomplete trending row cannot take an otherwise valid chain offline', async () => {
  const valid = token('bsc');
  const incomplete = token('bsc', { token: '0x2222222222222222222222222222222222222222', current_price_usd: '0' });
  const f = fixture({ fetchImpl: async () => Response.json({ tokens: [incomplete, valid] }) });
  const result = await f.client.trending('bsc');
  assert.deepEqual(result.rows.map(row => row.token), [CA]);
});

test('Solana is mapped explicitly while unverified chains are never reported supported', async () => {
  const sol = 'So11111111111111111111111111111111111111112';
  const f = fixture({ fetchImpl: async url => Response.json({ tokens: [token(new URL(url).searchParams.get('chain'), { token: sol })] }) });
  const rows = await f.client.discover('sol'); assert.equal(rows[0].chain, 'sol'); assert.equal(rows[0].address, sol);
  assert.equal(f.client.snapshot().chains.sol.apiChain, 'solana'); assert.equal(f.client.snapshot().chains.sol.state, 'observed');
  assert.equal(f.client.snapshot().chains.robinhood.documented, false); assert.equal(f.client.snapshot().chains.robinhood.state, 'unverified');
  const rh = fixture(); await rh.client.discover('robinhood'); assert.equal(rh.client.snapshot().chains.robinhood.state, 'observed');
});

test('upstream missing/old/future timestamps cannot become fresh by polling', async () => {
  for (const [updated_at, stale] of [[null, true], [AT / 1000 - 600, true], [AT / 1000 + 100, true], [AT / 1000 - 1, false]]) {
    const f = fixture({ fetchImpl: async () => Response.json({ tokens: [token('bsc', { updated_at })] }) });
    const rows = await f.client.discover('bsc'); assert.equal(rows[0].stale, stale);
    assert.equal(rows[0].sourceUpdatedAt, updated_at === null ? null : updated_at * 1000);
  }
});

test('token K lines use only closed 1m bars and preserve original event times', async () => {
  const f = fixture(), result = await f.client.tokenKlines('bsc', CA);
  assert.equal(result.list.length, 6); assert.equal(result.list.at(-1).time, AT - 60000); assert.equal(result.sourceUpdatedAt, AT);
  assert.equal(result.volumeUnit, 'upstream_unspecified');
  f.advance(30000); const cached = await f.client.tokenKlines('bsc', CA); assert.equal(cached.capturedAt, AT);
  assert.equal(cached.list.at(-1).time, AT - 60000); assert.equal(f.calls.length, 1);
});

test('invalid/conflicting candles and foreign identity fail schema, never get silently repaired', async () => {
  const one = klines().data.points[0];
  for (const change of [{ interval: 5 }, { chain: 'eth' }, { address: ca(9) }, { points: [{ ...one, high: '0.1' }] },
    { points: [{ ...one, time: one.time + 1 }] }, { points: [one, { ...one, close: '1.15' }] }, { points: [{ ...one, volume: null }] }]) {
    const f = fixture({ fetchImpl: async () => Response.json(klines(change)) });
    await assert.rejects(f.client.tokenKlines('bsc', CA), { code: 'AVE_SCHEMA' });
  }
});

test('audit preserves market fields and candles but does not extend a quote through the slow lane', async () => {
  const f = fixture(), result = await f.client.audit(CA, AT / 1000, 'bsc');
  assert.equal(result.info.price, 0.126); assert.equal(tokenInfoPrice(result.info, f.now()), null); assert.equal(result.candles.length, 7);
  assert.equal(result._meta.complete, false); assert.equal(result._meta.marketComplete, true); assert.equal(result._meta.auditedAt, null);
  assert.equal(result._meta.transportComplete, true); assert.equal(result._meta.evidenceComplete, false); assert.equal(result._meta.marketFresh, false);
  assert.deepEqual(result._meta.missingEvidence, ['security', 'holders', 'traders']);
  assert.deepEqual(result.security, {}); assert.equal(result.pool.liquidity, 12000); assert.deepEqual(result.holders, []); assert.deepEqual(result.traders, []);
  for (const field of ['security', 'holders', 'traders']) assert.equal(result._meta.endpoints[field].ok, false);
  assert.equal(f.client.snapshot().budget.used, 20);
});

test('early audit rejection avoids unnecessary Kline CU and all endpoint failures remain errors', async () => {
  const f = fixture(); const result = await f.client.audit(CA, AT / 1000, 'bsc', { shouldStopEarly: () => true });
  assert.equal(result._meta.earlyExit, true); assert.equal(f.calls.length, 1); assert.equal(f.client.snapshot().budget.used, 5);
  const bad = fixture({ fetchImpl: async () => new Response(KEY, { status: 401 }) });
  await assert.rejects(bad.client.audit(CA, AT / 1000, 'bsc'), { code: 'AVE_AUTH' }); assert.equal(bad.client.metrics.requests, 1);
});

test('priceAt is a bounded historical closed-candle read, not a current-price substitute', async () => {
  const f = fixture(); const result = await f.client.priceAt(CA, AT - 60000, 'bsc');
  assert.equal(result.at, AT - 60000); assert.equal(result.source, 'AVE_1M_CLOSE');
  assert.match(f.calls[0].url, /from_time=\d+&to_time=\d+$/);
  assert.equal(await f.client.priceAt(CA, AT + 1, 'bsc'), null);
  assert.equal(f.calls.length, 1);
});

test('body limit, malformed JSON, auth and network errors are sanitized', async () => {
  for (const [handler, code] of [
    [async () => new Response(KEY, { headers: { 'Content-Length': String(AVE_LIMITS.maxBytes + 1) } }), 'AVE_SIZE'],
    [async () => new Response('{' + KEY), 'AVE_SCHEMA'],
    [async () => new Response(KEY, { status: 403 }), 'AVE_AUTH'],
    [async () => { throw new Error(KEY); }, 'AVE_NETWORK'],
    [async () => Response.json({ tokens: [token('bsc', { name: 'x'.repeat(100) + KEY })] }), null],
  ]) {
    const f = fixture({ fetchImpl: handler });
    if (code) await assert.rejects(f.client.discover('bsc'), error => error.code === code && !error.message.includes(KEY));
    else assert.doesNotMatch(JSON.stringify(await f.client.discover('bsc')), new RegExp(KEY));
  }
});

test('hard timeout covers fetch and body even when mock ignores AbortSignal', async () => {
  for (const fetchImpl of [async () => new Promise(() => {}), async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }))]) {
    const f = fixture({ timeoutMs: 15, fetchImpl });
    await assert.rejects(f.client.discover('bsc'), { code: 'AVE_TIMEOUT' }); assert.equal(f.client.metrics.requests, 1);
  }
});

test('empty success is valid but does not invent source clock, market activity or chain support', async () => {
  const f = fixture({ fetchImpl: async () => Response.json({ tokens: [] }) });
  const live = await f.client.live('bsc'); assert.deepEqual(live.tokens, []); assert.equal(live.interval, null);
  assert.equal(live.coverage, 'trending_sample'); assert.equal(f.client.snapshot().chains.bsc.state, 'unverified');
  assert.deepEqual(normalizeList({ data: { tokens: [] } }), []); assert.equal(tokenInfoPrice({ price: 0 }), null);
});

test('discovery and live share enriched token/pair snapshot without refreshing cached quote time', async () => {
  const f = fixture({ enrichLimit: 6 });
  const [rows, live] = await Promise.all([f.client.discover('bsc'), f.client.live('bsc')]);
  assert.equal(f.calls.length, 2); assert.deepEqual(rows, live.tokens); assert.equal(f.client.snapshot().budget.used, 10);
  assert.equal(rows[0].pairAddress, undefined, 'the first round stops after discovering the pool route');
  f.advance(31000); const enriched = await f.client.discover('bsc');
  assert.equal(f.calls.length, 3); assert.equal(f.client.snapshot().budget.used, 15);
  const row = enriched[0];
  assert.equal(row.marketProvider, 'AVE'); assert.equal(row.pairAddress, POOL); assert.equal(row.price, 0.126); assert.equal(row.market_cap, 41000); assert.equal(row.liquidity, 12000);
  assert.equal(row.creation_timestamp, null); assert.equal(row.pool_created_at, AT / 1000 - 3600); assert.equal(row.firstTradeAt, AT - 3300000); assert.equal(row.ageBasis, 'pool');
  assert.equal(row.volume_5m, 500); assert.equal(row.price_change_percent5m, 0.1); assert.equal(row.buys_5m, null); assert.equal(row.sells_5m, null);
  assert.equal(row.buys_24h, 100); assert.equal(row.sells_24h, 80); assert.equal(row.is_honeypot, null); assert.equal(row.sourceUpdatedAt, AT - 1000);
  f.advance(31000); const refreshed = await f.client.discover('bsc');
  assert.ok(refreshed[0].capturedAt > row.capturedAt);
  assert.equal(refreshed[0].sourceUpdatedAt, row.sourceUpdatedAt, 'unchanged upstream time must not be refreshed by a new read');
  assert.equal(refreshed[0].stale, true); assert.equal(f.calls.length, 4);
  assert.equal(f.calls.filter(call => call.url.includes('/trending?')).length, 1, 'hot-list membership still shares the ten-minute cache');
});

test('pair requests enforce exact chain and pool identity with bounded private metadata', async () => {
  for (const changes of [{ chain: 'eth' }, { pair: ca(9) }, { token0_address: 'invalid' }, { target_token: ca(9) }, { tvl: '-1' },
    { buys_tx_24h_count: '1.5' }, { updated_at: AT }, { price_change_5m: 'not-a-number' }]) {
    const f = fixture({ fetchImpl: async () => Response.json(pair(changes)) });
    await assert.rejects(f.client.pairDetails('bsc', POOL), { code: 'AVE_SCHEMA' });
  }
  const f = fixture(), result = await f.client.pairDetails('bsc', POOL);
  assert.equal(result.pair.pair, POOL); assert.equal(result.pair.target_token, CA);
  assert.equal(f.calls[0].url, 'https://prod.ave-api.com/v2/pairs/' + POOL + '-bsc');
  assert.equal(f.client.snapshot().budget.used, 5);
});

test('opposite target cannot donate pair liquidity/volume and token1 orientation uses token1 price', async () => {
  for (const [changes, accepted] of [
    [{ target_token: ca(3) }, false],
    [{ token0_address: ca(3), token1_address: CA, token0_price_usd: '1', token1_price_usd: '0.13' }, true]
  ]) {
    const f = fixture({ enrichLimit: 1, fetchImpl: async url => Response.json(url.includes('/pairs/') ? pair(changes) : responseFor(url)) });
    await f.client.discover('bsc'); f.advance(31000);
    const row = (await f.client.discover('bsc'))[0];
    assert.equal(row.liquidity, accepted ? 12000 : 9000); assert.equal(row.volume_5m, accepted ? 500 : null);
    assert.equal(row.price, accepted ? 0.13 : 0.125); assert.equal(row.is_honeypot, null);
  }
});

test('discovery falls through a mismatched primary pool in ranked order with one bounded extra read', async () => {
  const pools = [ca(20), ca(21), ca(22)], seen = [];
  const f = fixture({ enrichLimit: 2, fetchImpl: async url => {
    seen.push(new URL(url).pathname);
    if (url.includes('/trending?')) return Response.json({ tokens: [token()] });
    if (url.includes('/tokens/')) return Response.json({ status: 1, data: { token: token(),
      pairs: pools.map((pool, index) => ({ chain: 'bsc', pair: pool, amm: 'rank-' + index })) } });
    if (url.includes('/pairs/')) {
      const requested = pools.find(pool => url.includes(pool));
      if (requested === pools[0]) return Response.json(pair({ pair: requested, token0_address: ca(90), token1_address: ca(91), target_token: ca(90) }));
      return Response.json(pair({ pair: requested }));
    }
    return Response.json(klines());
  } });
  await f.client.discover('bsc'); f.advance(31000);
  const [row] = await f.client.discover('bsc');
  assert.equal(row.pairAddress, pools[1]);
  assert.deepEqual(seen.filter(path => path.includes('/pairs/')), pools.slice(0, 2).map(pool => '/v2/pairs/' + pool + '-bsc'));
  assert.equal(f.client.snapshot().budget.used, 20);
});

test('discovery pair fallback is capped per round and resumes at the next pool', async () => {
  const pools = [ca(30), ca(31), ca(32)], seen = [];
  const f = fixture({ enrichLimit: 2, fetchImpl: async url => {
    if (url.includes('/trending?')) return Response.json({ tokens: [token()] });
    if (url.includes('/tokens/')) return Response.json({ status: 1, data: { token: token(),
      pairs: pools.map((pool, index) => ({ chain: 'bsc', pair: pool, amm: 'rank-' + index })) } });
    const requested = pools.find(pool => url.includes(pool)); seen.push(requested);
    if (requested !== pools[2]) return Response.json(pair({ pair: requested, token0_address: ca(90), token1_address: ca(91), target_token: ca(90) }));
    return Response.json(pair({ pair: requested }));
  } });
  await f.client.discover('bsc'); f.advance(31000);
  assert.equal((await f.client.discover('bsc'))[0].pairAddress, undefined);
  assert.deepEqual(seen, pools.slice(0, 2), 'only primary plus one fallback may run in one discovery round');
  f.advance(31000);
  assert.equal((await f.client.discover('bsc'))[0].pairAddress, pools[2]);
  assert.deepEqual(seen, pools);
});

test('audit tries the next ranked pool but never walks an unbounded pool list', async () => {
  const pools = [ca(40), ca(41), ca(42)], seen = [];
  const f = fixture({ fetchImpl: async url => {
    if (url.includes('/tokens/')) return Response.json({ status: 1, data: { token: token(),
      pairs: pools.map((pool, index) => ({ chain: 'bsc', pair: pool, amm: 'rank-' + index })) } });
    if (url.includes('/pairs/')) {
      const requested = pools.find(pool => url.includes(pool)); seen.push(requested);
      if (requested === pools[0]) return Response.json(pair({ pair: requested, token0_address: ca(90), token1_address: ca(91), target_token: ca(90) }));
      return Response.json(pair({ pair: requested }));
    }
    return Response.json(klines());
  } });
  const result = await f.client.audit(CA, AT / 1000, 'bsc');
  assert.deepEqual(seen, pools.slice(0, 2));
  assert.equal(result.pool.pairAddress, pools[1]);
  assert.equal(result._meta.endpoints.pool.state, 'ok');
  assert.equal(f.client.snapshot().budget.used, 25);
});

test('pair source clocks stay independent from token capture and last trade time never refreshes quote', async () => {
  const f = fixture({ enrichLimit: 1, fetchImpl: async url => Response.json(url.includes('/pairs/') ? pair({ updated_at: AT / 1000 - 600, last_trade_at: AT / 1000 - 1 }) : responseFor(url)) });
  await f.client.discover('bsc'); f.advance(31000);
  const row = (await f.client.discover('bsc'))[0];
  assert.equal(row.sourceUpdatedAt, AT - 600000); assert.equal(row.stale, true);
  assert.equal(row.tokenSourceUpdatedAt, AT - 10000); assert.equal(row.lastTradeAt, AT - 1000);
});

test('discovery enrichment is bounded, rotates on refresh, and never invents data for unvisited rows', async () => {
  const seen = [];
  const f = fixture({ enrichLimit: 2, enrichmentTtlMs: 30000, fetchImpl: async url => {
    if (url.includes('/trending?')) return Response.json({ tokens: Array.from({ length: 4 }, (_, i) => token('bsc', { token: ca(i + 10) })) });
    if (url.includes('/tokens/')) {
      const requested = new URL(url).pathname.split('/').at(-1).slice(0, -4); seen.push(requested);
      const value = detail('bsc', { token: requested }); value.data.pairs[0].pair = ca(Number(BigInt(requested)) + 100); return Response.json(value);
    }
    const pool = new URL(url).pathname.split('/').at(-1).slice(0, -4), requested = ca(Number(BigInt(pool)) - 100);
    return Response.json(pair({ pair: pool, token0_address: requested, target_token: requested }));
  } });
  const first = await f.client.discover('bsc'); assert.equal(first.filter(row => row.volume_5m !== null).length, 0); assert.deepEqual(seen, [ca(10), ca(11)]);
  f.advance(31000); await f.client.discover('bsc'); assert.deepEqual(seen, [ca(10), ca(11), ca(12)]);
  f.advance(31000); await f.client.discover('bsc'); assert.deepEqual(seen, [ca(10), ca(11), ca(12)]);
  f.advance(31000); await f.client.discover('bsc'); assert.deepEqual(seen, [ca(10), ca(11), ca(12), ca(13)]);
  f.advance(31000); const complete = await f.client.discover('bsc');
  assert.equal(complete.filter(row => row.liquidity !== null).length, 4);
  assert.equal(f.client.snapshot().budget.used, 55, 'long staged rotation also refreshes expired head membership');
});

test('exhausted enrichment budget keeps honest raw leads with partial health and stops additional network', async () => {
  const f = fixture({ enrichLimit: 6, dailyBudgetCu: 5 });
  const rows = await f.client.discover('bsc');
  assert.equal(rows.length, 1); assert.equal(rows[0].liquidity, 9000); assert.equal(rows[0].is_honeypot, null);
  assert.equal(f.calls.length, 1); assert.equal(f.client.lastDiscoveryHealth.complete, false);
  assert.equal(f.client.lastDiscoveryHealth.enrichment.errors[0].code, 'AVE_BUDGET');
});

test('one cancelled discovery subscriber does not abort concurrent live enrichment', async () => {
  let release, started; const start = new Promise(resolve => { started = resolve; });
  const f = fixture({ enrichLimit: 1, fetchImpl: async url => {
    if (url.includes('/trending?')) { started(); return await new Promise(resolve => { release = resolve; }); }
    return Response.json(responseFor(url));
  } });
  const controller = new AbortController(), first = f.client.discover('bsc', { signal: controller.signal }), second = f.client.live('bsc');
  await start; controller.abort(); await assert.rejects(first, { code: 'AVE_ABORTED' }); release(Response.json({ tokens: [token()] }));
  assert.equal((await second).tokens[0].liquidity, 9000);
  f.advance(31000);
  assert.equal((await f.client.discover('bsc'))[0].liquidity, 12000);
});

test('local budget pause reaches scanner-facing nextAllowedAt without becoming a rate-limit error', async () => {
  const f = fixture({ dailyBudgetCu: 5 }); await f.client.details('bsc', CA);
  await assert.rejects(f.client.tokenKlines('bsc', CA), { code: 'AVE_BUDGET' });
  assert.ok(f.client.nextAllowedAt > f.now()); assert.equal(f.client.snapshot().pauseCode, 'AVE_BUDGET');
  const count = f.calls.length;
  await assert.rejects(f.client.trending('bsc'), { code: 'AVE_BUDGET' }); assert.equal(f.calls.length, count);
  f.client.resetCredentials(); await assert.rejects(f.client.details('bsc', CA), { code: 'AVE_BUDGET' });
});

test('persisted cooldown rejection updates scanner-facing pause even on a new client', async () => {
  const f = fixture({ readBudget: () => ({ day: '2026-09-21', used: 5, blockedUntil: AT + 60000, quotaUntil: 0, nextRequestAt: 0 }) });
  await assert.rejects(f.client.discover('bsc'), { code: 'AVE_RATE_LIMITED' });
  assert.equal(f.client.nextAllowedAt, AT + 60000); assert.equal(f.client.snapshot().pauseCode, 'AVE_RATE_LIMITED');
  assert.equal(f.calls.length, 0); assert.equal(f.client.snapshot().budget.used, 5);
});

test('market transport health separates pool failure from permanently unavailable audit evidence', async () => {
  const bad = fixture({ fetchImpl: async url => url.includes('/pairs/') ? new Response('upstream', { status: 500 }) : Response.json(responseFor(url)) });
  const result = await bad.client.audit(CA, AT / 1000, 'bsc');
  assert.equal(result._meta.transportComplete, false); assert.equal(result._meta.marketComplete, false);
  assert.equal(result._meta.complete, false); assert.equal(result._meta.endpoints.pool.state, 'error');
  assert.equal(result._meta.endpoints.security.state, 'unverified');
  const unmatched = fixture({ fetchImpl: async url => Response.json(url.includes('/pairs/') ? pair({ target_token: ca(3) }) : responseFor(url)) });
  const noBinding = await unmatched.client.audit(CA, AT / 1000, 'bsc');
  assert.equal(noBinding._meta.transportComplete, true, 'valid response is not a connection failure');
  assert.equal(noBinding._meta.marketComplete, false); assert.equal(noBinding._meta.endpoints.pool.state, 'unverified');
});

test('healthy but stale market data does not set audit clock or return a fresh price', async () => {
  const f = fixture({ fetchImpl: async url => Response.json(url.includes('/pairs/') ? pair({ updated_at: AT / 1000 - 600 }) : responseFor(url)) });
  const result = await f.client.audit(CA, AT / 1000, 'bsc');
  assert.equal(result._meta.transportComplete, true); assert.equal(result._meta.marketComplete, true); assert.equal(result._meta.marketFresh, false);
  assert.equal(result._meta.auditedAt, null); assert.equal(tokenInfoPrice(result.info, f.now()), null);
  const fresh = fixture(); const freshResult = await fresh.client.audit(CA, AT / 1000, 'bsc'), info = freshResult.info;
  assert.equal(info.price, 0.126); assert.equal(freshResult._meta.marketFresh, false);
  assert.equal(tokenInfoPrice(info, fresh.now()), null); assert.equal(tokenInfoPrice(info, info.expiresAt), null);
});
