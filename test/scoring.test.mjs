import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.mjs';
import {
  discoveryScreen, analyzeWallets, observeFiveMinutes, deepScreen, empiricalSellability, marketBehaviorScreen
} from '../src/scoring.mjs';

const nowSec = 1_800_000_000;
const address = '0x1111111111111111111111111111111111111111';
const validHolders = () => Array.from({ length: 10 }, (_, i) => ({
  address: `0x${String(i + 1).padStart(40, '0')}`, addr_type: 0, buy_tx_count_cur: 1,
  is_new: false, is_suspicious: false, amount_percentage: .01,
  native_transfer: { from_address: `source-${i}` }, tags: [], maker_token_tags: []
}));
const recentTraders = () => Array.from({ length: 5 }, (_, i) => ({
  address: `seller-${i}`, sell_tx_count_cur: 1, last_active_timestamp: nowSec - 60
}));

test('discovery waits five minutes and prioritizes 20k-80k market cap', () => {
  const base = { address, market_cap: 50_000, liquidity: 10_000, creation_timestamp: nowSec - 301, rug_ratio: .1, bundler_rate: .1, rat_trader_amount_rate: .1, is_wash_trading: false, is_honeypot: 0 };
  const pass = discoveryScreen(base, config, nowSec);
  assert.equal(pass.pass, true);
  assert.equal(pass.priorityBand, true);
  assert.equal(discoveryScreen({ ...base, creation_timestamp: nowSec - 299 }, config, nowSec).pass, false);
});

test('discovery recognizes boolean variants and fails closed on malformed safety fields', () => {
  const base = { address, market_cap: 50_000, liquidity: 10_000, creation_timestamp: nowSec - 600, rug_ratio: .1, bundler_rate: .1, rat_trader_amount_rate: .1, is_wash_trading: false, is_honeypot: 0 };
  assert.match(discoveryScreen({ ...base, is_honeypot: true }, config, nowSec).reasons.join(' '), /貔貅/);
  assert.match(discoveryScreen({ ...base, is_wash_trading: 'true' }, config, nowSec).reasons.join(' '), /刷量/);
  const unknown = discoveryScreen({ ...base, rug_ratio: 'unknown' }, config, nowSec);
  assert.equal(unknown.pass, false);
  assert.ok(unknown.unknownFields.includes('rugRatio'));
});

test('discovery validates Solana and EVM addresses according to chain', () => {
  const common = { market_cap: 50_000, liquidity: 10_000, creation_timestamp: nowSec - 600, rug_ratio: .1, bundler_rate: .1, rat_trader_amount_rate: .1, is_wash_trading: false };
  const solConfig = { ...config, chain: 'sol' };
  const solAddress = 'So11111111111111111111111111111111111111112';
  assert.equal(discoveryScreen({ ...common, address: solAddress }, solConfig, nowSec).pass, true);
  assert.match(discoveryScreen({ ...common, address }, solConfig, nowSec).reasons.join(' '), /地址格式异常/);
  assert.match(discoveryScreen({ ...common, address: solAddress, is_honeypot: 0 }, config, nowSec).reasons.join(' '), /地址格式异常/);
});

test('discovery ranking rewards multiple smart-money wallets but never rewards KOL-only interest', () => {
  const base = {
    address, market_cap: 50_000, liquidity: 10_000, creation_timestamp: nowSec - 600,
    rug_ratio: .1, bundler_rate: .1, rat_trader_amount_rate: .1,
    is_wash_trading: false, is_honeypot: 0, volume: 1_000, holder_count: 100
  };
  const single = discoveryScreen({ ...base, smart_degen_count: 1, renowned_count: 0 }, config, nowSec);
  const multiple = discoveryScreen({ ...base, smart_degen_count: 3, renowned_count: 0 }, config, nowSec);
  const kolOnly = discoveryScreen({ ...base, smart_degen_count: 1, renowned_count: 2 }, config, nowSec);
  const unknownSmart = discoveryScreen({ ...base, renowned_count: 2 }, config, nowSec);
  assert.equal(multiple.signals.smartBoost, 14);
  assert.ok(multiple.score > single.score);
  assert.equal(kolOnly.signals.kolOnly, true);
  assert.ok(kolOnly.score < single.score);
  assert.equal(unknownSmart.signals.kolOnly, false);
});

