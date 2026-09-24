import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeGmgnApiKey } from './gmgn-key-store.mjs';
import { secondaryChainSupport } from './secondary.mjs';
import { tokenKey } from './local-store.mjs';
import { CHART_RISK_VERSION, applyRiskExclusion } from './chart-risk.mjs';
import { AveError } from './ave-settings.mjs';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const CHAIN_IDS = new Set(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']);
const LIVE_CANDIDATE_TTL_MS = 15 * 60_000;
const CHECK_FIELDS = [
  'openSource', 'ownerRenounced', 'lpLocked', 'notHoneypot', 'tax', 'rug',
  'concentration', 'dev', 'insider', 'bundler', 'sniper', 'wash', 'liquidity',
  'wallets', 'observation', 'chartRisk', 'marketBehavior'
];

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteOrNull(value) {
  const parsed = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : null;
}

function text(value, maxLength = 160) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

function publicMessage(value, fallback, maxLength = 160) {
  const message = text(value, maxLength);
  return /command failed|api[_ -]?key|authorization|bearer\s|private[_ -]?key|passphrase|secret|gmgn_[a-z0-9]{8,}/i.test(message)
    ? fallback
    : message;
}

function publicCode(value) {
  const code = text(value, 48).toUpperCase();
  return /^[A-Z0-9_]{1,48}$/.test(code) ? code : '';
}

function externalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href.slice(0, 500) : '';
  } catch {
    return '';
  }
}

function publicError(status) {
  if (status === 'HOURLY_BUDGET_PAUSED') return '本机小时预算暂缓，下一整点继续。';
  if (status === 'TOTAL_BUDGET_PAUSED') return '本机累计预算已用完，需核对账户额度；不会自动清零。';
  if (status === 'BUDGET_PAUSED') return '本机每日预算已用完，下一预算日继续。';
  if (status === 'QUOTA_PAUSED') return 'AVE 返回配额不足，已暂停请求，不会自动购买。';
  if (status === 'RATE_LIMITED') return '行情接口请求受限，系统将等待冷却后复查。';
  if (status === 'GMGN_AUTH_REQUIRED') return 'GMGN只读数据源尚未完成本机配置。';
  if (status === 'DEGRADED') return '本轮部分数据不完整，系统将自动复查。';
  if (status === 'ERROR' || status === 'STATE_ERROR') return '数据请求暂时失败，下一轮将自动重试。';
  return '';
}

function publicChecks(source = {}) {
  return Object.fromEntries(CHECK_FIELDS.map(key => [key, source[key] === true]));
}

function publicSecondary(source = {}) {
  const sourceStatus = row => ({
    status: text(row?.status, 24),
    errorCode: publicCode(row?.errorCode)
  });
  const market = source.market || {};
  const security = source.security || {};
  const fields = security.fields || {};
  const securityFields = {};
  for (const key of [
    'isHoneypot', 'openSource', 'mintable', 'ownerChangeBalance', 'hiddenOwner',
    'cannotSellAll', 'selfDestruct', 'externalCall', 'slippageModifiable',
    'personalSlippageModifiable', 'transferPausable', 'blacklisted',
    'tradingCooldown', 'freezable', 'closable', 'balanceMutableAuthority',
    'transferFeeUpgradable', 'nonTransferable'
  ]) {
    if (fields[key] === true || fields[key] === false || fields[key] === null) securityFields[key] = fields[key];
  }
  return {
    status: text(source.status, 24),
    complete: source.complete === true,
    checkedAt: finite(source.checkedAt),
    sources: {
      dexScreener: sourceStatus(source.sources?.dexScreener),
      goPlus: sourceStatus(source.sources?.goPlus)
    },
    market: {
      complete: market.complete === true,
      pairUrl: externalUrl(market.pairUrl),
      priceUsd: finiteOrNull(market.priceUsd),
      marketCap: finiteOrNull(market.marketCap),
      liquidityUsd: finiteOrNull(market.liquidityUsd),
      websites: Array.isArray(market.websites) ? market.websites.slice(0, 5).map(externalUrl).filter(Boolean) : []
    },
    security: {
      complete: security.complete === true,
      verdict: text(security.verdict, 32),
      fatal: Array.isArray(security.fatal) ? security.fatal.slice(0, 20).map(row => ({
        field: text(row?.field, 48),
        reason: text(row?.reason, 80)
      })) : [],
      unknownFields: Array.isArray(security.unknownFields) ? security.unknownFields.slice(0, 32).map(value => text(value, 48)) : [],
      fields: securityFields,
      buyTax: finiteOrNull(security.buyTax),
      sellTax: finiteOrNull(security.sellTax)
    },
    conflicts: Array.isArray(source.conflicts) ? source.conflicts.slice(0, 20).map(row => ({
      type: text(row?.type, 40),
      field: text(row?.field, 48),
      relativeDifference: finiteOrNull(row?.relativeDifference)
    })) : []
  };
}

export function voiceSnapshot(state, enabledChains, liveDiscovery = null) {
  const scopes = { ...state.chainStates, [state.activeChain]: state };
  return { chains: Object.fromEntries(enabledChains.filter(chain => CHAIN_IDS.has(chain)).map(chain => [chain,
    liveDiscovery ? mergedVoiceRows(liveDiscovery, state, scopes[chain], chain) : auditVoiceRows(state, scopes[chain], chain)])) };
}

function auditVoiceRows(state, scope, chain) {
  return (scope?.candidates || []).slice(0, 200).map(row => ({
    source: 'audit', chain, address: text(row.address, 80), status: text(row.status, 32),
    auditedAt: finite(row.auditedAt), staleAt: finite(row.staleAt),
    qualified: row.status === 'X_REVIEW' && row.deep?.chainPass === true && !row.auditError
      && row.auditHealth?.complete !== false && row.deep?.chartRisk?.pass === true
      && row.deep?.chartRisk?.version === CHART_RISK_VERSION
      && !state.riskExclusions?.[tokenKey(chain, row.address)]
  }));
}

function rejectedAuditKeys(scope, chain) {
  return new Set([...(scope?.candidates || []), ...(scope?.auditQueue || [])]
    .filter(row => row && ['HARD_REJECT', 'REJECTED'].includes(row.status) && text(row.address, 80))
    .map(row => tokenKey(chain, row.address)));
}

function recentLiveRows(rows, scope, chain, now = Date.now()) {
  const history = new Map((scope?.auditQueue || []).filter(row => row && typeof row.address === 'string')
    .map(row => [tokenKey(chain, row.address), finiteOrNull(row.firstSeenAt)]));
  return (rows || []).flatMap(row => {
    if (!row || row.auditEligible !== true || row.stale === true || row.discoveryState !== 'READY') return [];
    const remembered = history.get(tokenKey(chain, row.address));
    const firstSeenAt = [remembered, finiteOrNull(row.firstSeenAt), finiteOrNull(row.newAt), finiteOrNull(row.sourceUpdatedAt)]
      .find(value => value !== null && value > 0 && value <= now);
    if (!firstSeenAt || now - firstSeenAt > LIVE_CANDIDATE_TTL_MS) return [];
    // The durable queue records the first time this contract actually passed
    // the fast screen. Reappearing on another trending page must not turn it
    // into a new card or a new voice alert.
    return [{ ...row, firstSeenAt, newAt: firstSeenAt }];
  });
}

function mergedVoiceRows(liveDiscovery, state, scope, chain) {
  const rejected = rejectedAuditKeys(scope, chain);
  // The open-source fast pool is driven solely by the current AVE discovery
  // snapshot. A historical X_REVIEW must not reappear or speak after today's
  // market screen has removed that token. Deep hard rejections still veto a
  // currently live row through the retained 24-hour audit queue.
  return liveVoiceRows(liveDiscovery, state, scope, chain)
    .filter(row => !rejected.has(tokenKey(chain, row.address)))
    .slice(0, 200);
}

