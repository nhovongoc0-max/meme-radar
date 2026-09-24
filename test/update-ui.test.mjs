import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/update-ui.mjs', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const status = (phase = 'idle', extra = {}) => ({ update: { phase, code: null, currentVersion: '0.1.8', availableVersion: phase === 'available' ? '0.1.9' : null, canInstall: phase === 'available', restartRequired: phase === 'handoff', ...extra } });
function harness() {
  const elements = new Map(), events = {}, requests = [], timers = new Map(); let timerId = 0;
  const el = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', dataset: {}, listeners: {}, hidden: false, disabled: false, open: false,
      set innerHTML(_) { throw new Error('Updater must use textContent only'); },
      addEventListener(type, fn) { this.listeners[type] = fn; }, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  const context = { document: { getElementById: el, documentElement: { lang: 'en' } }, window: { addEventListener: (name, callback) => { events[name] = callback; } }, AbortController,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch(path, options) { return new Promise((resolve, reject) => { requests.push({ path, options, done: false,
      reply(body, ok = true) { this.done = true; resolve({ ok, json: async () => body }); },
      fail() { this.done = true; reject(new Error('private-network-detail')); } }); }); } };
  vm.runInNewContext(source, context);
  const next = () => requests.find(row => !row.done);
  return { el, events, requests, timers, context,
    async reply(body, ok = true, request = next()) { assert.ok(request, 'expected a pending request'); request.reply(body, ok); await flush(); },
    async fail(request = next()) { assert.ok(request); request.fail(); await flush(); },
    async click(id) { if (!el(id).disabled) el(id).listeners.click(); await flush(); },
    async fire(delay) { const entry = [...timers].find(([, value]) => value.delay === delay); assert.ok(entry, `timer ${delay} should exist`); timers.delete(entry[0]); entry[1].fn(); await flush(); },
    get next() { return next(); }, get message() { return el('updateMessage').textContent; }, get mode() { return el('updateInstall').dataset.mode; },
    get installRequests() { return requests.filter(row => row.path === '/api/update-install'); },
  };
}
async function offered(h, value = status('available')) {
  await h.reply(status());
  await h.click('updateButton'); assert.equal(h.el('updateDialog').open, true);
  assert.equal(h.next.path, '/api/update-status'); await h.reply(status());
  assert.equal(h.next.path, '/api/update-check'); assert.equal(h.next.options.body, '{}'); await h.reply(value);
}

test('boot is read-only, checking never installs, and explicit confirmation binds the displayed target', async () => {
  const h = harness(); assert.equal(h.requests.length, 1); assert.equal(h.next.path, '/api/update-status');
  assert.equal(h.el('updateDialog').open, false);
  await offered(h);
  assert.equal(h.mode, 'install'); assert.match(h.el('updateVersion').textContent, /0\.1\.8.*0\.1\.9/); assert.equal(h.installRequests.length, 0);
  await h.click('updateInstall'); await h.click('updateInstall');
  assert.equal(h.installRequests.length, 1);
  assert.deepEqual(JSON.parse(h.installRequests[0].options.body), { version: '0.1.9', confirm: 'INSTALL_UPDATE' });
  assert.equal(h.installRequests[0].options.credentials, 'same-origin');
  assert.equal(h.installRequests[0].options.redirect, 'error');
  assert.equal(h.el('updateInstall').disabled, true);
  await h.reply(status('handoff', { availableVersion: '0.1.9' }));
  assert.match(h.message, /restart/); assert.equal(h.mode, 'status');
  await h.fire(3000); assert.equal(h.next.path, '/api/update-status');
  await h.reply(status('complete', { currentVersion: '0.1.9', availableVersion: '0.1.9' }));
  assert.equal(h.next.path, '/health'); assert.doesNotMatch(h.message, /Update complete;/);
  await h.reply({ ok: true, service: 'meme-radar', execution: false, version: '0.1.9', ready: false });
  assert.match(h.message, /Update complete;.*scanner status/); assert.equal(h.installRequests.length, 1); assert.equal(h.timers.size, 0);
});

test('local unpublished builds remain protected and equal, older, malformed or unauthorized targets cannot install', async () => {
  for (const value of [status('blocked', { code: 'UPDATE_LOCAL', canInstall: true, availableVersion: '0.1.9' }),
    status('current'), status('available', { availableVersion: '0.1.8' }), status('available', { availableVersion: '0.1.7' }),
    status('available', { availableVersion: '<img src=x>', message: '<script>bad</script>', code: 'secret-token' }),
    status('available', { canInstall: false }), status('available', { currentVersion: null })]) {
    const h = harness(); await offered(h, value);
    assert.notEqual(h.mode, 'install'); assert.equal(h.installRequests.length, 0);
    assert.doesNotMatch(h.message + h.el('updateVersion').textContent, /<img|<script|secret-token/);
    if (value.update.code === 'UPDATE_LOCAL') assert.match(h.message, /protected.*overwrite/);
    if (value.update.phase === 'current') assert.match(h.message, /not be downgraded or reinstalled/);
    if (['0.1.8', '0.1.7'].includes(value.update.availableVersion)) {
      assert.match(h.message, /No newer stable/); assert.doesNotMatch(h.message, /Update found/);
    }
  }
});

