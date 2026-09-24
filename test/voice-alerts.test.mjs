import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VoiceAlerts, voiceEligible, voiceKey, VOICE_TTL } from '../public/voice-alerts.mjs';
import { CANDIDATE_PHRASE, CANDIDATE_PHRASES, createVoicePlayer, selectChineseVoice, selectEnglishVoice, selectVoice } from '../public/voice-player.mjs';
import { voiceSnapshot, toPublicStatus, createServer } from '../src/server.mjs';
import { config } from '../src/config.mjs';

const now = 1_800_000_000_000;
const row = (address = '0x' + 'a'.repeat(40), at = now) => ({ address, chain: 'bsc',
  status: 'X_REVIEW', qualified: true, auditedAt: at, staleAt: at + 600000 });
const snapshot = rows => ({ chains: { bsc: rows } });

test('quiet baseline, newly audited promotion, duplicate suppression and downgrade cancellation', () => {
  const tracker = new VoiceAlerts(); tracker.reset(now);
  const old = row(), pending = { ...row('pending'), status: 'WAIT_RECHECK', qualified: false };
  tracker.ingest(snapshot([old, pending]), now);
  assert.equal(tracker.batch({}, now).length, 0);
  const promoted = row('pending', now + 1000);
  tracker.ingest(snapshot([old, promoted]), now + 1000);
  assert.deepEqual(tracker.batch({}, now + 1000), [promoted]);
  tracker.ingest(snapshot([old, pending]), now + 2000);
  assert.equal(tracker.batch({}, now + 2000).length, 0);
  tracker.ingest(snapshot([old, promoted]), now + 3000);
  tracker.acknowledge([promoted], now + 3000);
  tracker.ingest(snapshot([old, promoted]), now + 4000);
  assert.equal(tracker.batch({}, now + 4000).length, 0);
});

test('fresh unified live candidates alert once while incomplete or stale live rows stay quiet', () => {
  const tracker = new VoiceAlerts(); tracker.reset(now);
  tracker.ingest(snapshot([]), now);
  const live = { ...row('live', now + 1000), source: 'live', status: 'LIVE_READY' };
  tracker.ingest(snapshot([live]), now + 1000);
  assert.deepEqual(tracker.batch({}, now + 1000), [live]);
  tracker.acknowledge([live], now + 1000);
  tracker.ingest(snapshot([{ ...live, auditedAt: now + 2000 }]), now + 2000);
  assert.equal(tracker.batch({}, now + 2000).length, 0);
  assert.equal(voiceEligible({ ...live, status: 'LIVE_WAIT', qualified: false }, now + 1000), false);
  assert.equal(voiceEligible({ ...live, staleAt: now + 999 }, now + 1000), false);
});

test('stale, ignored, unknown, failed, future and unaudited-before-enable candidates never alert', () => {
  const tracker = new VoiceAlerts(); tracker.reset(now);
  tracker.ingest(snapshot([]), now);
  const rows = [row('old', now - 1), { ...row('stale'), staleAt: now },
    { ...row('failed'), qualified: false }, row('future', now + 5000), row('ignored')];
  tracker.ingest(snapshot(rows), now, r => r.address === 'ignored');
  assert.equal(tracker.batch({}, now).length, 0);
  assert.equal(voiceEligible(row('too-old', now - 601000), now), false);
  tracker.reset(now + 10000);
  tracker.ingest(snapshot([row('restart', now + 10000)]), now + 10000);
  assert.equal(tracker.batch({}, now + 10000).length, 0);
});

test('identity and cross-tab persisted dedupe respect chain and Solana case', () => {
  assert.equal(voiceKey(row('0xAa')), voiceKey(row('0xaa')));
  assert.notEqual(voiceKey({ chain: 'sol', address: 'Abc' }), voiceKey({ chain: 'sol', address: 'abc' }));
  assert.notEqual(voiceKey(row('same')), voiceKey({ chain: 'arc', address: 'same' }));
  const tracker = new VoiceAlerts(); tracker.reset(now); tracker.ingest(snapshot([]), now);
  const candidate = row('a', now + 1); tracker.ingest(snapshot([candidate]), now + 1);
  assert.equal(tracker.batch({ [voiceKey(candidate)]: now }, now + 1).length, 0);
  tracker.ingest(snapshot([row('a', now + VOICE_TTL + 1)]), now + VOICE_TTL + 1);
  assert.equal(tracker.batch({}, now + VOICE_TTL + 1).length, 0);
});

