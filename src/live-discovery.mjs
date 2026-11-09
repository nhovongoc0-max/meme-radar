import { discoveryScreen } from './scoring.mjs';
import { config } from './config.mjs';
import { validTokenAddress } from './address.mjs';
import { LeadSignals, publicLeadSignal } from './lead-signals.mjs';

const number = value => value === null || value === undefined || value === '' || typeof value === 'boolean'
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const count = value => { const n = number(value); return n !== null && n >= 0 && Number.isInteger(n) ? n : null; };
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
const safeText = (value, max) => /gmgn_[a-z0-9]{8,}|bearer\s|api[_ -]?key|private[_ -]?key/i.test(String(value)) ? '?' : text(value, max);
const identity = (chain, value) => chain === 'sol' ? value : value.toLowerCase();
const addressValid = (chain, value) => validTokenAddress(chain, value);
const identityHistoryMs = 7 * 24 * 60 * 60_000;
const clock = (value, at) => { const n = number(value); return n !== null && n > 0 && n <= at ? n : null; };
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

// This is a discovery snapshot, never an audit verdict. No extra per-token reads.
export function normalizeLiveRows(input, chain, previous = [], at = Date.now(), initialized = false) {
  const before = new Map(previous.map(row => [identity(chain, row.address), row]));
  const unique = new Map();
  for (const raw of input.slice(0, 300)) {
    // Historical or unlabelled observations are not current AVE evidence.
    if (!raw || raw.marketProvider !== 'AVE' || !addressValid(chain, raw.address) || raw.chain !== chain) continue;
    const address = identity(chain, raw.address);
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
      // Discovery and first qualification are different events. A pending
      // row may pass much later; quote refreshes must not renew either clock.
      qualifiedAt: clock(old?.qualifiedAt, at) ?? (screen.pass ? at : null),
      deltaWindowMs: comparable ? elapsed : null, priceDelta: comparable && price > 0 && old.price > 0 ? price / old.price - 1 : null,
      holdersDelta: holderComparable && holders !== null && old.holders !== null ? holders - old.holders : null, smartDelta: null,
      priorityBand: screen.priorityBand, hasUnknownRisk: true, auditEligible: screen.pass,
      observationProvider: raw.marketOverlayProvider === 'DEXSCREENER' ? 'DEXSCREENER' : raw.marketOverlayProvider ? null : 'AVE',
      pairAddress: raw.pairAddress, website: safeUrl(raw.website), twitter: safeText(raw.twitter_username, 80)
    });
  }
  return [...unique.values()].sort((a, b) => (b.volume5m || 0) - (a.volume5m || 0));
}

