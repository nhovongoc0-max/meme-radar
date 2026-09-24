import test from 'node:test';
import assert from 'node:assert/strict';
import { AveClient } from '../src/ave.mjs';
import { config } from '../src/config.mjs';
import { discoveryScreen } from '../src/scoring.mjs';
import { LiveDiscovery, normalizeLiveRows, discoveryDiagnostics } from '../src/live-discovery.mjs';

const AT = Date.UTC(2026, 8, 22, 12), ca = n => '0x' + n.toString(16).padStart(40, '0');
function fixture({ perPage = [[1]], caps = {}, noPoolCap = false, oldToken = false, enrichLimit = 3,
  maxTrendingPages = 3, rotateTrendingPages = false, failPage = -1, pageStatus = 429,
  failLaterPool = false, latency = 0, laterHook = false } = {}) {
  let at = AT, budget = null;
  const calls = [], token = n => ({ token: ca(n), chain: 'bsc', name: 'Fixture', symbol: 'T' + n,
    current_price_usd: '1', market_cap: String(caps[n] ?? 40000), holders: 30, updated_at: Math.floor((oldToken ? AT - 120000 : at) / 1000) });
  const client = new AveClient({ apiKeyProvider: () => 'mock-not-live-key', now: () => at, pause: async ms => { at += ms; },
    enrichLimit, maxTrendingPages, rotateTrendingPages,
    readBudget: () => budget, saveBudget: next => { budget = structuredClone(next); }, fetchImpl: async value => {
      const url = new URL(value); calls.push(url.pathname + url.search); at += latency;
      if (url.pathname.endsWith('/trending')) {
        const page = Number(url.searchParams.get('current_page'));
        if (page === failPage) return new Response('request failed', { status: pageStatus, headers: { 'Retry-After': '60' } });
        return Response.json({ tokens: (perPage[page] || []).map(token), next_page: page + 1 < perPage.length ? page + 1 : -1 });
      }
      const id = parseInt(url.pathname.split('/').at(-1).split('-')[0], 16);
      if (url.pathname.includes('/tokens/')) return Response.json({ status: 1, data: { token: token(id), pairs: [
        { chain: 'bsc', pair: ca(id + 1000), amm: 'pancakeswap-v2' },
        ...(laterHook && at > AT + 200000 ? [{ chain: 'bsc', pair: ca(id + 2000), amm: 'uniswap_v4' }] : [])] } });
      if (failLaterPool && at > AT + 200000) return new Response('request failed', { status: 503 });
      return Response.json({ pair: ca(id), chain: 'bsc', amm: 'pancakeswap-v2', token0_address: ca(id - 1000),
        token1_address: ca(9999), target_token: ca(id - 1000), token0_price_usd: '1', token1_price_usd: '1',
        ...(noPoolCap ? {} : { market_cap: '42000' }), tvl: '12000', updated_at: Math.floor(at / 1000),
        created_at: Math.floor(at / 1000) - 3600, volume_u_5m: '500', buy_volume_u_5m: '300', sell_volume_u_5m: '200' });
    } });
  return { client, calls, now: () => at, advance: ms => { at += ms; } };
}
const screen = (r, at) => discoveryScreen(r, { ...config, chain: 'bsc' }, at / 1000);
async function finishStagedEnrichment(f) {
  await f.client.discover('bsc');
  f.advance(31000);
  return f.client.discover('bsc');
}

test('four-minute scheduler refreshes head even when the first response finished late', async () => {
  const f = fixture({ enrichLimit: 0, latency: 2000 });
  await f.client.discover('bsc');
  f.advance(AT + 240000 - f.now());
  await f.client.discover('bsc');
  assert.equal(f.calls.filter(url => url.includes('/trending')).length, 2);
});

test('known routes finish their pair stage before incomplete tokens continue rotating', async () => {
  const f = fixture({ perPage: [[1, 2, 3, 4]], enrichLimit: 2 });
  await f.client.discover('bsc');
  assert.deepEqual(f.calls.filter(url => url.includes('/tokens/') && !url.includes('/trending')), [
    '/v2/tokens/' + ca(1) + '-bsc', '/v2/tokens/' + ca(2) + '-bsc'
  ]);
  f.advance(31000);
  await f.client.discover('bsc');
  assert.deepEqual(f.calls.filter(url => url.includes('/pairs/')), [
    '/v2/pairs/' + ca(1001) + '-bsc'
  ]);
  f.advance(31000);
  await f.client.discover('bsc');
  assert.deepEqual(f.calls.filter(url => url.includes('/tokens/') && !url.includes('/trending')), [
    '/v2/tokens/' + ca(1) + '-bsc', '/v2/tokens/' + ca(2) + '-bsc',
    '/v2/tokens/' + ca(3) + '-bsc'
  ]);
  assert.deepEqual(f.calls.filter(url => url.includes('/pairs/')), [
    '/v2/pairs/' + ca(1001) + '-bsc', '/v2/pairs/' + ca(1003) + '-bsc', '/v2/pairs/' + ca(1002) + '-bsc'
  ]);
  assert.equal(f.client.lastDiscoveryHealth.enrichment.attempted, 2);
});