test('check failures remain retryable and stale offered versions never re-enable confirmation after failed check', async () => {
  const h = harness(); await h.reply(status()); await h.click('updateButton'); await h.reply(status('available'));
  assert.equal(h.next.path, '/api/update-check'); await h.fail();
  assert.match(h.message, /Retry the check/); assert.equal(h.mode, 'check'); assert.equal(h.el('updateInstall').disabled, false);
  await h.click('updateInstall'); assert.equal(h.next.path, '/api/update-status'); await h.reply(status());
  assert.equal(h.next.path, '/api/update-check'); await h.reply(status('current'));
  assert.match(h.message, /No newer stable/); assert.equal(h.installRequests.length, 0);
});

test('an install timeout becomes status reconciliation and never retries POST even if old available status is returned', async () => {
  const h = harness(); await offered(h); await h.click('updateInstall');
  const lost = h.installRequests[0]; await h.fire(25000);
  assert.equal(lost.options.signal.aborted, true); assert.equal(h.mode, 'status'); assert.match(h.message, /without resending/);
  await h.click('updateInstall'); const recovery = h.requests.at(-1); assert.equal(recovery.path, '/api/update-status');
  await h.reply(status('available'), true, recovery);
  assert.equal(h.mode, 'status'); assert.equal(h.installRequests.length, 1);
  lost.reply(status('handoff', { availableVersion: '0.1.9' })); await flush();
  assert.match(h.message, /without resending/, 'a late timed-out response cannot overwrite the reconciled UI');
  await h.fire(3000); await h.reply(status('verifying', { availableVersion: '0.1.9' }));
  assert.match(h.message, /verifying/i); assert.equal(h.installRequests.length, 1);
});

test('restart disconnect and mismatched health cannot falsely report completion; status retries recover', async () => {
  const h = harness(); await offered(h); await h.click('updateInstall'); await h.fail();
  await h.fire(6000); await h.fail(); assert.equal(h.mode, 'status'); assert.equal(h.installRequests.length, 1);
  await h.click('updateInstall'); await h.reply(status('complete', { currentVersion: '0.1.9', availableVersion: '0.1.9' }));
  await h.reply({ ok: true, service: 'meme-radar', execution: false, version: '0.1.8' });
  assert.doesNotMatch(h.message, /Update complete;/); assert.equal(h.mode, 'status');
  await h.click('updateInstall'); await h.reply(status('complete', { currentVersion: '0.1.9', availableVersion: '0.1.9' }));
  await h.reply({ ok: true, service: 'meme-radar', execution: false, version: '0.1.9' });
  assert.match(h.message, /Update complete;/); assert.equal(h.installRequests.length, 1);
});

test('another tab installing blocks fresh release checks, and rollback is shown only after original service health', async () => {
  const h = harness(); await h.reply(status()); await h.click('updateButton');
  await h.reply(status('verifying', { availableVersion: '0.1.9' }));
  assert.equal(h.requests.filter(row => row.path === '/api/update-check').length, 0); assert.equal(h.mode, 'status');
  await h.fire(3000); await h.reply(status('rolled_back', { availableVersion: '0.1.9' }));
  assert.equal(h.next.path, '/health'); await h.reply({ ok: true, service: 'meme-radar', execution: false, version: '0.1.8' });
  assert.match(h.message, /restored original version is verified/); assert.equal(h.timers.size, 0); assert.equal(h.installRequests.length, 0);
});

test('locale events repaint dynamic states and lifecycle ignores late replies without installing on restore', async () => {
  const h = harness(); await h.reply(status('blocked', { code: 'UPDATE_LOCAL' }));
  for (const lang of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'ar']) {
    h.events['radar-locale']({ detail: lang }); assert.ok(h.message.length > 20); assert.doesNotMatch(h.message, /undefined/);
  }
  h.events['radar-locale']({ detail: 'en' });
  await h.click('updateButton'); const late = h.next; h.events.pagehide(); assert.equal(late.options.signal.aborted, true);
  h.events.pageshow({ persisted: true }); await flush(); const restored = h.requests.at(-1);
  assert.equal(restored.path, '/api/update-status'); await h.reply(status('current'), true, restored);
  late.reply(status('available')); await flush();
  assert.match(h.message, /No newer stable/); assert.equal(h.mode, 'check'); assert.equal(h.installRequests.length, 0);
  await h.click('updateClose'); assert.equal(h.el('updateDialog').open, false);
});

test('module uses a fixed same-origin endpoint set, text-only rendering and no persistent client storage', () => {
  assert.doesNotMatch(source, /innerHTML|outerHTML|localStorage|sessionStorage|location\.(?:href|replace|assign)|window\.open/);
  assert.deepEqual([...new Set([...source.matchAll(/request\('([^']+)'/g)].map(match => match[1]))].sort(), ['/api/update-check', '/api/update-install', '/api/update-status', '/health']);
  const block = source.slice(source.indexOf('const copy = {'), source.indexOf('const phases ='));
  const context = {}; vm.runInNewContext(block + ';this.copy = copy;', context);
  for (const [key, values] of Object.entries(context.copy)) assert.equal(values.length, 6, key);
});
