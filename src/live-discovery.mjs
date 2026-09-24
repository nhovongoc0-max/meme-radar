import { normalizeList } from './ave.mjs';
import { discoveryScreen, knownRiskReasons } from './scoring.mjs';
import { config } from './config.mjs';
import { validTokenAddress } from './address.mjs';

const number = value => value === null || value === undefined || value === '' || typeof value === 'boolean'
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const count = value => { const n = number(value); return n !== null && n >= 0 && Number.isInteger(n) ? n : null; };
const rate = value => { const n = number(value); return n !== null && n >= 0 && n <= 1 ? n : null; };
const flag = value => ['1', 'true', 'yes'].includes(String(value).toLowerCase()) ? true
  : ['0', 'false', 'no'].includes(String(value).toLowerCase()) ? false : null;
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
const safeText = (value, max) => /gmgn_[a-z0-9]{8,}|bearer\s|api[_ -]?key|private[_ -]?key/i.test(String(value)) ? '?' : text(value, max);
const identity = (chain, value) => chain === 'sol' ? value : value.toLowerCase();
const addressValid = (chain, value) => validTokenAddress(chain, value);
const safeUrl = value => {
  try { const url = new URL(String(value)); return url.protocol === 'https:' && !url.username && !url.password ? url.href.slice(0, 500) : ''; }
  catch { return ''; }
};
const waitingReasons = new Set(['AVE 行情已过期或原始时间未核验', '市值原始时间待更新',
  '池龄或首笔成交时间未知', '市值数据未知', '流动性数据未知', '近5分钟成交额不足或未知', '价格数据未知']);
function aveDisplayState(raw, chain, at) {
  const screen = discoveryScreen(raw, { ...config, chain }, at / 1000);
  const visible = screen.pass || screen.reasons.every(reason => waitingReasons.has(reason));
  const missing = !(number(raw.liquidity) > 0) || !(number(raw.volume_5m) > 0) || !(screen.createdAt > 0) || !(number(raw.market_cap) > 0);
  return { screen, visible, state: screen.pass ? 'READY' : missing ? 'PENDING' : 'STALE' };
}
export function discoveryDiagnostics(input, chain, at = Date.now()) {
  const summary = { received: input.length, inRange: 0, pending: 0, stale: 0, ready: 0, excluded: 0, outsideRange: 0 };
  for (const raw of input.slice(0, 300)) {
    if (raw?.marketProvider !== 'AVE' || !addressValid(chain, raw.address) || raw.chain !== chain) { summary.excluded++; continue; }
    const { screen, visible, state } = aveDisplayState(raw, chain, at);
    if (screen.mc >= config.discoveryMinMarketCap && screen.mc <= config.discoveryMaxMarketCap) summary.inRange++;
    if (screen.reasons.includes('市值不在发现范围')) summary.outsideRange++;
    if (!visible) summary.excluded++;
    else summary[state.toLowerCase()]++;
  }
  return summary;
}

export function liveRequestArgs(chain) {
  return ['market', 'trending', '--chain', chain, '--interval', '1m', '--limit', '100',
    '--order-by', 'volume', '--direction', 'desc', '--min-created', '5m',
    '--min-marketcap', '10000', '--max-marketcap', '500000', '--min-liquidity', '3000', '--raw'];
}

