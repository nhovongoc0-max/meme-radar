import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.mjs';
import { GmgnClient, requestWeight, tokenInfoPrice, translateGmgnError } from '../src/gmgn.mjs';
import { collectOutcomeSamples, dueOutcomeJobs, outcomeCoverage, sampleRejected } from '../src/outcomes.mjs';
import { RadarControls, atomicJson, readJsonWithBackup, tokenKey } from '../src/local-store.mjs';
import { GmgnKeyStore } from '../src/gmgn-key-store.mjs';
import { GmgnConnection } from '../src/gmgn-connection.mjs';
import { RadarState } from '../src/state.mjs';
import { Scanner, reviewRevision } from '../src/scanner.mjs';
import { createServer } from '../src/server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const address = '0x' + '1'.repeat(40);
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-v3-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('weighted request pacing, bounded cache and credential invalidation', async () => {
  assert.equal(requestWeight(['token','holders']), 5);
  assert.equal(requestWeight(['market','trenches']), 3);
  const client = new GmgnClient();
  let calls = 0;
  client.run = async () => ({ count: ++calls });
  const args = ['token','security','--chain','bsc','--address',address];
  assert.equal((await client.cachedRead(args, 60000)).count, 1);
  assert.equal((await client.cachedRead(args, 60000)).count, 1);
  client.nextAllowedAt = Date.now() + 60000;
  client.resetCredentials();
  assert.equal((await client.cachedRead(args, 60000)).count, 2);
  assert.ok(client.nextAllowedAt > Date.now());
  assert.equal(client.metrics.cacheHits, 1);
  assert.equal(tokenInfoPrice({ price: { price: '0.025' } }), 0.025);
  assert.equal(tokenInfoPrice({ price: '' }), null);
  const cooldown = translateGmgnError({ status: 429, resetAtUnix: Math.ceil(Date.now()/1000) + 120 });
  assert.ok(cooldown.retryAfterMs >= 120000);
});

test('confirmed static rejection skips expensive wallet and candle reads', async () => {
  const client = new GmgnClient(); const commands = [];
  client.run = async args => { commands.push(args[1]); return { data: { is_honeypot: 'yes' } }; };
  const audit = await client.audit(address, 1800000000, 'bsc', { shouldStopEarly: partial => partial.security.is_honeypot === 'yes' });
  assert.deepEqual(commands, ['info','security','pool']);
  assert.equal(audit._meta.earlyExit, true);
  assert.equal(audit._meta.complete, false);
});

test('historical samples survive delisting; missing prices stay missing and retries back off', async () => {
  const now = 1800000000000;
  const rows = [{ address, chain: 'bsc', baselineAt: now-1900000, baselinePrice: 2, initialDecision:'X_REVIEW', samples: {} }];
  const calls = [];
  const gmgn = { priceAt: async (a, at, chain) => { calls.push([a,at,chain]); return { at, price: 3, source: 'GMGN_1M_CLOSE' }; } };
  await collectOutcomeSamples(rows, gmgn, 'bsc', { now: () => now, limit: 3 });
  assert.equal(rows[0].samples.m30.return, .5);
  assert.equal(calls.length, 3);
  assert.equal(rows[0].samples.h2, undefined);
  const missing = [{ ...rows[0], samples: {} }];
  await collectOutcomeSamples(missing, { priceAt: async () => null }, 'bsc', { now: () => now, limit: 3 });
  assert.deepEqual(missing[0].samples, {});
  assert.equal(dueOutcomeJobs(missing, now).length, 0);
  assert.equal(outcomeCoverage(missing, now).passed.m30.missing, 1);
  assert.equal(outcomeCoverage(missing, now).passed.h24.eligible, 0);
});

test('priceAt selects timestamped closed candles, not current price or future bars', async () => {
  const client = new GmgnClient();
  const target = Date.now() - 86400000;
  client.run = async () => ({ list: [{ time: target - 60000, close: '2' }, { time: Date.now()+60000, close:'99' }] });
  assert.deepEqual(await client.priceAt(address, target, 'bsc'), { at: target, price:2, source:'GMGN_1M_CLOSE' });
});

