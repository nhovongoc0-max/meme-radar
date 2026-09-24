import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.mjs';
import { AveClient } from '../src/ave.mjs';
import { discoveryScreen, deepScreen } from '../src/scoring.mjs';
import { Scanner, classifyDeepResult, updateOutcomeTracking } from '../src/scanner.mjs';
import { LiveDiscovery, normalizeLiveRows } from '../src/live-discovery.mjs';

const ca = n => '0x' + n.toString(16).padStart(40, '0'), CA = ca(1), POOL = ca(2);
const AT = 1800000000000, settings = { ...config, chain: 'bsc', maxDeepAuditsPerCycle: 1 };
function row(at = AT, changes = {}) {
  const value = { address: CA, chain: 'bsc', marketProvider: 'AVE', symbol: 'MOCK', name: 'Mock',
    market_cap: 50000, liquidity: 5000, price: 1, creation_timestamp: null, pool_created_at: Math.floor(at / 1000) - 3600,
    first_trade_at: Math.floor(at / 1000) - 3500, poolCreatedAt: at - 3600000, firstTradeAt: at - 3500000,
    capturedAt: at - 1000, sourceUpdatedAt: at - 2000, expiresAt: at + 28000, stale: false,
    holder_count: 100, volume_5m: 1000, buy_volume_5m: 600, sell_volume_5m: 400,
    buys_5m: null, sells_5m: null, buys_24h: 200, sells_24h: 100,
    rug_ratio: null, bundler_rate: null, rat_trader_amount_rate: null, is_honeypot: null, is_wash_trading: null,
    pairAddress: POOL,
    ...changes };
  if (!Object.hasOwn(changes, 'poolEvidence')) value.poolEvidence = { source: 'AVE', identityBasis: 'response', chain: 'bsc',
    pair: value.pairAddress, target_token: value.address, token0_address: value.address, token1_address: ca(3), amm: 'pancakeswap_v2',
    created_at: value.pool_created_at, first_trade_at: value.first_trade_at, tvl: value.liquidity, volume_u_5m: value.volume_5m,
    token0_price_usd: value.price, token1_price_usd: 1, capturedAt: value.capturedAt,
    sourceUpdatedAt: value.sourceUpdatedAt, expiresAt: value.expiresAt };
  return value;
}
function memoryState() {
  return { value: { activeChain: 'bsc', candidates: [], auditQueue: [], outcomes: [], events: [], riskExclusions: {}, chainStates: {}, sourceHealth: {} },
    save(next = this.value) { this.value = structuredClone(next); } };
}
function marketAudit(at) {
  return { info: row(at, { liquidity: 15000 }), pool: { liquidity: 15000 }, security: {}, holders: [], traders: [], candles: [],
    _meta: { provider: 'AVE', complete: false, evidenceComplete: false, transportComplete: true, marketComplete: true, auditedAt: null,
      missingEvidence: ['security', 'holders', 'traders'], endpoints: {} } };
}
const liveOptions = (provider, clock = () => AT) => ({ provider, now: clock, settings, schedule: () => ({ unref() {} }), cancel: () => {} });

test('AVE shortlist admits verified market facts without pretending missing GMGN risk evidence is safe', () => {
  const screen = discoveryScreen(row(), settings, AT / 1000);
  assert.equal(screen.pass, true); assert.equal(screen.ageBasis, 'trade'); assert.equal(screen.createdAt, AT / 1000 - 3500);
  assert.ok(screen.unknownFields.includes('honeypot')); assert.equal(screen.signals.buys5m, null);
  assert.equal(discoveryScreen(row(AT, { liquidity: 3000 }), settings, AT / 1000).pass, true);
  const deep = deepScreen({ discovery: row(), audit: marketAudit(AT) }, settings);
  assert.equal(deep.chainPass, false);
  assert.notEqual(classifyDeepResult(deep, { complete: false, provider: 'AVE' }).status, 'X_REVIEW');
});

