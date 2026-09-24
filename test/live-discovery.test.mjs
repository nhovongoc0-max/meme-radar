import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.mjs';
import { LiveDiscovery, liveRequestArgs, normalizeLiveRows } from '../src/live-discovery.mjs';
import { executeReadOnly } from '../src/gmgn-readonly-worker.mjs';
import { Scanner } from '../src/scanner.mjs';
import { RadarState } from '../src/state.mjs';
import { createServer } from '../src/server.mjs';

const now = 1800000000000;
const address = '0x' + '1'.repeat(40);
const token = (id = 1, overrides = {}) => ({ address:'0x'+id.toString(16).padStart(40,'0'), symbol:'T'+id, name:'Test',
  market_cap:50000,liquidity:15000,creation_timestamp:now/1000-1000,price:'1',volume:1000,buys:10,sells:5,swaps:15,
  holder_count:100,smart_degen_count:3,rug_ratio:.1,bundler_rate:.1,rat_trader_amount_rate:.1,is_wash_trading:false,is_honeypot:0,...overrides });
const options = gmgn => ({gmgn,now:()=>now,schedule:()=>({unref(){}}),cancel:()=>{}});

test('live requests use a one-minute read with no deep-audit or trading calls', async () => {
  let called;
  const client={ getTrendingSwaps:async (...args)=>{called=args;return {rank:[]};} };
  await executeReadOnly(client,liveRequestArgs('sol'));
  assert.equal(called[0],'sol');assert.equal(called[1],'1m');
  assert.equal(called[2].min_created,'5m'); assert.equal(called[2].limit,100);
  await assert.rejects(executeReadOnly(client,['market','trending','--chain','sol','--interval','0m']));
  await assert.rejects(executeReadOnly(client,['swap','buy','--chain','sol']));
});

test('quick discovery drops explicit hazards and newborns, preserves unknowns and case-sensitive Solana addresses', () => {
  const rows=normalizeLiveRows([token(),token(2,{is_honeypot:1}),token(3,{is_wash_trading:true}),token(4,{rug_ratio:.4}),
    token(5,{creation_timestamp:now/1000-200}),token(6,{liquidity:2000}),token(7,{address:'invalid'}),
    token(8,{market_cap:null}),token(9,{smart_degen_count:null,rug_ratio:null,buy_tax:null,website:'javascript:alert(1)'})], 'bsc',[],now);
  assert.equal(rows.length,2); assert.equal(rows[1].smartMoney,null); assert.equal(rows[1].hasUnknownRisk,true);
  assert.equal(rows[1].auditEligible,false); assert.equal(rows[1].website,'');
  assert.ok(rows.every(row=>row.newAt===0 && row.priceDelta===null));
  const upper='So11111111111111111111111111111111111111112',lower='so11111111111111111111111111111111111111112';
  assert.equal(normalizeLiveRows([token(1,{address:upper}),token(2,{address:lower})],'sol',[],now).length,2);
  assert.equal(normalizeLiveRows([token(),token(1,{address:token().address.toUpperCase().replace('0X','0x')})],'bsc',[],now).length,1);
});

test('snapshot changes use actual elapsed time; first load is not a stream of fake new arrivals', () => {
  const first=normalizeLiveRows([token()],'bsc',[],now);
  const second=normalizeLiveRows([token(1,{price:1.1,holder_count:103}),token(2)],'bsc',first,now+20000,true);
  assert.ok(Math.abs(second[0].priceDelta-.1)<1e-9);assert.equal(second[0].deltaWindowMs,20000);
  assert.equal(second[0].holdersDelta,3);assert.equal(second[0].newAt,0);assert.equal(second[1].newAt,now+20000);
  const afterGap=normalizeLiveRows([token()],'bsc',first,now+180000,true);
  assert.equal(afterGap[0].priceDelta,null);
});

