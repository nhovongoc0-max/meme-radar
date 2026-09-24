import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chartRiskScreen, applyRiskExclusion } from '../src/chart-risk.mjs';
import { config } from '../src/config.mjs';
import { deepScreen, knownRiskReasons, discoveryScreen, observeFiveMinutes } from '../src/scoring.mjs';
import { normalizeLiveRows } from '../src/live-discovery.mjs';
import { classifyDeepResult, Scanner } from '../src/scanner.mjs';
import { toPublicStatus, voiceSnapshot } from '../src/server.mjs';
import { RadarState } from '../src/state.mjs';

const now = 1_800_000_000_000, address = '0x' + 'a'.repeat(40);
const series = (closes, at = now) => closes.map((close, i) => {
  const open = i ? closes[i - 1] : 1;
  return { time: at - (closes.length - i) * 60_000, open, close,
    high: Math.max(open, close) * 1.005, low: Math.min(open, close) * .995, volume: 100 };
});
const pump = at => series([1.3776, 1.38, 1.38, 1.39, 1.39, 1.39, 1.40, 1.40, 1.40], at);
const dump = at => series([1, .65, .35, .18, .18, .18, .18, .18, .18], at);
const discovery = at => ({ address, chain: 'bsc', market_cap: 50000, liquidity: 12000,
  creation_timestamp: at / 1000 - 600, rug_ratio: .1, bundler_rate: .05,
  rat_trader_amount_rate: .05, is_wash_trading: false, is_honeypot: false });

test('observed early pump and collapse are rejected even when the last five bars look normal', () => {
  for (const [bars, code] of [[pump(now), 'VERTICAL_PLATEAU'], [dump(now), 'SUSTAINED_COLLAPSE']]) {
    assert.equal(observeFiveMinutes(bars, now).pass, true);
    const risk = chartRiskScreen(bars, now);
    assert.equal(risk.status, 'REJECT'); assert.ok(risk.codes.includes(code));
    assert.equal(risk.from, bars[0].time);
    assert.equal(chartRiskScreen([...bars].reverse(), now).status, 'REJECT');
    assert.equal(chartRiskScreen(bars.map(b => ({ ...b, time: b.time / 1000 })), now).status, 'REJECT');
    const deep = deepScreen({ discovery: {}, audit: { candles: bars }, nowMs: now }, config);
    assert.equal(classifyDeepResult(deep).status, 'HARD_REJECT');
  }
});

test('unknown, conflicting, stale, flat-zero-volume and price-gap candles do not create permanent accusations', () => {
  const good = series([1, 1.01, 1.02, 1.025, 1.03, 1.04, 1.05, 1.06]);
  assert.equal(chartRiskScreen(good, now).pass, true);
  assert.equal(chartRiskScreen([...good, good[0]], now).pass, true);
  const gapPrices = series([1, 1.5, 1.5, 1.5, 1.5, 1.5]).map(b => ({ ...b, open: b.close, low: b.close, high: b.close }));
  const cases = [[], good.slice(0, 3), good.slice(0, -3), [...good.slice(0, 3), ...good.slice(4)],
    [...good, { ...good[0], volume: 9 }], good.map(b => ({ ...b, time: b.time - 180000 })),
    good.map(b => ({ ...b, volume: 0 })), gapPrices, pump(now).map(b => ({ ...b, volume: 0 })),
    good.map(b => ({ ...b, open: [] }))];
  for (const rows of cases) {
    const risk = chartRiskScreen(rows, now);
    assert.equal(risk.status, 'UNKNOWN'); assert.equal(risk.pass, false);
    assert.equal(classifyDeepResult({ chainPass: false, failed: ['chartRisk'], blockingUnknownFields: risk.unknownFields }).status, 'WAIT_RECHECK');
  }
  // A huge high wick has no ordered evidence of two later collapsed closes.
  assert.equal(chartRiskScreen(good.map(b => ({ ...b, high: 100 })), now).pass, true);
});

test('DEV exit labels cannot override positive holdings or fill a missing balance', () => {
  for (const status of ['sell', 'creator_close']) {
    for (const value of [.0803, '8.03%', undefined]) {
      const deep = deepScreen({ discovery: { creator_token_status: status, dev_team_hold_rate: value }, audit: {}, nowMs: now }, config);
      assert.equal(deep.checks.dev, false);
      if (value === undefined) assert.ok(deep.blockingUnknownFields.includes('devHold'));
    }
  }
});

test('both discovery paths filter known low LP, high taxes, DEV and explicit zero 5m volume', () => {
  for (const fields of [{ liquidity: 3310 }, { buy_tax: '10%', sell_tax: '15%' },
    { dev_team_hold_rate: .0803 }, { creator_balance_rate: .08 }, { volume_5m: 0 }]) {
    const row = { ...discovery(now), ...fields };
    assert.ok(knownRiskReasons(row, config).length);
    assert.equal(discoveryScreen(row, { ...config, chain: 'bsc' }, now / 1000).pass, false);
    assert.equal(normalizeLiveRows([row], 'bsc', [], now).length, 0);
  }
  assert.equal(normalizeLiveRows([{ ...discovery(now), volume: 0 }], 'bsc', [], now).length, 1);
});

test('risk memory survives restart, old snapshots and chain switching without another deep audit', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-risk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let state = new RadarState(dir), audits = 0;
  state.value.activeChain = 'bsc';
  const gmgn = { keyEpoch: 1, configured: async () => true, discover: async () => [discovery(Date.now())],
    audit: async () => { audits++; return { candles: pump(Date.now()) }; } };
  let scanner = new Scanner({ state, gmgn, settings: { ...config, chain: 'bsc', outcomeReadsPerCycle: 1, maxDeepAuditsPerCycle: 1 } });
  await scanner.cycle();
  assert.equal(audits, 1);
  const key = 'bsc:' + address, hold = state.value.riskExclusions[key];
  assert.ok(hold.codes.includes('VERTICAL_PLATEAU'));
  assert.equal(state.value.candidates[0].status, 'HARD_REJECT');
  // Reproduce a crash after exclusion persistence but before candidate replacement.
  state.value.candidates[0] = { ...state.value.candidates[0], status: 'X_REVIEW',
    deep: { chainPass: true, chartRisk: { version: 1, pass: true } } };
  state.save(); state = new RadarState(dir);
  assert.equal(toPublicStatus(state.value).candidates[0].status, 'HARD_REJECT');
  assert.equal(voiceSnapshot(state.value, ['bsc']).chains.bsc[0].qualified, false);
  scanner = new Scanner({ state, gmgn, settings: { ...config, chain: 'bsc' } });
  await scanner.cycle(); assert.equal(audits, 1);
  assert.equal(state.value.candidates[0].status, 'HARD_REJECT');
  scanner.activateChain('arc', true); scanner.activateChain('bsc', true);
  assert.ok(state.value.riskExclusions[key]);
  assert.equal(scanner.enqueueReview('bsc', discovery(Date.now())).reason, 'risk_excluded');
  assert.equal(applyRiskExclusion({ address: address.toUpperCase(), status: 'X_REVIEW' }, state.value.riskExclusions, 'bsc').status, 'HARD_REJECT');
  assert.equal(applyRiskExclusion({ address, status: 'X_REVIEW' }, state.value.riskExclusions, 'arc').status, 'X_REVIEW');
});
