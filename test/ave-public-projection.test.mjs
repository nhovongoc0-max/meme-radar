import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createServer, toPublicStatus } from '../src/server.mjs';

const CA = '0x' + '1'.repeat(40), POOL = '0x' + '2'.repeat(40);
const row = (now, extra = {}) => ({ chain: 'bsc', address: CA, marketProvider: 'AVE', symbol: 'MOCK', name: 'Mock',
  marketCap: 40000, liquidity: 9000, price: 1, createdAt: Math.floor(now / 1000) - 3500, ageSec: 3500, ageBasis: 'trade',
  poolCreatedAt: now - 3600000, firstTradeAt: now - 3500000, capturedAt: now - 1000, sourceUpdatedAt: now - 2000,
  expiresAt: now + 20000, stale: false, auditEligible: true, volume5m: 1234, buys5m: null, sells5m: null, activityWindow: '5m',
  discoveryState: 'READY', firstSeenAt: now - 5000, newAt: now - 5000,
  holders: null, buys: null, sells: null, volume1h: null, pairAddress: POOL, status: 'WAIT_RECHECK', auditedAt: 0,
  raw: { key: 'raw-private-fixture' }, ...extra });
function dispatch(server) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from('{"chain":"bsc"}')]);
    Object.assign(req, { method: 'POST', url: '/api/live-discovery', socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:3791', origin: 'http://127.0.0.1:3791', 'content-type': 'application/json' } });
    let status;
    const res = { writeHead(code) { status = code; }, end(content) { resolve({ status, body: JSON.parse(content) }); } };
    Promise.resolve(server.listeners('request')[0](req, res)).catch(reject);
  });
}

test('AVE public candidates preserve original clocks, pool/trade age basis and null evidence without creating an audit pass', () => {
  const now = Date.now(), input = row(now);
  const output = toPublicStatus({ activeChain: 'bsc', candidates: [input] }).candidates[0];
  for (const key of ['marketProvider', 'ageBasis', 'capturedAt', 'sourceUpdatedAt', 'expiresAt', 'poolCreatedAt', 'firstTradeAt',
    'createdAt', 'ageSec', 'volume5m', 'activityWindow', 'pairAddress', 'stale', 'auditEligible']) assert.equal(output[key], input[key], key);
  for (const key of ['holders', 'volume1h', 'buys', 'sells']) assert.equal(output[key], null, key);
  assert.equal(output.auditedAt, 0); assert.equal(output.deep.chainPass, false); assert.equal(output.status, 'WAIT_RECHECK');
  assert.doesNotMatch(JSON.stringify(output), /raw-private-fixture|"raw"/);
  for (const extra of [{ expiresAt: now - 1 }, { capturedAt: now + 5000 }, { sourceUpdatedAt: now - 61000 }, { sourceUpdatedAt: null }, { stale: true }]) {
    const expired = toPublicStatus({ activeChain: 'bsc', candidates: [row(now, extra)] }).candidates[0];
    assert.equal(expired.stale, true); assert.equal(expired.auditEligible, false);
  }
  const missing = toPublicStatus({ activeChain: 'bsc', candidates: [row(now, { ageBasis: 'raw-private-fixture', ageSec: null, volume5m: null })] }).candidates[0];
  assert.equal(missing.ageBasis, 'unknown'); assert.equal(missing.ageSec, null); assert.equal(missing.volume5m, null);
  const launch = toPublicStatus({ activeChain: 'bsc', candidates: [row(now, { ageBasis: 'launch' })] }).candidates[0];
  assert.equal(launch.ageBasis, 'launch');
});

