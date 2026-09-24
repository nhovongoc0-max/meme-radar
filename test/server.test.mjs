import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createServer, healthSnapshot, isTrustedLocalRequest, toPublicStatus } from '../src/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settings = { port: 3791, scanIntervalMs: 120_000, publicDir: path.join(ROOT, 'public') };

function request(overrides = {}) {
  return {
    ...overrides,
    socket: overrides.socket || { remoteAddress: '127.0.0.1' },
    headers: {
      host: '127.0.0.1:3791',
      origin: 'http://127.0.0.1:3791',
      'sec-fetch-site': 'same-origin',
      ...overrides.headers
    }
  };
}

test('local request gate rejects foreign host, origin, fetch site and remote address', () => {
  assert.equal(isTrustedLocalRequest(request(), settings), true);
  assert.equal(isTrustedLocalRequest(request({ headers: { host: 'attacker.example' } }), settings), false);
  assert.equal(isTrustedLocalRequest(request({ headers: { origin: 'http://attacker.example' } }), settings), false);
  assert.equal(isTrustedLocalRequest(request({ headers: { 'sec-fetch-site': 'cross-site' } }), settings), false);
  assert.equal(isTrustedLocalRequest(request({ socket: { remoteAddress: '192.0.2.10' } }), settings), false);
});

