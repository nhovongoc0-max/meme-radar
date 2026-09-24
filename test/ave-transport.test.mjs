import test from 'node:test';
import assert from 'node:assert/strict';
import { AveClient } from '../src/ave.mjs';
const AT = Date.UTC(2026, 8, 22, 12, 10), CA = '0x' + '1'.repeat(40), POOL = '0x' + '2'.repeat(40), KEY = 'fixture-secret-must-not-leak';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(handler, options = {}) {
  let at = AT, stored = null, count = 0;
  const starts = [], now = () => at;
  const token = chain => ({ token: CA, chain, current_price_usd: '1', market_cap: '40000', updated_at: Math.floor(at / 1000) - 1 });
  const response = url => {
    const chain = url.includes('trending?') ? new URL(url).searchParams.get('chain') : new URL(url).pathname.split('-').at(-1);
    if (url.includes('trending?')) return Response.json({ tokens: [token(chain)] });
    if (url.includes('/pairs/')) return Response.json({ pair: POOL, chain, token0_address: CA, token1_address: '0x' + '3'.repeat(40), target_token: CA,
      token0_price_usd: '1', token1_price_usd: '1', tvl: '9000', market_cap: '40000', updated_at: Math.floor(at / 1000) - 1,
      created_at: Math.floor(at / 1000) - 3600, volume_u_5m: '100', buy_volume_u_5m: '50', sell_volume_u_5m: '50' });
    return Response.json({ status: 1, data: { token: token(chain), pairs: [{ chain, pair: POOL }] } });
  };
  const config = { apiKeyProvider: () => KEY, now, pause: async ms => { at += ms; }, enrichLimit: 0,
    readBudget: () => structuredClone(stored), saveBudget: b => { stored = structuredClone(b); },
    fetchImpl: async (url, init) => { starts.push(at); return handler ? handler({ url, init, count: ++count, response, advance: ms => { at += ms; } }) : response(url); }, ...options };
  return { client: new AveClient(config), config, starts, now, advance: ms => { at += ms; }, setTime: t => { at = t; }, read: () => structuredClone(stored) };
}

test('all request kinds wait sixty seconds after complete response, not merely after dispatch', async () => {
  const f = fixture(({ url, response, advance }) => { advance(500); return response(url); });
  await Promise.all([f.client.trending('bsc'), f.client.details('bsc', CA), f.client.trending('robinhood')]);
  assert.deepEqual(f.starts.map(at => at - AT), [0, 60500, 121000]);
  assert.equal(f.read().totalUsed, 15);
  assert.equal(f.client.snapshot().transport.spacingMs, 60000);
});

test('slow response body counts as transport time before the sixty-second gap', async () => {
  const f = fixture(({ url, count, response, advance }) => {
    if (count !== 1) return response(url);
    return new Response(new ReadableStream({ start(controller) {
      advance(800); controller.enqueue(new TextEncoder().encode(JSON.stringify({ tokens: [] }))); controller.close();
    } }));
  });
  await f.client.trending('bsc'); await f.client.trending('eth');
  assert.deepEqual(f.starts.map(at => at - AT), [0, 60800]);
});

test('repeated 429 grows both cooldown and effective recovery spacing to a fifteen-minute ceiling across restart', async () => {
  const f = fixture(() => new Response('too many requests ' + KEY, { status: 429 }));
  let client = f.client;
  for (const [i, delay] of [60000, 120000, 240000, 480000, 900000, 900000].entries()) {
    const before = f.now(); await assert.rejects(client.trending('bsc'), { code: 'AVE_RATE_LIMITED' });
    const retryAt = client.nextAllowedAt;
    assert.equal(retryAt, before + delay); assert.equal(client.snapshot().transport.strikes, i + 1);
    assert.equal(client.snapshot().transport.spacingMs, delay,
      'a successful recovery probe must retain the strike-derived interval instead of falling back to two minutes');
    assert.equal(client.snapshot().recovery.headOnly, true);
    const used = f.read().totalUsed;
    await assert.rejects(client.details('bsc', CA), error => ['AVE_RATE_LIMITED', 'AVE_DISCOVERY_RESERVE'].includes(error.code));
    assert.equal(f.starts.length, i + 1); assert.equal(f.read().totalUsed, used);
    f.setTime(Math.max(retryAt, f.now())); client = new AveClient(f.config);
  }
  assert.equal(f.client.snapshot().transport.recent[0].category, 'rate');
  assert.doesNotMatch(JSON.stringify([f.read(), f.client.snapshot()]), new RegExp(KEY));
});