function liveVoiceRows(liveDiscovery, state, scope, chain) {
  let source;
  try { source = liveDiscovery.snapshot(chain); } catch { return []; }
  const snapshot = publicLiveSnapshot(source, chain);
  return recentLiveRows(snapshot.rows, scope, chain).slice(0, 200).map(row => {
    const excluded = state.riskExclusions?.[tokenKey(chain, row.address)];
    return {
      source: 'live', chain, address: text(row.address, 80),
      symbol: text(row.symbol || '?', 30), name: text(row.name, 80),
      marketCap: finiteOrNull(row.marketCap), liquidity: finiteOrNull(row.liquidity),
      volume5m: finiteOrNull(row.volume5m), createdAt: finiteOrNull(row.createdAt),
      ageBasis: ['pool', 'trade', 'launch', 'token'].includes(row.ageBasis) ? row.ageBasis : 'unknown',
      sourceUpdatedAt: finiteOrNull(row.sourceUpdatedAt), firstSeenAt: finiteOrNull(row.firstSeenAt),
      newAt: finiteOrNull(row.newAt),
      status: row.auditEligible && !row.stale && row.discoveryState === 'READY' ? 'LIVE_READY' : 'LIVE_WAIT',
      // The latest upstream observation is also the moment a previously
      // incomplete row can become eligible. Quiet baselines and the 24-hour
      // address history prevent quote refreshes from creating repeat alerts.
      auditedAt: finite(row.newAt || row.sourceUpdatedAt),
      staleAt: finite(row.expiresAt),
      qualified: row.auditEligible === true && row.stale !== true && row.discoveryState === 'READY' && !excluded
    };
  });
}

// Quote and pool clocks are market evidence, never a refreshed audit clock or
// proof of token creation. Preserve unknowns rather than converting them to 0.
function publicMarketEvidence(row = {}, now = Date.now()) {
  if (row.marketProvider !== 'AVE') return {};
  const clock = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  const capturedAt = clock(row.capturedAt), sourceUpdatedAt = clock(row.sourceUpdatedAt), expiresAt = clock(row.expiresAt);
  const stale = row.stale !== false || capturedAt === null || sourceUpdatedAt === null || expiresAt === null
    || capturedAt > now || sourceUpdatedAt > capturedAt || now - sourceUpdatedAt > 60_000 || now >= expiresAt;
  return { marketProvider: 'AVE', ageBasis: ['pool', 'trade', 'launch', 'token'].includes(row.ageBasis) ? row.ageBasis : 'unknown',
    capturedAt, sourceUpdatedAt, expiresAt, stale, auditEligible: row.auditEligible === true && !stale,
    volume5m: optionalMarketNumber(row.volume5m), activityWindow: row.activityWindow === '5m' ? '5m' : null,
    pairAddress: typeof row.pairAddress === 'string' && /^(?:0x(?:[0-9a-f]{40}|[0-9a-f]{64})|[1-9A-HJ-NP-Za-km-z]{32,44})$/i.test(row.pairAddress) ? row.pairAddress : '',
    poolCreatedAt: clock(row.poolCreatedAt), firstTradeAt: clock(row.firstTradeAt) };
}
function optionalMarketNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function publicLiveSnapshot(source = {}, chain) {
  const statuses = ['WAITING', 'LOADING', 'READY', 'AUTH_REQUIRED', 'ERROR', 'BUDGET_PAUSED', 'HOURLY_BUDGET_PAUSED', 'TOTAL_BUDGET_PAUSED', 'QUOTA_PAUSED', 'RATE_LIMITED'];
  const codes = new Set(['READ_FAILED', 'GMGN_RATE_LIMITED', 'GMGN_AUTH_FAILED', 'GMGN_PERMISSION_DENIED', 'GMGN_TIMEOUT', ...AVE_PUBLIC_CODES]);
  const output = { chain, marketProvider: source.marketProvider === 'AVE' ? 'AVE' : null,
    status: statuses.includes(source.status) ? source.status : 'WAITING', code: codes.has(source.code) ? source.code : null,
    execution: false, stale: source.stale !== false,
    ...Object.fromEntries(['intervalMs', 'nextPollAt', 'lastAttemptAt', 'lastPollAt', 'lastSuccessAt', 'requestMs', 'pollCount', 'receivedCount', 'filteredCount']
      .map(key => [key, nonnegative(source[key])])),
    diagnostics: Object.fromEntries(['received', 'inRange', 'pending', 'stale', 'ready', 'excluded', 'outsideRange']
      .map(key => [key, nonnegative(source.diagnostics?.[key])])),
    rows: (Array.isArray(source.rows) ? source.rows : []).slice(0, 300)
      .filter(row => row && typeof row.address === 'string' && (!row.chain || row.chain === chain)
        && (chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-f]{40}$/i).test(row.address))
      .map(row => ({ address: row.address, chain, symbol: publicMessage(row.symbol, '?', 30), name: publicMessage(row.name, '', 80),
        ...Object.fromEntries(['marketCap', 'liquidity', 'createdAt', 'price', 'volume1m', 'buys1m', 'sells1m', 'swaps1m', 'holders', 'smartMoney',
          'volume5m', 'buys5m', 'sells5m', 'observedAt', 'capturedAt', 'sourceUpdatedAt', 'expiresAt', 'holderSourceUpdatedAt', 'firstSeenAt', 'newAt', 'deltaWindowMs']
          .map(key => [key, optionalMarketNumber(row[key])])),
        ...Object.fromEntries(['priceDelta', 'holdersDelta', 'smartDelta'].map(key => [key,
          typeof row[key] === 'number' && Number.isFinite(row[key]) ? row[key] : null])),
        priorityBand: row.priorityBand === true, hasUnknownRisk: row.hasUnknownRisk !== false,
        stale: row.stale === true, auditEligible: row.auditEligible === true,
        discoveryState: ['READY', 'PENDING', 'STALE'].includes(row.discoveryState) ? row.discoveryState : null,
        website: externalUrl(row.website), twitter: publicMessage(row.twitter, '', 80),
        ...publicMarketEvidence(row) })) };
  if (output.rows.length && output.rows.every(row => row.stale === true)) output.stale = true;
  return output;
}