test('AVE initial market gates reject wrong identity, stale/future clocks, newborn/old pools and zero flows', () => {
  for (const changes of [{ chain: 'eth' }, { address: ca(0) }, { address: 'invalid' }, { sourceUpdatedAt: AT - 61000 },
    { capturedAt: AT + 1 }, { sourceUpdatedAt: AT }, { expiresAt: AT }, { stale: true },
    { first_trade_at: AT / 1000 - 100 }, { first_trade_at: AT / 1000 - 8 * 86400 },
    { first_trade_at: null, pool_created_at: null }, { market_cap: 9999 }, { market_cap: 150001 },
    { price: 0 }, { liquidity: 2999 }, { volume_5m: null }, { volume_5m: 0 }, { buy_volume_5m: 0 }, { sell_volume_5m: -1 }]) {
    assert.equal(discoveryScreen(row(AT, changes), settings, AT / 1000).pass, false, JSON.stringify(changes));
  }
  assert.equal(discoveryScreen(row(AT, { first_trade_at: null, buy_volume_5m: null, sell_volume_5m: null }), settings, AT / 1000).pass, true);
});

test('AVE fast alerts reject mature inactive pools and deep ATH collapses without permanently blacklisting them', () => {
  const old = { first_trade_at: AT / 1000 - 18 * 3600, pool_created_at: AT / 1000 - 18 * 3600,
    liquidity: 11727.45, volume_5m: 10.52 };
  const inactive = discoveryScreen(row(AT, old), settings, AT / 1000);
  assert.equal(inactive.pass, false); assert.match(inactive.reasons.join(), /老池当前成交活跃度不足/);
  const evidence = { source: 'AVE', identityBasis: 'response', chain: 'bsc', pair: POOL, target_token: CA, token0_address: CA,
    token1_address: ca(3), amm: 'pancakeswap_v2', token0_price_usd: .025, token1_price_usd: 1,
    created_at: old.pool_created_at, first_trade_at: old.first_trade_at, tvl: old.liquidity, volume_u_5m: 500,
    price_ath_u: 1, price_change_1h: 5, capturedAt: AT - 500, sourceUpdatedAt: AT - 1000, expiresAt: AT + 20000 };
  assert.equal(discoveryScreen(row(AT, { ...old, volume_5m: 500,
    poolEvidence: { ...evidence, token0_price_usd: .5, price_ath_u: .6, price_change_1h: 30 } }), settings, AT / 1000).pass, true,
    'an older pool needs genuine same-pool activity and a current non-collapsed trajectory');

  const collapsed = discoveryScreen(row(AT, { ...old, volume_5m: 500, poolEvidence: evidence }), settings, AT / 1000);
  assert.equal(collapsed.pass, false); assert.match(collapsed.reasons.join(), /距历史高点跌幅过深/);
  assert.equal(discoveryScreen(row(AT, { ...old, volume_5m: 500,
    poolEvidence: { ...evidence, price_change_1h: 30 } }), settings, AT / 1000).pass, true,
    'a verified strong one-hour rebound is not mislabeled as a dead pool');
  assert.equal(discoveryScreen(row(AT, { ...old, volume_5m: 500,
    poolEvidence: { ...evidence, price_change_1h: 501 } }), settings, AT / 1000).pass, true,
    'an extreme verified rebound is not converted to an unknown value');
  const staleEvidence = { ...evidence, capturedAt: AT - 120000, sourceUpdatedAt: AT - 121000, expiresAt: AT - 90000 };
  const staleAveFreshSamePool = discoveryScreen(row(AT, { ...old, volume_5m: 500, price: .025,
    poolEvidence: staleEvidence, marketOverlayProvider: 'DEXSCREENER', marketOverlayPriceUpdated: true }), settings, AT / 1000);
  assert.equal(staleAveFreshSamePool.pass, false);
  assert.match(staleAveFreshSamePool.reasons.join(), /距历史高点跌幅过深/,
    'fresh same-pool overlay price still uses recent AVE ATH evidence');
  const wrongIdentity = discoveryScreen(row(AT, { ...old, volume_5m: 500,
    poolEvidence: { ...evidence, target_token: ca(9) } }), settings, AT / 1000);
  assert.equal(wrongIdentity.pass, false);
  assert.match(wrongIdentity.reasons.join(), /池龄或首笔成交时间未知|身份待核验|同池/,
    'ATH evidence from the wrong token identity must fail closed');

  const crossPoolAge = discoveryScreen(row(AT, { first_trade_at: AT / 1000 - 600,
    pool_created_at: AT / 1000 - 18 * 3600, liquidity: 11727.45, volume_5m: 10.52,
    marketOverlayProvider: 'DEXSCREENER', pairAddress: ca(8), poolEvidence: null }), settings, AT / 1000);
  assert.equal(crossPoolAge.ageBasis, 'pool');
  assert.equal(crossPoolAge.pass, false);
  assert.match(crossPoolAge.reasons.join(), /老池当前成交活跃度不足/);
});