test('AVE live endpoint allowlists fields, keeps quote expiry and supplies the actual UI five-minute/pool-age values', async () => {
  const now = Date.now(), fresh = row(now), old = row(now, { address: '0x' + '3'.repeat(40), expiresAt: now - 1 });
  const snapshot = { chain: 'bsc', marketProvider: 'AVE', status: 'READY', stale: false, lastSuccessAt: now - 1000,
    rows: [fresh, old, row(now, { chain: 'eth' })], raw: 'raw-private-fixture' };
  const server = createServer({ state: { value: { activeChain: 'bsc' } },
    settings: { port: 3791, publicDir: fileURLToPath(new URL('../public', import.meta.url)) }, liveDiscovery: { touch: () => snapshot } });
  const response = await dispatch(server);
  assert.equal(response.status, 200); assert.equal(response.body.rows.length, 1);
  const result = response.body.rows[0];
  assert.equal(result.volume5m, 1234); assert.equal(result.volume1m, null); assert.equal(result.buys5m, null);
  assert.equal(result.ageBasis, 'trade'); assert.equal(result.sourceUpdatedAt, fresh.sourceUpdatedAt); assert.equal(result.expiresAt, fresh.expiresAt);
  assert.equal(snapshot.rows[1].stale, false, 'projection must not mutate retained data');
  assert.doesNotMatch(JSON.stringify(response), /raw-private-fixture|"raw"/);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const elements = Object.fromEntries(['liveAuto', 'liveState', 'liveSearch', 'liveSort', 'liveMeta', 'liveRows']
    .map(id => [id, { value: '', textContent: '', innerHTML: '', hidden: false }]));
  const context = { Date: class extends Date { static now() { return now; } }, viewChain: 'bsc', liveData: response.body,
    lastData: { scheduler: { enabledChains: ['bsc'] } }, liveEnabled: true, liveOffline: false, liveFingerprint: '', liveQueued: new Map(),
    rowsCache: [], backendDisposition: () => 'waiting',
    currentLocale: 'en', byId: id => elements[id], activeChain: () => 'bsc', t: key => key,
    number: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    chainCatalog: [{ id: 'bsc' }], chainLabel: () => 'BSC', relativeTime: String, escapeHtml: String,
    formatMoney: value => value === null ? 'UNKNOWN' : String(value), formatCount: value => value === null ? 'UNKNOWN' : String(value),
    formatSignedPercent: String, formatDuration: String, radarLinks: () => '',
    voiceSpotlightRank: () => Infinity, voiceSpotlightKey: r => r.chain + ':' + r.address,
    voiceSpotlight: null, voiceSpotlightSelected: '', voiceSpotlightSignature: '', voiceSpotlightSnapshot: null };
  const poolStart = html.indexOf('function unifiedPoolRows('), poolEnd = html.indexOf('// Voice spotlight:', poolStart);
  const start = html.indexOf('function renderLive()'), end = html.indexOf('async function refreshLive()', start);
  const draw = html.slice(poolStart, poolEnd) + html.slice(start, end) + ';renderLive();';
  vm.runInNewContext(draw, context);
  assert.equal(elements.liveState.textContent, 'liveReady'); assert.equal(elements.liveState.hidden, false);
  context.lastData = { status: 'RUNNING', scheduler: { enabledChains: ['bsc'] },
    aveMarket: { pauseCode: null, nextAllowedAt: 0, recovery: { active: true } } };
  vm.runInNewContext(draw, context);
  assert.equal(elements.liveState.textContent, 'liveReady', 'successful recovery must not replace the candidate state');
  assert.equal(elements.liveState.hidden, false);
  context.lastData.aveMarket = { pauseCode: 'AVE_RATE_LIMITED', nextAllowedAt: 0,
    budget: { blockedUntil: now + 60000 }, recovery: { active: true } };
  vm.runInNewContext(draw, context);
  assert.equal(elements.liveState.textContent, '', 'the top status owns an active rate-limit notice');
  assert.equal(elements.liveState.hidden, true);
  context.lastData.aveMarket = { pauseCode: null, nextAllowedAt: 0, recovery: { active: false } };
  context.liveData = { ...response.body, status: 'AUTH_REQUIRED' };
  vm.runInNewContext(draw, context);
  assert.equal(elements.liveState.textContent, 'statusAuth', 'unrelated candidate states remain visible');
  assert.equal(elements.liveState.hidden, false);
  context.liveData = response.body;
  assert.match(elements.liveRows.innerHTML, /1234/); assert.match(elements.liveRows.innerHTML, /poolAge/);
  assert.doesNotMatch(elements.liveRows.innerHTML, /ageLabel|data-live-audit/);
  assert.doesNotMatch(elements.liveRows.innerHTML, /liveStale/);
  context.liveData = { ...response.body, rows: [row(now, { ageBasis: 'launch', pairAddress: '' })] };
  vm.runInNewContext(draw, context);
  assert.match(elements.liveRows.innerHTML, /launchAge/); assert.doesNotMatch(elements.liveRows.innerHTML, /poolAge/);
  context.liveData = response.body;
  elements.liveSort.value = 'new';
  vm.runInNewContext(draw, context);
  assert.match(elements.liveRows.innerHTML, /MOCK/); assert.doesNotMatch(elements.liveRows.innerHTML, /liveFilteredEmpty/);
  elements.liveSearch.value = 'no-match';
  vm.runInNewContext(draw, context);
  assert.match(elements.liveRows.innerHTML, /liveFilteredEmpty/); assert.match(elements.liveRows.innerHTML, /data-live-reset/);
  elements.liveSearch.value = '';
  elements.liveSort.value = 'priority';
  context.liveData = { ...response.body, receivedCount: 50,
    rows: [row(now, { auditEligible: false, discoveryState: 'PENDING', liquidity: null, volume5m: null, stale: true })],
    diagnostics: { received: 50, inRange: 1, pending: 1, stale: 0, ready: 0, excluded: 49, outsideRange: 49 } };
  context.t = (key, args) => key === 'liveCoverage' ? JSON.stringify(args) : key;
  vm.runInNewContext(draw, context);
  assert.match(elements.liveMeta.title, /"received":50/);
  assert.doesNotMatch(elements.liveRows.innerHTML, /livePending|liveFetching/);
  assert.doesNotMatch(elements.liveRows.innerHTML, /UNKNOWN/);
  assert.doesNotMatch(elements.liveRows.innerHTML, /data-live-audit/);
  // The server projection removes expired rows; model that public response
  // rather than injecting an internally inconsistent READY-but-expired row.
  context.liveData.rows = [row(now, { discoveryState: 'READY', expiresAt: now - 1, stale: true, auditEligible: false })];
  vm.runInNewContext(draw, context);
  assert.doesNotMatch(elements.liveRows.innerHTML, /MOCK|liveStale|data-live-audit/);
  // The fast pool is a fifteen-minute window, not a permanent watchlist.
  // An expired card cannot be repinned without a current eligible snapshot.
  elements.liveSort.value = 'new';
  const other = '0x' + '4'.repeat(40);
  context.liveData.rows = [row(now, { symbol: 'OLD', firstSeenAt: now - 1800000, newAt: 0 }),
    row(now, { address: other, symbol: 'NEWER', firstSeenAt: now - 5000, newAt: now - 5000 })];
  vm.runInNewContext(draw, context);
  assert.match(elements.liveRows.innerHTML, /NEWER/); assert.doesNotMatch(elements.liveRows.innerHTML, /OLD/);
  context.voiceSpotlight = { id: 1 }; context.voiceSpotlightSelected = 'bsc:' + CA;
  context.voiceSpotlightRank = r => r.address === CA ? 0 : Infinity;
  vm.runInNewContext(draw, context);
  assert.doesNotMatch(elements.liveRows.innerHTML, /OLD|voice-highlight/);
  context.voiceSpotlightSignature = 'expired'; context.voiceSpotlightRank = () => Infinity;
  vm.runInNewContext(draw, context);
  assert.doesNotMatch(elements.liveRows.innerHTML, /voice-highlight/);

  // A historical audit-only candidate cannot refill the fast market pool after
  // current discovery has removed it.
  const auditOnly = '0x' + '5'.repeat(40);
  context.rowsCache = [{ chain: 'bsc', address: auditOnly, symbol: 'AUDIT', name: 'Audit only', status: 'X_REVIEW',
    auditedAt: now - 1000, staleAt: now + 30000, marketCap: 50000, liquidity: 10000, createdAt: Math.floor(now / 1000) - 600 }];
  context.backendDisposition = candidate => candidate.status === 'X_REVIEW' ? 'chain' : 'waiting';
  context.voiceSpotlightSelected = 'bsc:' + auditOnly;
  context.voiceSpotlightRank = candidate => candidate.address === auditOnly ? 0 : Infinity;
  vm.runInNewContext(draw, context);
  assert.doesNotMatch(elements.liveRows.innerHTML, /AUDIT/);

  // A just-announced live row comes from the status snapshot immediately,
  // without waiting for the independent live-feed request to finish.
  const instant = '0x' + '6'.repeat(40);
  context.voiceSpotlightSnapshot = { chains: { bsc: [{ chain: 'bsc', address: instant, source: 'live', status: 'LIVE_READY',
    qualified: true, symbol: 'INSTANT', name: 'Instant alert', marketCap: 60000, liquidity: 12000, volume5m: 700,
    createdAt: Math.floor(now / 1000) - 800, sourceUpdatedAt: now - 500, auditedAt: now - 500,
    staleAt: now + 20000, firstSeenAt: now - 500, newAt: now - 500 }] } };
  context.voiceSpotlightSelected = 'bsc:' + instant;
  context.voiceSpotlightRank = candidate => candidate.address === instant ? 0 : Infinity;
  vm.runInNewContext(draw, context);
  assert.match(elements.liveRows.innerHTML, /INSTANT/);
  assert.doesNotMatch(elements.liveRows.innerHTML, /OLD/);
  assert.ok(elements.liveRows.innerHTML.indexOf('INSTANT') < elements.liveRows.innerHTML.indexOf('NEWER'),
    'a just-announced candidate is pinned ahead of the remaining current cards');

  const remindedRows = Array.from({ length: 16 }, (_, index) => ({ chain: 'bsc',
    address: '0x' + (index + 10).toString(16).padStart(40, '0'), source: 'live', status: 'LIVE_READY', qualified: true,
    symbol: 'REM' + index, name: 'Reminded ' + index, marketCap: 60000, liquidity: 12000, volume5m: 700,
    createdAt: Math.floor(now / 1000) - 800, sourceUpdatedAt: now - 500, auditedAt: now - 500,
    staleAt: now + 20000, firstSeenAt: now - 500, newAt: now - 500 }));
  context.voiceSpotlightSnapshot = { chains: { bsc: remindedRows } };
  context.voiceSpotlightRank = candidate => {
    const rank = remindedRows.findIndex(row => row.address === candidate.address);
    return rank < 0 ? Infinity : rank;
  };
  vm.runInNewContext(draw, context);
  assert.equal((elements.liveRows.innerHTML.match(/voice-highlight/g) || []).length, 16,
    'every token in a large spoken batch remains visible above ordinary cards');
});