test('continuous qualification and regular reaudits do not re-alert during the seven-day window', () => {
  const tracker = new VoiceAlerts(); tracker.reset(now); tracker.ingest(snapshot([row()]), now);
  for (const offset of [VOICE_TTL - 1, VOICE_TTL + 1, 2 * VOICE_TTL + 1]) {
    tracker.ingest(snapshot([row(undefined, now + offset)]), now + offset);
    assert.equal(tracker.batch({}, now + offset).length, 0);
  }
});

test('server voice snapshot includes all enabled chains, excludes incomplete/legacy/held and leaks no raw data', () => {
  const make = chain => ({ ...row(), chain, deep: { chainPass: true, chartRisk: { pass: true, version: 1 } },
    auditHealth: { complete: true }, privateStuff: 'do-not-return', rawDiscovery: { confidential: true } });
  const state = { activeChain: 'bsc', candidates: [make('bsc')], chainStates: { arc: { candidates: [make('arc')] } } };
  let result = voiceSnapshot(state, ['bsc', 'arc', 'fake']);
  assert.deepEqual(Object.keys(result.chains), ['bsc', 'arc']);
  assert.equal(result.chains.arc[0].qualified, true);
  assert.doesNotMatch(JSON.stringify(result), /privateStuff|do-not-return|rawDiscovery/);
  state.candidates[0].auditHealth.complete = false;
  state.chainStates.arc.candidates[0].deep.chartRisk.version = 0;
  result = voiceSnapshot(state, ['bsc', 'arc']);
  assert.equal(result.chains.bsc[0].qualified, false); assert.equal(result.chains.arc[0].qualified, false);
  assert.equal(toPublicStatus({ activeChain: 'arc', candidates: state.chainStates.arc.candidates }).candidates[0].status, 'WAIT_RECHECK');
});

test('production voice snapshot feeds the unified pool from fresh live rows without overriding a hard rejection', () => {
  const at = Date.now(), address = '0x' + 'b'.repeat(40);
  const audit = { ...row(address, at - 2000), chain: 'bsc', deep: { chainPass: true, chartRisk: { pass: true, version: 1 } },
    auditHealth: { complete: true } };
  const source = { chain: 'bsc', marketProvider: 'AVE', status: 'READY', stale: false, lastSuccessAt: at - 500,
    rows: [{ chain: 'bsc', address, marketProvider: 'AVE', symbol: 'LIVE', name: 'Live', capturedAt: at - 500,
      sourceUpdatedAt: at - 1000, expiresAt: at + 30000, stale: false, auditEligible: true,
      discoveryState: 'READY', firstSeenAt: at - 4000, newAt: at - 3000 }] };
  const live = { snapshot: () => source };
  const state = { activeChain: 'bsc', candidates: [audit], chainStates: {}, riskExclusions: {},
    auditQueue: [{ address, status: 'QUEUED', firstSeenAt: at - 3000 }] };
  let result = voiceSnapshot(state, ['bsc'], live).chains.bsc;
  assert.equal(result.length, 1); assert.equal(result[0].source, 'live');
  assert.equal(result[0].status, 'LIVE_READY'); assert.equal(result[0].qualified, true);
  assert.equal(result[0].auditedAt, at - 3000); assert.equal(result[0].staleAt, at + 30000);
  source.rows[0] = { ...source.rows[0], auditEligible: false, discoveryState: 'PENDING' };
  result = voiceSnapshot(state, ['bsc'], live).chains.bsc;
  assert.equal(result.length, 0, 'incomplete rows stay out of the unified fast-alert pool');
  source.rows[0] = { ...source.rows[0], auditEligible: true, discoveryState: 'READY' };
  state.candidates[0] = { ...state.candidates[0], status: 'HARD_REJECT' };
  result = voiceSnapshot(state, ['bsc'], live).chains.bsc;
  assert.equal(result.length, 0);
  state.candidates[0] = audit;
  source.rows = [];
  result = voiceSnapshot(state, ['bsc'], live).chains.bsc;
  assert.equal(result.length, 0, 'historical X_REVIEW cannot refill a token removed by the current fast screen');
  state.candidates = [];
  state.auditQueue = [{ address, status: 'HARD_REJECT', lastAuditedAt: at - 2000, nextAuditAt: at + 600000 }];
  result = voiceSnapshot(state, ['bsc'], live).chains.bsc;
  assert.equal(result.length, 0, 'retained audit-queue rejection vetoes live after the display candidate expires');
});

