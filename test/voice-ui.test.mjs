import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { VoiceAlerts, VOICE_TTL, voiceKey, voiceEligible } from '../public/voice-alerts.mjs';

const source = fs.readFileSync(new URL('../public/voice-ui.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness({ hub = { storage: new Map(), tabs: [], locked: false }, failHistory = false, autoStart = true } = {}) {
  let now = Date.now(), finish, begin, plays = 0;
  const emitted = [], playLanguages = [], unlockLanguages = [];
  const elements = new Map(), events = {};
  const el = id => {
    if (!elements.has(id)) elements.set(id, { value: id === 'voiceVolume' ? '50' : '', listeners: {},
      setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
    return elements.get(id);
  };
  const player = { ready: true, playing: false, unlock: async language => { unlockLanguages.push(language); }, stop() { finish?.(false); },
    play(volume, { onStart, language } = {}) {
      if (this.playing || !(volume > 0)) return Promise.resolve(false);
      this.playing = true; plays++; playLanguages.push(language);
      return new Promise(resolve => {
        let started = false;
        finish = ok => { finish = null; this.playing = false; resolve(ok); };
        begin = () => { if (!finish || started) return; started = true; if (onStart?.() === false) finish(false); };
        if (autoStart) begin();
      });
    } };
  const localStorage = { getItem: key => hub.storage.get(key) ?? null,
    setItem(key, value) {
      if (failHistory && key === 'memeCommunityVoiceHistoryV1') throw Error('quota');
      const oldValue = hub.storage.get(key) ?? null; hub.storage.set(key, value);
      if (oldValue !== value) for (const other of hub.tabs) if (other !== events)
        queueMicrotask(() => other.storage?.({ key, oldValue, newValue: value }));
    } };
  hub.tabs.push(events);
  vm.runInNewContext(source, { VoiceAlerts, VOICE_TTL, voiceKey, voiceEligible, createVoicePlayer: () => player,
    Date: class extends Date { static now() { return now; } }, document: { getElementById: el }, localStorage,
    navigator: { locks: { async request(_name, _options, fn) {
      if (hub.locked) return fn(null);
      hub.locked = true; try { return await fn({}); } finally { hub.locked = false; }
    } } }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    window: { addEventListener: (type, fn) => { events[type] = fn; }, dispatchEvent(event) { emitted.push({ type: event.type, detail: structuredClone(event.detail) }); events[event.type]?.(event); } } });
  return { hub, el, player, events, emitted, start() { assert.ok(begin); begin(); }, advance(ms = 100) { now += ms; },
    row(address = '0x123') { return { chain: 'bsc', address, status: 'X_REVIEW', qualified: true, auditedAt: now, staleAt: now + 600000 }; },
    snapshot(rows = []) { events['radar-snapshot']({ detail: { chains: { bsc: rows } } }); },
    click(id) { return el(id).listeners.click(); },
    input(value) { el('voiceVolume').value = String(value); el('voiceVolume').listeners.input(); },
    changeLanguage(value) { el('voiceLanguage').value = value; return el('voiceLanguage').listeners.change(); },
    finish(ok = true) { assert.ok(finish, 'audio must be playing'); finish(ok); },
    get plays() { return plays; }, get playLanguages() { return playLanguages; }, get unlockLanguages() { return unlockLanguages; },
    get history() { return JSON.parse(hub.storage.get('memeCommunityVoiceHistoryV1') || '{}'); },
    get status() { return el('voiceStatus').textContent; } };
}
async function enable(h) {
  h.snapshot(); const pending = h.click('voiceEnable'); await flush(); h.start(); h.finish(); await pending; await flush();
}

test('enable is committed only after the native preview really starts and failure stays disabled', async () => {
  const h = harness({ autoStart: false }); h.snapshot();
  const enabling = h.click('voiceEnable'); await flush();
  assert.match(h.status, /准备/);
  assert.notEqual(JSON.parse(h.hub.storage.get('memeCommunityVoiceV1') || '{}').enabled, true);
  h.start(); assert.equal(JSON.parse(h.hub.storage.get('memeCommunityVoiceV1')).enabled, true);
  h.finish(); await enabling; await flush(); assert.match(h.status, /已开启/);

  const failed = harness({ autoStart: false }); failed.snapshot();
  const attempt = failed.click('voiceEnable'); await flush(); failed.start(); failed.finish(false); await attempt; await flush();
  assert.equal(JSON.parse(failed.hub.storage.get('memeCommunityVoiceV1')).enabled, false);
  assert.match(failed.status, /重试/);
});

test('preview during candidate playback cannot invalidate successful delivery history', async () => {
  const h = harness(); await enable(h); h.advance(); const row = h.row();
  h.snapshot([row]); await flush(); await h.click('voiceEnable'); h.finish(); await flush();
  h.snapshot([row]); await flush(); assert.equal(h.plays, 2);
  assert.ok(h.history.notified['bsc:0x123']);
});
test('failed history persistence stops automatic retries until explicitly enabled again', async () => {
  const h = harness({ failHistory: true }); await enable(h); h.advance(); h.snapshot([h.row()]);
  await flush(); h.snapshot([h.row()]); await flush();
  assert.equal(h.plays, 2); assert.equal(h.player.playing, false); assert.match(h.status, /重试/);
});
test('two tabs share candidate dedupe and global one-minute cooldown', async () => {
  const a = harness(), b = harness({ hub: a.hub }); await enable(a); await enable(b);
  a.advance(); b.advance(); const row = a.row(); a.snapshot([row]); b.snapshot([row]); await flush();
  assert.equal(a.plays + b.plays, 3); a.finish(); await flush(); b.snapshot([row]); await flush();
  assert.equal(a.plays + b.plays, 3);
  a.advance(); a.snapshot([row, a.row('next')]); await flush(); assert.equal(a.plays, 2);
  a.advance(61000); a.snapshot([row, a.row('next')]); await flush(); assert.equal(a.plays, 3); a.finish(); await flush();
});
test('closing or muting in one tab silences other tabs without automatically unlocking them', async () => {
  const a = harness(), b = harness({ hub: a.hub }); await enable(a); await enable(b);
  a.input(0); await flush(); assert.equal(b.el('voiceVolume').value, 0); assert.match(b.status, /暂停/);
  b.advance(); b.snapshot([b.row()]); await flush(); assert.equal(b.plays, 1);
  a.input(50); await flush(); await a.click('voiceStop'); await flush(); assert.match(b.status, /未开启/);
  b.advance(); b.snapshot([b.row('other')]); await flush(); assert.equal(b.plays, 1);
  await enable(a); await flush(); assert.match(b.status, /点击启用/);
});
test('voice language is independent from page locale, persists, previews immediately, and keeps pending candidates', async () => {
  const h = harness({ autoStart: false }); await enable(h); assert.equal(h.playLanguages[0], 'zh');
  h.advance(); const candidate = h.row(); h.snapshot([candidate]); await flush();
  assert.equal(h.player.playing, true, 'candidate is queued before the language switch');
  const beforeSwitch = h.plays;
  const switching = h.changeLanguage('en'); await flush();
  h.start(); h.finish(); await switching; await flush();
  assert.equal(h.playLanguages.at(-1), 'en'); assert.equal(h.unlockLanguages.at(-1), 'en');
  assert.equal(JSON.parse(h.hub.storage.get('memeCommunityVoiceV1')).language, 'en');
  h.events['radar-locale']({ detail: 'ja' }); assert.equal(h.el('voiceLanguage').value, 'en');
  h.snapshot([candidate]); await flush();
  if (h.player.playing) { h.start(); h.finish(); await flush(); }
  assert.ok(h.playLanguages.slice(beforeSwitch).every(language => language === 'en'));
  assert.ok(h.history.notified?.['bsc:0x123'], 'switching language must not lose the pending candidate');
});
test('close while the native preview is waiting cannot turn alerts back on', async () => {
  const h = harness({ autoStart: false });
  h.snapshot(); const starting = h.click('voiceEnable'); await flush(); await h.click('voiceStop');
  await starting; h.advance(); h.snapshot([h.row()]); await flush();
  assert.equal(h.plays, 1); assert.match(h.status, /未开启/);
});
test('offline and bfcache restore require a fresh quiet baseline and show actual audio state', async () => {
  const h = harness(); await enable(h); h.events['radar-offline'](); await flush(); assert.match(h.status, /暂停/);
  h.advance(); h.snapshot([h.row()]); await flush(); assert.equal(h.plays, 1);
  h.events.pagehide(); h.events.pageshow({ persisted: true });
  assert.match(h.status, /点击启用/); h.advance(); h.snapshot([h.row('later')]); await flush(); assert.equal(h.plays, 1);
});

test('spotlight starts only on real candidate audio start, never preview, baseline, or queued playback', async () => {
  const h = harness({ autoStart: false }); await enable(h); assert.deepEqual(h.emitted, []);
  h.advance(); const rows = [h.row('first'), h.row('second')]; h.snapshot(rows); await flush();
  assert.deepEqual(h.emitted, []); assert.equal(h.history.notified, undefined);
  h.start(); h.start();
  assert.equal(h.emitted.length, 1); assert.equal(h.emitted[0].type, 'radar-voice-start');
  assert.deepEqual(h.emitted[0].detail.rows.map(row => row.address), ['first', 'second']);
  assert.ok(h.history.notified['bsc:first']); assert.ok(h.history.notified['bsc:second']);
  h.finish(); await flush();
  assert.deepEqual(h.emitted[1], { type: 'radar-voice-finish', detail: { id: h.emitted[0].detail.id, completed: true } });
  assert.ok(h.history.notified['bsc:first']); assert.ok(h.history.notified['bsc:second']);
  h.snapshot(rows); await flush(); assert.equal(h.emitted.length, 2);
});
test('a downgrade or ignore before queued speech starts cancels that candidate without spotlight or acknowledgement', async () => {
  for (const ignored of [false, true]) {
    const h = harness({ autoStart: false }); await enable(h); h.advance(); const row = h.row(); h.snapshot([row]); await flush();
    if (ignored) h.hub.storage.set('robinhoodRadarManualMarksV1', JSON.stringify({ [voiceKey(row)]: { decision: 'ignored' } }));
    else h.snapshot([{ ...row, qualified: false, status: 'HARD_REJECT' }]);
    h.start(); await flush();
    assert.deepEqual(h.emitted, []); assert.equal(h.history.notified, undefined); assert.equal(h.player.playing, false);
  }
});
test('batch spotlight and delivery include only candidates still eligible at actual audio start', async () => {
  const h = harness({ autoStart: false }); await enable(h); h.advance();
  const first = h.row('first'), second = h.row('second'); h.snapshot([first, second]); await flush();
  h.snapshot([{ ...first, qualified: false }, second]); h.start(); h.finish(); await flush();
  assert.deepEqual(h.emitted[0].detail.rows.map(row => row.address), ['second']);
  assert.equal(h.history.notified['bsc:first'], undefined); assert.ok(h.history.notified['bsc:second']);
});
test('muting after actual start marks the spotlight interrupted and still deduplicates the delivered alert', async () => {
  const h = harness(); await enable(h); h.advance(); h.snapshot([h.row()]); await flush();
  assert.equal(h.emitted[0].type, 'radar-voice-start');
  h.input(0); await flush();
  assert.equal(h.emitted[1].type, 'radar-voice-finish'); assert.equal(h.emitted[1].detail.completed, false);
  assert.ok(h.history.notified['bsc:0x123']);
  h.snapshot([h.row('muted')]); await flush(); assert.equal(h.emitted.length, 2);
});