function publicCandidate(row = {}) {
  const earlyExit = row.auditHealth?.earlyExit === true;
  const deep = row.deep || {};
  const currentRules = deep.chartRisk?.version === CHART_RISK_VERSION;
  const security = deep.security || {};
  const wallets = deep.wallets || {};
  const observation = deep.observation || {};
  const sellability = deep.sellability || {};
  const social = row.social || {};
  const info = row.info || {};
  return {
    address: text(row.address, 80),
    chain: text(row.chain, 32),
    symbol: text(row.symbol || '?', 30),
    name: text(row.name, 80),
    marketCap: finite(row.marketCap),
    liquidity: finite(row.liquidity),
    price: finiteOrNull(row.price),
    createdAt: finite(row.createdAt),
    ageSec: row.marketProvider === 'AVE' ? optionalMarketNumber(row.ageSec) : finite(row.ageSec),
    ...publicMarketEvidence(row),
    priorityBand: row.priorityBand === true,
    discoveryScore: finite(row.discoveryScore),
    holders: row.marketProvider === 'AVE' ? optionalMarketNumber(row.holders) : finite(row.holders),
    volume1h: row.marketProvider === 'AVE' ? optionalMarketNumber(row.volume1h) : finite(row.volume1h),
    buys: row.marketProvider === 'AVE' ? optionalMarketNumber(row.buys) : finite(row.buys),
    sells: row.marketProvider === 'AVE' ? optionalMarketNumber(row.sells) : finite(row.sells),
    twitter: text(row.twitter, 80),
    gmgnUrl: externalUrl(row.gmgnUrl),
    status: ['X_REVIEW', 'QUALIFIED'].includes(row.status) && !currentRules ? 'WAIT_RECHECK' : text(row.status, 32),
    auditedAt: finite(row.auditedAt),
    staleAt: finite(row.staleAt),
    reviewRevision: text(row.reviewRevision, 64),
    auditHealth: { earlyExit },
    auditError: row.auditError ? '深度审计暂时失败，已进入等待复查。' : '',
    decisionReason: ['X_REVIEW', 'QUALIFIED'].includes(row.status) && !currentRules
      ? '风险规则已升级，等待重新核验' : text(row.decisionReason, 120),
    deep: {
      chainPass: deep.chainPass === true && currentRules,
      chartRisk: { version: finite(deep.chartRisk?.version), status: text(deep.chartRisk?.status, 32),
        pass: deep.chartRisk?.pass === true, from: finite(deep.chartRisk?.from), to: finite(deep.chartRisk?.to),
        reasons: (deep.chartRisk?.reasons || []).slice(0, 5).map(reason => text(reason, 100)) },
      failed: Array.isArray(deep.failed) ? deep.failed.slice(0, 32).map(value => text(value, 40)) : [],
      unknownFields: Array.isArray(deep.unknownFields) ? deep.unknownFields.slice(0, 48).map(value => text(value, 64)) : [],
      blockingUnknownFields: Array.isArray(deep.blockingUnknownFields) ? deep.blockingUnknownFields.slice(0, 48).map(value => text(value, 64)) : [],
      checks: publicChecks(deep.checks),
      honeypotEvidence: text(deep.honeypotEvidence, 80),
      security: {
        openSource: security.openSource === true || security.openSource === false ? security.openSource : text(security.openSource, 16),
        ownerRenounced: security.ownerRenounced === true || security.ownerRenounced === false ? security.ownerRenounced : text(security.ownerRenounced, 16),
        evmOwnerRenounced: security.evmOwnerRenounced === true || security.evmOwnerRenounced === false ? security.evmOwnerRenounced : null,
        renouncedMint: security.renouncedMint === true || security.renouncedMint === false ? security.renouncedMint : null,
        renouncedFreezeAccount: security.renouncedFreezeAccount === true || security.renouncedFreezeAccount === false ? security.renouncedFreezeAccount : null,
        honeypot: security.honeypot === true || security.honeypot === false ? security.honeypot : null,
        buyTax: finiteOrNull(security.buyTax),
        sellTax: finiteOrNull(security.sellTax),
        taxDifference: finiteOrNull(security.taxDifference),
        rugRatio: finiteOrNull(security.rugRatio),
        top10: finiteOrNull(security.top10),
        devHold: finiteOrNull(security.devHold),
        insider: finiteOrNull(security.insider),
        bundler: finiteOrNull(security.bundler),
        sniperHold: finiteOrNull(security.sniperHold),
        lockRate: finiteOrNull(security.lockRate),
        lpBurned: security.lpBurned === true,
        liquidity: finite(security.liquidity)
      },
      wallets: {
        sampled: earlyExit ? null : finite(wallets.sampled),
        ordinaryCount: earlyExit ? null : finite(wallets.ordinaryCount),
        ordinaryHoldRate: earlyExit ? null : finiteOrNull(wallets.ordinaryHoldRate),
        riskWalletCount: finite(wallets.riskWalletCount),
        botHoldRate: earlyExit ? null : finiteOrNull(wallets.botHoldRate),
        linkedHoldRate: earlyExit ? null : finiteOrNull(wallets.linkedHoldRate),
        duplicateCount: finite(wallets.duplicateCount),
        missingAddressCount: finite(wallets.missingAddressCount),
        invalidRateCount: finite(wallets.invalidRateCount),
        unknownFields: Array.isArray(wallets.unknownFields) ? wallets.unknownFields.slice(0, 32).map(value => text(value, 64)) : [],
        dataComplete: wallets.dataComplete === true,
        pass: wallets.pass === true
      },
      observation: {
        pass: observation.pass === true,
        status: text(observation.status, 24),
        reason: publicMessage(observation.reason, '盘面证据状态已更新。', 100),
        bars: finite(observation.bars),
        return5m: finiteOrNull(observation.return5m),
        maxDrawdown: finiteOrNull(observation.maxDrawdown),
        volumeConcentration: finiteOrNull(observation.volumeConcentration),
        totalVolume: finiteOrNull(observation.totalVolume),
        activeBars: finite(observation.activeBars),
        volumeChange: finiteOrNull(observation.volumeChange),
        volumeTrend: text(observation.volumeTrend, 24),
        decliningVolumeBars: finite(observation.decliningVolumeBars),
        invalidBars: finite(observation.invalidBars),
        duplicateBars: finite(observation.duplicateBars),
        continuous: observation.continuous === true,
        fresh: observation.fresh === true,
        latestClosedAt: finite(observation.latestClosedAt),
        stalenessMs: finite(observation.stalenessMs),
        unknownFields: Array.isArray(observation.unknownFields) ? observation.unknownFields.slice(0, 16).map(value => text(value, 64)) : []
      },
      sellability: {
        pass: sellability.pass === true,
        sells5m: finite(sellability.sells5m),
        sells24h: finite(sellability.sells24h),
        distinctSellers: earlyExit ? null : finite(sellability.distinctSellers),
        historicalDistinctSellers: finite(sellability.historicalDistinctSellers),
        windowSec: finite(sellability.windowSec),
        unknownFields: Array.isArray(sellability.unknownFields) ? sellability.unknownFields.slice(0, 16).map(value => text(value, 64)) : [],
        evidenceType: text(sellability.evidenceType, 48),
        evidenceNote: publicMessage(sellability.evidenceNote, '卖出证据仅作为经验参考。', 200)
      }
    },
    social: {
      status: text(social.status, 24),
      score: finite(social.score),
      reason: publicMessage(social.reason, 'X社区需要人工复核。', 160),
      twitter: text(social.twitter, 80)
    },
    info: {
      twitter: text(info.twitter, 80),
      website: externalUrl(info.website)
    },
    secondary: row.secondary && typeof row.secondary === 'object' ? publicSecondary(row.secondary) : null
  };
}

function publicRejected(row = {}) {
  return {
    address: text(row.address, 80),
    symbol: text(row.symbol || '?', 30),
    marketCap: finite(row.marketCap),
    liquidity: finite(row.liquidity),
    ageSec: finite(row.ageSec),
    createdAt: finite(row.createdAt),
    status: text(row.status, 32),
    stage: text(row.stage, 32),
    nextCheckAt: finite(row.nextCheckAt),
    reasons: Array.isArray(row.reasons) ? row.reasons.slice(0, 24).map(value => text(value, 80)) : []
  };
}

function publicEvent(event = {}) {
  const type = text(event.type, 32);
  const fixedMessage = type === 'ERROR'
    ? '数据请求暂时失败，系统会在下一轮重试。'
    : type === 'RATE_LIMITED'
      ? 'GMGN请求频率超限，系统已进入等待重试。'
      : type === 'AUTH'
        ? 'GMGN只读数据源尚未完成本机配置。'
        : publicMessage(event.message, '雷达状态已更新。', 160);
  return { at: finite(event.at), type, chain: text(event.chain, 32), message: fixedMessage };
}

function countSummary(source, allowedKeys) {
  const result = {};
  for (const key of allowedKeys) {
    if (source?.[key] !== undefined) result[key] = finite(source[key]);
  }
  return result;
}

function healthMessage(row = {}, provider) {
  if (row.ok === true) return '';
  const code = publicCode(row.code || row.errorCode);
  if (provider === 'AVE' || code.startsWith('AVE_')) {
    if (row.state === 'unverified' || code === 'AVE_FIELD_UNVERIFIED') return 'AVE 当前只读接口尚未提供该核验证据；不等于安全，也不表示网络失败。';
    const messages = {
      AVE_AUTH: 'AVE 行情凭证或权限未通过。', AVE_CONFIG: 'AVE 行情凭证尚未配置。', AVE_DISABLED: 'AVE 行情访问已暂停。',
      AVE_RATE_LIMITED: 'AVE 行情请求受限，正在冷却；不会自动购买额度。', AVE_RATE_LIMIT: 'AVE 行情请求受限，正在冷却。',
      AVE_QUOTA: 'AVE 配额不足，已暂停行情请求；不会自动购买。', AVE_BUDGET: '本机每日行情预算已用完。',
      AVE_HOURLY_BUDGET: '本机小时预算已用完，下一小时继续。', AVE_TOTAL_BUDGET: '本机累计预算已用完，需核对账户额度后调整；不会自动清零。',
      AVE_BUDGET_STORE: '本机行情预算无法安全保存，已暂停请求。', AVE_TIMEOUT: 'AVE 行情响应超时。',
      AVE_NETWORK: 'AVE 行情连接失败。', AVE_SCHEMA: 'AVE 行情格式或身份未通过核验。', AVE_SIZE: 'AVE 行情响应超过大小限制。',
      AVE_CHANGED: 'AVE 配置已变化，本次数据未采用。', AVE_ABORTED: 'AVE 行情请求已取消。', AVE_BUSY: 'AVE 行情队列已满。',
      AVE_UPSTREAM: 'AVE 行情请求未成功。',
    };
    return messages[code] || 'AVE 核验证据状态未知，不能视为已通过。';
  }
  if (/RATE_LIMIT/.test(code)) return 'GMGN请求频率受限，系统将自动重试。';
  if (/AUTH|UNAUTHORIZED/.test(code)) return 'GMGN只读授权无效或已失效。';
  if (/PERMISSION|FORBIDDEN/.test(code)) return 'GMGN当前权限无法读取该数据。';
  if (/TIMEOUT/.test(code)) return 'GMGN数据请求超时。';
  return 'GMGN数据请求暂时失败。';
}