const localVoice = { name: 'Meijia', lang: 'zh-TW', localService: true };
const englishVoice = { name: 'Samantha', lang: 'en-US', localService: true };
function mockSpeech(voices = [localVoice]) {
  const utterances = [];
  let timeout, cancellations = 0;
  const synthesis = { paused: true, getVoices: () => voices, resume() { this.paused = false; },
    speak(u) { utterances.push(u); }, cancel() { cancellations++; } };
  const player = createVoicePlayer({ synthesis, makeUtterance: text => ({ text }),
    schedule(fn) { timeout = fn; return 1; }, cancelTimer() { timeout = null; } });
  return { player, synthesis, utterances, expire() { timeout(); }, get cancellations() { return cancellations; } };
}
test('voice selection prefers installed Chinese female voices and never falls back to cloud voices', () => {
  const male = { name: 'Male', lang: 'zh-CN', localService: true, default: true };
  const remote = { name: 'Xiaoxiao', lang: 'zh-CN', localService: false };
  assert.equal(selectChineseVoice([male, remote, localVoice]), localVoice);
  assert.equal(selectChineseVoice([remote, { ...male, lang: 'en-US' }]), null);
  assert.equal(selectChineseVoice([male]), male);
});
test('English selection stays local, uses the requested language, and never falls back to Chinese', () => {
  const remote = { name: 'Ava', lang: 'en-US', localService: false };
  const localMale = { name: 'English Male', lang: 'en-GB', localService: true, default: true };
  assert.equal(selectEnglishVoice([localMale, remote, englishVoice]), englishVoice);
  assert.equal(selectEnglishVoice([remote, localVoice]), null);
  assert.equal(selectVoice([localVoice, englishVoice], 'en'), englishVoice);
  assert.equal(selectVoice([localVoice, englishVoice], 'invalid'), localVoice);
});
test('player unlocks in gesture, speaks fixed text locally, never overlaps, and stop is not delivery', async () => {
  const { player, synthesis, utterances } = mockSpeech();
  await assert.rejects(player.play(.5), /suspended/);
  const unlocking = player.unlock(); assert.equal(synthesis.paused, false); await unlocking;
  assert.equal(player.ready, true);
  const playing = player.play(.5); assert.equal(await player.play(.5), false);
  assert.equal(utterances[0].text, CANDIDATE_PHRASE); assert.equal(utterances[0].voice, localVoice);
  assert.equal(utterances[0].volume, .5); assert.equal(utterances[0].rate, .9);
  player.stop(); assert.equal(await playing, false);
  const completed = player.play(2); assert.equal(utterances.at(-1).volume, 1);
  utterances.at(-1).onstart(); utterances.at(-1).onend(); assert.equal(await completed, true);
  assert.equal(await player.play(0), false); assert.equal(await player.play(Infinity), false);
});
test('missing Chinese voice can be retried after voice discovery, with no silent fake success', async () => {
  const voices = [], { player } = mockSpeech(voices);
  assert.throws(() => player.unlock(), /chinese_voice_missing/); assert.equal(player.ready, false);
  voices.push(localVoice); player.unlock(); assert.equal(player.ready, true);
});
test('player manually switches between Chinese and English phrases without cross-language fallback', async () => {
  const h = mockSpeech([localVoice, englishVoice]);
  await h.player.unlock('en'); assert.equal(h.player.language, 'en');
  const english = h.player.play(.5, { language: 'en' });
  assert.equal(h.utterances.at(-1).text, CANDIDATE_PHRASES.en); assert.equal(h.utterances.at(-1).voice, englishVoice);
  h.utterances.at(-1).onstart(); h.utterances.at(-1).onend(); assert.equal(await english, true);
  await assert.rejects(h.player.play(.5, { language: 'zh' }), /voice_language_not_unlocked/);
  await h.player.unlock('zh'); const chinese = h.player.play(.5, { language: 'zh' });
  assert.equal(h.utterances.at(-1).text, CANDIDATE_PHRASES.zh); assert.equal(h.utterances.at(-1).voice, localVoice);
  h.utterances.at(-1).onstart(); h.utterances.at(-1).onend(); assert.equal(await chinese, true);
  const missing = mockSpeech([localVoice]); assert.throws(() => missing.player.unlock('en'), /english_voice_missing/);
});
test('speech failure and timeout disable player until explicitly reenabled', async () => {
  const h = mockSpeech(); await h.player.unlock();
  const failure = h.player.play(.5); h.utterances.at(-1).onerror({ error: 'not-allowed' });
  await assert.rejects(failure, /not-allowed/); assert.equal(h.player.ready, false);
  await h.player.unlock(); const timed = h.player.play(.5); h.expire();
  await assert.rejects(timed, /speech_timeout/); assert.equal(h.player.ready, false);
  assert.equal(h.cancellations, 1); assert.equal(h.player.playing, false);
});

