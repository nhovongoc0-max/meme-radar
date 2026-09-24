import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('let aveBusy'), end = html.indexOf('async function refresh()', start);
assert.ok(start >= 0 && end > start, 'AVE key flow must exist');
const source = html.slice(start, end);

test('AVE Key form waits for Data verification, blocks duplicate submission and clears secrets on every result', async () => {
  for (const item of [
    { ok: true, body: { ave: { configured: true, data: { configured: true, status: 'connected' } } }, badge: 'aveChecked', refreshes: 1 },
    { ok: false, body: { error: 'AVE_AUTH', ave: { configured: true, data: { configured: true, status: 'error' } } }, badge: 'aveFailed', refreshes: 0, error: 'AVE_AUTH' },
    { ok: false, body: { error: 'AVE_RATE_LIMIT', ave: { configured: false, data: { status: 'error' } } }, badge: 'aveFailed', refreshes: 0, error: 'AVE_RATE_LIMIT' },
    { ok: false, body: { error: '<script>raw-private-fixture</script>', ave: { configured: false, data: { status: 'error' } } }, badge: 'aveFailed', refreshes: 0, error: 'AVE_REQUEST' },
    { network: true, badge: '', refreshes: 0, error: 'AVE_CONNECT' },
  ]) {
    const key = 'private-fixture-api-key';
    const ids = ['ave-api-key', 'ave-config-status', 'ave-data-status', 'aveSummary', 'aveSettings'];
    const elements = Object.fromEntries(ids.map(id => [id, { value: id === 'ave-api-key' ? key : '', dataset: {}, textContent: '', open: false }]));
    const buttons = [{ disabled: false }, { disabled: false }];
    let refreshes = 0, calls = 0, finish;
    const context = vm.createContext({
      byId: id => elements[id], t: key => key, AbortSignal,
      document: { querySelectorAll: selector => { assert.equal(selector, '.ave-settings button'); return buttons; } },
      fetch: async (url, request) => {
        calls++; assert.equal(url, '/api/ave-configure'); assert.equal(request.method, 'POST');
        assert.equal(request.headers['Content-Type'], 'application/json'); assert.deepEqual(JSON.parse(request.body), { key });
        return new Promise((resolve, reject) => { finish = () => item.network ? reject(new Error(key))
          : resolve({ ok: item.ok, json: async () => item.body }); });
      }, refresh: async () => { refreshes++; },
    });
    vm.runInContext(source, context);
    const pending = context.changeAve('configure');
    assert.equal(elements['ave-config-status'].textContent, 'aveChecking');
    assert.ok(buttons.every(button => button.disabled));
    assert.notEqual(elements['ave-data-status'].textContent, 'aveChecked');
    await context.changeAve('configure'); assert.equal(calls, 1);
    finish(); await pending;
    assert.equal(elements['ave-api-key'].value, ''); assert.ok(buttons.every(button => !button.disabled));
    assert.equal(elements['ave-data-status'].textContent, item.badge); assert.equal(refreshes, item.refreshes);
    if (item.error) assert.equal(elements['ave-config-status'].textContent, 'aveFailed · ' + item.error);
    assert.doesNotMatch(JSON.stringify(elements), /private-fixture-api-key|raw-private-fixture|<script>/);
  }
});

test('AVE remove never resubmits the typed key and the flow never persists credentials in browser storage', async () => {
  const elements = Object.fromEntries(['ave-api-key', 'ave-config-status', 'ave-data-status', 'aveSummary', 'aveSettings']
    .map(id => [id, { value: 'unsaved-private-fixture', dataset: {}, textContent: '' }]));
  const context = vm.createContext({ byId: id => elements[id], t: key => key, AbortSignal,
    document: { querySelectorAll: () => [] }, refresh: async () => {},
    fetch: async (url, request) => { assert.equal(url, '/api/ave-remove'); assert.deepEqual(JSON.parse(request.body), {});
      return { ok: true, json: async () => ({ ave: { configured: false, data: { configured: false, status: 'untested' } } }) }; } });
  vm.runInContext(source, context); await context.changeAve('remove');
  assert.equal(elements['ave-api-key'].value, ''); assert.equal(elements['aveSettings'].open, true);
  assert.equal(elements['aveSummary'].textContent, ' · aveUnconfigured');
  assert.doesNotMatch(source, /localStorage|sessionStorage|readStorage|writeStorage|console\.|innerHTML|signTransaction|\/api\/gmgn/);
});