test('rejection cohort is deterministic and separated from passed outcomes', () => {
  const rows = [];
  for (let i=1;i<100;i++) sampleRejected(rows, { chain:'bsc', address:'0x'+i.toString(16).padStart(40,'0'), price: 1, status:'HARD_REJECT' }, 10);
  assert.ok(rows.length > 5 && rows.length < 40);
  const count = rows.length;
  for (const row of [...rows]) sampleRejected(rows, { ...row, price:1, status:'HARD_REJECT' }, 20);
  assert.equal(rows.length, count);
  assert.equal(outcomeCoverage(rows, 1900000).passed.m30.eligible, 0);
  assert.equal(outcomeCoverage(rows, 1900000).rejected.m30.eligible, count);
});

test('local store recovers last good JSON; unrecoverable data is not silently reset', t => {
  const dir = temp(t); const file = path.join(dir,'state.json');
  atomicJson(file,{n:1}); atomicJson(file,{n:2});
  fs.writeFileSync(file,'broken');
  assert.deepEqual(readJsonWithBackup(file,{}), {value:{n:1},recovered:true});
  atomicJson(file,{n:3});
  assert.equal(JSON.parse(fs.readFileSync(file+'.bak')).n,1);
  fs.writeFileSync(file,'broken'); fs.writeFileSync(file+'.bak','broken');
  assert.throws(() => readJsonWithBackup(file,{}), {code:'STATE_CORRUPT'});
});

test('favorites and notes persist with exact Solana keys, bounded input and safe chain selection', t => {
  const dir=temp(t); const controls = new RadarControls(dir, config.supportedChains,'robinhood');
  const a='So11111111111111111111111111111111111111112', b='so11111111111111111111111111111111111111112';
  controls.annotate({chain:'sol',address:a,favorite:true,note:'hello'});
  controls.annotate({chain:'sol',address:b,favorite:false,note:'different'});
  assert.notEqual(tokenKey('sol',a),tokenKey('sol',b));
  assert.equal(Object.keys(controls.value.annotations).length,2);
  controls.setChains(['sol','bsc','base']);
  assert.deepEqual(new RadarControls(dir,config.supportedChains,'robinhood').value.enabledChains,['sol','bsc','base']);
  assert.throws(() => controls.setChains(['sol','bsc','eth','base']));
  assert.throws(() => controls.annotate({chain:'bsc',address:'../../x',favorite:true,note:'x'}));
});

test('disconnect survives reload and never falls back to legacy credentials; verification races cannot restore it', async t => {
  const dir=temp(t); const store=new GmgnKeyStore(dir); const key='gmgn_'+'a'.repeat(32);
  store.save(key);
  store.onboarding();
  const gmgn=new GmgnClient({ apiKeyProvider:()=>store.get(), legacyKeyProvider:()=>key });
  let finish;
  gmgn.verifyApiKey=()=>new Promise(resolve=>{finish=resolve;});
  const connection=new GmgnConnection({gmgn,keyStore:store,scanner:{activeChain:'bsc',requestCycle(){}}});
  const pending=connection.apply(key);
  connection.disconnect(); finish({verified:true});
  await assert.rejects(pending,{code:'GMGN_CHECK_CANCELLED'});
  assert.equal(gmgn.apiKey(),'');
  assert.equal(new GmgnKeyStore(dir).disconnected(),true);
  assert.equal(store.get(),'');
  gmgn.verifyApiKey=async()=>({verified:true});
  await connection.apply(key);
  assert.equal(store.disconnected(),false);
  assert.equal(gmgn.apiKey(),key);
});

test('UI approval is case-sensitive on Solana and expires on risk revision changes', () => {
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  const start=html.indexOf('function addressIdentity('), end=html.indexOf('function rowMatches(',start);
  const context={ Date, manualMarks:{}, lastData:{}, activeChain:()=> 'sol', candidateAuditAge:()=>0, t:x=>x, escapeHtml:x=>x };
  vm.runInNewContext(html.slice(start,end)+'\nthis.key=addressIdentity; this.status=effectiveStatus;',context);
  const a='So11111111111111111111111111111111111111112', b=a.replace(/^S/,'s');
  context.manualMarks['sol:'+a]={decision:'passed',at:Date.now(),reviewRevision:'r1'};
  assert.equal(context.status({address:a,status:'X_REVIEW',reviewRevision:'r1'}),'passed');
  assert.equal(context.status({address:b,status:'X_REVIEW',reviewRevision:'r1'}),'chain');
  assert.equal(context.status({address:a,status:'X_REVIEW',reviewRevision:'r2'}),'chain');
  assert.notEqual(reviewRevision({status:'X_REVIEW'}),reviewRevision({status:'HARD_REJECT'}));
});

