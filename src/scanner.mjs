import { config } from './config.mjs';
import { CHART_RISK_VERSION, applyRiskExclusion } from './chart-risk.mjs';
import crypto from 'node:crypto';
import { discoveryScreen, deepScreen, marketCap, createdAt } from './scoring.mjs';
import { socialGate } from './social.mjs';
import { tokenInfoPrice } from './gmgn.mjs';
import { collectOutcomeSamples, dueOutcomeJobs, outcomeCoverage, sampleRejected } from './outcomes.mjs';
import { tokenKey } from './local-store.mjs';

const numberOrNull = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const num = (value, fallback = 0) => numberOrNull(value) ?? fallback;
const first = (...values) => values.find(value => value !== undefined && value !== null && value !== '');
const OUTCOME_WINDOWS = Object.freeze({
  m5: 5 * 60_000,
  m15: 15 * 60_000,
  m30: 30 * 60_000,
  h1: 60 * 60_000,
  h2: 2 * 60 * 60_000,
  h6: 6 * 60 * 60_000,
  h24: 24 * 60 * 60_000
});
const OUTCOME_SAMPLE_GRACE_MS = 5 * 60_000;
const REQUIRED_CALIBRATION_WINDOWS = Object.freeze(['m30', 'h2', 'h24']);
const CHAIN_SCOPE_KEYS = Object.freeze([
  'scanCount', 'discoveredCount', 'prequalifiedCount', 'candidates', 'rejected',
  'auditQueue', 'auditQueueStats', 'outcomes', 'outcomeSummary', 'sourceHealth',
  'lastAttemptAt', 'lastSuccessAt', 'lastCompleteSuccessAt', 'lastCycleMs', 'retryAt', 'status', 'generatedAt', 'nextCycleAt'
]);
const RESERVED_X_PATHS = new Set([
  'home', 'explore', 'search', 'intent', 'share', 'i', 'messages', 'notifications', 'settings'
]);

// EVM addresses are case-insensitive. Solana addresses are base58 and
// case-sensitive, so globally lower-casing every chain can merge distinct mints.
function addressKey(value) {
  const address = String(value ?? '').trim();
  return /^0x[0-9a-f]{40}$/i.test(address) ? address.toLowerCase() : address;
}