test('later trending pages reveal in-range tokens without loosening market/risk rules', async () => {
  const f = fixture({ perPage: [[1, 2], [3], [4]], caps: { 1: 4000000, 2: 5000000 } });
  const rows = await finishStagedEnrichment(f);
  assert.equal(rows.length, 4); assert.equal(f.client.lastDiscoveryHealth.coverage.pages, 3);
  assert.equal(rows.filter(r => screen(r, f.now()).pass).length, 1, 'the sixty-second lane keeps only the latest thirty-second quote actionable');
  assert.ok(f.calls[1].includes('current_page=1&page_size=100'));
  assert.ok(f.calls[2].includes('current_page=2&page_size=100'));
  assert.equal(f.client.snapshot().budget.used, 50, 'slow staged enrichment rechecks expired paginated membership before pairing');
  assert.ok(rows.every(r => r.is_honeypot === null));
});

test('maxTrendingPages one never follows next_page and reports single-page coverage', async () => {
  const f = fixture({ perPage: [[1], [2], [3]], caps: { 1: 9_000_000 }, enrichLimit: 0, maxTrendingPages: 1 });
  const rows = await f.client.discover('bsc');
  assert.deepEqual(rows.map(row => row.address), [ca(1)]);
  assert.deepEqual(f.calls, ['/v2/tokens/trending?chain=bsc&current_page=0&page_size=100']);
  assert.equal(f.client.lastDiscoveryHealth.coverage.pages, 1);
  assert.equal(f.client.lastDiscoveryHealth.coverage.maxPages, 1);
  assert.equal(f.client.snapshot().metrics.byKind.trending.requests, 1);
});

test('single-request page rotation revisits the head between tail pages without a request burst', async () => {
  const f = fixture({ perPage: [[1], [2], [3]], caps: { 1: 9_000_000 }, enrichLimit: 0,
    maxTrendingPages: 1, rotateTrendingPages: true });
  for (let round = 0; round < 4; round++) {
    await f.client.discover('bsc');
    if (round < 3) f.advance(241000);
  }
  const trending = f.calls.filter(url => url.includes('/trending'));
  assert.deepEqual(trending, [0, 1, 0, 2].map(page =>
    `/v2/tokens/trending?chain=bsc&current_page=${page}&page_size=100`));
  assert.equal(f.client.snapshot().metrics.byKind.trending.requests, 4,
    'rotation keeps exactly one paid trending request per discovery round');
});

test('four-minute round refreshes list membership and selected quotes; passive UI costs nothing', async () => {
  const f = fixture(), first = (await finishStagedEnrichment(f))[0];
  assert.equal(screen(first, f.now()).pass, true);
  f.advance(240000);
  const preview = await f.client.live('bsc', { refresh: false });
  assert.equal(preview.tokens[0].stale, true); assert.equal(f.calls.length, 3);
  const current = (await f.client.discover('bsc'))[0];
  assert.equal(screen(current, f.now()).pass, true);
  assert.ok(current.sourceUpdatedAt > first.sourceUpdatedAt);
  assert.equal(f.calls.filter(v => v.includes('/trending')).length, 2);
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls.filter(v => v.includes('/tokens/') && !v.includes('/trending')).length, 1);
  assert.equal(f.calls.filter(v => v.includes('/pairs/')).length, 2);
  assert.equal(f.client.lastDiscoveryHealth.checkedAt, current.capturedAt);
});

test('pool without market cap uses token evidence without changing its source timestamp', async () => {
  const f = fixture({ noPoolCap: true }), [row] = await finishStagedEnrichment(f);
  assert.equal(row.market_cap, 40000); assert.equal(screen(row, f.now()).pass, false);
  assert.ok(screen(row, f.now()).reasons.includes('市值原始时间待更新'));
  assert.ok(row.marketCapSourceUpdatedAt < row.sourceUpdatedAt);
  const old = fixture({ noPoolCap: true, oldToken: true }), [stale] = await finishStagedEnrichment(old);
  assert.equal(stale.market_cap, 40000); assert.equal(screen(stale, old.now()).pass, false);
  assert.ok(screen(stale, old.now()).reasons.includes('市值原始时间待更新'));
});

test('rotation retains old observations as stale, never mixing old pool facts with hot-list time', async () => {
  const f = fixture({ perPage: [[1, 2]], enrichLimit: 1 }), [first] = await finishStagedEnrichment(f);
  f.advance(240000);
  await f.client.discover('bsc');
  f.advance(31000);
  const rows = await f.client.discover('bsc');
  assert.equal(rows[0].liquidity, 12000); assert.equal(rows[0].sourceUpdatedAt, first.sourceUpdatedAt);
  assert.equal(rows[0].capturedAt, first.capturedAt); assert.equal(rows[0].stale, true);
  assert.equal(screen(rows[0], f.now()).pass, false); assert.equal(screen(rows[1], f.now()).pass, true);
  assert.equal(normalizeLiveRows(rows, 'bsc', [], f.now()).length, 1,
    'expired pool evidence must leave the visible fast pool instead of lingering as a stale card');
});