function endpointHealth(row = {}, provider) {
  return {
    ok: row.ok === true,
    count: finite(row.count),
    code: provider === 'AVE' ? AVE_PUBLIC_CODES.has(row.code) ? row.code : '' : publicCode(row.code),
    message: healthMessage(row, provider),
    ...(provider === 'AVE' ? { state: ['ok', 'error', 'unverified'].includes(row.state) ? row.state : row.ok === true ? 'ok' : 'unverified',
      capturedAt: optionalMarketNumber(row.capturedAt), sourceUpdatedAt: optionalMarketNumber(row.sourceUpdatedAt), cacheHit: row.cacheHit === true } : {})
  };
}

function secondaryEndpointHealth(row = {}) {
  const status = text(row.status, 24).toUpperCase();
  const errorCode = publicCode(row.errorCode);
  const messages = {
    NO_DATA: '第二数据源暂未找到该代币。',
    ERROR: errorCode === 'TIMEOUT' ? '第二数据源请求超时。' : '第二数据源请求暂时失败。',
    UNSUPPORTED: '当前链尚无该第二数据源覆盖。'
  };
  return { ok: status === 'OK', status, code: errorCode, message: messages[status] || '' };
}

function publicSourceHealth(source = {}) {
  const result = {};
  if (source.discovery && typeof source.discovery === 'object') {
    const ave = source.discovery.provider === 'AVE';
    result.discovery = {
      ...(ave ? { provider: 'AVE' } : {}),
      complete: source.discovery.complete === true,
      checkedAt: finite(source.discovery.checkedAt),
      ...(!ave ? { trenches: endpointHealth(source.discovery.trenches) } : {}),
      ...(!ave || source.discovery.trending ? { trending: endpointHealth(source.discovery.trending, ave ? 'AVE' : undefined) } : {}),
      ...(ave && source.discovery.coverage ? { coverage: Object.fromEntries(['pages', 'inRange', 'maxPages']
        .map(key => [key, nonnegative(source.discovery.coverage[key])])) } : {}),
      ...(ave && source.discovery.enrichment ? { enrichment: {
        attempted: nonnegative(source.discovery.enrichment.attempted), enriched: nonnegative(source.discovery.enrichment.enriched),
        deferred: nonnegative(source.discovery.enrichment.deferred), complete: source.discovery.enrichment.complete === true,
        pausedCode: AVE_PUBLIC_CODES.has(source.discovery.enrichment.pausedCode) ? source.discovery.enrichment.pausedCode : null,
        pausedUntil: nonnegative(source.discovery.enrichment.pausedUntil),
        errorCount: Array.isArray(source.discovery.enrichment.errors) ? source.discovery.enrichment.errors.length : 0 } } : {})
    };
  }
  if (source.lastAudit && typeof source.lastAudit === 'object') {
    const ave = source.lastAudit.provider === 'AVE';
    const endpoints = {};
    for (const name of ['info', 'security', 'pool', 'holders', 'traders', 'candles']) {
      if (source.lastAudit.endpoints?.[name]) endpoints[name] = endpointHealth(source.lastAudit.endpoints[name], ave ? 'AVE' : undefined);
    }
    result.lastAudit = {
      ...(ave ? { provider: 'AVE', transportComplete: source.lastAudit.transportComplete === true,
        marketComplete: source.lastAudit.marketComplete === true, evidenceComplete: source.lastAudit.evidenceComplete === true,
        marketFresh: source.lastAudit.marketFresh === true, capturedAt: optionalMarketNumber(source.lastAudit.capturedAt),
        missingEvidence: ['info', 'security', 'pool', 'holders', 'traders', 'candles'].filter(name => source.lastAudit.missingEvidence?.includes(name)),
        requestedEndpoints: ['info', 'security', 'pool', 'holders', 'traders', 'candles'].filter(name => source.lastAudit.requestedEndpoints?.includes(name)) } : {}),
      complete: source.lastAudit.complete === true,
      checkedAt: finite(source.lastAudit.checkedAt || source.lastAudit.auditedAt),
      code: ave ? AVE_PUBLIC_CODES.has(source.lastAudit.code) ? source.lastAudit.code : '' : publicCode(source.lastAudit.code),
      endpoints
    };
  }
  if (source.lastSecondary && typeof source.lastSecondary === 'object') {
    result.lastSecondary = {
      complete: source.lastSecondary.complete === true,
      checkedAt: finite(source.lastSecondary.checkedAt),
      status: text(source.lastSecondary.status, 24),
      sources: {
        dexScreener: secondaryEndpointHealth(source.lastSecondary.sources?.dexScreener),
        goPlus: secondaryEndpointHealth(source.lastSecondary.sources?.goPlus)
      }
    };
  }
  return result;
}

function publicAuditQueueStats(source = {}) {
  return countSummary(source, [
    'total', 'retained', 'due', 'neverAudited', 'waitingRecheck', 'hardReject',
    'chainReview', 'estimatedMinutes', 'attempted', 'succeeded', 'failed', 'auditedThisCycle'
  ]);
}

function publicOutcomeSummary(source = {}) {
  return {
    ...countSummary(source, [
      'tracked', 'minimumSample', 'completed5m', 'completed15m', 'completed30m', 'completed1h',
      'completed2h', 'completed6h', 'completed24h'
    ]),
    calibrationReady: source.calibrationReady === true,
    averageReturn5m: finiteOrNull(source.averageReturn5m),
    averageReturn15m: finiteOrNull(source.averageReturn15m),
    averageReturn30m: finiteOrNull(source.averageReturn30m),
    averageReturn1h: finiteOrNull(source.averageReturn1h),
    averageReturn2h: finiteOrNull(source.averageReturn2h),
    averageReturn24h: finiteOrNull(source.averageReturn24h),
    note: text(source.note, 160)
    ,coverage: Object.fromEntries(['passed', 'rejected'].map(cohort => [cohort,
      Object.fromEntries(['m5','m15','m30','h1','h2','h6','h24'].map(key => {
        const row = source.coverage?.[cohort]?.[key] || {};
        return [key, { ...countSummary(row, ['eligible','completed','missing']), median: finiteOrNull(row.median), positiveRate: finiteOrNull(row.positiveRate) }];
      }))
    ]))
  };
}

export function toPublicStatus(source = {}) {
  const status = text(source.status, 32) || 'STARTING';
  const requestedActiveChain = text(source.activeChain || source.policy?.chain, 32).toLowerCase();
  const activeChain = CHAIN_IDS.has(requestedActiveChain) ? requestedActiveChain : 'robinhood';
  const requestedPendingChain = text(source.pendingChain, 32).toLowerCase();
  const priorityMarketCap = Array.isArray(source.policy?.priorityMarketCap)
    ? source.policy.priorityMarketCap.slice(0, 2).map(value => finite(value))
    : [];
  return {
    version: finite(source.version, 1),
    status,
    error: publicError(status),
    retryAt: finite(source.retryAt),
    generatedAt: finite(source.generatedAt),
    lastAttemptAt: finite(source.lastAttemptAt),
    lastSuccessAt: finite(source.lastSuccessAt),
    nextCycleAt: finite(source.nextCycleAt),
    lastCompleteSuccessAt: finite(source.lastCompleteSuccessAt),
    cycleStartedAt: finite(source.cycleStartedAt),
    scanInProgress: source.scanInProgress === true,
    lastCycleMs: finite(source.lastCycleMs),
    scanCount: finite(source.scanCount),
    discoveredCount: finite(source.discoveredCount),
    prequalifiedCount: finite(source.prequalifiedCount),
    activeChain,
    pendingChain: CHAIN_IDS.has(requestedPendingChain) ? requestedPendingChain : '',
    supportedChains: Array.isArray(source.supportedChains)
      ? source.supportedChains.slice(0, CHAIN_IDS.size).map(value => text(value, 32)).filter(value => CHAIN_IDS.has(value))
      : [],
    candidates: Array.isArray(source.candidates) ? source.candidates.slice(0, 100)
      .map(row => publicCandidate(applyRiskExclusion(row, source.riskExclusions, activeChain))) : [],
    rejected: Array.isArray(source.rejected) ? source.rejected.slice(0, 100).map(publicRejected) : [],
    events: Array.isArray(source.events) ? source.events.slice(0, 100).map(publicEvent) : [],
    xCapability: {
      available: source.xCapability?.available === true,
      backend: text(source.xCapability?.backend, 48),
      reason: publicMessage(source.xCapability?.reason, 'X社区需要人工复核。', 120)
    },
    sourceHealth: publicSourceHealth(source.sourceHealth),
    auditQueueStats: publicAuditQueueStats(source.auditQueueStats),
    outcomeSummary: publicOutcomeSummary(source.outcomeSummary),
    policy: {
      chain: text(source.policy?.chain, 32),
      priorityMarketCap,
      discoveryMarketCap: Array.isArray(source.policy?.discoveryMarketCap)
        ? source.policy.discoveryMarketCap.slice(0, 2).map(value => finite(value))
        : [],
      minimumAgeMinutes: finite(source.policy?.minimumAgeMinutes),
      scanIntervalMs: finite(source.policy?.scanIntervalMs),
      xReview: source.policy?.xReview === 'manual' ? 'manual' : '',
      execution: 'disabled'
    }
  };
}