test('known hazards veto AVE observations and another same-token pool cannot hide a Hook architecture', () => {
  for (const changes of [{ is_honeypot: true }, { sellable: false }, { cannot_sell_all: '1' }, { is_wash_trading: true },
    { buy_tax: .2 }, { dev_team_hold_rate: .02 }, { rug_ratio: .31 }]) {
    assert.equal(discoveryScreen(row(AT, changes), settings, AT / 1000).pass, false);
  }
  const hook = { chain: 'bsc', address: CA, pair: ca(4), amm: 'uniswap_v4' };
  assert.match(discoveryScreen(row(AT, { pairs: [hook] }), settings, AT / 1000).reasons.join(), /Hook架构池待核验/);
  assert.equal(discoveryScreen(row(AT, { pairs: [{ ...hook, chain: 'eth' }] }), settings, AT / 1000).pass, true);
  assert.equal(discoveryScreen(row(AT, { pairs: [{ ...hook, address: ca(9) }] }), settings, AT / 1000).pass, true);
  assert.equal(discoveryScreen(row(AT, { poolEvidence: { ...row().poolEvidence, amm: 'pancakeswap-infinity' } }), settings, AT / 1000).pass, false);
});

test('AVE live rows expose 5m USD volume and original pool/time basis but never fake 1m counts', () => {
  const one = normalizeLiveRows([row()], 'bsc', [], AT);
  assert.equal(one.length, 1); assert.equal(one[0].createdAt, AT / 1000 - 3500); assert.equal(one[0].ageBasis, 'trade');
  assert.equal(one[0].marketProvider, 'AVE'); assert.equal(one[0].activityWindow, '5m'); assert.equal(one[0].volume5m, 1000);
  for (const key of ['volume1m', 'buys1m', 'sells1m', 'swaps1m', 'buys5m', 'sells5m', 'smartMoney']) assert.equal(one[0][key], null);
  assert.equal(one[0].hasUnknownRisk, true); assert.equal(one[0].auditEligible, true);
  const same = normalizeLiveRows([row()], 'bsc', one, AT + 10000, true);
  assert.equal(same[0].observedAt, one[0].observedAt); assert.equal(same[0].priceDelta, null); assert.equal(same[0].deltaWindowMs, null);
  const stale = normalizeLiveRows([row()], 'bsc', one, AT + 61000, true);
  assert.equal(stale.length, 1); assert.equal(stale[0].stale, true); assert.equal(stale[0].auditEligible, false);
  assert.equal(stale[0].observedAt, one[0].observedAt);
});