test('exact static routes serve voice modules, keep CSP, exclude recordings and reject traversal', async () => {
  const server = createServer({ state: { value: {} }, settings: config });
  const dispatch = url => new Promise((resolve, reject) => {
    const req = { method: 'GET', url, headers: { host: `127.0.0.1:${config.port}` }, socket: { remoteAddress: '127.0.0.1' } };
    const out = {};
    const res = { writeHead(status, headers) { Object.assign(out, { status, headers }); }, end(body) { resolve({ ...out, body }); } };
    Promise.resolve(server.listeners('request')[0](req, res)).catch(reject);
  });
  for (const route of ['/voice-ui.mjs', '/voice-alerts.mjs', '/voice-player.mjs']) {
    const result = await dispatch(route); assert.equal(result.status, 200); assert.match(result.headers['Content-Type'], /javascript/);
    assert.match(result.headers['Content-Security-Policy'], /connect-src 'self'/);
  }
  assert.equal((await dispatch('/audio/candidate-found.wav')).status, 404);
  assert.equal((await dispatch('/audio/../src/config.mjs')).status, 404);
  assert.equal((await dispatch('/voice-unknown.mjs')).status, 404);
  const ui = fs.readFileSync(new URL('../public/voice-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /addEventListener\('storage'/); assert.match(ui, /navigator\.locks\.request/);
  assert.match(ui, /if \(player.playing \|\| state === 'loading'\) return/);
});

test('player start callback follows native onstart exactly once and cannot fire after cancellation', async () => {
  const h = mockSpeech(); await h.player.unlock(); let starts = 0;
  const playing = h.player.play(.5, { onStart() { starts++; } });
  assert.equal(starts, 0); const start = h.utterances.at(-1).onstart;
  start(); start(); assert.equal(starts, 1);
  h.utterances.at(-1).onend(); assert.equal(await playing, true); start(); assert.equal(starts, 1);
  const cancelled = h.player.play(.5, { onStart() { starts++; } }), late = h.utterances.at(-1).onstart;
  h.player.stop(); late(); assert.equal(await cancelled, false); assert.equal(starts, 1);
});
test('native end without start is not delivery and stale queued candidates can abort on start', async () => {
  const h = mockSpeech(); await h.player.unlock(); let starts = 0;
  const ghost = h.player.play(.5, { onStart() { starts++; } }); h.utterances.at(-1).onend();
  await assert.rejects(ghost, /speech_did_not_start/); assert.equal(starts, 0);
  await h.player.unlock();
  const obsolete = h.player.play(.5, { onStart() { return false; } }); h.utterances.at(-1).onstart();
  assert.equal(await obsolete, false); assert.equal(h.player.playing, false); assert.equal(h.cancellations, 1);
});