test('wallet proxy rejects bot-heavy and linked-funding holder sets', () => {
  const ordinary = Array.from({ length: 10 }, (_, i) => ({ address: `0x${String(i + 1).padStart(40, '0')}`, addr_type: 0, buy_tx_count_cur: 1, is_new: false, is_suspicious: false, amount_percentage: .01, native_transfer: { from_address: `source-${i}` }, tags: [], maker_token_tags: [] }));
  assert.equal(analyzeWallets(ordinary, config).pass, true);
  const botHeavy = ordinary.map((row, i) => i < 3 ? { ...row, amount_percentage: .08, maker_token_tags: ['bundler'] } : row);
  assert.equal(analyzeWallets(botHeavy, config).pass, false);
});

test('wallet proxy deduplicates addresses, normalizes risk tags and parses explicit percentages', () => {
  const ordinary = Array.from({ length: 10 }, (_, i) => ({ address: `0x${String(i + 1).padStart(40, '0')}`, addr_type: 0, buy_tx_count_cur: 1, is_new: false, is_suspicious: false, amount_percentage: '1%', native_transfer: { from_address: `source-${i}` }, tags: [], maker_token_tags: [] }));
  const deduped = analyzeWallets([...ordinary, { ...ordinary[0], address: ordinary[0].address.toUpperCase() }], config);
  assert.equal(deduped.sampled, 10);
  assert.equal(deduped.ordinaryCount, 10);
  assert.equal(deduped.duplicateCount, 1);
  assert.equal(deduped.pass, true);

  const bot = analyzeWallets(ordinary.map((row, index) => index === 0 ? { ...row, amount_percentage: '25%', maker_token_tags: ['BUNDLER'] } : row), config);
  assert.equal(bot.botHoldRate, .25);
  assert.equal(bot.pass, false);

  const missing = analyzeWallets([...ordinary.slice(0, 9), { ...ordinary[9], address: '' }], config);
  assert.equal(missing.ordinaryCount, 9);
  assert.equal(missing.pass, false);
  assert.ok(missing.unknownFields.includes('holders.address'));
});

test('market behavior deduplicates wallet evidence and requires multiple smart wallets for strength', () => {
  const firstSmart = { address, tags: ['SMART-DEGEN'] };
  const duplicateSmart = { address: address.toUpperCase(), maker_token_tags: ['smart_degen'] };
  const secondSmart = { address: '0x2222222222222222222222222222222222222222', tags: ['smart_degen'] };
  const one = marketBehaviorScreen({ holders: [firstSmart, duplicateSmart], nowMs: nowSec * 1000 }, config);
  assert.equal(one.evidence.smartWallets, 1);
  assert.deepEqual(one.strengths, []);

  const two = marketBehaviorScreen({ holders: [firstSmart, duplicateSmart, secondSmart], nowMs: nowSec * 1000 }, config);
  assert.equal(two.evidence.smartWallets, 2);
  assert.match(two.strengths.join(' '), /轻度加分/);
});