function inlineHashes(html, tagName) {
  const hashes = [];
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  for (const match of html.matchAll(pattern)) {
    const digest = crypto.createHash('sha256').update(match[1], 'utf8').digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

function contentSecurityPolicy(html) {
  const scripts = inlineHashes(html, 'script');
  const styles = inlineHashes(html, 'style');
  return [
    "default-src 'none'",
    "base-uri 'none'",
    `script-src 'self' ${scripts.join(' ')}`.trim(),
    "script-src-attr 'none'",
    `style-src 'self' ${styles.join(' ')}`.trim(),
    "style-src-attr 'none'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "worker-src 'none'",
    "manifest-src 'self'"
  ].join('; ');
}

function headers(type, csp) {
  return {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Content-Security-Policy': csp
  };
}

function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function isTrustedLocalRequest(req, settings) {
  if (!LOOPBACK_ADDRESSES.has(String(req.socket?.remoteAddress || ''))) return false;
  const hosts = allowedHosts(settings.port);
  const host = String(req.headers?.host || '').toLowerCase();
  if (!hosts.has(host)) return false;

  const origin = req.headers?.origin;
  if (origin) {
    let originHost;
    try {
      const parsed = new URL(String(origin));
      if (parsed.protocol !== 'http:') return false;
      originHost = parsed.host.toLowerCase();
    } catch {
      return false;
    }
    if (!hosts.has(originHost) || originHost !== host) return false;
  }

  const fetchSite = String(req.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none') return true;
  // A link from another website/app is a cross-site top-level navigation, not
  // a cross-origin API request. Only the static landing document is public in
  // this narrow case; loopback, Host and explicit Origin checks still apply.
  if (!['cross-site', 'same-site'].includes(fetchSite) || req.method !== 'GET'
    || req.headers?.['sec-fetch-mode'] !== 'navigate' || req.headers?.['sec-fetch-dest'] !== 'document') return false;
  try {
    const target = new URL(req.url, `http://${host}`);
    return target.origin === `http://${host}` && ['/', '/index.html'].includes(target.pathname);
  } catch { return false; }
}

export function healthSnapshot(source = {}, settings, now = Date.now()) {
  const maxAgeMs = scannerFreshnessMaxAge(settings);
  const lastSuccessAt = finite(source.lastSuccessAt);
  const ageMs = lastSuccessAt > 0 ? Math.max(0, now - lastSuccessAt) : null;
  const fresh = ageMs !== null && ageMs <= maxAgeMs;
  const status = text(source.status, 32) || 'STARTING';
  const ready = status === 'RUNNING' && fresh;
  return {
    ok: true,
    service: 'meme-radar',
    version: versionValue(settings.version),
    instanceId: crypto.createHash('sha256').update(String(settings.publicDir)).digest('hex').slice(0, 16),
    ready,
    degraded: !ready,
    scanner: {
      status,
      fresh,
      scanInProgress: source.scanInProgress === true,
      cycleStartedAt: finite(source.cycleStartedAt),
      lastSuccessAt,
      ageMs,
      maxAgeMs
    },
    execution: false
  };
}

function scannerFreshnessMaxAge(settings = {}) {
  const interval = finite(settings.scanIntervalMs, 120_000);
  return Math.max(5 * 60_000, Math.min(60 * 60_000, interval * 3));
}

function selectedChainScope(source, chain, enabledChains, settings, now = Date.now()) {
  if (!chain) return source;
  // Older embedders may omit RadarControls. In that case the enabled set is
  // unknown, so retain the legacy assumption that a supported chain is live.
  const enabled = !Array.isArray(enabledChains) || enabledChains.includes(chain);
  const lastSuccessAt = finite(source.lastSuccessAt);
  const fresh = lastSuccessAt > 0 && now - lastSuccessAt <= scannerFreshnessMaxAge(settings);
  if (enabled && (source.status !== 'RUNNING' || fresh)) return source;
  return {
    ...source,
    // A disabled chain is a historical view, not an active scanner. An
    // enabled-but-expired RUNNING scope is degraded until its next real turn.
    status: enabled && lastSuccessAt ? 'DEGRADED' : 'STARTING',
    scanInProgress: false,
    pendingChain: '',
    ...(enabled ? {} : { retryAt: 0, nextCycleAt: 0 })
  };
}

function sendJson(res, statusCode, value, csp) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, { ...headers('application/json; charset=utf-8', csp), 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function bodyError(code, message) {
  const error = new Error(message);
  error.statusCode = code;
  return error;
}

function readSmallJson(req, maxBytes = 1024) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return Promise.reject(bodyError(415, 'json_required'));
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return Promise.reject(bodyError(413, 'body_too_large'));

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(bodyError(413, 'body_too_large'));
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed);
      } catch {
        reject(bodyError(400, 'invalid_json'));
      }
    });
    req.on('error', () => reject(bodyError(400, 'invalid_request')));
  });
}

function allowedChainIds(supportedChains) {
  const configured = Array.isArray(supportedChains)
    ? supportedChains.map(value => text(value, 32)).filter(value => CHAIN_IDS.has(value))
    : [];
  return new Set(configured.length ? configured : CHAIN_IDS);
}

const versionValue = value => typeof value === 'string' && /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(value) ? value : null;
const AVE_PUBLIC_CODES = new Set(['AVE_AUTH', 'AVE_RATE_LIMIT', 'AVE_RATE_LIMITED', 'AVE_QUOTA', 'AVE_BUDGET', 'AVE_HOURLY_BUDGET', 'AVE_TOTAL_BUDGET', 'AVE_BUDGET_STORE', 'AVE_DISCOVERY_RESERVE',
  'AVE_STORAGE', 'AVE_SCHEMA', 'AVE_SIZE', 'AVE_TIMEOUT', 'AVE_CHANGED', 'AVE_ABORTED', 'AVE_DISABLED', 'AVE_BUSY', 'AVE_CONNECT',
  'AVE_NETWORK', 'AVE_UPSTREAM', 'AVE_CONFIG', 'AVE_KEY', 'AVE_INPUT', 'AVE_COOLDOWN', 'AVE_RELOAD', 'AVE_FIELD_UNVERIFIED']);
const UPDATE_PUBLIC_CODES = new Set(['UPDATE_NETWORK', 'UPDATE_STORAGE', 'UPDATE_LOCAL', 'UPDATE_CHECKSUM', 'UPDATE_ARCHIVE',
  'UPDATE_BUSY', 'UPDATE_VERSION', 'UPDATE_PLATFORM', 'UPDATE_DEPENDENCIES', 'UPDATE_HANDOFF', 'UPDATE_START']);