// This is a discovery snapshot, never an audit verdict. No extra per-token reads.
export function normalizeLiveRows(input, chain, previous = [], at = Date.now(), initialized = false) {
  const before = new Map(previous.map(row => [identity(chain, row.address), row]));
  const unique = new Map();
  for (const raw of input.slice(0, 300)) {
    if (!raw || !addressValid(chain, raw.address) || (raw.chain && raw.chain !== chain)) continue;
    const address = identity(chain, raw.address);
    if (raw.marketProvider === 'AVE') {
      const { screen, visible, state } = aveDisplayState(raw, chain, at);
      if (!visible) continue;
      const stale = !screen.pass;
      const old = before.get(address), observedAt = number(raw.sourceUpdatedAt), elapsed = old ? observedAt - old.observedAt : 0;
      const comparable = !stale && old?.marketProvider === 'AVE' && elapsed >= 5000 && elapsed <= 120000;
      const price = number(raw.price), holders = count(raw.holder_count);
      const holderAt = number(raw.tokenSourceUpdatedAt ?? raw.sourceUpdatedAt);
      const holderComparable = comparable && holderAt > (old?.holderSourceUpdatedAt || 0);
      unique.set(address, {
        address, chain, marketProvider: 'AVE', symbol: safeText(raw.symbol || '?', 30), name: safeText(raw.name, 80),
        marketCap: number(raw.market_cap), liquidity: number(raw.liquidity), createdAt: screen.createdAt, ageBasis: screen.ageBasis,
        price: price > 0 ? price : null, volume1m: null, buys1m: null, sells1m: null, swaps1m: null,
        volume5m: number(raw.volume_5m), buys5m: count(raw.buys_5m), sells5m: count(raw.sells_5m), activityWindow: '5m',
        holders, smartMoney: null, observedAt, capturedAt: number(raw.capturedAt), sourceUpdatedAt: observedAt,
        expiresAt: number(raw.expiresAt), holderSourceUpdatedAt: holderAt, stale, discoveryState: state,
        firstSeenAt: old?.firstSeenAt || at, newAt: old?.newAt || (initialized && !old ? at : 0),
        deltaWindowMs: comparable ? elapsed : null, priceDelta: comparable && price > 0 && old.price > 0 ? price / old.price - 1 : null,
        holdersDelta: holderComparable && holders !== null && old.holders !== null ? holders - old.holders : null, smartDelta: null,
        priorityBand: screen.priorityBand, hasUnknownRisk: true, auditEligible: screen.pass,
        pairAddress: raw.pairAddress, website: safeUrl(raw.website), twitter: safeText(raw.twitter_username, 80)
      });
      continue;
    }
    if (knownRiskReasons(raw, config).length) continue;
    const mc = number(raw.market_cap), liquidity = number(raw.liquidity), created = number(raw.creation_timestamp);
    if (mc === null || mc < 10000 || mc > 500000 || liquidity === null || liquidity < 3000
      || created === null || created <= 0 || at / 1000 - created < 300) continue;
    if (flag(raw.is_wash_trading) === true || (chain !== 'sol' && flag(raw.is_honeypot) === true)
      || [raw.rug_ratio, raw.bundler_rate, raw.rat_trader_amount_rate].some(value => rate(value) !== null && rate(value) > .3)) continue;
    const old = before.get(address);
    const elapsed = old ? at - old.observedAt : 0;
    const comparable = elapsed >= 5000 && elapsed <= 120000;
    const price = number(raw.price), holders = count(raw.holder_count), smart = count(raw.smart_degen_count);
    const hasUnknownRisk = [raw.rug_ratio, raw.bundler_rate, raw.rat_trader_amount_rate].some(value => rate(value) === null)
      || flag(raw.is_wash_trading) === null || (chain !== 'sol' && flag(raw.is_honeypot) === null);
    unique.set(address, {
      address, chain, symbol: safeText(raw.symbol || '?', 30), name: safeText(raw.name, 80),
      marketCap: mc, liquidity, createdAt: created, price: price !== null && price > 0 ? price : null,
      volume1m: number(raw.volume) >= 0 ? number(raw.volume) : null,
      buys1m: count(raw.buys), sells1m: count(raw.sells), swaps1m: count(raw.swaps), holders, smartMoney: smart,
      observedAt: at, firstSeenAt: old?.firstSeenAt || at,
      newAt: old?.newAt || (initialized && !old ? at : 0),
      deltaWindowMs: comparable ? elapsed : null,
      priceDelta: comparable && price > 0 && old.price > 0 ? price / old.price - 1 : null,
      holdersDelta: comparable && holders !== null && old.holders !== null ? holders - old.holders : null,
      smartDelta: comparable && smart !== null && old.smartMoney !== null ? smart - old.smartMoney : null,
      priorityBand: mc >= 20000 && mc <= 80000, hasUnknownRisk,
      website: safeUrl(raw.website), twitter: safeText(raw.twitter_username, 80),
      auditEligible: discoveryScreen(raw, { ...config, chain }, at / 1000).pass
    });
  }
  return [...unique.values()].sort((a, b) => (b.marketProvider === 'AVE' ? b.volume5m || 0 : b.volume1m || 0) - (a.marketProvider === 'AVE' ? a.volume5m || 0 : a.volume1m || 0));
}