test('market behavior sends KOL-only, inconsistent activity and old sudden pumps to recheck', () => {
  const kolOnly = marketBehaviorScreen({
    discovery: { smart_degen_count: 1, renowned_count: 2 }, nowMs: nowSec * 1000
  }, config);
  assert.equal(kolOnly.pass, false);
  assert.match(kolOnly.downgradeReasons.join(' '), /仅见KOL/);

  const mismatch = marketBehaviorScreen({
    discovery: { smart_degen_count: 0, renowned_count: 0, holder_count: 10, swaps: 200, buys: 100, sells: 100 },
    nowMs: nowSec * 1000
  }, config);
  assert.equal(mismatch.pass, false);
  assert.match(mismatch.downgradeReasons.join(' '), /交易笔数与持有人数量/);

  const oldPump = marketBehaviorScreen({
    discovery: {
      creation_timestamp: nowSec - 2 * 86400, smart_degen_count: 3, renowned_count: 0,
      price_change_percent5m: .40, swaps: 40, buys: 25, sells: 15, holder_count: 100
    }, nowMs: nowSec * 1000
  }, config);
  assert.equal(oldPump.pass, false);
  assert.match(oldPump.downgradeReasons.join(' '), /老盘5分钟突然大幅拉升/);

  const recentlyOpened = marketBehaviorScreen({
    discovery: {
      creation_timestamp: nowSec - 2 * 86400, open_timestamp: nowSec - 600,
      smart_degen_count: 3, renowned_count: 0, price_change_percent5m: .40,
      swaps: 40, buys: 25, sells: 15, holder_count: 100
    }, nowMs: nowSec * 1000
  }, config);
  assert.equal(recentlyOpened.pass, true);
});

test('market behavior identifies distribution flow and corroborated repeat-launcher risk', () => {
  const distribution = marketBehaviorScreen({
    discovery: {
      creation_timestamp: nowSec - 3600, smart_degen_count: 3, renowned_count: 1,
      price_change_percent5m: .15, swaps: 60, buys: 20, sells: 40, holder_count: 100
    }, nowMs: nowSec * 1000
  }, config);
  assert.equal(distribution.pass, false);
  assert.match(distribution.downgradeReasons.join(' '), /分发阶段/);

  const repeat = marketBehaviorScreen({
    discovery: { creator_created_count: 20, creator_created_open_count: 2 },
    info: { dev: { creator_open_count: 20, creator_token_status: 'sell' } },
    nowMs: nowSec * 1000
  }, config);
  assert.equal(repeat.pass, false);
  assert.equal(repeat.evidence.creatorStatus, 'EXITED');
  assert.match(repeat.downgradeReasons.join(' '), /历史质量偏弱/);

  const historyUnknown = marketBehaviorScreen({
    info: { dev: { creator_open_count: 20, creator_token_status: 'sell' } },
    nowMs: nowSec * 1000
  }, config);
  assert.equal(historyUnknown.pass, true);
  assert.match(historyUnknown.warnings.join(' '), /历史发币20个/);
});

function candles({ spike = false } = {}) {
  return Array.from({ length: 6 }, (_, i) => ({ time: (nowSec - 7 * 60 + i * 60) * 1000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: spike && i === 5 ? 10000 : 100 }));
}

test('five-minute observation rejects single-candle machine volume pulse', () => {
  const normal = observeFiveMinutes(candles(), nowSec * 1000);
  assert.equal(normal.pass, true);
  assert.equal(normal.continuous, true);
  assert.equal(normal.fresh, true);
  assert.equal(normal.volumeTrend, 'STABLE');
  const result = observeFiveMinutes(candles({ spike: true }), nowSec * 1000);
  assert.equal(result.pass, false);
  assert.match(result.reason, /机器脉冲/);
});

test('five-minute observation waits on gapped or stale candles', () => {
  const gapped = candles();
  gapped[3] = { ...gapped[3], time: gapped[3].time + 30_000 };
  const gapResult = observeFiveMinutes(gapped, nowSec * 1000);
  assert.equal(gapResult.status, 'WAITING');
  assert.ok(gapResult.unknownFields.includes('candles.continuity'));

  const stale = candles().map(row => ({ ...row, time: row.time - 10 * 60_000 }));
  const staleResult = observeFiveMinutes(stale, nowSec * 1000);
  assert.equal(staleResult.status, 'WAITING');
  assert.ok(staleResult.unknownFields.includes('candles.freshness'));
});