test('successful recovery probes keep the empirically safe eight-minute floor across full recovery and restart', async () => {
  const f = fixture(({ url, count, response }) => count <= 5
    ? new Response('rate limit', { status: 429 }) : response(url));
  for (let i = 0; i < 5; i++) {
    await assert.rejects(f.client.trending('bsc'), { code: 'AVE_RATE_LIMITED' });
    f.setTime(f.client.nextAllowedAt);
  }
  assert.equal(f.client.snapshot().transport.spacingMs, 15 * 60_000);

  await f.client.trending('bsc');
  assert.equal(f.client.snapshot().recovery.active, true);
  assert.equal(f.client.snapshot().transport.spacingMs, 8 * 60_000);
  assert.equal(f.client.nextAllowedAt, f.now() + 8 * 60_000);

  f.setTime(f.client.nextAllowedAt); await f.client.trending('eth');
  assert.equal(f.client.snapshot().transport.spacingMs, 8 * 60_000);
  assert.equal(f.client.nextAllowedAt, f.now() + 8 * 60_000);

  for (const chain of ['base', 'robinhood', 'arc']) {
    f.setTime(f.client.nextAllowedAt); await f.client.trending(chain);
  }
  assert.equal(f.client.snapshot().recovery.active, false);
  assert.equal(f.client.snapshot().transport.spacingMs, 8 * 60_000);
  const restarted = new AveClient(f.config);
  await restarted.hydrate();
  assert.equal(restarted.snapshot().transport.spacingMs, 8 * 60_000);
});

test('production cautiously probes five minutes, falls back to eight on 429, and waits a day before retrying', async () => {
  const f = fixture(({ url, count, response }) => count === 1 || count === 9
    ? new Response('rate limit', { status: 429 }) : response(url), { minimumGapMs: 5 * 60_000 });
  await f.client.hydrate();
  assert.equal(f.client.snapshot().transport.spacingMs, 5 * 60_000);

  await assert.rejects(f.client.trending('bsc'), { code: 'AVE_RATE_LIMITED' });
  const firstFailureAt = f.now();
  assert.equal(f.client.snapshot().transport.spacingMs, 8 * 60_000);
  assert.equal(f.read().rateControl.lastFloorFailureAt, firstFailureAt);

  for (const chain of ['bsc', 'eth', 'base', 'robinhood', 'bsc']) {
    f.setTime(f.client.nextAllowedAt); await f.client.trending(chain);
  }
  assert.equal(f.client.snapshot().recovery.active, false);
  assert.equal(f.client.snapshot().transport.spacingMs, 8 * 60_000);

  f.setTime(f.client.schedulerReadyAt); await f.client.trending('eth');
  assert.equal(f.client.snapshot().transport.spacingMs, 8 * 60_000,
    'a normal success inside the 24-hour hold must not retry five minutes');

  f.setTime(firstFailureAt + 24 * 60 * 60_000); await f.client.trending('base');
  assert.equal(f.client.snapshot().transport.spacingMs, 5 * 60_000);
  assert.equal(f.client.schedulerReadyAt, f.now() + 5 * 60_000);

  f.setTime(f.client.schedulerReadyAt);
  await assert.rejects(f.client.trending('robinhood'), { code: 'AVE_RATE_LIMITED' });
  const secondFailureAt = f.now();
  assert.equal(f.client.snapshot().transport.spacingMs, 8 * 60_000);
  assert.equal(f.read().rateControl.lastFloorFailureAt, secondFailureAt);
  assert.equal(f.client.nextAllowedAt, secondFailureAt + 8 * 60_000);

  const restarted = new AveClient(f.config); await restarted.hydrate();
  for (const chain of ['bsc', 'eth', 'base', 'robinhood', 'bsc']) {
    f.setTime(restarted.nextAllowedAt); await restarted.trending(chain);
  }
  f.setTime(restarted.schedulerReadyAt); await restarted.trending('eth');
  assert.equal(restarted.snapshot().transport.spacingMs, 8 * 60_000,
    'the failed five-minute probe must stay suppressed across restart');
});

test('two-hour Retry-After seconds and HTTP date are never truncated to one hour', async () => {
  for (const header of ['7200', new Date(AT + 7200000).toUTCString()]) {
    const f = fixture(() => new Response('rate limit', { status: 429, headers: { 'Retry-After': header } }));
    await assert.rejects(f.client.trending('bsc'), { code: 'AVE_RATE_LIMITED' });
    assert.equal(f.client.nextAllowedAt, AT + 7200000);
    assert.equal(f.client.snapshot().transport.recent[0].retryAfterMs, 7200000);
  }
});

