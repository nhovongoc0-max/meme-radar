#!/usr/bin/env node
import { config, ROOT } from './config.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AveClient } from './ave.mjs';
import { createUpdater } from './updater.mjs';
import { createAveSettings } from './ave-settings.mjs';
import { RadarState } from './state.mjs';
import { Scanner } from './scanner.mjs';
import { DexBatchMarketOverlay, SecondaryValidator } from './secondary.mjs';
import { createServer, toPublicStatus } from './server.mjs';
import { RadarControls } from './local-store.mjs';
import { LiveDiscovery } from './live-discovery.mjs';
import { configureWindowsSystemProxy } from './windows-proxy.mjs';

// Browsers use the Windows system proxy automatically, while Node normally
// only sees proxy environment variables. Mirror the effective Windows proxy
// before AVE reads begin so the portable build follows the same
// network route as the user's browser.
const proxy = configureWindowsSystemProxy();
if (process.platform === 'win32') {
  console.log(proxy.proxy ? '已接入 Windows 系统网络代理。' : '未检测到 Windows 系统代理，将使用直连网络。');
}

const once = process.argv.includes('--once');
const state = new RadarState(config.stateDir);
let scanner;
// Production discovery deliberately performs one hot-list read per turn. The
// current AVE head response already carries the card fields; pagination and
// automatic per-token completion must not amplify a shared-key rate limit.
const market = new AveClient({ directory: config.stateDir, apiKeyProvider: () => ave.getKey(), enrichLimit: 0,
  maxTrendingPages: 1, rotateTrendingPages: true, minimumGapMs: 5 * 60_000 });
const ave = createAveSettings({ directory: config.stateDir,
  verifyData: key => market.verifyApiKey(key),
  onChange: () => { market.resetCredentials(); scanner?.requestCycle(); }
});
// Keep old history and credentials on disk, but never reuse a GMGN pass as
// current AVE evidence. No GMGN client, worker or key store is loaded here.
if (state.value.scanProvider !== 'AVE') {
  for (const scope of [state.value, ...Object.values(state.value.chainStates || {})]) {
    for (const row of scope.candidates || []) {
      if (row.status === 'X_REVIEW') {
        row.status = 'WAIT_RECHECK'; row.staleAt = 0;
        row.deep = { ...row.deep, chainPass: false };
        row.decisionReason = '已切换 AVE，等待新来源核验';
      }
    }
    scope.sourceHealth = {}; scope.retryAt = 0;
  }
  state.value.scanProvider = 'AVE'; state.save();
}
const controls = new RadarControls(config.stateDir, config.supportedChains, state.value.activeChain || config.chain);
scanner = new Scanner({ provider: market, secondary: new SecondaryValidator(), state, controls });
const liveDiscovery = new LiveDiscovery({ provider: market, cacheOnly: true, marketOverlay: new DexBatchMarketOverlay() });
const updater = createUpdater({ root: ROOT, port: config.port });
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

if (once) {
  await scanner.cycle();
  console.log(JSON.stringify(toPublicStatus(state.value), null, 2));
  process.exit(state.value.status === 'ERROR' ? 1 : 0);
}

const server = createServer({
  ave,
  state,
  controls,
  liveDiscovery,
  enqueueReview: (chain, row) => scanner.enqueueReview(chain, row),
  settings: { ...config, version },
  supportedChains: config.supportedChains,
  switchChain: chain => scanner.switchChain(chain),
  getAveConnection: () => ave.snapshot(),
  getMarketStatus: () => market.snapshot(),
  updater,
  onUpdateReady: () => shutdown(false)
});
server.requestTimeout = 10_000;
server.headersTimeout = 12_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.port, '127.0.0.1', resolve);
});
console.log(`Meme雷达：http://127.0.0.1:${config.port}`);
console.log('只读扫描器：交易执行永久关闭');
let closing = false;
function shutdown(stopUpdate = true) {
  if (closing) return;
  closing = true; scanner.stop(); liveDiscovery.stop();
  market.resetCredentials({ disabled: true });
  if (stopUpdate) updater.stop();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown());
await scanner.start();