test('sellability aligns seller evidence to a recent activity window and states its limitation', () => {
  const traders = Array.from({ length: 5 }, (_, i) => ({ address: `seller-${i}`, sell_tx_count_cur: 1, last_active_timestamp: nowSec - 60 }));
  const result = empiricalSellability({ info: { price: { sells_5m: 3, sells_24h: 20 } }, discovery: {}, traders, nowSec });
  assert.equal(result.pass, true);
  assert.equal(result.distinctSellers, 5);
  assert.match(result.evidenceNote, /不一定就是卖出/);
  assert.equal(empiricalSellability({ info: { price: { sells_5m: 3, sells_24h: 20 } }, discovery: {}, traders: traders.map(row => ({ ...row, last_active_timestamp: nowSec - 600 })), nowSec }).pass, false);
});

test('deep screen accepts strict chain data with empirical sell evidence and known DEV balance', () => {
  const holders = Array.from({ length: 10 }, (_, i) => ({ address: `0x${String(i + 1).padStart(40, '0')}`, addr_type: 0, buy_tx_count_cur: 1, is_new: false, is_suspicious: false, amount_percentage: .01, native_transfer: { from_address: `source-${i}` }, tags: [], maker_token_tags: [] }));
  const traders = Array.from({ length: 5 }, (_, i) => ({ address: `seller-${i}`, sell_tx_count_cur: 1, last_active_timestamp: nowSec - 60 }));
  const result = deepScreen({
    discovery: { address, market_cap: 50_000, liquidity: 10_000, sells_24h: 20, rug_ratio: .1, top_10_holder_rate: .2, bundler_rate: .05, rat_trader_amount_rate: .05, top70_sniper_hold_rate: .02, is_wash_trading: false, creator_token_status: 'creator_close', dev_team_hold_rate: 0, lock_percent: .9 },
    audit: { info: { liquidity: 10_000, price: { sells_5m: 3, sells_24h: 20 } }, security: { open_source: 'yes', owner_renounced: 'yes', buy_tax: .01, sell_tax: .01, rug_ratio: .1, top_10_holder_rate: .2, creator_token_status: 'creator_close', rat_trader_amount_rate: .05, bundler_trader_amount_rate: .05, top70_sniper_hold_rate: .02, is_wash_trading: false, lock_percent: .9 }, pool: { liquidity: 10_000 }, holders, traders, candles: candles() },
    nowMs: nowSec * 1000
  }, config);
  assert.equal(result.chainPass, true);
  assert.equal(result.honeypotEvidence, '经验卖出证据');
});

test('deep screen reuses nested token-info dev and stat fields without another request', () => {
  const result = deepScreen({
    discovery: { liquidity: 10_000, sells_24h: 20 },
    audit: {
      info: {
        liquidity: 10_000,
        locked_ratio: .9,
        holder_count: 10,
        dev: { creator_token_status: 'sell', creator_open_count: 2 },
        stat: { top_10_holder_rate: .2, dev_team_hold_rate: 0, top_rat_trader_percentage: .05, top_bundler_trader_percentage: .05 },
        price: { sells_5m: 3, sells_24h: 20 }
      },
      security: {
        open_source: true, owner_renounced: true, is_honeypot: false, buy_tax: 0, sell_tax: 0,
        rug_ratio: .1, top70_sniper_hold_rate: .02, is_wash_trading: false
      },
      pool: { liquidity: 10_000 }, holders: validHolders(), traders: recentTraders(), candles: candles()
    },
    nowMs: nowSec * 1000
  }, config);
  assert.equal(result.checks.dev, true);
  assert.equal(result.checks.concentration, true);
  assert.equal(result.security.creatorStatus, 'EXITED');
});

test('deep screen rejects malformed taxes instead of coercing them to zero', () => {
  const result = deepScreen({ discovery: {}, audit: { info: {}, security: { open_source: true, owner_renounced: true, buy_tax: 'unknown', sell_tax: '5%' }, pool: {}, holders: [], traders: [], candles: [] }, nowMs: nowSec * 1000 }, config);
  assert.equal(result.checks.tax, false);
  assert.ok(result.failed.includes('tax'));
  assert.ok(result.unknownFields.includes('buyTax'));
  assert.ok(result.blockingUnknownFields.includes('buyTax'));
  assert.equal(result.security.sellTax, .05);
});