export class LiveDiscovery {
  constructor({ provider, settings = config, now = Date.now, intervalMs = 20000, leaseMs = 30000, schedule = setTimeout, cancel = clearTimeout,
    cacheOnly = false, marketOverlay = null, overlayWaitMs = 150, overlayTimeoutMs = 10000 }) {
    this.provider = provider; this.controller = null;
    this.cacheOnly = cacheOnly;
    this.marketOverlay = marketOverlay;
    this.settings = settings; this.now = now; this.intervalMs = Math.max(20000, intervalMs);
    this.leaseMs = leaseMs; this.schedule = schedule; this.cancel = cancel;
    this.overlayWaitMs = Math.max(0, Math.min(200, Number(overlayWaitMs) || 0));
    this.overlayTimeoutMs = Math.max(1, Math.min(10000, Number(overlayTimeoutMs) || 10000));
    this.cacheReads = new Map(); this.cachedInputs = new Map(); this.overlayJobs = new Map(); this.overlayNextAt = new Map();
    this.backgroundGeneration = 0;
    this.signals = new LeadSignals();
    this.states = new Map(); this.raw = new Map(); this.identityHistory = new Map(); this.focus = ''; this.leaseUntil = 0;
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
      this.states.clear(); this.raw.clear(); this.signals.reset(); this.resetBackground(); this.epoch = this.provider.keyEpoch;
    }
  }

  resetBackground() {
    this.backgroundGeneration++;
    for (const job of this.overlayJobs.values()) job.cancel();
    this.overlayJobs.clear(); this.overlayNextAt.clear(); this.cachedInputs.clear(); this.cacheReads.clear();
  }

  currentInput(chain, input) {
    return !this.stopped && !this.provider.disabled && input.epoch === this.provider.keyEpoch
      && input.generation === this.backgroundGeneration && this.cachedInputs.get(chain) === input;
  }

  publishCachedInput(chain, input) {
    if (!this.currentInput(chain, input)) return;
    const now = this.now(), old = this.states.get(chain) || { rows: [], lastSuccessAt: 0, pollCount: 0 };
    // A completed overlay can be reused only under its original evidence
    // clocks. Expired overlays fall back to the current AVE input, not a
    // timestamp-renewed copy of yesterday's market facts.
    const enriched = new Map((input.enriched || []).filter(row => row && addressValid(chain, row.address))
      .map(row => [identity(chain, row.address), row]));
    const marketRows = input.tokens.map(row => {
      const overlay = typeof row?.address === 'string' ? enriched.get(identity(chain, row.address)) : null;
      return overlay && overlay.stale !== true && overlay.expiresAt > now && overlay.capturedAt <= now
        && overlay.sourceUpdatedAt > 0 && overlay.sourceUpdatedAt <= overlay.capturedAt
        && now - overlay.sourceUpdatedAt <= 60000 ? overlay : row;
    });
    const rows = this.normalizeRows(marketRows, chain, old, now);
    const capturedAt = rows.length ? Math.max(...rows.map(row => row.capturedAt || 0)) : input.capturedAt;
    this.states.set(chain, { ...old, rows, status: capturedAt ? 'READY' : 'WAITING', marketProvider: 'AVE',
      lastPollAt: now, lastSuccessAt: capturedAt, receivedCount: input.tokens.length,
      filteredCount: Math.max(0, input.tokens.length - rows.length), diagnostics: discoveryDiagnostics(marketRows, chain, now) });
    const visible = new Set(rows.map(row => row.address));
    this.raw.set(chain, new Map(marketRows.filter(row => row && addressValid(chain, row.address)
      && visible.has(identity(chain, row.address))).map(row => [identity(chain, row.address), row])));
  }

  startOverlay(chain, input) {
    const existing = this.overlayJobs.get(chain);
    if (existing) return existing.promise;
    if (!this.marketOverlay || typeof this.marketOverlay.enrich !== 'function' || !input.tokens.length
      || !this.currentInput(chain, input) || this.now() < (this.overlayNextAt.get(chain) || 0)) return null;
    // One background request per chain and at most one start per live cadence,
    // even when many tabs poll or a failed dependency returns immediately.
    this.overlayNextAt.set(chain, this.now() + this.intervalMs);
    const job = { cancel: () => {}, promise: null };
    const cancelled = new Promise(resolve => { job.cancel = () => resolve(null); });
    this.overlayJobs.set(chain, job);
    job.promise = (async () => {
      let timer;
      try {
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), this.overlayTimeoutMs); timer.unref?.(); });
        const work = Promise.resolve().then(() => this.marketOverlay.enrich(chain, input.tokens, {
          minMarketCap: this.settings.discoveryMinMarketCap, maxMarketCap: this.settings.discoveryMaxMarketCap
        }));
        const enriched = await Promise.race([work, timeout, cancelled]);
        if (!Array.isArray(enriched) || !this.currentInput(chain, input)) return;
        const configured = await this.provider.configured();
        this.syncCredentials();
        if (!configured) { this.resetBackground(); return; }
        if (!this.currentInput(chain, input)) return;
        input.enriched = enriched;
        this.publishCachedInput(chain, input);
      } catch { /* Optional market enrichment must never reject the local cache read. */ }
      finally {
        clearTimeout(timer);
        if (this.overlayJobs.get(chain) === job) this.overlayJobs.delete(chain);
      }
    })();
    return job.promise;
  }

  async waitForQuickOverlay(promise) {
    if (!promise || !this.overlayWaitMs) return;
    let timer;
    try { await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, this.overlayWaitMs); })]); }
    finally { clearTimeout(timer); }
  }

  normalizeRows(input, chain, old, at) {
    const history = this.identityHistory.get(chain) || new Map();
    for (const [address, record] of history) if (at - record.lastSeenAt >= identityHistoryMs) history.delete(address);
    // Keep identity clocks through page rotation or temporary exclusion, but
    // never retain market evidence here or use it to extend quote freshness.
    // These public identities also survive key changes; changing credentials
    // must not turn a previously qualified contract into a new arrival.
    const remembered = input.slice(0, 300).flatMap(row => {
      const record = typeof row?.address === 'string' ? history.get(identity(chain, row.address)) : null;
      return record ? [record] : [];
    });
    const previous = [...remembered, ...old.rows];
    const rows = normalizeLiveRows(input, chain, previous, at, old.lastSuccessAt > 0);
    for (const row of rows) history.set(row.address, { address: row.address, chain, marketProvider: 'AVE',
      firstSeenAt: row.firstSeenAt, newAt: row.newAt, qualifiedAt: row.qualifiedAt, lastSeenAt: at });
    this.identityHistory.set(chain, history);
    return this.signals.observe(input, rows, chain, at);
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
    return this.readCachedSnapshot(chain);
  }

  readCachedSnapshot(chain) {
    const existing = this.cacheReads.get(chain);
    if (existing) return existing;
    const read = this.loadCachedSnapshot(chain);
    this.cacheReads.set(chain, read);
    read.finally(() => { if (this.cacheReads.get(chain) === read) this.cacheReads.delete(chain); }).catch(() => {});
    return read;
  }

  async loadCachedSnapshot(chain) {
    // Production reads only the scanner's in-memory cache. Do not wait for
    // a slow external overlay or the single focused-tab timer. Both the timer
    // and HTTP path share this per-chain cache read and background work.
    try {
      const configured = await this.provider.configured();
      this.syncCredentials();
      if (!configured) { this.resetBackground(); return { ...this.snapshot(chain), status: 'AUTH_REQUIRED' }; }
      const epoch = this.provider.keyEpoch, generation = this.backgroundGeneration;
      if (this.stopped) return this.snapshot(chain);
      const result = await this.provider.live(chain, { refresh: false });
      if (epoch !== this.provider.keyEpoch || generation !== this.backgroundGeneration || this.stopped) return this.snapshot(chain);
      if (!Array.isArray(result?.tokens)) throw new Error('invalid_cached_result');
      const now = this.now();
      // AVE's passive read derives stale from the unchanged expiry clock.
      // That transition is not new upstream evidence and must not evict a
      // still-fresh DEX overlay. An explicit stale flag before expiry remains
      // part of the version, as do all real facts and original source clocks.
      const signature = JSON.stringify([result.capturedAt, result.tokens.map(row => row && typeof row === 'object'
        ? { ...row, stale: row.stale === true && !(Number.isFinite(row.expiresAt) && row.expiresAt <= now) } : row)]);
      let input = this.cachedInputs.get(chain);
      if (!input || input.signature !== signature) {
        input = { epoch, generation, signature, tokens: result.tokens, capturedAt: number(result.capturedAt) || 0, enriched: null };
        this.cachedInputs.set(chain, input);
      } else input.tokens = result.tokens; // Keep the latest derived expiry state for fallback.
      this.publishCachedInput(chain, input);
      await this.waitForQuickOverlay(this.startOverlay(chain, input));
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
    if (this.cacheOnly) {
      this.running = true; this.nextPollAt = at + this.intervalMs;
      try {
        await this.readCachedSnapshot(chain);
        const state = this.states.get(chain);
        if (state && !this.stopped && epoch === this.provider.keyEpoch) this.states.set(chain, { ...state,
          lastAttemptAt: at, requestMs: this.now() - at, pollCount: state.pollCount + 1 });
      } finally { this.running = false; this.arm(); }
      return;
    }
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
      if (typeof this.provider.live !== 'function') throw new Error('invalid_live_provider');
      // All live reads use the shared read-only AVE scanner/live cache.
      const result = await this.provider.live(chain, { signal: controller.signal, refresh: !this.cacheOnly });
      if (this.stopped || controller.signal.aborted || epoch !== this.provider.keyEpoch) return;
      if (!Array.isArray(result?.tokens)) throw new Error('invalid_live_response');
      const input = await this.enrichMarket(chain, result.tokens);
      if (this.stopped || controller.signal.aborted || epoch !== this.provider.keyEpoch) return;
      const now = this.now();
      const rows = this.normalizeRows(input, chain, old, now);
      const capturedAt = rows.length ? Math.max(...rows.map(row => row.capturedAt || 0)) : number(result.capturedAt) || 0;
      this.states.set(chain, { rows, status: this.cacheOnly && !capturedAt ? 'WAITING' : 'READY', marketProvider: 'AVE', lastAttemptAt: at, lastPollAt: now, lastSuccessAt: capturedAt,
        requestMs: now - at, pollCount: old.pollCount + 1, receivedCount: input.length, filteredCount: Math.max(0, input.length - rows.length),
        diagnostics: discoveryDiagnostics(input, chain, now) });
      this.raw.set(chain, new Map(input.filter(row => row && addressValid(chain, row.address) && rows.some(x => identity(chain, row.address) === x.address))
        .map(row => [identity(chain, row.address), row])));
    } catch (error) {
      if (this.stopped || controller.signal.aborted || epoch !== this.provider.keyEpoch) return;
      const status = error.code === 'AVE_TOTAL_BUDGET' ? 'TOTAL_BUDGET_PAUSED' : error.code === 'AVE_HOURLY_BUDGET' ? 'HOURLY_BUDGET_PAUSED'
        : error.code === 'AVE_BUDGET' ? 'BUDGET_PAUSED' : error.code === 'AVE_QUOTA' ? 'QUOTA_PAUSED'
        : error.code === 'AVE_RATE_LIMITED' ? 'RATE_LIMITED'
        : ['AVE_AUTH', 'AVE_CONFIG', 'AVE_DISABLED'].includes(error.code) ? 'AUTH_REQUIRED' : 'ERROR';
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
      return { ...row, ...publicLeadSignal({ ...row, stale }, this.now()), stale, auditEligible: row.auditEligible && !stale,
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

  stop() { this.stopped = true; this.signals.reset(); this.resetBackground(); this.controller?.abort(); if (this.timer) this.cancel(this.timer); this.timer = null; }
}