test('scanner batch audits multiple candidates, saves per-chain history, and multi-chain view does not interrupt work', async t => {
  const dir=temp(t); const state=new RadarState(dir); const controls=new RadarControls(dir,config.supportedChains,'bsc');
  state.value.activeChain='bsc';
  let audited=0;
  const gmgn={ configured:async()=>true, discover:async()=>Array.from({length:5},(_,i)=>({address:'0x'+String(i+1).padStart(40,'0'),symbol:'TEST',price:1,market_cap:50000,liquidity:10000,
    creation_timestamp:Date.now()/1000-1000,rug_ratio:.1,bundler_rate:.1,rat_trader_amount_rate:.1,is_wash_trading:false,is_honeypot:0})),
    audit:async()=>{audited++;return {info:{price:{price:'1'}},security:{owner_renounced:'no'},pool:{},holders:[],traders:[],candles:[],_meta:{complete:true}};} };
  const scanner=new Scanner({gmgn,state,controls,settings:{...config,maxDeepAuditsPerCycle:6}});
  await scanner.cycle();
  assert.equal(audited,5);
  assert.equal(state.value.auditQueueStats.auditedThisCycle,5);
  assert.equal(state.value.chainStates.bsc.scanCount,1);
  controls.setChains(['bsc','sol']); scanner.running=true;
  assert.equal(scanner.switchChain('sol').queued,false);
  assert.equal(scanner.activeChain,'bsc');
  assert.equal(scanner.pendingChain,'');
});

function dispatch(server, method, route, body, origin=true) {
  return new Promise((resolve,reject)=>{
    const req=Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method=method;req.url=route;req.socket={remoteAddress:'127.0.0.1'};
    req.headers={host:'127.0.0.1:3791','content-type':'application/json',...(origin?{origin:'http://127.0.0.1:3791'}:{})};
    const result={headers:{}};
    const res={setHeader(k,v){result.headers[k]=v;},writeHead(status,headers){result.status=status;Object.assign(result.headers,headers);},end(body){result.body=JSON.parse(body);resolve(result);}};
    Promise.resolve(server.listeners('request')[0](req,res)).catch(reject);
  });
}

test('settings endpoints validate origin/schema; view/export exposes whitelisted records only', async t=>{
  const dir=temp(t), controls=new RadarControls(dir,config.supportedChains,'bsc');
  const state={value:{activeChain:'bsc',status:'RUNNING',supportedChains:config.supportedChains,
    privateKey:'do-not-leak',candidates:[{ address, status:'HARD_REJECT', auditHealth:{earlyExit:true,private:'do-not-leak'}, deep:{wallets:{botHoldRate:0,linkedHoldRate:0,ordinaryCount:0},sellability:{distinctSellers:0}} }],chainStates:{sol:{scanCount:5,candidates:[]}},outcomes:[{address,baselinePrice:1,raw:'do-not-leak',samples:{m30:{return:.1,price:1.1,private:'do-not-leak'}}}]}};
  const server=createServer({state,controls,settings:{...config,publicDir:path.join(root,'public')},disconnectGmgnKey:()=>({disconnected:true})});
  assert.equal((await dispatch(server,'POST','/api/scan-chains',{chains:['sol','bsc']})).status,200);
  assert.equal((await dispatch(server,'POST','/api/scan-chains',{chains:['sol'],trade:true})).status,400);
  assert.equal((await dispatch(server,'POST','/api/gmgn-disconnect',{},false)).status,403);
  assert.equal((await dispatch(server,'POST','/api/gmgn-disconnect',{})).body.disconnected,true);
  const status=await dispatch(server,'GET','/api/status?chain=sol');
  assert.equal(status.body.activeChain,'sol'); assert.equal(status.body.scanCount,5);
  assert.equal(status.body.scheduler.scanningChain,'bsc');
  const exported=await dispatch(server,'GET','/api/export');
  assert.equal(exported.body.chains.bsc.outcomes[0].samples.m30.return,.1);
  const skipped = exported.body.chains.bsc.candidates[0];
  assert.equal(skipped.auditHealth.earlyExit,true);
  assert.equal(skipped.deep.wallets.botHoldRate,null);
  assert.equal(skipped.deep.wallets.linkedHoldRate,null);
  assert.equal(skipped.deep.sellability.distinctSellers,null);
  assert.doesNotMatch(JSON.stringify(exported),/do-not-leak/);
  assert.equal((await dispatch(server,'GET','/api/status?chain=not-a-chain')).status,400);
});