test('AVE live endpoint never re-exposes a contract already hard-rejected by deep checks', async () => {
  const now = Date.now(), rejected = row(now, { status: 'HARD_REJECT', auditedAt: now - 1000 });
  const snapshot = { chain: 'bsc', marketProvider: 'AVE', status: 'READY', stale: false, lastSuccessAt: now - 500,
    rows: [row(now)], diagnostics: { received: 1, inRange: 1, pending: 0, stale: 0, ready: 1, excluded: 0, outsideRange: 0 } };
  const state = { activeChain: 'bsc', candidates: [rejected], chainStates: {}, riskExclusions: {} };
  const server = createServer({ state: { value: state }, settings: { port: 3791, publicDir: fileURLToPath(new URL('../public', import.meta.url)) },
    liveDiscovery: { touch: () => snapshot } });
  const response = await dispatch(server);
  assert.equal(response.status, 200); assert.equal(response.body.rows.length, 0);
  assert.equal(response.body.diagnostics.excluded, 1); assert.equal(response.body.diagnostics.ready, 0);

  const retainedState = { activeChain: 'bsc', candidates: [],
    auditQueue: [{ address: CA, status: 'HARD_REJECT', lastAuditedAt: now - 1000, nextAuditAt: now + 600000 }],
    chainStates: {}, riskExclusions: {} };
  const retainedServer = createServer({ state: { value: retainedState },
    settings: { port: 3791, publicDir: fileURLToPath(new URL('../public', import.meta.url)) }, liveDiscovery: { touch: () => snapshot } });
  const retained = await dispatch(retainedServer);
  assert.equal(retained.status, 200); assert.equal(retained.body.rows.length, 0,
    'the longer-lived audit queue keeps the rejection active after candidates retention expires');
});

