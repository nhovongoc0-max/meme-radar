import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { LeadSignals, publicLeadSignal } from '../src/lead-signals.mjs';
import { LiveDiscovery } from '../src/live-discovery.mjs';
import { observationVoiceSnapshot } from '../src/server.mjs';
import { VoiceAlerts, voiceKey, voiceEligible } from '../public/voice-alerts.mjs';

const AT = Date.now() - 600_000, CA = '0x' + '1'.repeat(40), POOL = '0x' + '2'.repeat(40);
const row = (at, overrides = {}) => ({ chain: 'bsc', address: CA, pairAddress: POOL,
  marketProvider: 'AVE', observationProvider: 'AVE', price: 1, liquidity: 10_000, volume5m: 2000,
  auditEligible: true, stale: false, discoveryState: 'READY', capturedAt: at, sourceUpdatedAt: at,
  expiresAt: at + 60_000, qualifiedAt: AT, firstSeenAt: AT, ...overrides });
function observe(tracker, at, changes = {}) {
  const input = row(at, changes);
  return tracker.observe([input], [input], input.chain, at)[0];
}
function confirmed(tracker, at = AT) {
  observe(tracker, at);
  observe(tracker, at + 150_000, { price: 1.02, volume5m: 2200, liquidity: 10_500 });
  return observe(tracker, at + 300_000, { price: 1.04, volume5m: 2500, liquidity: 11_100 });
}
test('sustained activity needs distinct same-pool quotes across five minutes; reasons are capped at two', () => {
  const tracker = new LeadSignals();
  const first = observe(tracker, AT);
  assert.deepEqual(first.reasonCodes, ['ACTIVE_VOLUME', 'NEW_LEAD']); assert.equal(first.momentum, null);
  const next = observe(tracker, AT + 150_000, { price: 1.02, volume5m: 2200, liquidity: 10_500 });
  assert.equal(next.momentum, null);
  const active = observe(tracker, AT + 300_000, { price: 1.04, volume5m: 2500, liquidity: 11_100 });
  assert.equal(active.momentum.state, 'ACTIVE'); assert.equal(active.momentum.samples, 3);
  assert.equal(active.momentum.spanMs, 300_000);
  assert.deepEqual(active.reasonCodes, ['LIQUIDITY_RISING', 'ACTIVE_VOLUME']);
  assert.equal(active.hasUnknownRisk, undefined, 'does not manufacture a safety verdict');
});
test('cache polls, re-stamped identical payloads and rapid ticks never count as continuous confirmation', () => {
  for (const mode of ['cache', 'identical', 'rapid']) {
    const tracker = new LeadSignals(); let last;
    for (let i = 0; i < 20; i++) {
      const at = mode === 'cache' ? AT : AT + i * (mode === 'rapid' ? 5000 : 60_000);
      last = observe(tracker, at, mode === 'rapid' ? { price: 1 + i / 1000 } : {});
    }
    assert.equal(last.momentum, null, mode);
  }
});
test('expiry between five-minute free scans does not erase history, and conflicting same-time quotes cannot upgrade', () => {
  const tracker = new LeadSignals();
  const first = observe(tracker, AT);
  tracker.observe([first], [{ ...first, stale: true, auditEligible: false }], 'bsc', AT + 61_000);
  observe(tracker, AT + 300_000, { price: 1.01 });
  assert.equal(observe(tracker, AT + 600_000, { price: 1.04 }).momentum.state, 'ACTIVE');
  assert.equal(observe(tracker, AT + 600_000, { price: 1.08 }).momentum, null);
  assert.equal(tracker.history.size, 0);
});
test('pool/source switches are isolated, and unknown pools never acquire upgraded status', () => {
  for (const change of [{ pairAddress: '0x' + '3'.repeat(40) }, { observationProvider: 'DEXSCREENER' }, { pairAddress: undefined }]) {
    const tracker = new LeadSignals();
    observe(tracker, AT); observe(tracker, AT + 150_000, { price: 1.03 });
    assert.equal(observe(tracker, AT + 300_000, { price: 1.08, ...change }).momentum, null);
  }
});
test('alternating source observations maintain separate timelines without inflating either sample count', () => {
  const tracker = new LeadSignals();
  observe(tracker, AT);
  observe(tracker, AT + 1000, { observationProvider: 'DEXSCREENER' });
  observe(tracker, AT + 150_000, { price: 1.02 });
  observe(tracker, AT + 151_000, { observationProvider: 'DEXSCREENER', price: 1.02 });
  assert.equal(observe(tracker, AT + 300_000, { price: 1.04 }).momentum.samples, 3);
});
test('a liquidity/price fall immediately withdraws an upgrade even within the sample spacing', () => {
  for (const change of [{ liquidity: 8000, price: 1.04 }, { price: .8, liquidity: 11_100 }]) {
    const tracker = new LeadSignals(); confirmed(tracker);
    const result = observe(tracker, AT + 301_000, change);
    assert.equal(result.momentum.state, 'COOLING');
    assert.equal(result.momentum.samples, 1);
    assert.equal(observe(tracker, AT + 361_000, { ...change, volume5m: 2200 }).momentum.state, 'COOLING');
  }
});
test('stale/retained data, missing values and rollback timestamps cannot retain or invent upgraded evidence', () => {
  const tracker = new LeadSignals(), active = confirmed(tracker);
  for (const changes of [{ stale: true }, { retainedSnapshot: true }, { auditEligible: false },
    { capturedAt: AT + 400_000 }, { sourceUpdatedAt: AT + 400_000 }]) {
    assert.equal(publicLeadSignal({ ...active, ...changes }, AT + 300_000).momentum, null);
  }
  assert.deepEqual(publicLeadSignal(active, AT + 361_000), { reasonCodes: [], momentum: null });
  assert.equal(observe(tracker, AT + 299_999, { price: 1.05 }).momentum, null);
  const other = new LeadSignals();
  for (let i = 0; i < 4; i++) assert.equal(observe(other, AT + i * 150_000, { liquidity: null }).momentum, null);
});
test('known screen failures and credential resets revoke history; long data gaps must re-establish a baseline', () => {
  const tracker = new LeadSignals(); confirmed(tracker);
  tracker.observe([row(AT + 301_000)], [], 'bsc', AT + 301_000);
  assert.equal(observe(tracker, AT + 450_000, { price: 1.1 }).momentum, null);
  tracker.reset(); assert.equal(tracker.history.size, 0);
  confirmed(tracker);
  assert.equal(observe(tracker, AT + 1_600_000, { price: 1.2 }).momentum, null);
});
test('COOLING cannot fall back to a retained first-sighting voice receipt', () => {
  const now = Date.now(), tracker = new LeadSignals(); confirmed(tracker, now - 301_000);
  const cooled = observe(tracker, now, { liquidity: 8000, price: 1.04 });
  const scope = { activeChain: 'bsc', liveLeads: [{ ...cooled, displayUntil: now + 600_000, qualifiedAt: now - 1000 }], riskExclusions: {} };
  assert.equal(cooled.momentum.state, 'COOLING');
  assert.deepEqual(observationVoiceSnapshot(scope, ['bsc'], { snapshot: () => ({ rows: [cooled] }) }, now).chains.bsc, []);
});
test('tracking has a bounded memory footprint and preserves chain/address isolation', () => {
  const tracker = new LeadSignals();
  confirmed(tracker);
  assert.equal(observe(tracker, AT + 300_000, { chain: 'eth', price: 1.04 }).momentum, null);
  for (let i = 1; i < 1550; i++) observe(tracker, AT + 300_000, { address: '0x' + i.toString(16).padStart(40, '0') });
  assert.ok(tracker.history.size <= 1500);
});
test('inactive volume/price does not pass confirmation just because time elapsed', () => {
  for (const change of [{ volume5m: 500 }, { price: .9 }, { liquidity: 8500 }]) {
    const tracker = new LeadSignals();
    observe(tracker, AT); observe(tracker, AT + 150_000, { price: 1.02 });
    assert.equal(observe(tracker, AT + 300_000, { price: 1.04, ...change }).momentum, null);
  }
});
test('public projection does not leak arbitrary fields or claim a malformed upgrade', () => {
  const active = confirmed(new LeadSignals());
  const output = publicLeadSignal({ ...active, reasonCodes: ['SECRET', ...active.reasonCodes, 'NEW_LEAD'],
    momentum: { ...active.momentum, apiKey: 'not-a-real-key' } }, AT + 300_000);
  assert.equal(output.reasonCodes.length, 2); assert.doesNotMatch(JSON.stringify(output), /SECRET|apiKey/);
  assert.equal(publicLeadSignal({ ...active, momentum: { ...active.momentum, samples: 1 } }, AT + 300_000).momentum, null);
});
test('observation voice upgrades are independent from first sightings and unavailable after risk, expiry or restart baseline', () => {
  const now = Date.now(), active = confirmed(new LeadSignals(), now - 300_000);
  const state = { activeChain: 'bsc', auditQueue: [], riskExclusions: {} };
  const live = { snapshot: () => ({ rows: [active] }) };
  const snapshot = observationVoiceSnapshot(state, ['bsc'], live, now);
  const upgraded = snapshot.chains.bsc[0];
  assert.equal(upgraded.alertKind, 'momentum'); assert.equal(upgraded.qualified, false);
  assert.equal(voiceEligible(upgraded, now), true);
  const tracker = new VoiceAlerts(); tracker.reset(now - 2000);
  tracker.ingest({ chains: { bsc: [] } }, now - 1000);
  tracker.ingest(snapshot, now);
  assert.equal(tracker.batch({ ['bsc:' + CA]: now - 500 }, now).length, 1);
  assert.equal(tracker.batch({ [voiceKey(upgraded)]: now - 500 }, now).length, 0);
  assert.equal(voiceEligible(upgraded, now + 61_000), false);
  const restarted = new VoiceAlerts(); restarted.reset(now); restarted.ingest(snapshot, now);
  assert.equal(restarted.batch({}, now).length, 0);
  state.riskExclusions['bsc:' + CA] = { reason: 'test' };
  assert.deepEqual(observationVoiceSnapshot(state, ['bsc'], live, now).chains.bsc, []);
});
test('live cache integration observes existing quotes only and resets on key changes', async () => {
  let at = AT, price = 1, reads = 0;
  const provider = { keyEpoch: 0, configured: async () => true, live: async (_chain, options) => {
    assert.equal(options.refresh, false); reads++;
    return { capturedAt: at, tokens: [{ chain: 'bsc', address: CA, pairAddress: POOL, marketProvider: 'AVE',
      market_cap: 50000, liquidity: 15000, volume_5m: 2000, price, launch_at: Math.floor(AT / 1000) - 1000,
      capturedAt: at, sourceUpdatedAt: at, expiresAt: at + 60_000 }] };
  } };
  const live = new LiveDiscovery({ provider, now: () => at, cacheOnly: true, schedule: () => ({ unref() {} }), cancel() {} });
  for (let i = 0; i < 3; i++) { at = AT + i * 150_000; price = 1 + i * .02; await live.readSnapshot('bsc'); }
  assert.equal(reads, 3); assert.equal(live.snapshot('bsc').rows[0].momentum.state, 'ACTIVE');
  at += 60_001; assert.equal(live.snapshot('bsc').rows[0].momentum, null);
  provider.keyEpoch++; assert.deepEqual(live.snapshot('bsc').rows, []);
  live.stop(); assert.equal(live.signals.history.size, 0);
});
test('reason UI escapes text, limits tags and removes old/retained labels', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('function currentLeadSignal('), html.indexOf('function observationVoiceReady('));
  const context = { t: key => key, escapeHtml: s => String(s).replaceAll('<', '&lt;') };
  vm.createContext(context); vm.runInContext(source, context);
  const active = confirmed(new LeadSignals());
  assert.equal(context.momentumActive(active, AT + 300_000), true);
  assert.equal((context.leadReasons(active, AT + 300_000).match(/<span>/g) || []).length, 2);
  assert.equal(context.leadReasons({ ...active, stale: true }, AT + 300_000), '');
  assert.equal(context.leadReasons({ ...active, reasonCodes: ['<script>'] }, AT + 300_000), '');
});