test('official token launch time is a usable fallback without being mislabeled as exact pool age', () => {
  const launchedAt = AT / 1000 - 900;
  const market = row(AT, { first_trade_at: null, pool_created_at: null, poolCreatedAt: null, firstTradeAt: null,
    pairAddress: undefined, poolEvidence: null, launch_at: launchedAt, creation_timestamp: launchedAt, ageBasis: 'launch' });
  const screen = discoveryScreen(market, settings, AT / 1000);
  assert.equal(screen.pass, true); assert.equal(screen.createdAt, launchedAt); assert.equal(screen.ageBasis, 'launch');
  const [live] = normalizeLiveRows([market], 'bsc', [], AT);
  assert.equal(live.createdAt, launchedAt); assert.equal(live.ageBasis, 'launch'); assert.equal(live.discoveryState, 'READY');
});

test('LiveDiscovery uses provider.live, not run, and preserves cache time/expiry', async () => {
  let at = AT, calls = 0;
  const provider = { keyEpoch: 0, configured: async () => true, run: () => assert.fail('must not invoke GMGN run'),
    live: async () => { calls++; return { tokens: [row()], capturedAt: AT - 1000 }; } };
  const live = new LiveDiscovery(liveOptions(provider, () => at)); live.touch('bsc'); await live.poll();
  assert.equal(live.snapshot('bsc').rows.length, 1); assert.equal(live.snapshot('bsc').lastSuccessAt, AT - 1000);
  at += 20000; live.touch('bsc'); await live.poll(); assert.equal(calls, 2);
  assert.equal(live.snapshot('bsc').lastSuccessAt, AT - 1000);
  at += 10000; assert.equal(live.snapshot('bsc').rows[0].stale, true); assert.equal(live.snapshot('bsc').rows[0].auditEligible, false); assert.equal(live.auditRow('bsc', CA), null);
  at += 35000; live.touch('bsc'); await live.poll();
  assert.equal(live.snapshot('bsc').rows.length, 1); assert.equal(live.snapshot('bsc').rows[0].stale, true);
  assert.equal(live.snapshot('bsc').rows[0].auditEligible, false);
  live.stop();
});

test('live AVE errors retain honest budget/quota states and use absolute retryAt', async () => {
  for (const [code, expected] of [['AVE_BUDGET', 'BUDGET_PAUSED'], ['AVE_HOURLY_BUDGET', 'HOURLY_BUDGET_PAUSED'], ['AVE_TOTAL_BUDGET', 'TOTAL_BUDGET_PAUSED'], ['AVE_QUOTA', 'QUOTA_PAUSED'], ['AVE_RATE_LIMITED', 'RATE_LIMITED']]) {
    const provider = { keyEpoch: 0, configured: async () => true, live: async () => { throw Object.assign(new Error('must not reflect me'), { code, retryAt: AT + 123456 }); } };
    const live = new LiveDiscovery(liveOptions(provider)); live.touch('bsc'); await live.poll();
    assert.equal(live.snapshot('bsc').status, expected); assert.equal(live.snapshot('bsc').nextPollAt, AT + 123456);
    assert.doesNotMatch(JSON.stringify(live.snapshot('bsc')), /must not reflect me/); live.stop();
  }
});

test('scanner AVE provider alias keeps healthy incomplete audits in WAIT_RECHECK, never X review/voice event', async () => {
  const state = memoryState();
  const provider = { keyEpoch: 0, configured: async () => true, discover: async () => [row(Date.now())],
    audit: async () => marketAudit(Date.now()), metrics: {}, lastDiscoveryHealth: { complete: true } };
  const scanner = new Scanner({ provider, state, settings });
  await scanner.cycle();
  assert.equal(state.value.prequalifiedCount, 1); assert.equal(state.value.candidates.length, 1);
  assert.equal(state.value.candidates[0].status, 'WAIT_RECHECK'); assert.equal(state.value.status, 'RUNNING');
  assert.equal(state.value.candidates[0].marketProvider, 'AVE'); assert.equal(state.value.candidates[0].ageBasis, 'trade');
  assert.equal(state.value.candidates[0].auditHealth.evidenceComplete, false);
  assert.equal(state.value.events.some(event => event.type === 'CANDIDATE_NEW'), false);
});