export class LiveDiscovery {
  constructor({ provider, gmgn, settings = config, now = Date.now, intervalMs = 20000, leaseMs = 30000, schedule = setTimeout, cancel = clearTimeout,
    cacheOnly = false, marketOverlay = null }) {
    this.provider = provider || gmgn; this.gmgn = this.provider;
    this.providerName = provider ? 'AVE' : 'GMGN'; this.controller = null;
    this.cacheOnly = cacheOnly;
    this.marketOverlay = marketOverlay;
    this.settings = settings; this.now = now; this.intervalMs = Math.max(20000, intervalMs);
    this.leaseMs = leaseMs; this.schedule = schedule; this.cancel = cancel;
    this.states = new Map(); this.raw = new Map(); this.focus = ''; this.leaseUntil = 0;
    this.nextPollAt = 0; this.running = false; this.timer = null; this.stopped = false; this.epoch = this.provider.keyEpoch;
  }

  async enrichMarket(chain, rows) {
    if (!this.marketOverlay || typeof this.marketOverlay.enrich !== 'function') return rows;
    try {
      const enriched = await this.marketOverlay.enrich(chain, rows, {
        minMarketCap: this.settings.discoveryMinMarketCap,
        maxMarketCap: this.settings.discoveryMaxMarketCap
      });
      return Array.isArray(enriched) ? enriched : rows;
    } catch { return rows; }
  }

  syncCredentials() {
    if (this.epoch !== this.provider.keyEpoch) {
      this.states.clear(); this.raw.clear(); this.epoch = this.provider.keyEpoch;
    }
  }

  touch(chain) {
    if (!this.settings.supportedChains.includes(chain)) throw new Error('unsupported_chain');
    this.syncCredentials(); this.focus = chain; this.leaseUntil = this.now() + this.leaseMs;
    if (!this.timer && !this.running && !this.stopped) this.arm();
    return this.snapshot(chain);
  }

  async readSnapshot(chain) {
    this.touch(chain);
    if (!this.cacheOnly || this.stopped) return this.snapshot(chain);
    // Production reads only the scanner's in-memory cache. Do not wait for
    // the single focused-tab timer: another tab/chain could starve this view.
    try {
      if (!await this.provider.configured()) return { ...this.snapshot(chain), status: 'AUTH_REQUIRED' };
      this.syncCredentials(); const epoch = this.provider.keyEpoch;
      const result = await this.provider.live(chain, { refresh: false });
      if (epoch !== this.provider.keyEpoch || this.stopped) return this.snapshot(chain);
      if (!Array.isArray(result?.tokens)) throw new Error('invalid_cached_result');
      const input = await this.enrichMarket(chain, result.tokens);
      if (epoch !== this.provider.keyEpoch || this.stopped) return this.snapshot(chain);
      const now = this.now(), old = this.states.get(chain) || { rows: [], lastSuccessAt: 0, pollCount: 0 };
      const rows = normalizeLiveRows(input, chain, old.rows, now, old.lastSuccessAt > 0);
      const capturedAt = rows.length ? Math.max(...rows.map(row => row.capturedAt || 0)) : number(result.capturedAt) || 0;
      this.states.set(chain, { ...old, rows, status: capturedAt ? 'READY' : 'WAITING', marketProvider: 'AVE',
        lastPollAt: now, lastSuccessAt: capturedAt, receivedCount: result.tokens.length,
        filteredCount: Math.max(0, result.tokens.length - rows.length), diagnostics: discoveryDiagnostics(input, chain, now) });
      this.raw.set(chain, new Map(input.filter(row => row && addressValid(chain, row.address)
        && rows.some(item => identity(chain, row.address) === item.address)).map(row => [identity(chain, row.address), row])));
    } catch { return { ...this.snapshot(chain), status: 'ERROR' }; }
    return this.snapshot(chain);
  }