test('deep screen rejects materially asymmetric buy and sell taxes', () => {
  const result = deepScreen({
    discovery: {
      address, market_cap: 50_000, liquidity: 10_000, sells_24h: 20, rug_ratio: .1,
      top_10_holder_rate: .2, bundler_rate: .05, rat_trader_amount_rate: .05,
      top70_sniper_hold_rate: .02, is_wash_trading: false, creator_token_status: 'creator_close', lock_percent: .9
    },
    audit: {
      info: { liquidity: 10_000, price: { sells_5m: 3, sells_24h: 20 } },
      security: { open_source: 'yes', owner_renounced: 'yes', is_honeypot: 'no', buy_tax: .01, sell_tax: .04,
        rug_ratio: .1, top_10_holder_rate: .2, creator_token_status: 'creator_close', rat_trader_amount_rate: .05,
        bundler_trader_amount_rate: .05, top70_sniper_hold_rate: .02, is_wash_trading: false, lock_percent: .9 },
      pool: { liquidity: 10_000 }, holders: validHolders(), traders: recentTraders(), candles: candles()
    },
    nowMs: nowSec * 1000
  }, config);
  assert.equal(result.checks.tax, false);
  assert.ok(result.security.taxDifference > config.maxTaxAsymmetry);
});

test('Solana deep screen uses mint and freeze renouncement instead of EVM owner and honeypot fields', () => {
  const solConfig = { ...config, chain: 'sol' };
  const holders = Array.from({ length: 10 }, (_, i) => ({ address: `SolWallet${String(i).padStart(32, '1')}`, addr_type: 0, buy_tx_count_cur: 1, is_new: false, is_suspicious: false, amount_percentage: .01, native_transfer: { from_address: `SolSource${i}` }, tags: [], maker_token_tags: [] }));
  const security = { open_source: true, renounced_mint: true, renounced_freeze_account: true, buy_tax: 0, sell_tax: 0, rug_ratio: .1, top_10_holder_rate: .2, creator_token_status: 'creator_close', rat_trader_amount_rate: .05, bundler_trader_amount_rate: .05, top70_sniper_hold_rate: .02, is_wash_trading: false, lock_percent: .9 };
  const result = deepScreen({ discovery: {}, audit: { info: { liquidity: 10_000 }, security, pool: { liquidity: 10_000 }, holders, traders: [], candles: candles() }, nowMs: nowSec * 1000 }, solConfig);
  assert.equal(result.checks.ownerRenounced, true);
  assert.equal(result.checks.notHoneypot, true);
  assert.equal(result.security.renouncedMint, true);
  assert.equal(result.security.renouncedFreezeAccount, true);
  assert.ok(!result.failed.includes('ownerRenounced'));
  assert.ok(!result.blockingUnknownFields.includes('ownerRenounced'));

  const unsafe = deepScreen({ discovery: {}, audit: { info: { liquidity: 10_000 }, security: { ...security, renounced_freeze_account: false }, pool: { liquidity: 10_000 }, holders, traders: [], candles: candles() }, nowMs: nowSec * 1000 }, solConfig);
  assert.equal(unsafe.checks.ownerRenounced, false);
  assert.ok(unsafe.failed.includes('ownerRenounced'));
});

test('deep screen hard-fails unrenounced ownership and unlocked LP', () => {
  const result = deepScreen({ discovery: {}, audit: { info: {}, security: { open_source: 'yes', owner_renounced: 'no' }, pool: {}, holders: [], traders: [], candles: [] } }, config);
  assert.equal(result.chainPass, false);
  assert.ok(result.failed.includes('ownerRenounced'));
  assert.ok(result.failed.includes('lpLocked'));
  assert.ok(result.failed.includes('wash'));
});
