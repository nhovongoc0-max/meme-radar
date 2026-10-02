import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
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
        trenches: { ok: false, code: 'TIMEOUT', message: 'raw-secret-message' },
        trending: { ok: true, count: 9 }
      },
      lastAudit: {
        complete: false,
        checkedAt: 89,
        endpoints: { info: { ok: true }, security: { ok: false, code: 'READ_FAILED', message: 'other-secret-message' } }
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
  assert.equal(result.sourceHealth.discovery.trenches.message, '数据源请求超时。');
  assert.equal(result.sourceHealth.lastAudit.endpoints.security.message, '数据源请求暂时失败。');
  assert.equal(result.candidates[0].info.website, '');
  assert.equal(result.candidates[0].secondary.security.verdict, 'NO_FATAL_FLAGS');
  assert.equal(result.candidates[0].secondary.market.websites[0], 'https://example.com/');
  assert.equal(result.error, '数据请求暂时失败，下一轮将自动重试。');
  assert.doesNotMatch(serialized, /do-not-return|candidate-secret|queue-secret|outcome-secret|raw-secret|other-secret|secondary-secret|privateField|rawDiscovery|"auditQueue":|"outcomes":/);
});

test('public failure events preserve only explicit allowlisted causes and never infer legacy error codes', () => {
  const at = 1_800_000_000_000, raw = 'private_fixture https://invalid.example/path?key=fixture_key Authorization: Bearer fixture_key';
  const cases = [
    ['BUDGET_PAUSED', 'AVE_BUDGET', /每日|预算/], ['HOURLY_BUDGET_PAUSED', 'AVE_HOURLY_BUDGET', /小时|预算/],
    ['TOTAL_BUDGET_PAUSED', 'AVE_TOTAL_BUDGET', /累计|预算/], ['QUOTA_PAUSED', 'AVE_QUOTA', /配额/],
    ['AUTH', 'AVE_AUTH', /凭证|权限/], ['RATE_LIMITED', 'AVE_RATE_LIMITED', /请求受限|冷却/],
    ['TIMEOUT', 'AVE_TIMEOUT', /超时/], ['NETWORK', 'AVE_NETWORK', /连接失败/], ['ERROR', 'AVE_SCHEMA', /格式|身份/]
  ];
  const events = cases.map(([type, code]) => ({ at, type, code, stage: 'discovery', chain: 'bsc', message: raw, headers: { authorization: raw }, url: raw }));
  events.push({ at, type: 'AUDIT_RETRY', code: raw, stage: raw, chain: 'bsc', message: raw });
  events.push({ at, type: 'ERROR', chain: 'bsc', message: 'AVE_RATE_LIMITED old text has no structured proof' });
  events.push({ at, type: 'ERROR', code: 'AVE_TIMEOUT', stage: 'audit', chain: 'bsc', message: raw });
  const output = toPublicStatus({ events }).events;
  for (let index = 0; index < cases.length; index++) {
    const [type, code, pattern] = cases[index];
    assert.equal(output[index].type, type); assert.equal(output[index].code, code);
    assert.equal(output[index].stage, 'discovery'); assert.match(output[index].message, pattern);
    if (type.includes('BUDGET') || type === 'QUOTA_PAUSED') assert.doesNotMatch(output[index].message, /网络|连接失败|超时/);
  }
  assert.equal(output.at(-3).code, null); assert.equal(output.at(-3).stage, null);
  assert.equal(output.at(-2).type, 'ERROR'); assert.equal(output.at(-2).code, null); assert.equal(output.at(-2).stage, null);
  assert.match(output.at(-2).message, /未分类/);
  assert.equal(output.at(-1).code, 'AVE_TIMEOUT'); assert.match(output.at(-1).message, /^深审：.*超时/);
  assert.doesNotMatch(JSON.stringify(output), /private_fixture|fixture_key|invalid\.example|Authorization|headers|https?:/);
  assert.equal(events.at(-2).code, undefined, 'projection must not mutate or backfill a historical record');
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
    const res = Object.assign(new EventEmitter(), {
      writeHead(status, responseHeaders) {
        response.status = status;
        response.headers = Object.fromEntries(Object.entries(responseHeaders).map(([key, value]) => [key.toLowerCase(), value]));
      },
      end(responseBody = '') {
        response.body = String(responseBody);
        resolve(response);
      }
    });
    Promise.resolve(server.listeners('request')[0](req, res)).catch(reject);
  });
}