test('default open-source fast feed never turns a successful hot-list read into an automatic details request', async () => {
  const state = memoryState(); let audits = 0;
  const provider = { keyEpoch: 0, configured: async () => true, metrics: {},
    discover: async () => [row(Date.now())],
    audit: async () => { audits++; return marketAudit(Date.now()); },
    lastDiscoveryHealth: { provider: 'AVE', complete: true } };
  const scanner = new Scanner({ provider, state, settings: { ...config, chain: 'bsc' } });
  await scanner.cycle(); scanner.stop();
  assert.equal(config.maxDeepAuditsPerCycle, 0);
  assert.equal(audits, 0);
  assert.equal(state.value.status, 'RUNNING');
  assert.equal(state.value.prequalifiedCount, 1);
  assert.equal(state.value.liveLeads.length, 1, 'a real fresh pass is persisted for display between chain turns');
  assert.equal(state.value.liveLeads[0].sourceUpdatedAt > 0, true);
  assert.equal(state.value.liveLeads[0].displayUntil - state.value.liveLeads[0].lastConfirmedAt, config.liveLeadRetentionMs);
  assert.equal(Number.isFinite(state.value.auditQueueStats.estimatedMinutes), false);
});

test('scanner only defers current explicit market rejection, not stale or missing evidence', async () => {
  const at = Date.now(), deferred = [], state = memoryState();
  const market = { keyEpoch: 0, configured: async () => true, metrics: {},
    lastDiscoveryHealth: { provider: 'AVE', complete: true, checkedAt: at },
    discover: async () => [row(at, { liquidity: 2000 }), row(at, { address: ca(4), liquidity: null }),
      row(at, { address: ca(5), liquidity: 2000, stale: true }), row(at, { address: ca(6), volume_5m: null })],
    deferEnrichment: (...args) => deferred.push(args), audit: () => assert.fail('rejected rows cannot reach audit') };
  const scanner = new Scanner({ provider: market, state, settings }); await scanner.cycle(); scanner.stop();
  assert.equal(deferred.length, 1); assert.equal(deferred[0][0], 'bsc'); assert.equal(deferred[0][1], CA);
  assert.equal(deferred[0][2].evidenceAt, at - 2000); assert.equal(deferred[0][2].until, at - 2000 + 1800000);
  assert.equal(state.value.prequalifiedCount, 0);
});

test('a discovery budget reserve defers audits without reporting a network error or approving a coin', async () => {
  const at = Date.now(), state = memoryState(); let audits = 0;
  const market = { keyEpoch: 0, configured: async () => true, metrics: {}, discover: async () => [row(at)],
    lastDiscoveryHealth: { provider: 'AVE', complete: true, checkedAt: at },
    audit: async () => { audits++; throw Object.assign(new Error('policy pause'), { code: 'AVE_DISCOVERY_RESERVE', retryAt: at + 600000 }); } };
  const scanner = new Scanner({ provider: market, state, settings }); await scanner.cycle();
  assert.equal(audits, 1); assert.equal(state.value.status, 'RUNNING'); assert.equal(state.value.pauseCode, null);
  assert.equal(state.value.sourceHealth.lastAudit, null);
  assert.ok(state.value.auditQueue[0].nextAuditAt >= at + 600000);
  assert.ok(!state.value.events.some(event => ['CANDIDATE_NEW', 'AUDIT_RETRY'].includes(event.type)));
  market.snapshot = () => ({ nonTrendingPausedUntil: at + 600000 });
  await scanner.cycle(); assert.equal(audits, 1); scanner.stop();
});