test('a short success burst never resets 429; one sustained healthy window clears historical strikes', async () => {
  const f = fixture(({ url, count, response }) => count === 1 ? new Response('rate limit', { status: 429 }) : response(url));
  await assert.rejects(f.client.trending('bsc'), { code: 'AVE_RATE_LIMITED' });
  f.setTime(f.client.nextAllowedAt);
  await f.client.trending('bsc'); await f.client.trending('bsc');
  assert.equal(f.client.snapshot().transport.strikes, 1); assert.equal(f.read().rateControl.successes, 1);
  assert.equal(f.client.snapshot().recovery.headOnly, true, 'one real success must not unlock other request kinds');
  for (const chain of ['eth', 'base', 'robinhood', 'arc']) await f.client.trending(chain);
  assert.equal(f.client.snapshot().transport.strikes, 1); assert.equal(f.read().rateControl.successes, 4);
  assert.equal(f.client.snapshot().recovery.headOnly, true);
  f.setTime(AT + 1800000); await f.client.trending('bsc');
  assert.equal(f.client.snapshot().transport.strikes, 0); assert.equal(f.client.snapshot().transport.spacingMs, 60000);
  assert.equal(f.client.snapshot().recovery.headOnly, false);
});

test('timed-out uncooperative fetch holds physical lane until settled, then still waits sixty seconds', async () => {
  let release;
  const f = fixture(({ url, count, response }) => count === 1 ? new Promise(resolve => { release = () => resolve(response(url)); }) : response(url), { timeoutMs: 15 });
  await assert.rejects(f.client.trending('bsc'), { code: 'AVE_TIMEOUT' });
  await assert.rejects(f.client.trending('eth'), { code: 'AVE_BUSY' });
  assert.equal(f.starts.length, 1); assert.equal(f.read().totalUsed, 5);
  f.advance(500); release(); await tick();
  assert.equal(f.client.snapshot().transport.active, false);
  await f.client.trending('eth'); assert.equal(f.starts[1], AT + 60500);
  assert.equal(f.client.snapshot().chains.bsc.state, 'unverified');
});

test('late cancelled 429 cannot mutate the current backoff and queued cancellation spends no CU', async () => {
  let release;
  const controller = new AbortController();
  const f = fixture(({ count, url, response }) => count === 1 ? new Promise(resolve => { release = resolve; }) : response(url));
  const first = f.client.trending('bsc', { signal: controller.signal }); await tick();
  const secondController = new AbortController();
  const second = f.client.trending('eth', { signal: secondController.signal });
  secondController.abort(); await assert.rejects(second, { code: 'AVE_ABORTED' });
  controller.abort(); await assert.rejects(first, { code: 'AVE_ABORTED' });
  release(new Response('rate limit', { status: 429 })); await tick();
  assert.equal(f.read().totalUsed, 5); assert.equal(f.starts.length, 1);
  assert.equal(f.client.snapshot().transport.strikes, 0); assert.equal(f.client.metrics.rateLimits, 0);
});

test('pair rate limit keeps its route but a successful recovery head probe cannot resume pair enrichment', async () => {
  let failPair = true;
  const f = fixture(({ url, response }) => {
    if (url.includes('/pairs/') && failPair) { failPair = false; return new Response('rate limit', { status: 429 }); }
    return response(url);
  }, { enrichLimit: 1 });
  const first = await f.client.discover('bsc'); assert.equal(f.starts.length, 2);
  assert.equal(f.client.lastDiscoveryHealth.enrichment.enriched, 0);
  const captured = first[0].capturedAt;
  f.advance(31000); await f.client.discover('bsc');
  assert.equal(f.starts.length, 3); assert.equal(f.client.lastDiscoveryHealth.enrichment.pausedCode, 'AVE_RATE_LIMITED');
  await f.client.discover('bsc'); assert.equal(f.starts.length, 3);
  f.setTime(Math.max(f.client.nextAllowedAt + 1, AT + 241000));
  await f.client.discover('bsc');
  assert.equal(f.starts.length, 4, 'recovery first probes a fresh head list only');
  assert.equal(f.client.snapshot().recovery.active, true);
  assert.equal(f.client.snapshot().recovery.headOnly, true);
  f.advance(31000);
  const recovered = await f.client.discover('bsc');
  assert.equal(f.starts.length, 4, 'one successful head probe must not resume pair enrichment');
  assert.equal(f.client.lastDiscoveryHealth.enrichment.attempted, 0);
  assert.equal(f.client.lastDiscoveryHealth.enrichment.enriched, 0);
  assert.equal(f.client.lastDiscoveryHealth.enrichment.errors.length, 0);
  assert.ok(f.client.lastDiscoveryHealth.trending.capturedAt > AT);
  assert.ok(recovered[0].capturedAt > captured);
  assert.equal(f.client.snapshot().metrics.byKind.trending.requests, 2);
  assert.equal(f.client.snapshot().metrics.byKind.details.requests, 1);
  assert.equal(f.client.snapshot().metrics.byKind.pair.requests, 1);
});