test('public request diagnostics preserve schema failures even with HTTP 200 and redact nonallowlisted fields', async () => {
  const raw = 'private_fixture https://invalid.example/?key=fixture_key';
  const server = createServer({ settings, state: { value: { activeChain: 'bsc', status: 'RUNNING', candidates: [] } },
    getMarketStatus: () => ({ transport: { recent: [
      { at: 1_800_000_000_000, endpoint: 'trending', chain: 'bsc', category: 'schema', httpStatus: 200,
        code: 'AVE_SCHEMA', message: raw, headers: { authorization: raw }, url: raw, raw },
      { at: 1_800_000_000_001, endpoint: raw, chain: raw, category: raw, httpStatus: 500 }
    ] } }) });
  const response = await dispatch(server, { pathName: '/api/status' });
  assert.equal(response.status, 200);
  const recent = JSON.parse(response.body).aveMarket.transport.recent;
  assert.equal(recent[0].category, 'schema'); assert.equal(recent[0].httpStatus, 200);
  assert.equal(recent[1].category, 'unknown'); assert.equal(recent[1].endpoint, 'unknown'); assert.equal(recent[1].chain, '');
  assert.doesNotMatch(JSON.stringify(recent), /private_fixture|fixture_key|invalid\.example|authorization|headers|https?:|"raw"/);
});

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

test('inline CSP hashes follow the parser newline normalization on a CRLF checkout', async () => {
  // The HTML parser normalizes CRLF and lone CR to LF before the browser hashes
  // inline content. Git for Windows defaults to core.autocrlf=true, so a checkout
  // stores these blocks with CRLF; hashing the raw file would advertise hashes the
  // browser never computes, and every inline style and script would be blocked.
  const style = 'body { color: #fff; }\n.card { margin: 0; }\n';
  const script = 'const ready = true;\n';
  const crlf = value => value.replace(/\n/g, '\r\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-crlf-'));
  fs.writeFileSync(path.join(dir, 'index.html'),
    '<!doctype html>\r\n<html><head>\r\n<style>' + crlf(style) + '</style>\r\n'
    + '<script>' + crlf(script) + '</script>\r\n</head><body></body></html>\r\n');
  try {
    const server = createServer({
      settings: { ...settings, publicDir: dir },
      state: { value: { status: 'RUNNING', generatedAt: Date.now(), candidates: [] } }
    });
    const page = await dispatch(server);
    assert.equal(page.status, 200);
    const policy = page.headers['content-security-policy'];
    const digest = value => `'sha256-${crypto.createHash('sha256').update(value).digest('base64')}'`;
    assert.ok(policy.includes(digest(style)), `style hash missing from CSP: ${policy}`);
    assert.ok(policy.includes(digest(script)), `script hash missing from CSP: ${policy}`);
    assert.ok(!policy.includes(digest(crlf(style))), 'the CRLF hash must never be advertised');
    assert.ok(!policy.includes(digest(crlf(script))), 'the CRLF hash must never be advertised');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP handler enforces local boundary, strong CSP and only safe local configuration writes', async () => {
  let switchedTo = '';
  const state = { value: { status: 'RUNNING', generatedAt: Date.now(), candidates: [] } };
  const server = createServer({
    state,
    settings,
    supportedChains: ['sol', 'bsc', 'robinhood'],
    switchChain: async chain => {
      switchedTo = chain;
      return { activeChain: 'robinhood', pendingChain: chain, queued: true };
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
  assert.equal((await dispatch(server, { pathName: '/api/ave-configure', method: 'POST', headers: navigationHeaders })).status, 403);
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