test('scanner captures epoch after configuration refresh and classifies quota/budget without transport fiction', async () => {
  for (const [code, status] of [['AVE_BUDGET', 'BUDGET_PAUSED'], ['AVE_HOURLY_BUDGET', 'HOURLY_BUDGET_PAUSED'], ['AVE_TOTAL_BUDGET', 'TOTAL_BUDGET_PAUSED'], ['AVE_QUOTA', 'QUOTA_PAUSED'], ['AVE_RATE_LIMITED', 'RATE_LIMITED']]) {
    const state = memoryState(), retryAt = Date.now() + 999999;
    const provider = { keyEpoch: 0, configured: async function() { this.keyEpoch++; return true; },
      discover: async () => { throw Object.assign(new Error('secret provider text'), { code, retryAt }); }, metrics: {} };
    const scanner = new Scanner({ provider, state, settings }); await scanner.cycle();
    assert.equal(state.value.status, status); assert.equal(state.value.retryAt, retryAt); assert.ok(state.value.nextCycleAt >= retryAt);
    assert.equal(state.value.policy.scanIntervalMs, settings.scanIntervalMs);
    assert.equal(state.value.policy.chain, 'bsc');
    assert.doesNotMatch(state.value.error, /secret provider text/);
  }
});

test('rate recovery leaves audit and outcome queues untouched and blocks manual review dispatch', async () => {
  const at = Date.now(), state = memoryState();
  state.value.outcomes = [{ chain: 'bsc', address: CA, baselineAt: at - 360000,
    baselinePrice: 1, baselineProvider: 'AVE', initialDecision: 'X_REVIEW', samples: {} }];
  const provider = { keyEpoch: 0, configured: async () => true, metrics: {}, discover: async () => [row(at)],
    lastDiscoveryHealth: { provider: 'AVE', complete: true, checkedAt: at },
    snapshot: () => ({ recovery: { active: true, headOnly: true, auditAllowed: false } }),
    audit: () => assert.fail('recovery must not launch audit'),
    outcomeSample: () => assert.fail('recovery must not launch outcome reads'),
    live: async () => ({ tokens: [row(at)], capturedAt: at }) };
  const scanner = new Scanner({ provider, state, settings }); await scanner.cycle(); scanner.stop();
  assert.ok(state.value.auditQueue.length > 0);
  assert.ok(!state.value.auditQueue[0].attempts);
  assert.ok(!state.value.events.some(event => event.type === 'AUDIT_RETRY'));
  const live = new LiveDiscovery(liveOptions(provider, () => at)); live.touch('bsc'); await live.poll();
  assert.equal(live.snapshot('bsc').rows.length, 1);
  assert.equal(live.auditRow('bsc', CA), null); live.stop();
});

test('production passive live polls pass refresh:false and do not invent a success timestamp for an empty cache', async () => {
  const options = [];
  const provider = { keyEpoch: 0, configured: async () => true,
    live: async (chain, option) => { options.push(option); return { tokens: [], capturedAt: null }; } };
  const live = new LiveDiscovery({ ...liveOptions(provider), cacheOnly: true });
  live.touch('bsc'); await live.poll();
  assert.equal(options[0].refresh, false);
  assert.equal(live.snapshot('bsc').status, 'WAITING'); assert.equal(live.snapshot('bsc').lastSuccessAt, 0);
  provider.snapshot = () => ({ pauseCode: 'AVE_TOTAL_BUDGET' }); provider.nextAllowedAt = 0;
  assert.equal(live.snapshot('bsc').status, 'TOTAL_BUDGET_PAUSED');
  assert.ok(Number.isFinite(live.snapshot('bsc').nextPollAt)); live.stop();
});