export function twitterHandle(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  const withoutHost = source.replace(/^(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\//i, '');
  const handle = withoutHost.replace(/^@/, '').split(/[/?#]/)[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return '';
  if (RESERVED_X_PATHS.has(handle.toLowerCase())) return '';
  return handle;
}

function cleanCandidate(row, defaultChain = '') {
  if (!row || typeof row !== 'object') return row;
  const { rawDiscovery: _rawDiscovery, socialHints: _socialHints, ...clean } = row;
  if (clean.status === 'QUALIFIED') clean.status = 'X_REVIEW';
  if (clean.status === 'REJECTED') clean.status = 'HARD_REJECT';
  if (!clean.chain && defaultChain) clean.chain = defaultChain;
  if (clean.status === 'X_REVIEW' && clean.deep?.chartRisk?.version !== CHART_RISK_VERSION) {
    clean.status = 'WAIT_RECHECK';
    clean.deep = { ...clean.deep, chainPass: false };
    clean.decisionReason = '风险规则已升级，等待重新核验';
  }
  return clean;
}

export function reviewRevision(candidate) {
  const security = candidate.deep?.security || {};
  return crypto.createHash('sha256').update(JSON.stringify({
    status: candidate.status, checks: candidate.deep?.checks, failed: candidate.deep?.failed,
    owner: security.ownerRenounced, mint: security.renouncedMint, freeze: security.renouncedFreezeAccount,
    honeypot: security.honeypot, buyTax: security.buyTax, sellTax: security.sellTax,
    lock: security.lockRate, burned: security.lpBurned,
    secondary: candidate.secondary?.security?.verdict, conflicts: candidate.secondary?.conflicts,
    website: candidate.info?.website, twitter: candidate.info?.twitter
  })).digest('hex').slice(0, 24);
}

function publicToken(row, screen, chain) {
  const twitter = first(row.twitter, row.twitter_username, row.link?.twitter_username) || '';
  const duplicateValue = first(row.twitter_dup, row.social_dup);
  const duplicateSocial = ['1', 'true', 'yes'].includes(String(duplicateValue ?? '').toLowerCase());
  return {
    address: String(row.address),
    chain,
    symbol: String(row.symbol || '?').slice(0, 30),
    name: String(row.name || '').slice(0, 80),
    marketCap: screen.mc,
    liquidity: screen.liquidity,
    price: numberOrNull(first(row.price, row.price_usd, row.usd_price)),
    createdAt: createdAt(row),
    ageSec: screen.ageSec,
    priorityBand: screen.priorityBand,
    discoveryScore: screen.score,
    holders: num(row.holder_count),
    volume1h: num(first(row.volume_1h, row.volume)),
    buys: num(first(row.buys_24h, row.buys)),
    sells: num(first(row.sells_24h, row.sells)),
    twitter: twitterHandle(twitter),
    gmgnUrl: String(row.link?.gmgn || ''),
    socialHints: {
      followerCount: num(first(row.x_user_follower, row.x_follower)),
      duplicateSocial
    }
  };
}

function socialFrom(token) {
  return {
    twitter: token.twitter,
    ...socialGate({
      twitter: token.twitter,
      followerCount: token.socialHints.followerCount,
      duplicateSocial: token.socialHints.duplicateSocial,
      capability: { available: false, mode: 'manual', reason: '当前采用X人工复核模式' }
    })
  };
}

export function classifyDeepResult(deep, auditMeta = {}) {
  const failed = new Set(deep?.failed || []);
  const unknown = new Set(deep?.blockingUnknownFields || deep?.unknownFields || []);
  const unknownCheck = name => {
    const prefixes = {
      openSource: ['openSource'], ownerRenounced: ['ownerRenounced', 'renouncedMint', 'renouncedFreezeAccount'],
      lpLocked: ['lockRate'], notHoneypot: ['honeypot', 'sellability.'], tax: ['buyTax', 'sellTax'],
      rug: ['rugRatio'], concentration: ['top10'], dev: ['devHold'], insider: ['insider'],
      bundler: ['bundler'], sniper: ['sniperHold'], wash: ['wash'], liquidity: ['liquidity'],
      wallets: ['holders.'], observation: ['candles'], chartRisk: ['chartRisk.']
    }[name] || [];
    return [...unknown].some(field => prefixes.some(prefix => field === prefix || field.startsWith(prefix)));
  };
  const transient = new Set(['wallets', 'observation', 'marketBehavior']);
  if (deep?.honeypotEvidence !== '检测到貔貅') transient.add('notHoneypot');
  const hardFailed = [...failed].filter(name => !transient.has(name) && !unknownCheck(name));
  const waitingFailed = [...failed].filter(name => transient.has(name) || unknownCheck(name));
  if (auditMeta.complete === false) waitingFailed.push('auditIncomplete');
  if (hardFailed.length) return { status: 'HARD_REJECT', hardFailed, waitingFailed };
  if (!deep?.chainPass || auditMeta.complete === false) return { status: 'WAIT_RECHECK', hardFailed, waitingFailed };
  return { status: 'X_REVIEW', hardFailed: [], waitingFailed: [] };
}

export function mergeSecondaryClassification(baseClassification, secondary) {
  const base = baseClassification || { status: 'WAIT_RECHECK', hardFailed: [], waitingFailed: [] };
  if (!secondary) return { ...base, secondaryReason: '' };
  const sources = Object.values(secondary.sources || {});
  const supported = sources.some(source => source?.status !== 'UNSUPPORTED');
  const fatal = secondary.security?.verdict === 'FATAL';
  const blockingConflicts = (secondary.conflicts || []).filter(conflict =>
    ['MARKET_MISMATCH', 'SECURITY_MISMATCH'].includes(conflict?.type)
  );
  const incomplete = supported && (secondary.status !== 'COMPLETE' || secondary.security?.verdict === 'UNKNOWN');
  return {
    ...base,
    status: fatal
      ? 'HARD_REJECT'
      : base.status === 'X_REVIEW' && (incomplete || blockingConflicts.length)
        ? 'WAIT_RECHECK'
        : base.status,
    secondaryReason: fatal
      ? '第二安全源触发一票否决'
      : incomplete
        ? '第二数据源不完整，等待复查'
        : blockingConflicts.length
          ? '多源数据冲突，等待复查'
          : (!supported ? '当前链暂无第二数据源，仅供人工查看' : '')
  };
}

function queueSort(a, b) {
  return Number(b.priorityBand) - Number(a.priorityBand)
    || num(a.firstSeenAt) - num(b.firstSeenAt)
    || num(b.score) - num(a.score);
}

export function selectAuditQueue(queue, availableAddresses, now, cycleNumber, limit) {
  const available = new Set([...availableAddresses].map(addressKey));
  const due = queue.filter(item => available.has(addressKey(item.address)) && num(item.nextAuditAt) <= now);
  const never = due.filter(item => !num(item.lastAuditedAt)).sort(queueSort);
  const rechecks = due.filter(item => num(item.lastAuditedAt)).sort(queueSort);
  const selected = [];
  while (selected.length < limit && (never.length || rechecks.length)) {
    const slot = cycleNumber + selected.length;
    const urgent = rechecks.findIndex(row => row.status === 'X_REVIEW' || row.watched);
    if (urgent >= 0 && slot % 3 !== 1) selected.push(...rechecks.splice(urgent, 1));
    else if (slot % 5 === 0 && never.length) {
      // Reserve a fairness slot so lower-priority tokens are not starved forever.
      const oldest = never.reduce((a, b) => num(a.firstSeenAt) < num(b.firstSeenAt) ? a : b);
      selected.push(...never.splice(never.indexOf(oldest), 1));
    } else selected.push((slot % 3 === 0 ? rechecks.shift() : never.shift()) || rechecks.shift() || never.shift());
  }
  return selected.filter(Boolean);
}

function nextAuditDelay(status, settings) {
  if (status === 'HARD_REJECT') return settings.hardRejectRecheckMs;
  if (status === 'X_REVIEW') return settings.chainPassRecheckMs;
  return settings.dynamicRecheckMs;
}

function buildQueue(previous, prequalified, now, settings) {
  const byAddress = new Map((previous || []).map(item => [addressKey(item.address), { ...item }]));
  for (const { row, screen } of prequalified) {
    const address = addressKey(row.address);
    const old = byAddress.get(address);
    byAddress.set(address, {
      address: String(row.address),
      firstSeenAt: num(old?.firstSeenAt, now),
      lastSeenAt: now,
      lastAuditedAt: num(old?.lastAuditedAt),
      nextAuditAt: num(old?.nextAuditAt),
      attempts: num(old?.attempts),
      status: old?.status || 'QUEUED',
      priorityBand: Boolean(screen.priorityBand),
      score: screen.score
      ,watched: Boolean(row._monitorOnly)
    });
  }
  return [...byAddress.values()].filter(item => now - num(item.lastSeenAt, item.firstSeenAt) <= settings.queueRetentionMs);
}

function queueStats(queue, availableAddresses, now, settings) {
  const available = new Set([...availableAddresses].map(addressKey));
  const active = queue.filter(item => available.has(addressKey(item.address)));
  const due = active.filter(item => num(item.nextAuditAt) <= now);
  return {
    total: active.length,
    retained: queue.length,
    due: due.length,
    neverAudited: active.filter(item => !num(item.lastAuditedAt)).length,
    waitingRecheck: active.filter(item => item.status === 'WAIT_RECHECK').length,
    hardReject: active.filter(item => item.status === 'HARD_REJECT').length,
    chainReview: active.filter(item => item.status === 'X_REVIEW').length,
    estimatedMinutes: Math.ceil(due.length / settings.maxDeepAuditsPerCycle) * settings.scanIntervalMs / 60_000
  };
}

function tokenPrice(row) {
  return numberOrNull(first(row?.price, row?.price_usd, row?.usd_price));
}

export function updateOutcomeTracking(outcomes, discoveredByAddress, now, retentionMs, sampleGraceMs = OUTCOME_SAMPLE_GRACE_MS) {
  const graceMs = Math.max(0, num(sampleGraceMs, OUTCOME_SAMPLE_GRACE_MS));
  return (outcomes || [])
    .filter(item => ['X_REVIEW', 'HARD_REJECT'].includes(item?.initialDecision))
    .filter(item => now - num(item.baselineAt) <= retentionMs).map(item => {
    const row = discoveredByAddress.get(addressKey(item.address));
    const price = tokenPrice(row);
    if (!(price > 0) || !(item.baselinePrice > 0)) return item;
    const samples = { ...(item.samples || {}) };
    const elapsedMs = now - item.baselineAt;
    for (const [key, windowMs] of Object.entries(OUTCOME_WINDOWS)) {
      const lagMs = elapsedMs - windowMs;
      if (!samples[key] && lagMs >= 0 && lagMs <= graceMs) {
        samples[key] = { at: now, targetAt: item.baselineAt + windowMs, lagMs, price, return: price / item.baselinePrice - 1 };
      }
    }
    return { ...item, samples, currentPrice: price, lastSeenAt: now };
  });
}

export function upsertOutcome(outcomes, candidate, now) {
  if (!(candidate.price > 0)) return outcomes;
  const address = addressKey(candidate.address);
  const index = outcomes.findIndex(item => addressKey(item.address) === address);
  if (index >= 0) {
    outcomes[index] = {
      ...outcomes[index],
      latestDecision: candidate.status,
      latestFailed: candidate.deep?.failed || [],
      lastAuditedAt: candidate.auditedAt
    };
    return outcomes;
  }
  if (candidate.status !== 'X_REVIEW') return outcomes;
  outcomes.push({
    address: candidate.address,
    chain: candidate.chain,
    symbol: candidate.symbol,
    baselineAt: now,
    baselinePrice: candidate.price,
    initialDecision: 'X_REVIEW',
    latestDecision: candidate.status,
    latestFailed: candidate.deep?.failed || [],
    lastAuditedAt: candidate.auditedAt,
    samples: {}
  });
  return outcomes;
}

export function summarizeOutcomes(outcomes) {
  const rows = (Array.isArray(outcomes) ? outcomes : []).filter(item => item?.initialDecision === 'X_REVIEW');
  const average = key => {
    const values = rows.map(item => numberOrNull(item.samples?.[key]?.return)).filter(value => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const completed = Object.fromEntries(Object.keys(OUTCOME_WINDOWS).map(key => [key, rows.filter(item => item.samples?.[key]).length]));
  return {
    tracked: rows.length,
    minimumSample: 50,
    calibrationReady: REQUIRED_CALIBRATION_WINDOWS.every(key => completed[key] >= 50),
    completed5m: completed.m5,
    completed15m: completed.m15,
    completed30m: completed.m30,
    completed1h: completed.h1,
    completed2h: completed.h2,
    completed6h: completed.h6,
    completed24h: completed.h24,
    averageReturn5m: average('m5'),
    averageReturn15m: average('m15'),
    averageReturn30m: average('m30'),
    averageReturn1h: average('h1'),
    averageReturn2h: average('h2'),
    averageReturn24h: average('h24'),
    note: '影子验证，仅衡量筛选结果，不代表可成交收益'
    ,coverage: outcomeCoverage(outcomes || [])
  };
}

function scopeSnapshot(value) {
  return Object.fromEntries(CHAIN_SCOPE_KEYS.map(key => [key, structuredClone(value[key])]).filter(([, value]) => value !== undefined));
}

function emptyScope() {
  return {
    scanCount: 0, discoveredCount: 0, prequalifiedCount: 0,
    candidates: [], rejected: [], auditQueue: [], outcomes: [],
    auditQueueStats: { total: 0, retained: 0, due: 0, neverAudited: 0, waitingRecheck: 0, hardReject: 0, chainReview: 0, estimatedMinutes: 0 },
    outcomeSummary: {
      minimumSample: 50, calibrationReady: false,
      tracked: 0, completed5m: 0, completed15m: 0, completed30m: 0,
      completed1h: 0, completed2h: 0, completed6h: 0, completed24h: 0
    },
    sourceHealth: {}, lastAttemptAt: 0, lastSuccessAt: 0, lastCompleteSuccessAt: 0,
    lastCycleMs: 0, retryAt: 0
  };
}

function addEvent(events, type, message, chain, data = {}) {
  if (['CANDIDATE_NEW', 'RISK_WORSENED'].includes(type) && (events || []).some(event =>
    event.type === type && event.chain === chain && event.address === data.address && Date.now() - event.at < 30 * 60_000)) return events;
  return [{ at: Date.now(), type, message, chain, ...data }, ...(events || [])].slice(0, 500);
}

export class Scanner {
  constructor({ gmgn, secondary = null, state, controls = null, settings = config }) {
    this.gmgn = gmgn;
    this.secondary = secondary;
    this.state = state;
    this.controls = controls;
    this.config = settings;
    this.supportedChains = [...settings.supportedChains];
    this.activeChain = this.supportedChains.includes(state.value.activeChain) ? state.value.activeChain : settings.chain;
    this.pendingChain = '';
    this.timer = null;
    this.running = false;
    this.rescanRequested = false;
    this.stopped = false;
    this.requestedReviews = new Map();
    this.state.value.activeChain = this.activeChain;
    this.state.value.supportedChains = this.supportedChains;
  }

  activateChain(chain, quiet = false) {
    const chainStates = { ...(this.state.value.chainStates || {}) };
    chainStates[this.activeChain] = scopeSnapshot(this.state.value);
    const restored = chainStates[chain] || emptyScope();
    this.activeChain = chain;
    this.state.value = {
      ...this.state.value,
      ...structuredClone(restored),
      chainStates,
      activeChain: chain,
      pendingChain: '',
      supportedChains: this.supportedChains,
      status: 'SWITCHING',
      scanInProgress: false,
      generatedAt: Date.now(),
      nextCycleAt: Date.now()
    };
    if (!quiet) this.state.value.events = addEvent(this.state.value.events, 'CHAIN_SWITCH', `已切换到 ${chain.toUpperCase()}，准备扫描`, chain);
    this.state.save();
  }

  switchChain(chain) {
    const normalized = String(chain || '').toLowerCase();
    if (!this.supportedChains.includes(normalized)) {
      const error = new Error('不支持的链');
      error.code = 'UNSUPPORTED_CHAIN';
      throw error;
    }
    if ((this.controls?.value.enabledChains.length || 1) > 1) {
      // Changing the visible tab must not interrupt shared multi-chain work.
      return { activeChain: normalized, pendingChain: '', queued: false };
    }
    this.controls?.setChains([normalized]);
    if (this.running) {
      this.pendingChain = normalized;
      this.state.value.pendingChain = normalized;
      this.state.value.events = addEvent(this.state.value.events, 'CHAIN_SWITCH_QUEUED', `当前轮次结束后切换到 ${normalized.toUpperCase()}`, this.activeChain);
      this.state.save();
      return { activeChain: this.activeChain, pendingChain: normalized, queued: true };
    }
    if (normalized !== this.activeChain) this.activateChain(normalized);
    void this.cycle();
    return { activeChain: normalized, pendingChain: '', queued: false };
  }

  requestCycle() {
    if (this.running) {
      this.rescanRequested = true;
      return { queued: true };
    }
    queueMicrotask(() => this.cycle());
    return { queued: false };
  }

  enqueueReview(chain, row) {
    if (row?.address && this.state.value.riskExclusions?.[tokenKey(chain, row.address)]) return { accepted: false, reason: 'risk_excluded' };
    const enabled = this.controls?.value.enabledChains || [this.activeChain];
    if (!enabled.includes(chain)) return { accepted: false, reason: 'chain_not_scanning' };
    if (!row || !discoveryScreen(row, { ...this.config, chain }).pass) return { accepted: false, reason: 'outside_audit_scope' };
    const scope = this.activeChain === chain ? this.state.value : this.state.value.chainStates?.[chain];
    const queued = scope?.auditQueue?.find(item => addressKey(item.address) === addressKey(row.address));
    if (queued?.status === 'HARD_REJECT' && queued.nextAuditAt > Date.now()) return { accepted: false, reason: 'risk_rejected' };
    for (const [key, item] of this.requestedReviews) if (Date.now() - item.at > 10 * 60000 || item.epoch !== this.gmgn.keyEpoch) this.requestedReviews.delete(key);
    const key = tokenKey(chain, row.address);
    if (this.requestedReviews.has(key)) return { accepted: true, queued: true };
    if (this.requestedReviews.size >= 12) return { accepted: false, reason: 'queue_full' };
    this.requestedReviews.set(key, { chain, row: structuredClone(row), at: Date.now(), epoch: this.gmgn.keyEpoch });
    return { accepted: true, queued: true };
  }

  async cycle() {
    if (this.running) return;
    this.running = true;
    const chain = this.activeChain;
    const chainCount = this.controls?.value.enabledChains.length || 1;
    const settings = { ...this.config, chain,
      maxDeepAuditsPerCycle: Math.max(1, Math.ceil(this.config.maxDeepAuditsPerCycle / chainCount)),
      auditCycleBudgetMs: Math.max(20_000, (this.config.auditCycleBudgetMs || 80_000) / chainCount),
      outcomeReadsPerCycle: Math.max(1, Math.ceil((this.config.outcomeReadsPerCycle || 4) / chainCount))
    };
    const keyEpoch = this.gmgn.keyEpoch;
    const startedAt = Date.now();
    const prior = structuredClone(this.state.value);
    const riskExclusions = prior.riskExclusions || (prior.riskExclusions = {});
    this.state.value.status = 'SCANNING';
    this.state.value.scanInProgress = true;
    this.state.value.cycleStartedAt = startedAt;
    this.state.value.lastAttemptAt = startedAt;
    this.state.value.generatedAt = startedAt;
    this.state.save();
    try {
      if (!await this.gmgn.configured()) {
        const next = {
          ...prior,
          status: 'GMGN_AUTH_REQUIRED',
          authMessage: '请在页面输入 GMGN 只读 API Key 并点击确认，验证成功后开始扫描',
          activeChain: chain,
          supportedChains: this.supportedChains,
          scanInProgress: false,
          lastAttemptAt: startedAt,
          generatedAt: Date.now(),
          nextCycleAt: Date.now() + settings.scanIntervalMs
        };
        next.events = addEvent(prior.events, 'AUTH', 'GMGN API尚未配置，真实扫描未启动', chain);
        this.state.save(next);
        return;
      }

      let discovered = await this.gmgn.discover(chain);
      if (this.gmgn.keyEpoch !== keyEpoch) return;
      const reviewRequests = [...this.requestedReviews.values()].filter(item => item.chain === chain
        && item.epoch === keyEpoch && Date.now() - item.at <= 10 * 60000);
      // Current discovery wins over a queued preview snapshot when both exist.
      discovered = [...new Map([...reviewRequests.map(item => item.row), ...discovered].map(row => [addressKey(row.address), row])).values()];
      const discoveredByAddress = new Map(discovered.filter(row => row?.address).map(row => [addressKey(row.address), row]));
      const screened = discovered.map(row => {
        const screen = discoveryScreen(row, settings);
        const held = riskExclusions[tokenKey(chain, row.address)];
        if (held) { screen.pass = false; screen.reasons.push(...held.reasons); }
        return { row, screen };
      });
      const prequalified = screened.filter(item => item.screen.pass).sort((a, b) =>
        Number(b.screen.priorityBand) - Number(a.screen.priorityBand) || b.screen.score - a.screen.score
      );
      const monitoring = new Map((prior.candidates || []).filter(row => row.status === 'X_REVIEW'
        || this.controls?.value.annotations[tokenKey(chain, row.address)]?.favorite).map(row => [addressKey(row.address), row]));
      for (const annotation of Object.values(this.controls?.value.annotations || {})) {
        if (annotation.chain === chain && annotation.favorite && !monitoring.has(addressKey(annotation.address))) monitoring.set(addressKey(annotation.address), annotation);
      }
      const monitors = [...monitoring.values()].filter(row => !prequalified.some(item => addressKey(item.row.address) === addressKey(row.address)))
        .map(row => ({ row: { address: row.address, symbol: row.symbol || row.address.slice(0, 6), name: row.name || '',
          price: row.price, market_cap: row.marketCap, liquidity: row.liquidity, creation_timestamp: row.createdAt, _monitorOnly: true },
          screen: { mc: num(row.marketCap), liquidity: num(row.liquidity), ageSec: num(row.ageSec), priorityBand: true, score: 0 } }));
      const auditable = [...prequalified, ...monitors].filter(item => !riskExclusions[tokenKey(chain, item.row.address)]);
      let auditQueue = buildQueue(prior.auditQueue, auditable, startedAt, settings);
      const availableAddresses = new Set(auditable.map(item => addressKey(item.row.address)));
      const queueByAddress = new Map(auditQueue.map(item => [addressKey(item.address), item]));
      const selected = selectAuditQueue(auditQueue, availableAddresses, startedAt, num(prior.scanCount) + 1, settings.maxDeepAuditsPerCycle);
      const requested = reviewRequests.map(item => queueByAddress.get(addressKey(item.row.address))).find(item => item
        && availableAddresses.has(addressKey(item.address)) && !(item.status === 'HARD_REJECT' && item.nextAuditAt > startedAt));
      if (requested) {
        const index = selected.findIndex(item => addressKey(item.address) === addressKey(requested.address));
        if (index >= 0) selected.splice(index, 1);
        selected.unshift(requested);
        selected.splice(settings.maxDeepAuditsPerCycle);
      }
      const candidatesByAddress = new Map((prior.candidates || []).map(row => cleanCandidate(row, chain)).filter(Boolean)
        .map(row => [addressKey(row.address), applyRiskExclusion(row, riskExclusions, chain)]));
      for (const { row, screen } of screened) {
        const previous = candidatesByAddress.get(addressKey(row.address));
        if (!screen.pass && previous?.status === 'X_REVIEW') {
          // A newer adverse discovery fact must not wait for a deep-audit slot
          // while an older approved snapshot remains eligible for alerts.
          candidatesByAddress.set(addressKey(row.address), { ...previous, status: 'WAIT_RECHECK',
            deep: { ...previous.deep, chainPass: false }, decisionReason: screen.reasons.join('；') });
        }
      }
      let outcomes = updateOutcomeTracking(
        prior.outcomes,
        discoveredByAddress,
        startedAt,
        settings.outcomeRetentionMs,
        Math.max(OUTCOME_SAMPLE_GRACE_MS, num(settings.scanIntervalMs) * 2)
      );
      let events = prior.events || [];
      let lastAuditHealth = prior.sourceHealth?.lastAudit || null;
      let lastSecondaryHealth = prior.sourceHealth?.lastSecondary || null;
      let auditHadError = false;
      let auditsCompleted = 0;

      for (const queued of selected) {
        if (auditsCompleted && Date.now() - startedAt >= (settings.auditCycleBudgetMs || 80_000)) break;
        if (this.gmgn.nextAllowedAt > Date.now() || this.gmgn.disabled) break;
        const item = auditable.find(entry => addressKey(entry.row.address) === addressKey(queued.address));
        if (!item) continue;
        const token = publicToken(item.row, item.screen, chain);
        const visibleToken = cleanCandidate(token);
        try {
          const audit = await this.gmgn.audit(token.address, Math.floor(Date.now() / 1000), chain, {
            shouldStopEarly: partial => classifyDeepResult(deepScreen({ discovery: item.row, audit: partial }, settings), partial._meta).status === 'HARD_REJECT'
          });
          if (this.gmgn.keyEpoch !== keyEpoch) return;
          const freshPrice = tokenInfoPrice(audit.info);
          if (freshPrice) { token.price = freshPrice; visibleToken.price = freshPrice; }
          if (item.row._monitorOnly) {
            const supply = Number(audit.info?.circulating_supply);
            if (freshPrice && supply > 0) token.marketCap = visibleToken.marketCap = freshPrice * supply;
            token.liquidity = visibleToken.liquidity = num(audit.info?.liquidity, token.liquidity);
          }
          const deep = deepScreen({ discovery: item.row, audit }, settings);
          if (deep.chartRisk.status === 'REJECT') {
            riskExclusions[tokenKey(chain, token.address)] = { chain, address: token.address,
              at: Date.now(), version: CHART_RISK_VERSION, codes: deep.chartRisk.codes,
              reasons: deep.chartRisk.reasons, from: deep.chartRisk.from, to: deep.chartRisk.to };
            // Persist immediately so a later source failure cannot erase the evidence.
            this.state.value.riskExclusions = riskExclusions;
            this.state.save();
          }
          const baseClassification = classifyDeepResult(deep, audit._meta || {});
          const primaryWebsite = String(first(audit.info?.link?.website, item.row.website, item.row.link?.website) || '');
          let secondary = null;
          if (this.secondary && baseClassification.status !== 'HARD_REJECT') {
            try {
              secondary = await this.secondary.validate({
                chain,
                tokenAddress: token.address,
                primary: {
                  market: {
                    priceUsd: token.price,
                    marketCap: token.marketCap,
                    liquidityUsd: token.liquidity,
                    website: primaryWebsite
                  },
                  security: {
                    isHoneypot: deep.security?.honeypot,
                    openSource: deep.security?.openSource,
                    // renounced_mint is Solana-specific; EVM placeholders are not mintability evidence.
                    mintable: chain === 'sol' && typeof deep.security?.renouncedMint === 'boolean' ? !deep.security.renouncedMint : undefined
                  }
                }
              });
            } catch {
              secondary = {
                status: 'DEGRADED', complete: false, checkedAt: Date.now(),
                sources: { dexScreener: { status: 'ERROR', errorCode: 'VALIDATION_FAILED' }, goPlus: { status: 'ERROR', errorCode: 'VALIDATION_FAILED' } },
                market: { complete: false, websites: [] },
                security: { complete: false, verdict: 'UNKNOWN', fatal: [], unknownFields: ['tokenSecurity'], fields: {}, buyTax: null, sellTax: null },
                conflicts: []
              };
            }
          }
          const classification = mergeSecondaryClassification(baseClassification, secondary);
          if (item.row._monitorOnly && classification.status === 'X_REVIEW') {
            classification.status = 'WAIT_RECHECK';
            classification.secondaryReason = '已离开发现范围，继续跟踪风险；不作为新的通过候选';
          }
          const social = socialFrom(token);
          const auditedAt = Date.now();
          const secondaryWebsite = secondary?.market?.websites?.[0] || '';
          const marketBehaviorReason = deep.marketBehavior?.downgradeReasons?.join('；') || '';
          const candidate = {
            ...visibleToken,
            status: classification.status,
            auditedAt,
            staleAt: auditedAt + settings.staleCandidateMs,
            deep,
            social,
            secondary,
            decisionReason: [...deep.chartRisk.reasons, classification.secondaryReason, marketBehaviorReason].filter(Boolean).join('；'),
            auditHealth: audit._meta || { complete: true, endpoints: {} },
            info: {
              twitter: social.twitter,
              website: String(first(primaryWebsite, secondaryWebsite) || '')
            }
          };
          const previousCandidate = candidatesByAddress.get(addressKey(token.address));
          candidate.reviewEvidence = reviewRevision(candidate);
          candidate.reviewRevision = previousCandidate?.reviewEvidence === candidate.reviewEvidence
            ? previousCandidate.reviewRevision : `${candidate.reviewEvidence}-${auditedAt}`;
          candidatesByAddress.set(addressKey(token.address), candidate);
          this.requestedReviews.delete(tokenKey(chain, token.address));
          const favorite = this.controls?.value.annotations[tokenKey(chain, token.address)]?.favorite;
          if (candidate.status === 'X_REVIEW' && previousCandidate?.status !== 'X_REVIEW') {
            events = addEvent(events, 'CANDIDATE_NEW', `${token.symbol}：新增链上候选，需人工复核`, chain, { address: token.address });
          } else if ((favorite || previousCandidate?.status === 'X_REVIEW') && candidate.status !== 'X_REVIEW' && candidate.status !== previousCandidate?.status) {
            events = addEvent(events, 'RISK_WORSENED', `${token.symbol}：风险或证据状态恶化，请重新复核`, chain, { address: token.address });
          }
          const queueItem = queueByAddress.get(addressKey(token.address));
          Object.assign(queueItem, {
            lastAuditedAt: auditedAt,
            nextAuditAt: auditedAt + nextAuditDelay(candidate.status, settings),
            attempts: num(queueItem.attempts) + 1,
            status: candidate.status
          });
          lastAuditHealth = { ...candidate.auditHealth, address: token.address, checkedAt: auditedAt };
          if (secondary) lastSecondaryHealth = {
            checkedAt: secondary.checkedAt,
            complete: secondary.complete,
            status: secondary.status,
            sources: secondary.sources
          };
          if (audit._meta?.complete === false && !audit._meta?.earlyExit) auditHadError = true;
          if (secondary && secondary.status === 'DEGRADED'
            && Object.values(secondary.sources || {}).some(source => source?.status !== 'UNSUPPORTED')) auditHadError = true;
          const label = { X_REVIEW: '链上通过，待人工看X', WAIT_RECHECK: '等待短时复查', HARD_REJECT: '永久安全拒绝' }[candidate.status];
          events = addEvent(events, candidate.status, `${token.symbol}：${label}`, chain, { address: token.address });
          outcomes = upsertOutcome(outcomes, candidate, auditedAt);
          outcomes = sampleRejected(outcomes, candidate, auditedAt);
        } catch (error) {
          auditHadError = true;
          const auditedAt = Date.now();
          const queueItem = queueByAddress.get(addressKey(token.address));
          Object.assign(queueItem, {
            lastAuditedAt: auditedAt,
            nextAuditAt: auditedAt + settings.dynamicRecheckMs,
            attempts: num(queueItem.attempts) + 1,
            status: 'WAIT_RECHECK'
          });
          const existing = candidatesByAddress.get(addressKey(token.address)) || visibleToken;
          candidatesByAddress.set(addressKey(token.address), {
            ...existing,
            status: 'WAIT_RECHECK',
            auditedAt,
            staleAt: auditedAt + settings.staleCandidateMs,
            auditError: String(error?.message || '深度审计暂时失败，等待复查')
            ,reviewRevision: `error-${auditedAt}`
          });
          lastAuditHealth = { complete: false, checkedAt: auditedAt, code: String(error?.code || 'GMGN_REQUEST_FAILED') };
          events = addEvent(events, 'AUDIT_RETRY', `${token.symbol}：深审暂时失败，已进入复查队列`, chain, { address: token.address });
          if (error?.code === 'GMGN_RATE_LIMITED') break;
        }
        auditsCompleted++;
      }

      const outcomeScopes = { ...Object.fromEntries(Object.entries(prior.chainStates || {}).map(([id, scope]) => [id, scope.outcomes || []])), [chain]: outcomes };
      const sampleJobs = Object.entries(outcomeScopes).flatMap(([id, rows]) => dueOutcomeJobs(rows, Date.now()).map(job => ({ ...job, chain: id })))
        .sort((a, b) => (a.row.sampleRetries?.[a.key]?.attempts || 0) - (b.row.sampleRetries?.[b.key]?.attempts || 0) || a.targetAt - b.targetAt)
        .slice(0, settings.outcomeReadsPerCycle || 4);
      for (const job of sampleJobs) {
        await collectOutcomeSamples([job.row], this.gmgn, job.chain, { limit: 1, deadline: startedAt + (settings.auditCycleBudgetMs || 80_000) + 25_000 });
      }
      for (const [id, rows] of Object.entries(outcomeScopes)) {
        if (id !== chain && prior.chainStates?.[id]) prior.chainStates[id].outcomeSummary = summarizeOutcomes(rows);
      }
      if (this.gmgn.keyEpoch !== keyEpoch) return;

      auditQueue = [...queueByAddress.values()];
      const now = Date.now();
      const candidates = [...candidatesByAddress.values()]
        .filter(row => now - num(row.auditedAt) <= settings.candidateRetentionMs || this.controls?.value.annotations[tokenKey(chain, row.address)]?.favorite)
        .sort((a, b) => {
          const rank = { X_REVIEW: 3, WAIT_RECHECK: 2, HARD_REJECT: 1 };
          return num(rank[b.status]) - num(rank[a.status]) || Number(b.priorityBand) - Number(a.priorityBand) || num(b.discoveryScore) - num(a.discoveryScore);
        })
        .slice(0, 200);
      const rejected = screened.filter(item => !item.screen.pass).slice(0, 100).map(item => ({
        address: String(item.row.address || ''), symbol: String(item.row.symbol || '?').slice(0, 30),
        marketCap: marketCap(item.row), createdAt: createdAt(item.row), reasons: item.screen.reasons
      }));
      const discoveryHealth = this.gmgn.lastDiscoveryHealth || { complete: true, checkedAt: now };
      const degraded = discoveryHealth.complete === false || auditHadError;
      const next = {
        ...prior,
        version: 2,
        status: degraded ? 'DEGRADED' : 'RUNNING',
        authMessage: '',
        error: degraded ? '本轮部分数据不完整，系统会自动复查；页面不会把未知值当作安全。' : '',
        retryAt: num(this.gmgn.nextAllowedAt),
        activeChain: chain,
        pendingChain: '',
        supportedChains: this.supportedChains,
        scanInProgress: false,
        generatedAt: now,
        lastAttemptAt: startedAt,
        lastSuccessAt: now,
        lastCompleteSuccessAt: degraded ? num(prior.lastCompleteSuccessAt) : now,
        nextCycleAt: Math.max(now, startedAt + settings.scanIntervalMs),
        lastCycleMs: now - startedAt,
        scanCount: num(prior.scanCount) + 1,
        discoveredCount: discovered.length,
        prequalifiedCount: prequalified.length,
        candidates,
        rejected,
        auditQueue,
        auditQueueStats: queueStats(auditQueue, availableAddresses, now, settings),
        outcomes,
        outcomeSummary: summarizeOutcomes(outcomes),
        sourceHealth: { discovery: discoveryHealth, lastAudit: lastAuditHealth, lastSecondary: lastSecondaryHealth },
        xCapability: { available: false, mode: 'manual', reason: 'X由用户点击链接人工复核' },
        policy: {
          chain,
          priorityMarketCap: [settings.priorityMinMarketCap, settings.priorityMaxMarketCap],
          discoveryMarketCap: [settings.discoveryMinMarketCap, settings.discoveryMaxMarketCap],
          minimumAgeMinutes: settings.minAgeSec / 60,
          scanIntervalMs: settings.scanIntervalMs,
          execution: 'disabled',
          xReview: 'manual'
        },
        events
      };
      next.auditQueueStats.auditedThisCycle = auditsCompleted;
      if (auditsCompleted) next.auditQueueStats.estimatedMinutes = Math.ceil(next.auditQueueStats.due / auditsCompleted) * settings.scanIntervalMs / 60_000;
      else delete next.auditQueueStats.estimatedMinutes;
      next.requestMetrics = { ...this.gmgn.metrics, cooldownUntil: this.gmgn.nextAllowedAt || 0 };
      next.chainStates = { ...(prior.chainStates || {}), [chain]: scopeSnapshot(next) };
      if (chain === this.activeChain) this.state.save(next);
    } catch (error) {
      if (this.gmgn.keyEpoch !== keyEpoch) return;
      if (chain !== this.activeChain) return;
      const rateLimited = error?.code === 'GMGN_RATE_LIMITED' || /请求频率超限/.test(error?.message || '');
      const now = Date.now();
      const next = {
        ...prior,
        status: rateLimited ? 'RATE_LIMITED' : 'ERROR',
        error: String(error?.message || '扫描暂时失败，下一轮将自动重试。'),
        retryAt: rateLimited ? now + num(error?.retryAfterMs, 30_000) : 0,
        activeChain: chain,
        supportedChains: this.supportedChains,
        scanInProgress: false,
        lastAttemptAt: startedAt,
        generatedAt: now,
        nextCycleAt: Math.max(now, startedAt + settings.scanIntervalMs),
        lastCycleMs: now - startedAt
      };
      next.events = addEvent(prior.events, rateLimited ? 'RATE_LIMITED' : 'ERROR', next.error, chain);
      next.chainStates = { ...(prior.chainStates || {}), [chain]: scopeSnapshot(next) };
      this.state.save(next);
    } finally {
      this.running = false;
      const rescanRequested = this.rescanRequested;
      this.rescanRequested = false;
      if (this.pendingChain && this.pendingChain !== this.activeChain) {
        const nextChain = this.pendingChain;
        this.pendingChain = '';
        this.activateChain(nextChain);
        queueMicrotask(() => this.cycle());
      } else if (rescanRequested) {
        queueMicrotask(() => this.cycle());
      }
    }
  }

  async start() {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      const started = Date.now();
      try {
        if (!this.running) {
          const enabled = this.controls?.value.enabledChains || [this.activeChain];
          const next = [...enabled].sort((a, b) => {
            const scope = c => c === this.activeChain ? this.state.value : this.state.value.chainStates?.[c];
            return num(scope(a)?.lastAttemptAt) - num(scope(b)?.lastAttemptAt);
          })[0];
          if (next !== this.activeChain) this.activateChain(next, true);
          await this.cycle();
        }
      } catch (error) {
        // Let the local supervisor restart instead of leaving a silently dead scheduler.
        console.error('扫描调度异常：' + String(error?.code || 'STATE_WRITE_FAILED'));
        process.exitCode = 1;
        throw error;
      } finally {
        if (!this.stopped) {
          const interval = Math.max(30_000, this.config.scanIntervalMs / (this.controls?.value.enabledChains.length || 1));
          const wait = Math.max(1000, interval - (Date.now() - started), num(this.gmgn.nextAllowedAt) - Date.now());
          this.timer = setTimeout(() => { void tick(); }, wait);
        }
      }
    };
    await tick();
  }

  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
}