test('unknown in-range observation is visible as pending but cannot be audited; hazards still excluded', async () => {
  const f = fixture({ perPage: [[1, 2]], enrichLimit: 1 }), rows = await finishStagedEnrichment(f);
  const live = normalizeLiveRows(rows, 'bsc', [], f.now()), pending = live.find(r => r.address === ca(2));
  assert.equal(live.length, 2); assert.equal(pending.discoveryState, 'PENDING');
  assert.equal(pending.auditEligible, false); assert.equal(pending.liquidity, null);
  assert.deepEqual(discoveryDiagnostics(rows, 'bsc', f.now()), { received: 2, inRange: 2, pending: 1, stale: 0, ready: 1, excluded: 0, outsideRange: 0 });
  for (const hazard of [{ is_honeypot: true }, { volume_5m: 0 }, { sellable: false }, { liquidity: 100 }]) {
    assert.equal(normalizeLiveRows([{ ...rows[0], ...hazard }], 'bsc', [], f.now()).length, 0);
  }
});

test('pagination remains bounded, validates page input, deduplicates, and preserves partial rows on 429', async () => {
  const same = fixture({ perPage: [[1], [1], [2]], caps: { 1: 9000000 } });
  assert.equal((await same.client.discover('bsc')).length, 1); assert.equal(same.calls.length, 2);
  const limited = fixture({ perPage: [[1], [2]], caps: { 1: 9000000 }, failPage: 1 });
  assert.equal((await limited.client.discover('bsc')).length, 1);
  assert.equal(limited.client.lastDiscoveryHealth.enrichment.pausedCode, 'AVE_RATE_LIMITED');
  assert.equal(limited.calls.length, 2); assert.equal(limited.client.snapshot().budget.used, 10);
  for (const page of [-1, 3, '../x', 1.5]) await assert.rejects(limited.client.trending('bsc', { page }), { code: 'AVE_INPUT' });
});

test('optional page failure does not starve already received in-scope leads', async () => {
  const f = fixture({ perPage: [[1], [2]], failPage: 1, pageStatus: 503 });
  await f.client.discover('bsc'); f.advance(31000);
  const rows = await f.client.discover('bsc');
  assert.equal(screen(rows[0], f.now()).pass, true);
  assert.equal(f.client.lastDiscoveryHealth.enrichment.attempted, 1);
  assert.equal(f.client.lastDiscoveryHealth.complete, false);
});

test('failed pool refresh retains the complete old observation and cannot renew eligibility', async () => {
  const f = fixture({ failLaterPool: true }), [first] = await finishStagedEnrichment(f);
  f.advance(240000);
  const [next] = await f.client.discover('bsc');
  assert.equal(next.liquidity, first.liquidity); assert.equal(next.capturedAt, first.capturedAt);
  assert.equal(next.sourceUpdatedAt, first.sourceUpdatedAt); assert.equal(next.stale, true);
  assert.equal(screen(next, f.now()).pass, false);
});

test('route metadata refresh exposes a newly observed Hook even when its pool quote fails', async () => {
  const f = fixture({ failLaterPool: true, laterHook: true }), [first] = await finishStagedEnrichment(f);
  assert.equal(normalizeLiveRows([first], 'bsc', [], f.now()).length, 1);
  f.advance(1800001); await f.client.discover('bsc');
  f.advance(31000); const [next] = await f.client.discover('bsc');
  assert.equal(next.liquidity, null);
  assert.ok(next.pairs.some(pair => pair.amm === 'uniswap_v4'));
  assert.equal(normalizeLiveRows([next], 'bsc', [], f.now()).length, 0);
});

test('pending first sighting remains a new arrival when market data subsequently completes', async () => {
  const f = fixture({ enrichLimit: 0 }), [pending] = await f.client.discover('bsc');
  const first = normalizeLiveRows([pending], 'bsc', [], f.now(), true);
  assert.equal(first[0].newAt, f.now()); assert.equal(first[0].auditEligible, false);
  const fresh = fixture(), [complete] = await finishStagedEnrichment(fresh);
  const later = normalizeLiveRows([complete], 'bsc', first, fresh.now(), true);
  assert.equal(later[0].newAt, first[0].newAt); assert.equal(later[0].auditEligible, true);
  assert.equal(normalizeLiveRows([pending], 'bsc', [], f.now(), false)[0].newAt, 0);
});

test('passive discovery displays already-paid partial results during provider cooldown without dispatching', async () => {
  const f = fixture({ enrichLimit: 0, perPage: [[1], [2]], failPage: 1 }); await f.client.discover('bsc');
  const live = new LiveDiscovery({ provider: f.client, cacheOnly: true, now: f.now,
    schedule: () => ({ unref() {} }), cancel: () => {} });
  live.touch('bsc'); await live.poll();
  const view = live.snapshot('bsc');
  assert.equal(view.rows.length, 1); assert.equal(view.receivedCount, 1);
  assert.equal(view.status, 'RATE_LIMITED'); assert.equal(view.rows[0].auditEligible, false);
  assert.equal(f.calls.length, 2); live.stop();
});