test('visible-client leases share one in-flight request and one global cadence across chains', async () => {
  let clock=now,calls=0,finish;
  const gmgn={keyEpoch:0,configured:async()=>true,run:async()=>{calls++;return new Promise(resolve=>{finish=resolve;});}};
  const live=new LiveDiscovery({...options(gmgn),now:()=>clock});
  live.touch('bsc');const pending=live.poll();await new Promise(resolve=>setImmediate(resolve));
  live.touch('bsc');live.touch('sol');await live.poll();assert.equal(calls,1);
  finish({rank:[token()]});await pending;
  assert.equal(live.snapshot('sol').rows.length,0);assert.equal(live.snapshot('bsc').rows.length,1);
  clock+=10000;await live.poll();assert.equal(calls,1);
  clock+=21000;await live.poll();assert.equal(calls,1,'expired hidden-page lease must not fetch');
});

test('global rate-limit cooldown is honored; failed responses preserve old timestamps and stale flags', async () => {
  let clock=now,calls=0;
  const gmgn={keyEpoch:0,nextAllowedAt:now+60000,configured:async()=>true,run:async()=>{calls++;return {rank:[token()]};}};
  const live=new LiveDiscovery({...options(gmgn),now:()=>clock});
  live.touch('bsc');await live.poll();assert.equal(calls,0);assert.equal(live.snapshot('bsc').status,'RATE_LIMITED');
  clock+=61000;live.touch('bsc');await live.poll();assert.equal(calls,1);
  const success=live.snapshot('bsc').lastSuccessAt;
  gmgn.run=async()=>{throw new Error('secret upstream failure');};clock+=65000;live.touch('bsc');await live.poll();
  assert.equal(live.snapshot('bsc').lastSuccessAt,success);assert.equal(live.snapshot('bsc').stale,true);
  assert.doesNotMatch(JSON.stringify(live.snapshot('bsc')),/secret upstream/);
});

test('AVE live cards apply one batch market overlay before filtering and expose real pool values', async () => {
  const ca = token().address, pool = '0x' + 'a'.repeat(40);
  const raw = { address: ca, chain: 'bsc', symbol: 'FAST', name: 'Fast', marketProvider: 'AVE', market_cap: 50_000,
    price: 1, holder_count: 10, capturedAt: now - 120_000, sourceUpdatedAt: now - 120_000,
    marketCapSourceUpdatedAt: now - 120_000, marketCapCapturedAt: now - 120_000, marketCapExpiresAt: now - 90_000,
    expiresAt: now - 90_000, stale: true };
  let overlayCalls = 0;
  const marketOverlay = { enrich: async (chain, rows, scope) => {
    overlayCalls++;
    assert.equal(chain, 'bsc'); assert.equal(scope.minMarketCap, config.discoveryMinMarketCap);
    return rows.map(row => ({ ...row, price: 1.1, market_cap: 51_000, liquidity: 12_000, volume_5m: 650,
      pool_created_at: now / 1000 - 900, pairAddress: pool, ageBasis: 'pool', capturedAt: now, sourceUpdatedAt: now,
      expiresAt: now + 20_000, marketCapSourceUpdatedAt: now, marketCapCapturedAt: now, marketCapExpiresAt: now + 20_000,
      stale: false, marketOverlayProvider: 'DEXSCREENER' }));
  } };
  const provider = { keyEpoch: 0, configured: async () => true, live: async () => ({ tokens: [raw], capturedAt: now - 120_000 }),
    snapshot: () => ({ pauseCode: null }), disabled: false, nextAllowedAt: 0 };
  const live = new LiveDiscovery({ provider, cacheOnly: true, marketOverlay, now: () => now,
    schedule: () => ({ unref() {} }), cancel: () => {} });
  const snapshot = await live.readSnapshot('bsc');
  assert.equal(overlayCalls, 1);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].liquidity, 12_000);
  assert.equal(snapshot.rows[0].volume5m, 650);
  assert.equal(snapshot.rows[0].createdAt, now / 1000 - 900);
  assert.equal(snapshot.rows[0].auditEligible, true);
});

test('credential changes discard in-flight data; unconfigured feed never requests upstream', async () => {
  let finish,calls=0;
  const gmgn={keyEpoch:0,configured:async()=>false,run:async()=>{calls++;return new Promise(resolve=>{finish=resolve;});}};
  const live=new LiveDiscovery(options(gmgn));live.touch('bsc');await live.poll();assert.equal(calls,0);
  gmgn.configured=async()=>true;live.nextPollAt=0;
  const pending=live.poll();await new Promise(resolve=>setImmediate(resolve));
  gmgn.disabled=true;gmgn.keyEpoch++;finish({rank:[token()]});await pending;
  assert.equal(live.snapshot('bsc').rows.length,0);assert.equal(live.auditRow('bsc',token().address),null);
});