test('error diagnostics contain only bounded classifications, never upstream body or header text', async () => {
  const f = fixture(() => new Response(JSON.stringify({ message: 'insufficient credits ' + KEY, data: { wallet: CA } }),
    { status: 429, headers: { 'x-private-key': KEY, 'retry-after': 'invalid-' + KEY } }));
  await assert.rejects(f.client.trending('bsc'), { code: 'AVE_QUOTA' });
  const result = f.client.snapshot().transport;
  assert.equal(result.recent[0].category, 'quota'); assert.equal(result.recent[0].endpoint, 'trending');
  assert.equal(result.recent[0].httpStatus, 429); assert.equal(result.recent[0].retryAfterMs, 0);
  assert.equal(f.client.snapshot().pauseCode, 'AVE_QUOTA');
  assert.doesNotMatch(JSON.stringify([result, f.read()]), new RegExp(KEY + '|' + CA + '|insufficient|x-private'));
});

test('repeated rate limits stay head-only after one successful probe and block details plus pair enrichment', async () => {
  const f = fixture(async ({ url, count, response }) => {
    if (count <= 3) return new Response('limited', { status: 429 });
    const result = response(url);
    if (!url.includes('/trending')) return result;
    const data = await result.json();
    return Response.json({ ...data, next_page: 1 });
  }, { enrichLimit: 2 });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(f.client.trending('bsc'), { code: 'AVE_RATE_LIMITED' });
    f.setTime(f.client.nextAllowedAt);
  }
  assert.equal(f.client.snapshot().transport.spacingMs, 240000);
  let client = new AveClient(f.config); // Persisted recovery must survive restart.
  await client.discover('bsc');
  assert.equal(client.snapshot().recovery.auditAllowed, false);
  assert.equal(f.starts.length, 4, 'first recovery round reads only head list');
  assert.equal(client.lastDiscoveryHealth.coverage.pages, 1);
  assert.equal(client.snapshot().recovery.headOnly, true, 'one real head success cannot unlock enrichment');
  assert.equal(f.read().rateControl.successes, 1);
  f.advance(31000); await client.discover('bsc');
  assert.equal(f.starts.length, 4, 'cached head remains head-only during recovery');
  assert.equal(client.lastDiscoveryHealth.enrichment.attempted, 0);
  const used = f.read().totalUsed;
  await assert.rejects(client.details('bsc', CA), { code: 'AVE_DISCOVERY_RESERVE' });
  await assert.rejects(client.pairDetails('bsc', POOL), { code: 'AVE_DISCOVERY_RESERVE' });
  assert.equal(f.starts.length, 4, 'blocked enrichment must neither dispatch nor spend CU');
  assert.equal(f.read().totalUsed, used);
  assert.equal(client.snapshot().recovery.auditAllowed, false);
});

test('a stalled 429 body stays classified as rate limit and recovery does not restart details enrichment', async () => {
  let limited = false;
  const f = fixture(({ url, response }) => {
    if (url.includes('/tokens/') && !url.includes('trending') && !limited) {
      limited = true;
      return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { status: 429 });
    }
    return response(url);
  }, { enrichLimit: 1, timeoutMs: 80 });
  await f.client.discover('bsc');
  assert.equal(f.client.lastDiscoveryHealth.enrichment.errors[0].code, 'AVE_RATE_LIMITED');
  assert.equal(f.client.lastDiscoveryHealth.enrichment.pausedCode, 'AVE_RATE_LIMITED');
  assert.equal(f.client.snapshot().transport.active, false);
  f.setTime(Math.max(f.client.nextAllowedAt + 1, AT + 211000));
  await f.client.discover('bsc');
  assert.equal(f.starts.length, 3, 'the first recovery round probes only the head list');
  assert.equal(f.client.snapshot().recovery.headOnly, true);
  f.advance(31000); await f.client.discover('bsc');
  assert.equal(f.starts.length, 3); assert.equal(f.client.lastDiscoveryHealth.enrichment.enriched, 0);
  f.advance(31000); await f.client.discover('bsc');
  assert.equal(f.starts.length, 3); assert.equal(f.client.lastDiscoveryHealth.enrichment.enriched, 0);
  assert.equal(f.client.snapshot().metrics.byKind.details.requests, 1);
});
