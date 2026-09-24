import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createServer, healthSnapshot } from '../src/server.mjs';
import { createAveSettings } from '../src/ave-settings.mjs';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const settings = { port: 3791, version: '0.1.8', publicDir: fileURLToPath(new URL('../public', import.meta.url)) };
const headers = { origin: 'http://127.0.0.1:3791', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
function dispatch(server, path, { method = 'POST', body = {}, extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    Object.assign(req, { method, url: path, headers: { host: '127.0.0.1:3791', ...headers, ...extraHeaders }, socket: { remoteAddress: '127.0.0.1' } });
    let status;
    const res = { setHeader() {}, writeHead(code) { status = code; }, end(content) { resolve({ status, body: JSON.parse(content) }); } };
    Promise.resolve(server.listeners('request')[0](req, res)).catch(reject);
  });
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('selected-chain timers inherit current global AVE cooldown without changing old success time', async () => {
  const now = Date.now(), retry = now + 500000;
  const server = createServer({ settings, state: { value: { activeChain: 'bsc', status: 'RUNNING',
    chainStates: { robinhood: { status: 'RATE_LIMITED', retryAt: now - 5000, nextCycleAt: now - 5000, lastSuccessAt: now - 1200000 } } } },
    getMarketStatus: () => ({ nextAllowedAt: retry, pauseCode: 'AVE_RATE_LIMITED', recovery: { active: true, headOnly: true, auditAllowed: false } }) });
  const { status, body } = await dispatch(server, '/api/status?chain=robinhood', { method: 'GET' });
  assert.equal(status, 200); assert.equal(body.retryAt, retry); assert.equal(body.nextCycleAt, retry);
  assert.equal(body.status, 'RATE_LIMITED'); assert.equal(body.lastSuccessAt, now - 1200000);
  assert.equal(body.aveMarket.recovery.auditAllowed, false);
});

test('an expired per-chain rate status is not shown as a current provider-wide wait', async () => {
  const now = Date.now();
  const server = createServer({ settings, state: { value: { activeChain: 'bsc', status: 'RUNNING',
    chainStates: { robinhood: { status: 'RATE_LIMITED', retryAt: now - 5000, nextCycleAt: now - 5000, lastSuccessAt: now - 1200000 } } } },
    getMarketStatus: () => ({ nextAllowedAt: 0, pauseCode: null, recovery: { active: true, headOnly: false, auditAllowed: false } }) });
  const { status, body } = await dispatch(server, '/api/status?chain=robinhood', { method: 'GET' });
  assert.equal(status, 200); assert.equal(body.status, 'DEGRADED'); assert.equal(body.retryAt, 0);
  assert.equal(body.lastSuccessAt, now - 1200000); assert.equal(body.aveMarket.recovery.headOnly, false);
});

test('disabled and expired chain views never expose a historical RUNNING state', async () => {
  const now = Date.now();
  const scope = lastSuccessAt => ({ status: 'RUNNING', scanInProgress: false, lastSuccessAt, generatedAt: lastSuccessAt });
  const controls = { value: { enabledChains: ['bsc', 'eth'], annotations: {} } };
  const state = { value: { activeChain: 'bsc', status: 'RUNNING', lastSuccessAt: now,
    chainStates: { robinhood: scope(now), eth: scope(now - 20 * 60_000), sol: scope(now) } } };
  const server = createServer({ settings: { ...settings, scanIntervalMs: 120_000 }, state, controls });

  const disabled = await dispatch(server, '/api/status?chain=robinhood', { method: 'GET' });
  assert.equal(disabled.status, 200); assert.equal(disabled.body.status, 'STARTING');
  assert.equal(disabled.body.retryAt, 0); assert.equal(disabled.body.nextCycleAt, 0);

  const expired = await dispatch(server, '/api/status?chain=eth', { method: 'GET' });
  assert.equal(expired.status, 200); assert.equal(expired.body.status, 'DEGRADED');
  assert.equal(expired.body.lastSuccessAt, state.value.chainStates.eth.lastSuccessAt);

  const fresh = await dispatch(server, '/api/status?chain=sol', { method: 'GET' });
  assert.equal(fresh.status, 200); assert.equal(fresh.body.status, 'STARTING');

  const active = await dispatch(server, '/api/status?chain=bsc', { method: 'GET' });
  assert.equal(active.status, 200); assert.equal(active.body.status, 'RUNNING');
});

test('active-chain endpoint rejects a chain outside a multi-chain scan set', async () => {
  let switched = 0;
  const server = createServer({ settings, state: { value: { activeChain: 'bsc' } },
    controls: { value: { enabledChains: ['bsc', 'eth'], annotations: {} } },
    supportedChains: ['bsc', 'eth', 'sol'], switchChain() { switched++; } });
  const result = await dispatch(server, '/api/active-chain', { body: { chain: 'sol' } });
  assert.equal(result.status, 409); assert.deepEqual(result.body, { error: 'chain_not_enabled' });
  assert.equal(switched, 0);
});

test('public status and export omit unsupported legacy Arc and Stable scopes', async () => {
  const supportedChains = ['sol', 'bsc', 'base', 'eth', 'robinhood'];
  const legacyScope = { status: 'RUNNING', candidates: [], outcomes: [] };
  const state = { value: { activeChain: 'bsc', status: 'RUNNING', supportedChains: [...supportedChains, 'arc', 'stable'],
    events: [{ type: 'SCAN', chain: 'bsc' }, { type: 'SCAN', chain: 'arc' }, { type: 'NOTICE' }],
    chainStates: { bsc: legacyScope, arc: legacyScope, stable: legacyScope } } };
  const server = createServer({ settings, state, supportedChains, switchChain: () => assert.fail('unsupported chains must not switch'),
    controls: { value: { enabledChains: [...supportedChains, 'arc', 'stable'], annotations: {
      keep: { chain: 'bsc', address: '0x1', favorite: true }, legacy: { chain: 'arc', address: '0x2', favorite: true }
    } } },
    getMarketStatus: () => ({ chains: Object.fromEntries([...supportedChains, 'arc', 'stable'].map(chain => [chain, {
      state: 'observed', documented: true
    }])) }) });

  const status = await dispatch(server, '/api/status', { method: 'GET' });
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.supportedChains, supportedChains);
  assert.deepEqual(status.body.scheduler.enabledChains, supportedChains);
  assert.deepEqual(Object.keys(status.body.aveMarket.chains), supportedChains);
  assert.deepEqual(Object.keys(status.body.coverage), supportedChains);
  assert.deepEqual(Object.keys(status.body.annotations), ['keep']);
  assert.deepEqual(status.body.events.map(event => event.chain), ['bsc', '']);

  const exported = await dispatch(server, '/api/export', { method: 'GET' });
  assert.equal(exported.status, 200);
  assert.deepEqual(Object.keys(exported.body.chains), ['bsc']);
  assert.deepEqual(exported.body.chains.bsc.events.map(event => event.chain), ['bsc', '']);
  for (const chain of ['arc', 'stable']) {
    assert.equal((await dispatch(server, `/api/status?chain=${chain}`, { method: 'GET' })).status, 400);
    assert.equal((await dispatch(server, '/api/active-chain', { body: { chain } })).status, 422);
  }
});
const update = { phase: 'available', currentVersion: '0.1.8', availableVersion: '0.1.9', canInstall: true,
  assetName: 'MemeRadar-OpenSource-macOS-0.1.9.zip', checkedAt: 123, message: 'raw-private-fixture', key: 'raw-private-fixture' };