  arm() {
    if (this.stopped || !this.focus || this.now() >= this.leaseUntil) return;
    const wait = Math.max(0, this.nextPollAt - this.now(), this.cacheOnly ? 0 : (this.provider.nextAllowedAt || 0) - this.now());
    this.timer = this.schedule(() => { this.timer = null; void this.poll(); }, Math.min(wait, 60000));
    this.timer?.unref?.();
  }

  async poll() {
    if (this.running || this.stopped || !this.focus || this.now() >= this.leaseUntil) return;
    if (this.now() < this.nextPollAt || !this.cacheOnly && this.now() < (this.provider.nextAllowedAt || 0)) { this.arm(); return; }
    this.syncCredentials();
    const chain = this.focus, at = this.now(); let epoch = this.provider.keyEpoch;
    let old = this.states.get(chain) || { rows: [], lastSuccessAt: 0, pollCount: 0 };
    const controller = new AbortController(); this.controller = controller;
    this.running = true; this.nextPollAt = at + this.intervalMs;
    this.states.set(chain, { ...old, status: 'LOADING', lastAttemptAt: at });
    try {
      if (!await this.provider.configured()) {
        this.states.set(chain, { ...old, status: 'AUTH_REQUIRED', lastAttemptAt: at }); return;
      }
      this.syncCredentials(); epoch = this.provider.keyEpoch;
      old = this.states.get(chain)?.status === 'LOADING' ? old : this.states.get(chain) || { rows: [], lastSuccessAt: 0, pollCount: 0 };
      const ave = this.providerName === 'AVE' || typeof this.provider.live === 'function';
      if (ave && typeof this.provider.live !== 'function') throw new Error('invalid_live_provider');
      // The legacy run branch is retained only for injected GMGN test clients.
      // Production AVE always uses its shared read-only scanner/live cache.
      const result = ave ? await this.provider.live(chain, { signal: controller.signal, refresh: !this.cacheOnly })
        : await this.provider.run(liveRequestArgs(chain), { deadline: Date.now() + 25000, signal: controller.signal });
      if (this.stopped || controller.signal.aborted || epoch !== this.provider.keyEpoch) return;
      let payload = result;
      for (let i = 0; i < 3 && payload && !Array.isArray(payload) && payload.data != null; i++) payload = payload.data;
      if (ave ? !Array.isArray(result?.tokens) : !Array.isArray(payload) && !Array.isArray(payload?.rank)) throw new Error('invalid_live_response');
      const input = ave ? await this.enrichMarket(chain, result.tokens) : normalizeList(result, ['rank']);
      if (this.stopped || controller.signal.aborted || epoch !== this.provider.keyEpoch) return;
      const now = this.now();
      const rows = normalizeLiveRows(input, chain, old.rows, now, old.lastSuccessAt > 0);
      const capturedAt = ave ? rows.length ? Math.max(...rows.map(row => row.capturedAt || 0)) : number(result.capturedAt) || 0 : now;
      this.states.set(chain, { rows, status: this.cacheOnly && !capturedAt ? 'WAITING' : 'READY', marketProvider: ave ? 'AVE' : undefined, lastAttemptAt: at, lastPollAt: now, lastSuccessAt: capturedAt,
        requestMs: now - at, pollCount: old.pollCount + 1, receivedCount: input.length, filteredCount: Math.max(0, input.length - rows.length),
        ...(ave ? { diagnostics: discoveryDiagnostics(input, chain, now) } : {}) });
      this.raw.set(chain, new Map(input.filter(row => row && addressValid(chain, row.address) && rows.some(x => identity(chain, row.address) === x.address))
        .map(row => [identity(chain, row.address), row])));
    } catch (error) {
      if (this.stopped || controller.signal.aborted || epoch !== this.provider.keyEpoch) return;
      const status = error.code === 'AVE_TOTAL_BUDGET' ? 'TOTAL_BUDGET_PAUSED' : error.code === 'AVE_HOURLY_BUDGET' ? 'HOURLY_BUDGET_PAUSED'
        : error.code === 'AVE_BUDGET' ? 'BUDGET_PAUSED' : error.code === 'AVE_QUOTA' ? 'QUOTA_PAUSED'
        : ['GMGN_RATE_LIMITED', 'AVE_RATE_LIMITED'].includes(error.code) ? 'RATE_LIMITED'
        : ['GMGN_AUTH_FAILED', 'GMGN_PERMISSION_DENIED', 'AVE_AUTH', 'AVE_CONFIG', 'AVE_DISABLED'].includes(error.code) ? 'AUTH_REQUIRED' : 'ERROR';
      this.states.set(chain, { ...old, status, lastAttemptAt: at, code: String(error.code || 'READ_FAILED') });
      this.nextPollAt = Math.max(this.nextPollAt, number(error.retryAt) || 0, this.now() + (status === 'AUTH_REQUIRED' ? 60000 : status === 'ERROR' ? 30000 : error.retryAfterMs || 0));
    } finally { if (this.controller === controller) this.controller = null; this.running = false; this.arm(); }
  }