test('AVE health distinguishes missing audit evidence from failed requests and does not invent a trenches endpoint', () => {
  const now = Date.now();
  const source = { discovery: { provider: 'AVE', complete: true, checkedAt: now, trending: { ok: true, capturedAt: now, count: 30 },
    enrichment: { attempted: 6, enriched: 5, deferred: 1, complete: false, pausedCode: 'AVE_DISCOVERY_RESERVE', pausedUntil: now + 1000,
      errors: [{ code: 'AVE_QUOTA', message: 'raw-private-fixture' }] } },
    lastAudit: { provider: 'AVE', complete: false, transportComplete: true, marketComplete: true, evidenceComplete: false,
      marketFresh: true, capturedAt: now, auditedAt: null, missingEvidence: ['security', 'holders', 'traders', 'raw-private-fixture'],
      requestedEndpoints: ['info', 'pool', 'candles'], endpoints: {
        info: { ok: true, state: 'ok', capturedAt: now, sourceUpdatedAt: now - 1000 },
        security: { ok: false, state: 'unverified', code: 'AVE_FIELD_UNVERIFIED', message: 'raw-private-fixture' },
        pool: { ok: false, state: 'error', code: 'AVE_QUOTA' },
      } } };
  const health = toPublicStatus({ sourceHealth: source }).sourceHealth;
  assert.equal(health.discovery.provider, 'AVE'); assert.equal(Object.hasOwn(health.discovery, 'trenches'), false);
  assert.equal(health.discovery.trending.ok, true); assert.equal(health.discovery.enrichment.errorCount, 1);
  assert.equal(health.discovery.enrichment.deferred, 1); assert.equal(health.discovery.enrichment.complete, false);
  assert.equal(health.discovery.enrichment.pausedCode, 'AVE_DISCOVERY_RESERVE'); assert.equal(health.discovery.enrichment.pausedUntil, now + 1000);
  assert.equal(health.lastAudit.transportComplete, true); assert.equal(health.lastAudit.marketComplete, true);
  assert.equal(health.lastAudit.evidenceComplete, false); assert.equal(health.lastAudit.complete, false);
  assert.deepEqual(health.lastAudit.missingEvidence, ['security', 'holders', 'traders']);
  assert.equal(health.lastAudit.endpoints.security.state, 'unverified'); assert.match(health.lastAudit.endpoints.security.message, /不表示网络失败/);
  assert.match(health.lastAudit.endpoints.pool.message, /配额不足/); assert.doesNotMatch(JSON.stringify(health), /GMGN|raw-private-fixture/);
  const empty = toPublicStatus({ sourceHealth: { discovery: { provider: 'AVE', complete: false } } }).sourceHealth.discovery;
  assert.equal(Object.hasOwn(empty, 'trending'), false); assert.equal(Object.hasOwn(empty, 'trenches'), false);
});
