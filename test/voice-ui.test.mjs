import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { VoiceAlerts, VOICE_TTL, voiceKey } from '../public/voice-alerts.mjs';

const source = fs.readFileSync(new URL('../public/voice-ui.mjs', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness({ hub = { storage: new Map(), tabs: [], locked: false }, failHistory = false } = {}) {
  let now = Date.now(), finish, plays = 0;
  const elements = new Map(), events = {};
  const el = id => {
    if (!elements.has(id)) elements.set(id, { value: id === 'voiceVolume' ? '50' : '', listeners: {},
      setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
    return elements.get(id);
  };
  const player = { ready: true, playing: false, unlock: async () => {}, stop() { finish?.(false); },
    play(volume) {
      if (this.playing || !(volume > 0)) return Promise.resolve(false);
      this.playing = true; plays++;
      return new Promise(resolve => { finish = ok => { finish = null; this.playing = false; resolve(ok); }; });
    } };
  const localStorage = { getItem: key => hub.storage.get(key) ?? null,
    setItem(key, value) {
      if (failHistory && key === 'memeCommunityVoiceHistoryV1') throw Error('quota');
      const oldValue = hub.storage.get(key) ?? null; hub.storage.set(key, value);
      if (oldValue !== value) for (const other of hub.tabs) if (other !== events)
        queueMicrotask(() => other.storage?.({ key, oldValue, newValue: value }));
    } };
  hub.tabs.push(events);
  vm.runInNewContext(source, { VoiceAlerts, VOICE_TTL, voiceKey, createVoicePlayer: () => player,
    Date: class extends Date { static now() { return now; } }, document: { getElementById: el }, localStorage,
    navigator: { locks: { async request(_name, _options, fn) {
      if (hub.locked) return fn(null);
      hub.locked = true; try { return await fn({}); } finally { hub.locked = false; }
    } } }, window: { addEventListener: (type, fn) => { events[type] = fn; } } });
  return { hub, el, player, events, advance(ms = 100) { now += ms; },
    row(address = '0x123') { return { chain: 'bsc', address, status: 'X_REVIEW', qualified: true, auditedAt: now, staleAt: now + 600000 }; },
    snapshot(rows = []) { events['radar-snapshot']({ detail: { chains: { bsc: rows } } }); },
    click(id) { return el(id).listeners.click(); },
    input(value) { el('voiceVolume').value = String(value); el('voiceVolume').listeners.input(); },
    finish(ok = true) { assert.ok(finish, 'audio must be playing'); finish(ok); },
    get plays() { return plays; }, get history() { return JSON.parse(hub.storage.get('memeCommunityVoiceHistoryV1') || '{}'); },
    get status() { return el('voiceStatus').textContent; } };
}
async function enable(h) {
  h.snapshot(); const pending = h.click('voiceEnable'); await flush(); h.finish(); await pending; await flush();
}

test('preview during candidate playback cannot invalidate successful delivery history', async () => {
  const h = harness(); await enable(h); h.advance(); const row = h.row();
  h.snapshot([row]); await flush(); await h.click('voiceEnable'); h.finish(); await flush();
  h.snapshot([row]); await flush(); assert.equal(h.plays, 2);
  assert.ok(h.history.notified['bsc:0x123']);
});
test('failed history persistence stops automatic retries until explicitly enabled again', async () => {
  const h = harness({ failHistory: true }); await enable(h); h.advance(); h.snapshot([h.row()]);
  await flush(); h.finish(); await flush(); h.snapshot([h.row()]); await flush();
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
test('close during asynchronous audio preparation cannot turn alerts back on', async () => {
  const h = harness(); let release;
  h.player.unlock = () => new Promise(resolve => { release = resolve; });
  h.snapshot(); const starting = h.click('voiceEnable'); await flush(); await h.click('voiceStop');
  release(); await starting; h.advance(); h.snapshot([h.row()]); await flush();
  assert.equal(h.plays, 0); assert.match(h.status, /未开启/);
});
test('offline and bfcache restore require a fresh quiet baseline and show actual audio state', async () => {
  const h = harness(); await enable(h); h.events['radar-offline'](); await flush(); assert.match(h.status, /暂停/);
  h.advance(); h.snapshot([h.row()]); await flush(); assert.equal(h.plays, 1);
  h.events.pagehide(); h.events.pageshow({ persisted: true });
  assert.match(h.status, /点击启用/); h.advance(); h.snapshot([h.row('later')]); await flush(); assert.equal(h.plays, 1);
});
