import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scanner } from '../src/scanner.mjs';
import { RadarState } from '../src/state.mjs';
import { config } from '../src/config.mjs';

for (const chain of ['bsc', 'eth', 'base', 'sol']) {
  test(`scanner does not invent a mintability conflict on ${chain}`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-mint-chain-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const state = new RadarState(dir);
    state.value.activeChain = chain;
    const nowSec = Math.floor(Date.now() / 60000) * 60;
    const address = chain === 'sol' ? 'So11111111111111111111111111111111111111112' : '0x' + '1'.repeat(40);
    const row = { address, symbol: 'TEST', price: 1, market_cap: 50000, liquidity: 10000,
      creation_timestamp: nowSec - 1000, rug_ratio: .1, bundler_rate: .05, rat_trader_amount_rate: .05,
      is_wash_trading: false, is_honeypot: 0, creator_token_status: 'creator_close', dev_team_hold_rate: 0 };
    const security = { open_source: true, owner_renounced: true, is_honeypot: false,
      renounced_mint: chain === 'sol', renounced_freeze_account: chain === 'sol',
      buy_tax: .01, sell_tax: .01, rug_ratio: .1, top_10_holder_rate: .2,
      creator_token_status: 'creator_close', dev_team_hold_rate: 0, rat_trader_amount_rate: .05,
      bundler_trader_amount_rate: .05, top70_sniper_hold_rate: .02, is_wash_trading: false, lock_percent: .9 };
    const gmgn = { keyEpoch: 0, configured: async () => true, discover: async () => [row], audit: async () => ({
      info: { liquidity: 10000, price: { price: 1, sells_5m: 3, sells_24h: 20 } }, security, pool: { liquidity: 10000 },
      holders: Array.from({length:10}, (_, i) => ({ address: '0x' + String(i+1).padStart(40,'0'), addr_type:0,
        buy_tx_count_cur:1, is_new:false, is_suspicious:false, amount_percentage:.01,
        native_transfer:{from_address:`source-${i}`}, tags:[], maker_token_tags:[] })),
      traders: Array.from({length:5}, (_, i) => ({ address:`seller-${i}`, sell_tx_count_cur:1, last_active_timestamp:nowSec-60 })),
      candles: Array.from({length:6}, (_, i) => ({ time:(nowSec-7*60+i*60)*1000, open:100+i, high:101+i, low:99+i, close:100.5+i, volume:100 })),
      _meta: { complete: true }
    }) };
    let primary;
    const secondary = { validate: async input => {
      primary = input.primary;
      return { status: 'COMPLETE', complete: true, sources: {goPlus:{status:'OK'},dexScreener:{status:'OK'}},
        security: {verdict:'NO_FATAL_FLAGS', fields:{mintable:false}},
        conflicts: primary.security.mintable === true ? [{type:'SECURITY_MISMATCH',field:'mintable'}] : [] };
    } };
    const scanner = new Scanner({gmgn, secondary, state, settings:config});
    await scanner.cycle();
    assert.ok(primary, 'scanner must reach secondary validation');
    assert.equal(primary.security.mintable, chain === 'sol' ? false : undefined);
    assert.equal(state.value.candidates[0].deep.chainPass, true);
    assert.equal(state.value.candidates[0].status, 'X_REVIEW');
  });
}