test('passive HTTP reads immediately hydrate each chain regardless of another tab focus', async () => {
  const calls = [], provider = { keyEpoch: 0, configured: async () => true,
    live: async (chain, options) => {
      calls.push({ chain, options }); return { tokens: [row(AT, { chain })], capturedAt: AT - 1000 };
    } };
  const live = new LiveDiscovery({ ...liveOptions(provider), cacheOnly: true });
  const a = await live.readSnapshot('bsc'), b = await live.readSnapshot('robinhood');
  assert.equal(a.rows.length, 1); assert.equal(b.rows.length, 1);
  assert.equal(a.rows[0].chain, 'bsc'); assert.equal(b.rows[0].chain, 'robinhood');
  assert.equal(a.lastSuccessAt, AT - 1000); assert.equal(b.lastSuccessAt, AT - 1000);
  assert.ok(calls.every(call => call.options.refresh === false));
  assert.equal((await live.readSnapshot('bsc')).rows[0].newAt, 0, 'baseline/cache read must not invent an arrival');
  live.stop();
});

test('hourly and cumulative audit protection do not complete, fail or approve an audit', async () => {
  for (const [code, status] of [['AVE_HOURLY_BUDGET', 'HOURLY_BUDGET_PAUSED'], ['AVE_TOTAL_BUDGET', 'TOTAL_BUDGET_PAUSED']]) {
    const at = Date.now(), state = memoryState();
    const provider = { keyEpoch: 0, configured: async () => true, metrics: {}, discover: async () => [row(at)],
      lastDiscoveryHealth: { provider: 'AVE', complete: true, checkedAt: at },
      audit: async () => { throw Object.assign(new Error('policy only'), { code, ...(code === 'AVE_HOURLY_BUDGET' ? { retryAt: at + 600000 } : {}) }); } };
    const scanner = new Scanner({ provider, state, settings }); await scanner.cycle(); scanner.stop();
    assert.equal(state.value.status, status); assert.equal(state.value.sourceHealth.lastAudit, null);
    assert.ok(!state.value.auditQueue[0].lastAuditedAt); assert.ok(!state.value.auditQueue[0].attempts);
    assert.ok(!state.value.events.some(event => ['CANDIDATE_NEW', 'AUDIT_RETRY'].includes(event.type)));
    assert.ok(Number.isFinite(state.value.nextCycleAt));
  }
});

test('AVE outcome samples use upstream observation time and reject expired cached data', () => {
  const baselineAt = AT - 300000, outcomes = [{ chain: 'bsc', address: CA, baselineAt, baselinePrice: 1, baselineProvider: 'AVE', initialDecision: 'X_REVIEW', samples: {} }];
  const cachedBeforeTarget = updateOutcomeTracking(outcomes, new Map([[CA, row(AT)]]), AT + 1000, 86400000)[0];
  assert.equal(cachedBeforeTarget.samples.m5, undefined);
  const actual = row(AT, { price: 1.1, sourceUpdatedAt: AT, capturedAt: AT + 1000, expiresAt: AT + 30000 });
  const fresh = updateOutcomeTracking(outcomes, new Map([[CA, actual]]), AT + 1000, 86400000)[0];
  assert.equal(fresh.samples.m5.at, AT); assert.equal(fresh.samples.m5.price, 1.1);
  assert.equal(updateOutcomeTracking(outcomes, new Map([[CA, actual]]), AT + 40000, 86400000)[0].samples.m5, undefined);
});