const readSnapshot = callback => { try { return callback?.() || {}; } catch { return {}; } };
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
function publicAveConnection(source = {}) {
  const configured = source.configured === true || source.data?.configured === true;
  const data = source.data || {};
  const status = ['connected', 'error', 'untested'].includes(data.status) ? data.status
    : source.status === 'VERIFIED' ? 'connected' : 'untested';
  return { configured, requiresReentry: source.requiresReentry === true, hasStoredKey: source.hasStoredKey === true || configured,
    status: !configured ? 'UNCONFIGURED' : status === 'connected' ? 'VERIFIED' : source.status === 'CHECKING' ? 'CHECKING' : 'CONFIGURED',
    data: { configured, status, checkedAt: nonnegative(data.checkedAt), code: AVE_PUBLIC_CODES.has(data.code) ? data.code : null,
      message: status === 'connected' ? 'AVE 行情接口测试通过；不代表可下单' : status === 'error' ? 'AVE 行情验证未通过，请检查错误代码' : 'AVE 行情尚未测试' },
    trade: { configured: false, status: 'disabled' }, executionReady: false,
    executionReason: '仅接入 AVE 行情；没有连接钱包、签名或下单能力' };
}
function publicAveMarket(source = {}, supportedChains = []) {
  const publicChains = allowedChainIds(supportedChains);
  const budget = source.budget;
  return { provider: 'AVE', readonly: true, dailyLimit: nonnegative(source.dailyLimit), nextAllowedAt: nonnegative(source.nextAllowedAt),
    totalLimit: nonnegative(source.totalLimit), hourlyLimit: nonnegative(source.hourlyLimit), manualResetRequired: source.manualResetRequired === true,
    pauseCode: AVE_PUBLIC_CODES.has(source.pauseCode) ? source.pauseCode : null, pending: nonnegative(source.pending),
    recovery: { active: source.recovery?.active === true, headOnly: source.recovery?.headOnly === true, auditAllowed: source.recovery?.auditAllowed !== false },
    discoveryReserveCu: nonnegative(source.discoveryReserveCu), nonTrendingPausedUntil: nonnegative(source.nonTrendingPausedUntil),
    transport: { spacingMs: nonnegative(source.transport?.spacingMs), strikes: nonnegative(source.transport?.strikes),
      last429At: nonnegative(source.transport?.last429At), active: source.transport?.active === true,
      recent: (Array.isArray(source.transport?.recent) ? source.transport.recent : []).slice(-20).map(row => ({
        endpoint: ['trending', 'details', 'pair', 'klines'].includes(row?.endpoint) ? row.endpoint : 'unknown',
        chain: publicChains.has(row?.chain) ? row.chain : '',
        category: ['ok', 'rate', 'quota', 'gateway', 'unknown', 'timeout', 'cancelled'].includes(row?.category) ? row.category : 'unknown',
        ...Object.fromEntries(['at', 'httpStatus', 'durationMs', 'retryAt', 'retryAfterMs'].map(key => [key, nonnegative(row?.[key])])),
        startGapMs: finiteOrNull(row?.startGapMs)
      })) },
    metrics: { ...Object.fromEntries(['requests', 'cacheHits', 'rateLimits', 'estimatedCu', 'discoveryCacheHits'].map(key => [key, nonnegative(source.metrics?.[key])])),
      scope: 'session', byKind: Object.fromEntries(['trending', 'details', 'pair', 'klines'].map(kind => [kind,
        Object.fromEntries(['requests', 'cacheHits', 'estimatedCu'].map(key => [key, nonnegative(source.metrics?.byKind?.[kind]?.[key])]))])) },
    budget: budget && typeof budget === 'object' ? {
      day: typeof budget.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(budget.day) ? budget.day : null,
      ...Object.fromEntries(['used', 'remaining', 'nonTrendingRemaining', 'totalUsed', 'totalRemaining', 'hourUsed', 'hourRemaining', 'periodStartedAt', 'blockedUntil', 'quotaUntil', 'nextRequestAt'].map(key => [key, nonnegative(budget[key])])),
      legacyUsageIncluded: budget.legacyUsageIncluded === true,
      basis: 'local_estimated_cu' } : null,
    chains: Object.fromEntries([...publicChains].filter(chain => source.chains?.[chain]).map(chain => [chain, {
      apiChain: chain === 'sol' ? 'solana' : chain, documented: source.chains[chain].documented === true,
      state: source.chains[chain].state === 'observed' ? 'observed' : 'unverified' }])) };
}
function publicUpdate(source = {}) {
  const messages = { idle: '尚未检查更新', checking: '正在检查官方稳定版本', available: '发现更高的稳定版本，可确认更新',
    current: '当前已是最新稳定版本', blocked: '更新条件未通过，当前版本保留；请查看错误代码', verifying: '正在校验发布包和当前安装',
    handoff: '校验完成，正在交接更新；失败将尝试恢复原版本', complete: '更新完成',
    rolled_back: '更新未完成，已恢复原版本', rollback_blocked: '自动恢复未完成，请保留原目录与备份' };
  const phase = Object.hasOwn(messages, source.phase) ? source.phase : 'idle';
  const code = UPDATE_PUBLIC_CODES.has(source.code) ? source.code : null;
  const message = code === 'UPDATE_LOCAL' ? '本机测试版或源码工作区不允许自动覆盖；请保留当前版本' : messages[phase];
  const assetName = typeof source.assetName === 'string' && /^MemeRadar-OpenSource-(?:Windows-x64|macOS)-\d+\.\d+\.\d+\.zip$/.test(source.assetName)
    && source.assetName.length < 128 ? source.assetName : null;
  return { phase, code, message, currentVersion: versionValue(source.currentVersion), availableVersion: versionValue(source.availableVersion),
    assetName, checkedAt: nonnegative(source.checkedAt), canInstall: phase === 'available' && source.canInstall === true,
    restartRequired: phase === 'handoff', repository: 'nhovongoc0-max/meme-radar' };
}

