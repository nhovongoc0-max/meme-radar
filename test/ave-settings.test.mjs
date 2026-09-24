import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAveSettings, AVE_CHECKS } from "../src/ave-settings.mjs";

const dataBody = { status: 1, data: { token: { chain: 'bsc', current_price_usd: '500' } } };
const tradeBody = { status: 200, data: [{ chain: 'bsc', high: '3', average: '2', low: '1' }] };
function fixture(legacy) {
  const directory = mkdtempSync(join(tmpdir(), 'radar-ave-test-'));
  if (legacy) writeFileSync(join(directory, 'ave-credentials.json'), JSON.stringify(legacy));
  let clock = 1000, replies = {};
  const calls = [], pauses = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const kind = url === AVE_CHECKS.data.url ? 'data' : 'trade';
    const [body, http] = replies[kind] || [kind === 'data' ? dataBody : tradeBody, 200];
    return new Response(JSON.stringify(body), { status: http });
  };
  const settings = createAveSettings({ directory, fetchImpl, now: () => clock, pause: async ms => { pauses.push(ms); } });
  return { directory, settings, calls, pauses, fetchImpl, next(value = {}) { clock += 61000; replies = value; },
    close() { rmSync(directory, { recursive: true, force: true }); } };
}
test('one AVE key reaches only the fixed Data GET; never becomes execution-ready', async () => {
  const f = fixture();
  try {
    const state = await f.settings.configure({ key: 'one-fixture-key' });
    assert.equal(state.configured, true); assert.equal(state.data.status, 'connected'); assert.equal(state.trade.status, 'disabled');
    assert.equal(state.executionReady, false);
    assert.deepEqual(f.calls.map(c => c.url), [AVE_CHECKS.data.url]);
    assert.deepEqual(Object.keys(AVE_CHECKS), ['data']);
    assert.deepEqual(f.pauses, []);
    for (const call of f.calls) { assert.equal(call.options.method, 'GET'); assert.equal(call.options.body, undefined); assert.equal(call.options.redirect, 'error'); }
    assert.equal(f.calls[0].options.headers['X-API-KEY'], 'one-fixture-key');
    assert.equal(f.settings.getKey(), 'one-fixture-key');
    assert.doesNotMatch(JSON.stringify(state), /one-fixture-key|privateKey/);
    const file = join(f.directory, 'ave-credentials.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file)), { schema: 2, key: 'one-fixture-key' });
    const reboot = createAveSettings({ directory: f.directory, fetchImpl: f.fetchImpl });
    assert.equal(reboot.snapshot().configured, true); assert.equal(reboot.snapshot().data.status, 'untested');
  } finally { f.close(); }
});
test('trade access cannot rescue failed Data verification or replace a saved key', async () => {
  const f = fixture();
  try {
    f.next({ trade: [{ error: 'fixture-secret' }, 403] });
    const state = await f.settings.configure({ key: 'partial-fixture' });
    assert.equal(state.configured, true); assert.equal(state.data.status, 'connected');
    assert.equal(state.trade.status, 'disabled'); assert.equal(state.executionReady, false);
    f.next({ data: [{ status: 0 }, 200] });
    await assert.rejects(f.settings.configure({ key: 'replacement-fixture' }), { code: 'AVE_SCHEMA' });
    assert.equal(f.calls.length, 2);
    assert.equal(f.settings.snapshot().data.status, 'connected');
    assert.equal(JSON.parse(readFileSync(join(f.directory, 'ave-credentials.json'))).key, 'partial-fixture');
  } finally { f.close(); }
});
test('failed replacements preserve saved key; retest uses saved key; removal clears both capabilities', async () => {
  const f = fixture();
  try {
    await f.settings.configure({ key: 'original-fixture' });
    const file = join(f.directory, 'ave-credentials.json'), saved = readFileSync(file, 'utf8');
    for (const [reply, http] of [[{ status: 0, msg: 'new-secret-fixture' }, 200], [{ error: 'new-secret-fixture' }, 401],
      [{ status: 1, data: { token: { chain: 'eth', current_price_usd: '1' } } }, 200]]) {
      f.next({ data: [reply, http], trade: [reply, http] });
      await assert.rejects(f.settings.configure({ key: 'new-secret-fixture' }), e => !e.message.includes('new-secret-fixture'));
      assert.equal(readFileSync(file, 'utf8'), saved);
      assert.equal(f.settings.snapshot().data.status, 'connected'); // old key, not failed replacement
    }
    f.next({ data: [{}, 401], trade: [{}, 401] });
    await assert.rejects(f.settings.configure({ key: '' }), { code: 'AVE_AUTH' });
    assert.equal(f.settings.snapshot().data.status, 'error'); assert.equal(f.settings.snapshot().trade.status, 'disabled');
    f.next(); await f.settings.configure({ key: '' });
    assert.equal(f.calls.at(-1).options.headers['X-API-KEY'], 'original-fixture');
    f.settings.remove({});
    assert.equal(f.settings.snapshot().configured, false); assert.equal(f.settings.snapshot().trade.configured, false);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /original-fixture/);
  } finally { f.close(); }
});
test('rate limit enforces cooldown without automatic retries or trade requests', async () => {
  const f = fixture();
  try {
    f.next({ data: [{}, 429] });
    await assert.rejects(f.settings.configure({ key: 'limited-fixture' }), { code: 'AVE_RATE_LIMIT' });
    assert.equal(f.calls.length, 1); assert.equal(f.pauses.length, 0);
    await assert.rejects(f.settings.configure({ key: 'limited-fixture' }), { code: 'AVE_COOLDOWN' });
    f.next({ trade: [{}, 429] });
    const state = await f.settings.configure({ key: 'limited-fixture' });
    assert.equal(state.data.status, 'connected'); assert.equal(state.trade.status, 'disabled');
    await assert.rejects(f.settings.configure({ key: '' }), { code: 'AVE_COOLDOWN' });
  } finally { f.close(); }
});
test('legacy one-sided/identical keys migrate safely; conflicting keys require reentry without modifying file', async () => {
  for (const keys of [{ data: 'legacy-fixture' }, { trade: 'legacy-fixture' }, { data: 'legacy-fixture', trade: 'legacy-fixture' }]) {
    const f = fixture({ schema: 1, keys });
    try {
      const file = join(f.directory, 'ave-credentials.json');
      assert.equal(JSON.parse(readFileSync(file)).schema, 1); assert.equal(f.settings.snapshot().configured, true);
      await f.settings.configure({});
      assert.equal(JSON.parse(readFileSync(file)).schema, 2);
      assert.equal(f.calls[0].options.headers['X-API-KEY'], 'legacy-fixture');
      assert.equal(f.calls.length, 1);
    } finally { f.close(); }
  }
  const f = fixture({ schema: 1, keys: { data: 'old-data-fixture', trade: 'old-trade-fixture' } });
  try {
    const file = join(f.directory, 'ave-credentials.json'), before = readFileSync(file, 'utf8');
    assert.equal(f.settings.snapshot().requiresReentry, true); assert.equal(f.settings.snapshot().hasStoredKey, true);
    assert.equal(f.settings.snapshot().configured, false);
    await assert.rejects(f.settings.configure({ key: '' }), { code: 'AVE_KEY' });
    assert.equal(f.calls.length, 0); assert.equal(readFileSync(file, 'utf8'), before);
    const result = await f.settings.configure({ key: 'chosen-fixture' });
    assert.equal(result.requiresReentry, false); assert.equal(result.configured, true);
    assert.deepEqual(JSON.parse(readFileSync(file)), { schema: 2, key: 'chosen-fixture' });
  } finally { f.close(); }
});
test('old split format, extra fields, header injection, revoked authority and corrupt configuration fail closed', async () => {
  const f = fixture();
  try {
    for (const input of [{ kind: 'data', key: 'valid-key-fixture' }, { key: 'valid-key-fixture', url: 'https://evil.invalid' },
      { key: 'foo\nsecret' }, { key: '' }, null]) await assert.rejects(f.settings.configure(input));
    assert.equal(f.calls.length, 0);
    await f.settings.configure({ key: 'original-fixture' });
    const file = join(f.directory, 'ave-credentials.json'), saved = readFileSync(file, 'utf8');
    f.next();
    let checks = 0;
    await assert.rejects(f.settings.configure({ key: 'replacement-fixture' }, () => { if (++checks === 3) throw new Error('revoked'); }));
    assert.equal(readFileSync(file, 'utf8'), saved);
    assert.throws(() => f.settings.remove({ kind: 'data' }));
    writeFileSync(file, '{broken');
    assert.throws(() => createAveSettings({ directory: f.directory }), /原文件保留/);
    assert.equal(readFileSync(file, 'utf8'), '{broken');
  } finally { f.close(); }
});