test('external links may navigate to the static home page, never to APIs or embedded resources', () => {
  const navigation = (url = '/', extra = {}) => request({ method: 'GET', url, ...extra,
    headers: { origin: undefined, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document', ...extra.headers } });
  for (const url of ['/', '/index.html', '/?from=desktop']) assert.equal(isTrustedLocalRequest(navigation(url), settings), true);
  assert.equal(isTrustedLocalRequest(navigation('/', { headers: { 'sec-fetch-site': 'same-site' } }), settings), true);
  for (const url of ['/api/status', '/api/export', '/health', '/voice-ui.mjs', '/audio/candidate-found.wav', '//foreign.example/']) {
    assert.equal(isTrustedLocalRequest(navigation(url), settings), false, url);
  }
  for (const headers of [
    { 'sec-fetch-dest': 'iframe' }, { 'sec-fetch-mode': 'cors' }, { 'sec-fetch-mode': 'no-cors' },
    { 'sec-fetch-dest': 'image' }, { 'sec-fetch-mode': undefined }, { origin: 'null' },
    { origin: 'https://foreign.example' }, { origin: 'http://localhost:3791' },
    { host: 'foreign.example' }, { host: '127.0.0.1:9999' }, { 'sec-fetch-site': 'invalid' }
  ]) assert.equal(isTrustedLocalRequest(navigation('/', { headers }), settings), false);
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) assert.equal(isTrustedLocalRequest(navigation('/', { method }), settings), false);
  assert.equal(isTrustedLocalRequest(navigation('/', { socket: { remoteAddress: '192.0.2.1' } }), settings), false);
});

test('public status is a field allowlist and removes raw provider and queue details', () => {
  const result = toPublicStatus({
    version: 2,
    status: 'ERROR',
    error: 'Command failed with confidential detail do-not-return-this',
    activeChain: 'robinhood',
    supportedChains: ['robinhood', 'sol', 'not-real'],
    lastAttemptAt: 100,
    lastSuccessAt: 90,
    nextCycleAt: 200,
    scanInProgress: true,
    auditQueue: [{ secret: 'queue-secret' }],
    auditQueueStats: { total: 12, retained: 14, due: 3, privateField: 'queue-summary-secret' },
    outcomes: [{ raw: 'outcome-secret' }],
    outcomeSummary: {
      tracked: 4, minimumSample: 50, calibrationReady: false, completed5m: 3, completed30m: 2, completed2h: 1, completed24h: 1,
      averageReturn5m: 0.12, averageReturn30m: 0.08, averageReturn2h: -0.02,
      averageReturn24h: 0.21, note: '影子验证', privateField: 'outcome-summary-secret'
    },
    sourceHealth: {
      discovery: {
        complete: false,
        checkedAt: 88,
        trenches: { ok: false, code: 'GMGN_TIMEOUT', message: 'raw-secret-message' },
        trending: { ok: true, count: 9 }
      },
      lastAudit: {
        complete: false,
        checkedAt: 89,
        endpoints: { info: { ok: true }, security: { ok: false, code: 'GMGN_REQUEST_FAILED', message: 'other-secret-message' } }
      }
    },
    candidates: [{
      address: '0x1111111111111111111111111111111111111111',
      symbol: 'SAFE',
      status: 'X_REVIEW',
      rawDiscovery: { apiKey: 'candidate-secret' },
      deep: { chainPass: true, checks: { tax: true }, security: {}, wallets: {}, observation: {}, sellability: {} },
      social: {},
      info: { website: 'javascript:alert(1)' },
      secondary: {
        status: 'COMPLETE', complete: true, checkedAt: 91, tokenAddress: 'secondary-secret-address', raw: 'secondary-secret-raw',
        sources: { dexScreener: { status: 'OK' }, goPlus: { status: 'OK' } },
        market: { complete: true, priceUsd: 1, marketCap: 50000, liquidityUsd: 12000, pairUrl: 'https://dexscreener.com/bsc/pair', websites: ['https://example.com'] },
        security: { complete: true, verdict: 'NO_FATAL_FLAGS', fatal: [], unknownFields: [], fields: { isHoneypot: false }, buyTax: 0.01, sellTax: 0.02 },
        conflicts: [], privateField: 'secondary-private-secret'
      }
    }]
  });
  const serialized = JSON.stringify(result);
  assert.equal(result.version, 2);
  assert.deepEqual(result.supportedChains, ['robinhood', 'sol']);
  assert.equal(result.auditQueueStats.total, 12);
  assert.equal(result.outcomeSummary.averageReturn5m, 0.12);
  assert.equal(result.outcomeSummary.completed24h, 1);
  assert.equal(result.outcomeSummary.minimumSample, 50);
  assert.equal(result.outcomeSummary.calibrationReady, false);
  assert.equal(result.outcomeSummary.averageReturn24h, 0.21);
  assert.equal(result.sourceHealth.discovery.trenches.message, 'GMGN数据请求超时。');
  assert.equal(result.sourceHealth.lastAudit.endpoints.security.message, 'GMGN数据请求暂时失败。');
  assert.equal(result.candidates[0].info.website, '');
  assert.equal(result.candidates[0].secondary.security.verdict, 'NO_FATAL_FLAGS');
  assert.equal(result.candidates[0].secondary.market.websites[0], 'https://example.com/');
  assert.equal(result.error, '数据请求暂时失败，下一轮将自动重试。');
  assert.doesNotMatch(serialized, /do-not-return|candidate-secret|queue-secret|outcome-secret|raw-secret|other-secret|secondary-secret|privateField|rawDiscovery|"auditQueue":|"outcomes":/);
});

test('health separates service liveness from scanner readiness and freshness', () => {
  const now = 1_800_000_000_000;
  const ready = healthSnapshot({ status: 'RUNNING', lastSuccessAt: now - 10_000 }, settings, now);
  assert.equal(ready.ok, true);
  assert.equal(ready.service, 'meme-radar');
  assert.equal(ready.ready, true);
  assert.equal(ready.scanner.fresh, true);

  const stale = healthSnapshot({ status: 'RUNNING', lastSuccessAt: now - 700_000 }, settings, now);
  assert.equal(stale.ok, true);
  assert.equal(stale.ready, false);
  assert.equal(stale.scanner.fresh, false);

  const failed = healthSnapshot({ status: 'ERROR', lastSuccessAt: now - 10_000 }, settings, now);
  assert.equal(failed.ready, false);
  assert.equal(failed.degraded, true);
  const paused = healthSnapshot({ status: 'HOURLY_BUDGET_PAUSED', lastSuccessAt: 0, generatedAt: now }, settings, now);
  assert.equal(paused.scanner.lastSuccessAt, 0);
  assert.equal(paused.scanner.fresh, false);
  assert.equal(paused.ready, false);
  assert.match(toPublicStatus({ status: 'HOURLY_BUDGET_PAUSED' }).error, /小时预算/);
});

function dispatch(server, { method = 'GET', pathName = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.method = method;
    req.url = pathName;
    req.headers = Object.fromEntries(Object.entries({ host: '127.0.0.1:3791', ...headers }).map(([key, value]) => [key.toLowerCase(), value]));
    req.socket = { remoteAddress: '127.0.0.1' };
    const response = { status: 0, headers: {}, body: '' };
    const res = {
      writeHead(status, responseHeaders) {
        response.status = status;
        response.headers = Object.fromEntries(Object.entries(responseHeaders).map(([key, value]) => [key.toLowerCase(), value]));
      },
      end(responseBody = '') {
        response.body = String(responseBody);
        resolve(response);
      }
    };
    Promise.resolve(server.listeners('request')[0](req, res)).catch(reject);
  });
}

test('AVE configuration is local-only, requires same-origin JSON and never opens trading routes', async () => {
  let calls = 0;
  const snapshot = { data: { configured: true }, trade: { configured: false }, executionReady: false };
  const server = createServer({ settings, state: { value: {} }, ave: { snapshot: () => snapshot, configure: async () => { calls++; return snapshot; }, remove: () => { calls++; return snapshot; } } });
  for (const pathName of ['/api/ave-configure', '/api/ave-remove']) {
    assert.equal((await dispatch(server, { method: 'POST', pathName, body: '{}' })).status, 403);
    assert.equal((await dispatch(server, { method: 'POST', pathName, headers: { origin: 'https://evil.invalid', 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await dispatch(server, { method: 'POST', pathName, headers: { origin: 'http://127.0.0.1:3791', 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  }
  assert.equal(calls, 0);
  const response = await dispatch(server, { method: 'POST', pathName: '/api/ave-configure', headers: { origin: 'http://127.0.0.1:3791', 'content-type': 'application/json' }, body: JSON.stringify({ key: 'fixture-not-real' }) });
  assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.equal(JSON.parse(response.body).ave.configured, true);
  assert.equal(JSON.parse(response.body).ave.executionReady, false);
  const trading = await dispatch(server, { method: 'POST', pathName: '/api/ave-submit', headers: { origin: 'http://127.0.0.1:3791' } });
  assert.equal(trading.status, 405);
});

test('HTTP handler enforces local boundary, strong CSP and only safe local configuration writes', async () => {
  let switchedTo = '';
  let savedKey = '';
  const state = { value: { status: 'RUNNING', generatedAt: Date.now(), candidates: [] } };
  const server = createServer({
    state,
    settings,
    supportedChains: ['sol', 'bsc', 'robinhood'],
    switchChain: async chain => {
      switchedTo = chain;
      return { activeChain: 'robinhood', pendingChain: chain, queued: true };
    },
    saveGmgnKey: async apiKey => {
      savedKey = apiKey;
      return { configured: true, verified: true };
    }
  });
  const page = await dispatch(server);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self' 'sha256-/);
  assert.match(page.headers['content-security-policy'], /object-src 'none'/);
  assert.doesNotMatch(page.headers['content-security-policy'], /unsafe-inline/);

  const navigationHeaders = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  const linkedPage = await dispatch(server, { headers: navigationHeaders });
  assert.equal(linkedPage.status, 200);
  assert.match(linkedPage.headers['content-type'], /text\/html/);
  assert.equal((await dispatch(server, { pathName: '/api/status', headers: navigationHeaders })).status, 403);
  assert.equal((await dispatch(server, { pathName: '/api/gmgn-key', method: 'POST', headers: navigationHeaders })).status, 403);
  assert.equal((await dispatch(server, { headers: { ...navigationHeaders, 'Sec-Fetch-Dest': 'iframe' } })).status, 403);
  assert.equal((await dispatch(server, { headers: { ...navigationHeaders, Origin: 'https://foreign.example' } })).status, 403);

  const foreign = await dispatch(server, { headers: { Host: 'attacker.example' } });
  assert.equal(foreign.status, 403);

  const switchResponse = await dispatch(server, {
    method: 'POST',
    pathName: '/api/active-chain',
    headers: {
      Origin: 'http://127.0.0.1:3791',
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ chain: 'sol' })
  });
  assert.equal(switchResponse.status, 202);
  assert.equal(switchedTo, 'sol');
  assert.deepEqual(JSON.parse(switchResponse.body), {
    accepted: true,
    requestedChain: 'sol',
    activeChain: 'robinhood',
    pendingChain: 'sol',
    queued: true
  });

  const key = `gmgn_${'c3'.repeat(16)}`;
  const keyResponse = await dispatch(server, {
    method: 'POST',
    pathName: '/api/gmgn-key',
    headers: {
      Origin: 'http://127.0.0.1:3791',
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ apiKey: key })
  });
  assert.equal(keyResponse.status, 200);
  assert.equal(savedKey, key);
  assert.deepEqual(JSON.parse(keyResponse.body), { accepted: true, configured: true, verified: true });
  assert.doesNotMatch(keyResponse.body, /gmgn_/);

  const missingOrigin = await dispatch(server, {
    method: 'POST',
    pathName: '/api/gmgn-key',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: key })
  });
  assert.equal(missingOrigin.status, 403);

  const invalidKey = await dispatch(server, {
    method: 'POST',
    pathName: '/api/gmgn-key',
    headers: { Origin: 'http://127.0.0.1:3791', 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'invalid' })
  });
  assert.equal(invalidKey.status, 400);
  assert.deepEqual(JSON.parse(invalidKey.body), { error: 'gmgn_key_request_rejected' });

  const extraField = await dispatch(server, {
    method: 'POST',
    pathName: '/api/gmgn-key',
    headers: { Origin: 'http://127.0.0.1:3791', 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: key, echo: true })
  });
  assert.equal(extraField.status, 400);

  const unsupported = await dispatch(server, {
    method: 'POST',
    pathName: '/api/active-chain',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain: 'unknown' })
  });
  assert.equal(unsupported.status, 422);

  const forbiddenWrite = await dispatch(server, {
    method: 'POST',
    pathName: '/api/status',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(forbiddenWrite.status, 405);
});

test('GMGN onboarding returns only a local public key and official creation URL', async () => {
  const publicKey = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA111111111111111111111111111111111111111=\n-----END PUBLIC KEY-----\n';
  let regenerate = null;
  const server = createServer({ state: { value: {} }, settings,
    getGmgnOnboarding: options => {
      regenerate = options.regenerate;
      return { algorithm: 'Ed25519', publicKey,
        createUrl: `https://gmgn.ai/ai/generateapi?pbk=${encodeURIComponent(publicKey)}` };
    }
  });
  const response = await dispatch(server, { method: 'POST', pathName: '/api/gmgn-onboarding',
    headers: { Origin: 'http://127.0.0.1:3791', 'Content-Type': 'application/json' },
    body: JSON.stringify({ regenerate: true })
  });
  assert.equal(response.status, 200);
  assert.equal(regenerate, true);
  const result = JSON.parse(response.body);
  assert.equal(result.publicKey, publicKey);
  assert.equal(result.createUrl.startsWith('https://gmgn.ai/ai/generateapi?pbk='), true);
  assert.equal(response.body.includes('PRIVATE KEY'), false);
  assert.equal((await dispatch(server, { method: 'POST', pathName: '/api/gmgn-onboarding',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regenerate: false }) })).status, 403);
  assert.equal((await dispatch(server, { method: 'POST', pathName: '/api/gmgn-onboarding',
    headers: { Origin: 'http://127.0.0.1:3791', 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
});

test('key verification errors are allowlisted and never expose upstream messages', async () => {
  const cases = [
    ['GMGN_AUTH_FAILED', 401, 'gmgn_auth_failed'],
    ['GMGN_PERMISSION_DENIED', 403, 'gmgn_permission_denied'],
    ['GMGN_RATE_LIMITED', 429, 'gmgn_rate_limited'],
    ['GMGN_CHECK_BUSY', 409, 'gmgn_check_busy'],
    ['GMGN_TIMEOUT', 504, 'gmgn_timeout'],
    ['GMGN_NETWORK_ERROR', 502, 'gmgn_network_error'],
    ['GMGN_DEPENDENCY_MISSING', 503, 'gmgn_dependency_missing'],
    ['UNEXPECTED', 500, 'gmgn_key_request_rejected']
  ];
  for (const [code, status, expected] of cases) {
    const server = createServer({ state: { value: {} }, settings,
      saveGmgnKey: async () => { throw Object.assign(new Error('upstream-secret-must-not-appear'), { code }); }
    });
    const response = await dispatch(server, { method: 'POST', pathName: '/api/gmgn-key',
      headers: { Origin: 'http://127.0.0.1:3791', 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: `gmgn_${'a'.repeat(32)}` })
    });
    assert.equal(response.status, status);
    const result = JSON.parse(response.body);
    assert.equal(result.error, expected);
    if (code === 'GMGN_RATE_LIMITED') assert.equal(result.retryAfterSeconds, 30);
    else assert.deepEqual(result, { error: expected });
  }
});

test('connection status exposes only readiness and saving alone cannot be reported as verified', async () => {
  const server = createServer({ state: { value: {} }, settings,
    getGmgnConnection: () => ({ configured: true, status: 'VERIFIED', apiKey: 'must-not-leak' }),
    saveGmgnKey: async () => ({ configured: true })
  });
  const response = await dispatch(server, { pathName: '/api/status' });
  assert.deepEqual(JSON.parse(response.body).gmgnConnection, { configured: true, status: 'VERIFIED' });
  assert.equal(response.body.includes('must-not-leak'), false);
  const unverified = await dispatch(server, { method: 'POST', pathName: '/api/gmgn-key',
    headers: { Origin: 'http://127.0.0.1:3791', 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: `gmgn_${'a'.repeat(32)}` })
  });
  assert.equal(unverified.status, 502);
});