export function createServer({ state, settings, controls, switchChain, saveGmgnKey, disconnectGmgnKey, getGmgnOnboarding, getGmgnConnection,
  liveDiscovery, enqueueReview, ave, getAveConnection, getMarketStatus, updater, onUpdateReady, supportedChains = [] }) {
  const publicChains = allowedChainIds(supportedChains);
  const dashboard = path.join(settings.publicDir, 'index.html');
  const dashboardHtml = fs.readFileSync(dashboard, 'utf8');
  const csp = contentSecurityPolicy(dashboardHtml);
  let handoffScheduled = false;
  const aveSnapshot = () => publicAveConnection(readSnapshot(() => ave?.snapshot()));
  const updateSnapshot = () => publicUpdate(readSnapshot(() => updater?.snapshot()));

  const server = http.createServer(async (req, res) => {
    if (!isTrustedLocalRequest(req, settings)) {
      return sendJson(res, 403, { error: 'local_request_required' }, csp);
    }

    let url;
    try {
      url = new URL(req.url, `http://127.0.0.1:${settings.port}`);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' }, csp);
    }

    if (url.pathname === '/api/update-status' && req.method === 'GET') {
      return sendJson(res, updater ? 200 : 503, updater ? { update: updateSnapshot() } : { error: 'update_unavailable' }, csp);
    }
    if (req.method === 'POST' && ['/api/update-check', '/api/update-install'].includes(url.pathname)) {
      if (!req.headers.origin) return sendJson(res, 403, { error: 'local_request_required' }, csp);
      if (!updater) return sendJson(res, 503, { error: 'update_unavailable' }, csp);
      try {
        const body = await readSmallJson(req, 512), install = url.pathname === '/api/update-install';
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).sort().join(',') !== (install ? 'confirm,version' : '')
          || install && (!versionValue(body.version) || body.confirm !== 'INSTALL_UPDATE')) {
          return sendJson(res, 400, { error: 'invalid_update_request' }, csp);
        }
        // Installation must never hand off without a graceful exit callback.
        if (install && typeof onUpdateReady !== 'function') return sendJson(res, 503, { error: 'update_unavailable' }, csp);
        const result = publicUpdate(await (install ? updater.install(body) : updater.check()));
        sendJson(res, 200, { update: result }, csp);
        if (install && result.phase === 'handoff' && !handoffScheduled) {
          handoffScheduled = true;
          setImmediate(() => { try { Promise.resolve(onUpdateReady()).catch(() => {}); } catch { /* No raw errors in HTTP or logs. */ } });
        }
        return;
      } catch (error) {
        const code = UPDATE_PUBLIC_CODES.has(error?.code) ? error.code : 'UPDATE_STORAGE';
        const status = [400, 413, 415].includes(error?.statusCode) ? error.statusCode : 409;
        return sendJson(res, status, { error: code, update: updateSnapshot() }, csp);
      }
    }

    if (url.pathname === '/api/ave-status' && req.method === 'GET') return sendJson(res, ave ? 200 : 503, ave ? { ave: aveSnapshot() } : { error: 'ave_unavailable' }, csp);
    if (req.method === 'POST' && ['/api/ave-configure', '/api/ave-remove'].includes(url.pathname)) {
      if (!req.headers.origin) return sendJson(res, 403, { error: 'local_request_required' }, csp);
      if (!ave) return sendJson(res, 503, { error: 'ave_unavailable' }, csp);
      try {
        const body = await readSmallJson(req, 4096);
        const result = url.pathname.endsWith('configure') ? await ave.configure(body) : ave.remove(body);
        return sendJson(res, 200, { ave: publicAveConnection(result) }, csp);
      } catch (e) { return sendJson(res, e instanceof AveError && [400, 409, 429, 502, 503, 504].includes(e.status) ? e.status
        : [400, 413, 415].includes(e.statusCode) ? e.statusCode : 503,
      { error: AVE_PUBLIC_CODES.has(e?.code) ? e.code : 'AVE_STORAGE', ave: aveSnapshot() }, csp); }
    }

    if (req.method === 'POST' && ['/api/live-discovery', '/api/live-review'].includes(url.pathname)) {
      if (!req.headers.origin) return sendJson(res, 403, { error: 'local_request_required' }, csp);
      if (!liveDiscovery) return sendJson(res, 503, { error: 'live_unavailable' }, csp);
      try {
        const body = await readSmallJson(req, 512);
        const keys = url.pathname === '/api/live-review' ? 'address,chain' : 'chain';
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== keys
          || !publicChains.has(body.chain)) return sendJson(res, 400, { error: 'invalid_live_request' }, csp);
        if (url.pathname === '/api/live-review') {
          if (typeof body.address !== 'string' || body.address.length > 80 || !enqueueReview) return sendJson(res, 400, { error: 'invalid_live_request' }, csp);
          const row = liveDiscovery.auditRow(body.chain, body.address);
          const result = row ? enqueueReview(body.chain, row) : { accepted: false, reason: 'snapshot_expired' };
          return sendJson(res, result.accepted ? 200 : 409, result, csp);
        }
        const snapshot = publicLiveSnapshot(typeof liveDiscovery.readSnapshot === 'function'
          ? await liveDiscovery.readSnapshot(body.chain) : liveDiscovery.touch(body.chain), body.chain);
        const scope = state.value.activeChain === body.chain ? state.value : state.value.chainStates?.[body.chain] || {};
        const key = address => body.chain === 'sol' ? address : address.toLowerCase();
        const audits = new Map((scope.candidates || []).map(row => [key(row.address), row]));
        const rejectedKeys = rejectedAuditKeys(scope, body.chain);
        const rejected = row => {
          const audit = audits.get(key(row.address));
          return rejectedKeys.has(tokenKey(body.chain, row.address))
            || audit && ['HARD_REJECT', 'REJECTED'].includes(publicCandidate(audit).status);
        };
        const removed = snapshot.rows.filter(row => state.value.riskExclusions?.[tokenKey(body.chain, row.address)] || rejected(row)).length;
        snapshot.rows = snapshot.rows.filter(row => !state.value.riskExclusions?.[tokenKey(body.chain, row.address)] && !rejected(row)).map(row => {
          const audit = audits.get(key(row.address));
          return { ...row, audit: audit ? { status: publicCandidate(audit).status, at: finite(audit.auditedAt) } : null };
        });
        const freshRows = recentLiveRows(snapshot.rows, scope, body.chain);
        snapshot.diagnostics.excluded += removed + snapshot.rows.length - freshRows.length;
        snapshot.rows = freshRows;
        snapshot.diagnostics.ready = snapshot.rows.filter(row => row.auditEligible).length;
        snapshot.diagnostics.pending = snapshot.rows.filter(row => row.discoveryState === 'PENDING').length;
        snapshot.diagnostics.stale = snapshot.rows.filter(row => row.discoveryState === 'STALE').length;
        return sendJson(res, 200, snapshot, csp);
      } catch (error) {
        return sendJson(res, [400, 413, 415].includes(error?.statusCode) ? error.statusCode : 500, { error: 'live_request_failed' }, csp);
      }
    }

    if (req.method === 'POST' && ['/api/scan-chains', '/api/annotation', '/api/gmgn-disconnect'].includes(url.pathname)) {
      if (!req.headers.origin) return sendJson(res, 403, { error: 'local_request_required' }, csp);
      try {
        const body = await readSmallJson(req, 4096);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'invalid_settings' }, csp);
        if (url.pathname === '/api/gmgn-disconnect') {
          if (Object.keys(body).length) return sendJson(res, 400, { error: 'invalid_settings' }, csp);
          if (typeof disconnectGmgnKey !== 'function') return sendJson(res, 503, { error: 'gmgn_unavailable' }, csp);
          return sendJson(res, 200, disconnectGmgnKey(), csp);
        }
        if (!controls) return sendJson(res, 503, { error: 'settings_unavailable' }, csp);
        if (url.pathname === '/api/scan-chains') {
          if (Object.keys(body).length !== 1) return sendJson(res, 400, { error: 'invalid_settings' }, csp);
          return sendJson(res, 200, controls.setChains(body.chains), csp);
        }
        if (Object.keys(body).sort().join(',') !== 'address,chain,favorite,note') return sendJson(res, 400, { error: 'invalid_settings' }, csp);
        return sendJson(res, 200, controls.annotate(body), csp);
      } catch (error) { return sendJson(res, error?.statusCode === 400 ? 400 : 500, { error: 'settings_not_saved' }, csp); }
    }

    if (url.pathname === '/api/gmgn-key' && req.method === 'POST') {
      if (!req.headers.origin) return sendJson(res, 403, { error: 'gmgn_key_request_rejected' }, csp);
      if (typeof saveGmgnKey !== 'function') return sendJson(res, 503, { error: 'gmgn_key_request_rejected' }, csp);
      try {
        const body = await readSmallJson(req, 512);
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length !== 1 || typeof body.apiKey !== 'string') {
          return sendJson(res, 400, { error: 'gmgn_key_request_rejected' }, csp);
        }
        const apiKey = normalizeGmgnApiKey(body.apiKey);
        if (!apiKey) return sendJson(res, 400, { error: 'gmgn_key_request_rejected' }, csp);
        const result = await saveGmgnKey(apiKey);
        if (result?.verified !== true || result?.configured !== true) {
          return sendJson(res, 502, { error: 'gmgn_verification_failed' }, csp);
        }
        return sendJson(res, 200, { accepted: true, configured: true, verified: true }, csp);
      } catch (error) {
        const safeErrors = {
          GMGN_AUTH_FAILED: [401, 'gmgn_auth_failed'],
          GMGN_PERMISSION_DENIED: [403, 'gmgn_permission_denied'],
          GMGN_RATE_LIMITED: [429, 'gmgn_rate_limited'],
          GMGN_CHECK_BUSY: [409, 'gmgn_check_busy'],
          GMGN_TIMEOUT: [504, 'gmgn_timeout'],
          GMGN_NETWORK_ERROR: [502, 'gmgn_network_error'],
          GMGN_DEPENDENCY_MISSING: [503, 'gmgn_dependency_missing'],
          GMGN_ONBOARDING_REQUIRED: [409, 'gmgn_onboarding_required'],
          GMGN_SIGNING_KEY_FAILED: [500, 'gmgn_signing_key_failed']
        };
        const safe = safeErrors[error?.code];
        if (safe) {
          const body = { error: safe[1] };
          if (error?.code === 'GMGN_RATE_LIMITED') {
            body.retryAfterSeconds = Math.max(1, Math.min(300, Math.ceil((Number(error.retryAfterMs) || 30_000) / 1000)));
          }
          return sendJson(res, safe[0], body, csp);
        }
        const statusCode = [400, 413, 415].includes(error?.statusCode) ? error.statusCode : 500;
        return sendJson(res, statusCode, { error: 'gmgn_key_request_rejected' }, csp);
      }
    }

    if (url.pathname === '/api/gmgn-onboarding' && req.method === 'POST') {
      if (!req.headers.origin) {
        return sendJson(res, 403, { error: 'gmgn_onboarding_rejected' }, csp);
      }
      if (typeof getGmgnOnboarding !== 'function') return sendJson(res, 503, { error: 'gmgn_unavailable' }, csp);
      try {
        const body = await readSmallJson(req, 64);
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).sort().join(',') !== 'regenerate'
          || typeof body.regenerate !== 'boolean') {
          return sendJson(res, 400, { error: 'gmgn_onboarding_rejected' }, csp);
        }
        const value = getGmgnOnboarding({ regenerate: body.regenerate });
        if (value?.algorithm !== 'Ed25519'
          || !/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(value?.publicKey || '')) {
          return sendJson(res, 500, { error: 'gmgn_onboarding_failed' }, csp);
        }
        const createUrl = new URL(value.createUrl);
        if (createUrl.protocol !== 'https:' || createUrl.hostname !== 'gmgn.ai' || createUrl.pathname !== '/ai/generateapi') {
          return sendJson(res, 500, { error: 'gmgn_onboarding_failed' }, csp);
        }
        return sendJson(res, 200, { algorithm: 'Ed25519', publicKey: value.publicKey, createUrl: createUrl.href }, csp);
      } catch {
        return sendJson(res, 500, { error: 'gmgn_onboarding_failed' }, csp);
      }
    }

    if (url.pathname === '/api/active-chain' && req.method === 'POST') {
      if (typeof switchChain !== 'function') return sendJson(res, 503, { error: 'chain_switch_unavailable' }, csp);
      try {
        const body = await readSmallJson(req);
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length !== 1 || typeof body.chain !== 'string') {
          return sendJson(res, 400, { error: 'invalid_chain_request' }, csp);
        }
        const chain = text(body.chain, 32).toLowerCase();
        if (!publicChains.has(chain)) return sendJson(res, 422, { error: 'unsupported_chain' }, csp);
        const enabledChains = Array.isArray(controls?.value.enabledChains) ? controls.value.enabledChains : [];
        if (enabledChains.length > 1 && !enabledChains.includes(chain)) {
          return sendJson(res, 409, { error: 'chain_not_enabled' }, csp);
        }
        const result = await switchChain(chain);
        const returnedActive = text(result?.activeChain, 32).toLowerCase();
        const returnedPending = text(result?.pendingChain, 32).toLowerCase();
        return sendJson(res, 202, {
          accepted: true,
          requestedChain: chain,
          activeChain: publicChains.has(returnedActive) ? returnedActive : chain,
          pendingChain: publicChains.has(returnedPending) ? returnedPending : '',
          queued: result?.queued === true
        }, csp);
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        const publicCode = statusCode === 500 ? 'chain_switch_failed' : text(error.message, 48);
        return sendJson(res, statusCode, { error: publicCode }, csp);
      }
    }

    if (req.method !== 'GET') return sendJson(res, 405, { error: 'read_only_scanner' }, csp);
    if (url.pathname === '/api/status' || url.pathname === '/api/export') {
      const snapshot = getGmgnConnection?.();
      const gmgnConnection = {
        configured: snapshot?.configured === true,
        status: ['CHECKING', 'UNCONFIGURED', 'VERIFIED', 'CONFIGURED'].includes(snapshot?.status) ? snapshot.status : 'UNCONFIGURED'
      };
      const chain = url.searchParams.get('chain');
      if (chain && !publicChains.has(chain)) return sendJson(res, 400, { error: 'unsupported_chain' }, csp);
      const configuredEnabledChains = Array.isArray(controls?.value.enabledChains)
        ? controls.value.enabledChains.map(value => text(value, 32).toLowerCase()).filter(value => publicChains.has(value))
        : null;
      const enabledChains = configuredEnabledChains || [state.value.activeChain];
      const storedSelection = chain && chain !== state.value.activeChain
        ? { status: 'STARTING', candidates: [], ...state.value.chainStates?.[chain], activeChain: chain,
          supportedChains: state.value.supportedChains, events: state.value.events, riskExclusions: state.value.riskExclusions,
          policy: { ...state.value.policy, chain }, scanInProgress: false }
        : state.value;
      const selected = selectedChainScope(storedSelection, chain, configuredEnabledChains, settings);
      const annotations = Object.fromEntries(Object.entries(controls?.value.annotations || {}).filter(([, value]) =>
        publicChains.has(text(value?.chain, 32).toLowerCase())).slice(0, 500).map(([key, value]) => [key, {
          chain: text(value.chain, 32).toLowerCase(), address: text(value.address, 128), favorite: value.favorite === true,
          note: publicMessage(value.note, '[redacted]', 500), updatedAt: finite(value.updatedAt)
        }]));
      const output = { ...toPublicStatus(selected), scanProvider: 'AVE',
        aveConnection: publicAveConnection(readSnapshot(getAveConnection || (() => ave?.snapshot()))),
        aveMarket: publicAveMarket(readSnapshot(getMarketStatus), supportedChains), gmgnConnection, annotations,
        voiceSnapshot: voiceSnapshot(state.value, enabledChains, liveDiscovery),
        scheduler: { scanningChain: text(state.value.activeChain, 32), enabledChains,
          lastSuccessAt: finite(state.value.lastSuccessAt), status: text(state.value.status, 32) },
        coverage: Object.fromEntries([...publicChains].map(id => [id, {
          dexScreener: Boolean(secondaryChainSupport.dexScreener[id]), goPlus: Boolean(secondaryChainSupport.goPlus[id])
        }])),
        requestMetrics: countSummary(state.value.requestMetrics || {}, ['requests', 'cacheHits', 'rateLimits', 'cooldownUntil'])
      };
      output.supportedChains = [...publicChains];
      output.events = (output.events || []).filter(event => !event.chain || publicChains.has(event.chain));
      // The AVE key and backoff are shared by every chain; a selected chain's
      // stored timer must not advertise an already elapsed retry time.
      const statusNow = Date.now();
      if (output.aveMarket.pauseCode === 'AVE_RATE_LIMITED' && output.aveMarket.nextAllowedAt > statusNow) {
        output.status = 'RATE_LIMITED';
        output.retryAt = output.aveMarket.nextAllowedAt;
        output.nextCycleAt = Math.max(output.nextCycleAt || 0, output.retryAt);
      } else if (output.status === 'RATE_LIMITED' && (!output.retryAt || output.retryAt <= statusNow)) {
        // A chain can retain the status of its last failed turn while another
        // enabled chain performs the recovery probe. Do not present that old
        // state as an active provider-wide wait after the real gate expired.
        output.status = output.lastSuccessAt ? 'DEGRADED' : 'STARTING';
        output.retryAt = 0;
      }
      if (url.pathname === '/api/export') {
        const scopes = { ...state.value.chainStates, [state.value.activeChain]: state.value };
        output.exportedAt = Date.now();
        output.chains = Object.fromEntries(Object.entries(scopes).filter(([id]) => publicChains.has(id)).map(([id, scope]) => [id, {
          ...toPublicStatus({ ...scope, activeChain: id, riskExclusions: state.value.riskExclusions }),
          outcomes: (scope.outcomes || []).slice(0, 1000).map(row => ({
            address: text(row.address, 128), symbol: publicMessage(row.symbol, '?', 30), chain: id,
            baselineAt: finite(row.baselineAt), baselinePrice: finiteOrNull(row.baselinePrice),
            initialDecision: text(row.initialDecision, 32), latestDecision: text(row.latestDecision, 32),
            samples: Object.fromEntries(['m5','m15','m30','h1','h2','h6','h24'].map(key => [key, row.samples?.[key] ? {
              at: finite(row.samples[key].at), targetAt: finite(row.samples[key].targetAt),
              source: text(row.samples[key].source, 32), price: finiteOrNull(row.samples[key].price), return: finiteOrNull(row.samples[key].return)
            } : null]))
          }))
        }]));
        for (const scope of Object.values(output.chains)) {
          scope.events = (scope.events || []).filter(event => !event.chain || publicChains.has(event.chain));
        }
        res.setHeader('Content-Disposition', 'attachment; filename="meme-radar-records.json"');
      }
      return sendJson(res, 200, output, csp);
    }
    if (url.pathname === '/health') return sendJson(res, 200, healthSnapshot(state.value, settings), csp);
    const assets = { '/update-ui.mjs': ['update-ui.mjs', 'text/javascript; charset=utf-8'],
      '/voice-ui.mjs': ['voice-ui.mjs', 'text/javascript; charset=utf-8'],
      '/voice-alerts.mjs': ['voice-alerts.mjs', 'text/javascript; charset=utf-8'],
      '/voice-player.mjs': ['voice-player.mjs', 'text/javascript; charset=utf-8'] };
    if (Object.hasOwn(assets, url.pathname)) {
      const [relative, type] = assets[url.pathname];
      try {
        const content = fs.readFileSync(path.join(settings.publicDir, relative));
        res.writeHead(200, { ...headers(type, csp), 'Content-Length': content.length });
        return res.end(content);
      } catch { return sendJson(res, 404, { error: 'asset_not_found' }, csp); }
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { ...headers('text/html; charset=utf-8', csp), 'Content-Length': Buffer.byteLength(dashboardHtml) });
      return res.end(dashboardHtml);
    }
    return sendJson(res, 404, { error: 'not_found' }, csp);
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}