test('adapter projects all validated same-token pool protocols through discovery and audit', async () => {
  let at = Date.now() - 5000, saved = null;
  const token = { token: CA, chain: 'bsc', current_price_usd: '1', market_cap: '50000', holders: 100, updated_at: Math.floor(at / 1000) - 1 };
  const pairs = [{ pair: POOL, chain: 'bsc', amm: 'pancakeswap_v2' }, { pair: ca(4), chain: 'bsc', amm: 'uniswap_v4' }];
  const client = new AveClient({ apiKeyProvider: () => 'mock-only-ave-key', now: () => at, pause: async ms => { at += ms; },
    readBudget: () => saved, saveBudget: next => { saved = next; }, fetchImpl: async url => {
      if (url.includes('trending')) return Response.json({ tokens: [token] });
      if (url.includes('/pairs/')) return Response.json({ pair: POOL, chain: 'bsc', token0_address: CA, token1_address: ca(3), target_token: CA,
        token0_price_usd: '1', token1_price_usd: '1', tvl: '15000', market_cap: '50000', created_at: Math.floor(at / 1000) - 3600,
        updated_at: Math.floor(at / 1000) - 1, volume_u_5m: '1000', buy_volume_u_5m: '600', sell_volume_u_5m: '400' });
      if (url.includes('/klines/')) return Response.json({ status: 1, data: { interval: 1, points: [] } });
      return Response.json({ status: 1, data: { token, pairs } });
    } });
  const discovered = await client.discover('bsc'); assert.equal(discovered[0].pairs.length, 2); assert.equal(discovered[0].pairs[1].address, CA);
  assert.match(discoveryScreen(discovered[0], settings).reasons.join(), /Hook架构池待核验/);
  const audit = await client.audit(CA, Math.floor(at / 1000), 'bsc'); assert.equal(audit.info.pairs.length, 2); assert.equal(audit._meta.complete, false);
});

test('actual mocked AveClient feeds live and Scanner using one cache while unknown audit stays non-alerting', async () => {
  let at = Date.now() - 120000, saved = null; const calls = [];
  const updated = Math.floor(at / 1000);
  const token = { token: CA, chain: 'bsc', name: 'Mock', symbol: 'MOCK', current_price_usd: '1', market_cap: '50000', holders: 100, updated_at: updated };
  const client = new AveClient({ apiKeyProvider: () => 'mock-key-offline-only', now: () => at, pause: async ms => { at += ms; },
    readBudget: () => saved, saveBudget: next => { saved = next; }, fetchImpl: async (url, options) => {
      calls.push(url); assert.equal(options.method, 'GET'); assert.equal(options.headers['X-API-KEY'], 'mock-key-offline-only');
      if (url.includes('trending')) return Response.json({ tokens: [token] });
      if (url.includes('/pairs/')) return Response.json({ pair: POOL, chain: 'bsc', amm: 'pancakeswap_v2', token0_address: CA, token1_address: ca(3), target_token: CA,
        token0_price_usd: '1', token1_price_usd: '1', tvl: '15000', market_cap: '50000', created_at: updated - 3600,
        updated_at: Math.floor(at / 1000), volume_u_5m: '1000', buy_volume_u_5m: '600', sell_volume_u_5m: '400' });
      if (url.includes('/klines/')) return Response.json({ status: 1, data: { interval: 1, points: Array.from({ length: 10 }, (_, i) => ({
        time: Math.floor(at / 60000) * 60 - (10 - i) * 60, open: '1', high: '1.01', low: '.99', close: '1', volume: '100'
      })) } });
      return Response.json({ status: 1, data: { token, pairs: [{ pair: POOL, chain: 'bsc', amm: 'pancakeswap_v2' }] } });
    } });
  const live = new LiveDiscovery(liveOptions(client, Date.now)); live.touch('bsc'); await live.poll();
  assert.equal(live.snapshot('bsc').rows.length, 1); assert.equal(calls.length, 2, 'the first live round discovers a route without issuing its pair read');
  at += 31000; await client.discover('bsc');
  const state = memoryState(), scanner = new Scanner({ provider: client, state, settings }); await scanner.cycle();
  assert.equal(state.value.prequalifiedCount, 1); assert.equal(state.value.candidates[0].status, 'WAIT_RECHECK');
  assert.equal(state.value.status, 'RUNNING'); assert.equal(state.value.events.some(event => event.type === 'CANDIDATE_NEW'), false);
  assert.equal(calls.length, 6, 'the scanner adds the bounded details, pair and K-line audit reads');
  assert.ok(calls.every(url => url.startsWith('https://prod.ave-api.com/v2/')));
  live.stop(); scanner.stop();
});