test('malformed successful payloads are errors, not fake empty live updates; audit input has no mislabeled 1m counters', async () => {
  const gmgn={keyEpoch:0,configured:async()=>true,run:async()=>({rank:[token()]})};
  const live=new LiveDiscovery(options(gmgn));live.touch('bsc');await live.poll();
  const audit=live.auditRow('bsc',token().address);
  assert.equal(audit.volume,undefined);assert.equal(audit.buys,undefined);assert.equal(audit.swaps,undefined);
  live.nextPollAt=0;gmgn.run=async()=>({unexpected:true});await live.poll();
  assert.equal(live.snapshot('bsc').status,'ERROR');assert.equal(live.snapshot('bsc').pollCount,1);
});

test('manual review uses original safety gates, one priority slot, unchanged batch budget and no chain switch', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radar-live-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const state=new RadarState(dir);state.value.activeChain='bsc';const audited=[];
  const fresh=id=>token(id,{creation_timestamp:Date.now()/1000-1000});
  const gmgn={keyEpoch:0,configured:async()=>true,discover:async()=>[fresh(1),fresh(2),fresh(3)],audit:async address=>{audited.push(address);
    return {info:{price:{price:1}},security:{owner_renounced:'no'},pool:{},holders:[],traders:[],candles:[],_meta:{complete:true}};}};
  const scanner=new Scanner({gmgn,state,settings:{...config,maxDeepAuditsPerCycle:2}});
  assert.equal(scanner.enqueueReview('sol',fresh(4)).reason,'chain_not_scanning');
  assert.equal(scanner.enqueueReview('bsc',{...fresh(4),is_honeypot:1}).accepted,false);
  assert.equal(scanner.enqueueReview('bsc',fresh(4)).accepted,true);
  assert.equal(scanner.enqueueReview('bsc',fresh(4)).accepted,true);
  await scanner.cycle();assert.equal(audited.length,2);assert.equal(audited[0],fresh(4).address);
  assert.equal(scanner.activeChain,'bsc');assert.equal(scanner.requestedReviews.size,0);
});

function dispatch(server,route,body,origin=true) {
  return new Promise((resolve,reject)=>{
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='POST';req.url=route;req.socket={remoteAddress:'127.0.0.1'};
    req.headers={host:'127.0.0.1:3791','content-type':'application/json',...(origin?{origin:'http://127.0.0.1:3791'}:{})};
    const res={writeHead(status){this.status=status;},end(body){resolve({status:this.status,body:JSON.parse(body)});}};
    Promise.resolve(server.listeners('request')[0](req,res)).catch(reject);
  });
}

test('live endpoints require same-origin exact schema and return no raw data or trade authority', async () => {
  const root=fileURLToPath(new URL('../',import.meta.url));
  let touches=0,queued=0;
  const live={touch:chain=>{touches++;return {chain,rows:[{address}],execution:false};},auditRow:()=>token()};
  const server=createServer({state:{value:{activeChain:'bsc',candidates:[{address,status:'HARD_REJECT',auditedAt:now,raw:'secret'}]}},settings:{...config,publicDir:path.join(root,'public')},
    liveDiscovery:live,enqueueReview:()=>{queued++;return {accepted:true};}});
  assert.equal((await dispatch(server,'/api/live-discovery',{chain:'bsc'},false)).status,403);
  assert.equal((await dispatch(server,'/api/live-discovery',{chain:'bsc',force:true})).status,400);
  assert.equal((await dispatch(server,'/api/live-discovery',{chain:'unknown'})).status,400);
  const response=await dispatch(server,'/api/live-discovery',{chain:'bsc'});
  assert.equal(touches,1);assert.equal(response.body.execution,false);assert.equal(response.body.rows.length,0);
  assert.equal(response.body.diagnostics.excluded,1);
  assert.doesNotMatch(JSON.stringify(response),/secret/);
  assert.equal((await dispatch(server,'/api/live-review',{chain:'bsc',address})).status,200);assert.equal(queued,1);
});