  snapshot(chain) {
    this.syncCredentials();
    const state = this.states.get(chain) || { status: 'WAITING', rows: [], lastSuccessAt: 0, pollCount: 0 };
    let pauseCode; try { pauseCode = this.provider.snapshot?.().pauseCode; } catch { /* Optional public provider health. */ }
    const pausedStatus = pauseCode === 'AVE_TOTAL_BUDGET' ? 'TOTAL_BUDGET_PAUSED' : pauseCode === 'AVE_HOURLY_BUDGET' ? 'HOURLY_BUDGET_PAUSED'
      : pauseCode === 'AVE_BUDGET' ? 'BUDGET_PAUSED' : pauseCode === 'AVE_QUOTA' ? 'QUOTA_PAUSED' : 'RATE_LIMITED';
    const rows = state.rows.map(row => {
      if (row.marketProvider !== 'AVE') return row;
      const stale = row.stale || this.now() - row.sourceUpdatedAt > 60000 || row.expiresAt !== null && row.expiresAt <= this.now();
      return { ...row, stale, auditEligible: row.auditEligible && !stale,
        discoveryState: row.discoveryState === 'READY' && stale ? 'STALE' : row.discoveryState };
    });
    const diagnostics = state.diagnostics ? { ...state.diagnostics, ready: rows.filter(row => row.auditEligible).length,
      stale: rows.filter(row => row.discoveryState === 'STALE').length } : undefined;
    return structuredClone({ ...state, rows, chain, intervalMs: this.intervalMs, execution: false,
      ...(diagnostics ? { diagnostics } : {}),
      nextPollAt: this.cacheOnly ? this.nextPollAt : Math.max(this.nextPollAt, this.provider.nextAllowedAt || 0),
      status: this.provider.disabled ? 'AUTH_REQUIRED' : pauseCode === 'AVE_TOTAL_BUDGET' || this.provider.nextAllowedAt > this.now() ? pausedStatus : state.status,
      stale: !state.lastSuccessAt || this.now() - state.lastSuccessAt > 60000 || rows.length > 0 && rows.every(row => row.stale === true) });
  }

  auditRow(chain, address) {
    this.syncCredentials();
    if (this.provider.snapshot?.().recovery?.auditAllowed === false) return null;
    const snapshot = this.snapshot(chain);
    if (snapshot.stale || this.provider.disabled || snapshot.status === 'AUTH_REQUIRED') return null;
    const row = this.raw.get(chain)?.get(identity(chain, address));
    if (!row) return null;
    if (row.marketProvider === 'AVE' && !discoveryScreen(row, { ...this.settings, chain }, this.now() / 1000).pass) return null;
    // Interval-specific counters must never masquerade as five-minute counters.
    const { volume, swaps, buys, sells, price_change_percent, ...audit } = row;
    return structuredClone(audit);
  }

  stop() { this.stopped = true; this.controller?.abort(); if (this.timer) this.cancel(this.timer); this.timer = null; }
}