test('update endpoints require explicit local Origin, JSON and exact allowlisted fields without network', async () => {
  let calls = 0;
  const server = createServer({ settings, state: { value: {} }, updater: {
    snapshot: () => update, check: async () => { calls++; return update; }, install: async () => { calls++; return update; }
  }, onUpdateReady() { assert.fail('not handed off'); } });
  assert.equal((await dispatch(server, '/api/update-status', { method: 'GET' })).body.update.repository, 'nhovongoc0-max/meme-radar');
  for (const path of ['/api/update-check', '/api/update-install']) {
    const body = path.endsWith('install') ? { version: '0.1.9', confirm: 'INSTALL_UPDATE' } : {};
    for (const extraHeaders of [{ origin: undefined }, { origin: 'https://evil.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await dispatch(server, path, { body, extraHeaders })).status, 403);
    }
    assert.equal((await dispatch(server, path, { body, extraHeaders: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await dispatch(server, path, { body: { ...body, url: 'https://evil.invalid/update.zip' } })).status, 400);
    assert.equal((await dispatch(server, path, { body: [] })).status, 400);
    assert.equal((await dispatch(server, path, { body: '{' })).status, 400);
    assert.equal((await dispatch(server, path, { body: ' '.repeat(513) })).status, 413);
  }
  for (const version of ['0.1.9-beta.1', '../0.1.9', 'v0.1.9', 9]) assert.equal((await dispatch(server, '/api/update-install', {
    body: { version, confirm: 'INSTALL_UPDATE' } })).status, 400);
  assert.equal((await dispatch(server, '/api/update-install', { body: { version: '0.1.9', confirm: true } })).status, 400);
  assert.equal(calls, 0);
  const checked = await dispatch(server, '/api/update-check');
  assert.equal(checked.status, 200); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(checked), /raw-private-fixture/);
});

test('update handoff is acknowledged before exactly one graceful shutdown callback', async () => {
  let closed = 0, installed;
  const server = createServer({ settings, state: { value: {} }, updater: { snapshot: () => update,
    install: async body => { installed = body; return { ...update, phase: 'handoff' }; } }, onUpdateReady() { closed++; } });
  const body = { version: '0.1.9', confirm: 'INSTALL_UPDATE' };
  const result = await dispatch(server, '/api/update-install', { body });
  assert.equal(result.status, 200); assert.equal(result.body.update.restartRequired, true);
  assert.deepEqual(installed, body); assert.equal(closed, 0);
  await tick(); assert.equal(closed, 1);
  await dispatch(server, '/api/update-install', { body }); await tick(); assert.equal(closed, 1);
  const noExit = createServer({ settings, state: { value: {} }, updater: { install: () => assert.fail('must not stage without exit handler') } });
  assert.equal((await dispatch(noExit, '/api/update-install', { body })).status, 503);
});

test('update errors expose fixed codes only and never request shutdown', async () => {
  let closed = 0;
  for (const code of ['UPDATE_CHECKSUM', 'raw-private-fixture']) {
    const server = createServer({ settings, state: { value: {} }, updater: { snapshot: () => ({ ...update, phase: 'blocked', code, message: 'raw-private-fixture' }),
      install: async () => { throw Object.assign(new Error('raw-private-fixture'), { code }); } }, onUpdateReady() { closed++; } });
    const result = await dispatch(server, '/api/update-install', { body: { version: '0.1.9', confirm: 'INSTALL_UPDATE' } });
    assert.equal(result.status, 409); assert.equal(result.body.error, code === 'UPDATE_CHECKSUM' ? code : 'UPDATE_STORAGE');
    assert.doesNotMatch(JSON.stringify(result), /raw-private-fixture/);
  }
  await tick(); assert.equal(closed, 0);
});

test('status adds AVE market budget and safe connection fields, fixed health version and no production GMGN mutations', async () => {
  const secret = 'raw-private-fixture';
  const server = createServer({ settings, state: { value: { version: 987, status: 'RUNNING' } },
    getAveConnection: () => ({ configured: true, key: secret, data: { status: 'connected', checkedAt: 42, message: secret } }),
    getMarketStatus: () => ({ dailyLimit: 2000, totalLimit: 1000000, hourlyLimit: 1250, manualResetRequired: false, nextAllowedAt: 100, pending: 2, pauseCode: 'AVE_HOURLY_BUDGET', key: secret, discoveryReserveCu: 800, nonTrendingPausedUntil: 999,
      metrics: { requests: 3, estimatedCu: 11, key: secret, byKind: { klines: { requests: 1, estimatedCu: 10, key: secret }, secret: { key: secret } } },
      transport: { spacingMs: 4000, strikes: 1, last429At: 88, active: false, key: secret,
        recent: [{ at: 88, endpoint: 'pair', chain: 'bsc', httpStatus: 429, category: 'rate', retryAt: 1000, retryAfterMs: 60000, startGapMs: 2200, durationMs: 200, body: secret, headers: { key: secret } }] },
      budget: { day: '2026-09-21', used: 11, remaining: 1989, totalUsed: 2011, totalRemaining: 997989, hourUsed: 11, hourRemaining: 1239, periodStartedAt: 100, legacyUsageIncluded: true, legacySnapshot: { key: secret }, nonTrendingRemaining: 1189, fingerprint: secret },
      chains: { bsc: { state: 'observed', documented: true, apiChain: secret }, secret: { state: secret } } }) });
  const status = await dispatch(server, '/api/status', { method: 'GET' });
  assert.equal(status.body.scanProvider, 'AVE'); assert.equal(status.body.aveConnection.data.status, 'connected');
  assert.equal(status.body.aveMarket.metrics.estimatedCu, 11); assert.equal(status.body.aveMarket.budget.remaining, 1989);
  assert.equal(status.body.aveMarket.metrics.scope, 'session'); assert.equal(status.body.aveMarket.metrics.byKind.klines.estimatedCu, 10);
  assert.equal(status.body.aveMarket.discoveryReserveCu, 800); assert.equal(status.body.aveMarket.budget.nonTrendingRemaining, 1189);
  assert.equal(status.body.aveMarket.totalLimit, 1000000); assert.equal(status.body.aveMarket.hourlyLimit, 1250);
  assert.equal(status.body.aveMarket.budget.totalRemaining, 997989); assert.equal(status.body.aveMarket.budget.hourRemaining, 1239);
  assert.equal(status.body.aveMarket.budget.legacyUsageIncluded, true); assert.equal(status.body.aveMarket.budget.legacySnapshot, undefined);
  assert.equal(status.body.aveMarket.pauseCode, 'AVE_HOURLY_BUDGET');
  assert.equal(status.body.aveMarket.transport.spacingMs, 4000);
  assert.equal(status.body.aveMarket.transport.recent[0].category, 'rate');
  assert.equal(status.body.aveMarket.transport.recent[0].body, undefined);
  assert.equal(status.body.aveMarket.chains.bsc.apiChain, 'bsc'); assert.equal(status.body.aveMarket.readonly, true);
  assert.equal(status.body.aveConnection.executionReady, false); assert.doesNotMatch(JSON.stringify(status), /raw-private-fixture|fingerprint/);
  assert.equal((await dispatch(server, '/health', { method: 'GET' })).body.version, '0.1.8');
  assert.equal(healthSnapshot({ version: '9.9.9' }, settings).version, '0.1.8');
  assert.equal((await dispatch(server, '/api/gmgn-onboarding', { body: { regenerate: false } })).status, 503);
  assert.equal((await dispatch(server, '/api/gmgn-disconnect')).status, 503);
  assert.equal((await dispatch(server, '/api/gmgn-key', { body: { apiKey: 'fixture-key' } })).status, 503);
});

test('injected Data verifier is shared, serialized and cannot leak key or rescue failures via Trade', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-ave-injected-'));
  let clock = 1000, reply = 'ok', release;
  const calls = [], changes = [];
  try {
    const ave = createAveSettings({ directory, now: () => clock, fetchImpl: () => assert.fail('injected verifier must be used'),
      verifyData: async key => {
        calls.push(key);
        if (reply === 'pending') await new Promise(resolve => { release = resolve; });
        if (reply === 'failure') throw Object.assign(new Error(key), { code: 'AVE_AUTH' });
        if (reply === 'rate') throw Object.assign(new Error(key), { code: 'AVE_RATE_LIMITED' });
        if (reply === 'false') return false;
        return { connected: true, key, message: key };
      }, onChange: change => { changes.push({ ...change, stored: JSON.parse(readFileSync(join(directory, 'ave-credentials.json'))).key }); } });
    await ave.configure({ key: 'old-fixture-key' });
    assert.equal(ave.getKey(), 'old-fixture-key'); assert.equal(changes[0].stored, 'old-fixture-key');
    assert.doesNotMatch(JSON.stringify(ave.snapshot()), /old-fixture-key/);
    clock += 61000; reply = 'failure';
    await assert.rejects(ave.configure({ key: 'new-fixture-key' }), error => error.code === 'AVE_AUTH' && !error.message.includes('new-fixture-key'));
    assert.equal(ave.getKey(), 'old-fixture-key'); assert.equal(changes.length, 1);
    clock += 61000; reply = 'false'; await assert.rejects(ave.configure({ key: '' }), { code: 'AVE_SCHEMA' });
    clock += 61000; reply = 'rate'; await assert.rejects(ave.configure({ key: '' }), { code: 'AVE_RATE_LIMIT' });
    const count = calls.length; await assert.rejects(ave.configure({ key: '' }), { code: 'AVE_COOLDOWN' }); assert.equal(calls.length, count);
    clock += 61000; reply = 'pending'; const pending = ave.configure({ key: '' });
    await assert.rejects(ave.configure({ key: '' }), { code: 'AVE_BUSY' }); assert.throws(() => ave.remove({}), { code: 'AVE_BUSY' });
    release(); await pending;
    const server = createServer({ settings, state: { value: {} }, ave });
    const removed = await dispatch(server, '/api/ave-remove');
    assert.equal(removed.status, 200); assert.equal(ave.getKey(), ''); assert.equal(changes.at(-1).reason, 'removed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
