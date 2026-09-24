import { validTokenAddress } from './address.mjs';
import { verifiedAvePoolEvidence } from './pool-identity.mjs';

const DEX_CHAIN_IDS = Object.freeze({ sol: 'solana', bsc: 'bsc', base: 'base', eth: 'ethereum' });
// Fast overlays must use the same verified chain map as deep validation.
// Robinhood Chain currently has no verified DexScreener chain id here; a
// speculative request only wastes time and makes the UI overstate coverage.
const DEX_BATCH_CHAIN_IDS = DEX_CHAIN_IDS;
const GOPLUS_EVM_CHAIN_IDS = Object.freeze({ eth: '1', bsc: '56', base: '8453' });

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const DEFAULT_MAX_BYTES = 1_000_000;

function optionalNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || !NUMBER_PATTERN.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalNonNegative(value) {
  const parsed = optionalNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function optionalRate(value) {
  let parsed;
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    const percent = optionalNumber(value.trim().slice(0, -1));
    parsed = percent === null ? null : percent / 100;
  } else {
    parsed = optionalNumber(value);
  }
  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function optionalBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return null;
}

function nestedBoolean(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return optionalBoolean(value.status);
  return optionalBoolean(value);
}

function cleanString(value, maxLength = 160) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function safeHttpUrl(value) {
  const raw = cleanString(value, 2048);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function normalizedAddress(value, chain) {
  const address = cleanString(value, 128);
  return chain === 'sol' ? address : address.toLowerCase();
}

function sameAddress(left, right, chain) {
  const a = normalizedAddress(left, chain), b = normalizedAddress(right, chain);
  return Boolean(a && b && a === b);
}

const validAddress = (value, chain) => validTokenAddress(chain, cleanString(value, 128));

function errorCode(error) {
  if (error?.code) return String(error.code).slice(0, 64);
  if (error?.name === 'AbortError') return 'TIMEOUT';
  return 'REQUEST_FAILED';
}

async function readLimitedText(response, maxBytes) {
  const contentLength = optionalNonNegative(response?.headers?.get?.('content-length'));
  if (contentLength !== null && contentLength > maxBytes) {
    const error = new Error('response too large');
    error.code = 'RESPONSE_TOO_LARGE';
    throw error;
  }

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          const error = new Error('response too large');
          error.code = 'RESPONSE_TOO_LARGE';
          throw error;
        }
        chunks.push(chunk);
      }
    } finally {
      if (total > maxBytes) await reader.cancel().catch(() => {});
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const error = new Error('response too large');
    error.code = 'RESPONSE_TOO_LARGE';
    throw error;
  }
  return text;
}

async function requestJson(fetchImpl, url, { timeoutMs, maxResponseBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response || typeof response.ok !== 'boolean') {
      const error = new Error('invalid response');
      error.code = 'INVALID_RESPONSE';
      throw error;
    }
    if (!response.ok) {
      const error = new Error('upstream HTTP error');
      error.code = `HTTP_${Number(response.status) || 0}`;
      throw error;
    }
    const contentType = cleanString(response.headers?.get?.('content-type'), 128).toLowerCase();
    if (contentType && !/(?:application|text)\/(?:[a-z0-9.+-]*\+)?json\b/.test(contentType)) {
      const error = new Error('invalid content type');
      error.code = 'INVALID_CONTENT_TYPE';
      throw error;
    }
    const text = await readLimitedText(response, maxResponseBytes);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const error = new Error('invalid JSON');
      error.code = 'INVALID_JSON';
      throw error;
    }
    if (parsed === null || typeof parsed !== 'object') {
      const error = new Error('invalid JSON root');
      error.code = 'INVALID_JSON_SHAPE';
      throw error;
    }
    return parsed;
  } catch (error) {
    if (controller.signal.aborted && error?.code !== 'RESPONSE_TOO_LARGE') {
      const timeout = new Error('request timed out');
      timeout.code = 'TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function emptyMarket() {
  return {
    complete: false, pairAddress: '', dexId: '', pairUrl: '', symbol: '', name: '',
    priceUsd: null, marketCap: null, fdv: null, liquidityUsd: null, websites: []
  };
}

function parseDexScreener(payload, { chain, dexChainId, tokenAddress }) {
  if (!Array.isArray(payload)) {
    const error = new Error('unexpected DexScreener JSON shape');
    error.code = 'INVALID_JSON_SHAPE';
    throw error;
  }
  const pairs = payload.filter(pair => pair && typeof pair === 'object'
    && cleanString(pair.chainId, 32) === dexChainId
    && sameAddress(pair.baseToken?.address, tokenAddress, chain));
  if (!pairs.length) return { found: false, market: emptyMarket() };
  pairs.sort((a, b) => (optionalNonNegative(b.liquidity?.usd) ?? -1) - (optionalNonNegative(a.liquidity?.usd) ?? -1));
  const pair = pairs[0];
  const websites = [...new Set((Array.isArray(pair.info?.websites) ? pair.info.websites : [])
    .map(row => safeHttpUrl(row?.url)).filter(Boolean))].slice(0, 10);
  const market = {
    complete: false,
    pairAddress: cleanString(pair.pairAddress, 128),
    dexId: cleanString(pair.dexId, 64),
    pairUrl: safeHttpUrl(pair.url),
    symbol: cleanString(pair.baseToken?.symbol, 40),
    name: cleanString(pair.baseToken?.name, 120),
    priceUsd: optionalNonNegative(pair.priceUsd),
    marketCap: optionalNonNegative(pair.marketCap),
    fdv: optionalNonNegative(pair.fdv),
    liquidityUsd: optionalNonNegative(pair.liquidity?.usd),
    websites
  };
  market.complete = market.priceUsd !== null && market.marketCap !== null && market.liquidityUsd !== null;
  return { found: true, market };
}

function validPairAddress(value, chain) {
  const pair = cleanString(value, 128);
  if (chain === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pair);
  return /^0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(pair);
}

function parseDexBatch(payload, { chain, dexChainId, tokenAddresses, capturedAt }) {
  if (!Array.isArray(payload) || payload.length > 1_000) {
    const error = new Error('unexpected DexScreener batch JSON shape');
    error.code = 'INVALID_JSON_SHAPE';
    throw error;
  }
  const requested = new Set(tokenAddresses.map(value => normalizedAddress(value, chain)));
  const best = new Map();
  for (const pair of payload) {
    if (!pair || typeof pair !== 'object' || cleanString(pair.chainId, 32) !== dexChainId) continue;
    const baseAddress = normalizedAddress(pair.baseToken?.address, chain);
    const members = [baseAddress, normalizedAddress(pair.quoteToken?.address, chain)].filter(value => requested.has(value));
    if (!members.length || !validPairAddress(pair.pairAddress, chain)) continue;
    const liquidity = optionalNonNegative(pair.liquidity?.usd);
    const volume5m = optionalNonNegative(pair.volume?.m5);
    const createdAt = optionalNonNegative(pair.pairCreatedAt);
    if (liquidity === null || volume5m === null || !Number.isSafeInteger(createdAt)
      || createdAt <= 0 || createdAt > capturedAt + 300_000) continue;
    const poolMarket = {
      pairAddress: cleanString(pair.pairAddress, 128), dexId: cleanString(pair.dexId, 64),
      liquidity, volume5m, pairCreatedAt: createdAt
    };
    for (const tokenAddress of members) {
      const market = { ...poolMarket,
        // DexScreener's price/market-cap fields describe baseToken only. Pool
        // metrics remain valid when the requested token happens to be quote.
        priceUsd: tokenAddress === baseAddress ? optionalNonNegative(pair.priceUsd) : null,
        marketCap: tokenAddress === baseAddress ? optionalNonNegative(pair.marketCap) : null,
        fdv: tokenAddress === baseAddress ? optionalNonNegative(pair.fdv) : null };
      const previous = best.get(tokenAddress);
      if (!previous || market.liquidity > previous.liquidity) best.set(tokenAddress, market);
    }
  }
  return best;
}

function overlayDexMarket(rows, chain, marketByToken, capturedAt, ttlMs) {
  return rows.map(row => {
    const market = marketByToken.get(normalizedAddress(row?.address, chain));
    if (!market) return row;
    const evidence = verifiedAvePoolEvidence(row, chain);
    const evidencePair = evidence?.pair || '';
    // Pair-scoped AVE facts (age, ATH and 1h move) are atomic. Do not combine
    // them with DexScreener's highest-liquidity *different* pool.
    if (evidencePair && evidencePair !== normalizedAddress(market.pairAddress, chain)) return row;
    // An overlay without a strictly verified same-pool AVE identity starts a
    // new atomic pool tuple. Never carry a legacy first-trade clock, ATH or
    // other pair-scoped evidence into the selected DexScreener pool.
    const cleanRow = evidence ? row : { ...row, first_trade_at: null, firstTradeAt: null,
      last_trade_at: null, lastTradeAt: null, poolEvidence: null };
    const marketCap = market.marketCap ?? cleanRow.market_cap;
    const marketOverlayPriceUpdated = market.priceUsd > 0;
    const price = marketOverlayPriceUpdated ? market.priceUsd : cleanRow.price;
    return {
      ...cleanRow, price, market_cap: marketCap,
      marketCapSourceUpdatedAt: market.marketCap !== null ? capturedAt : cleanRow.marketCapSourceUpdatedAt,
      marketCapCapturedAt: market.marketCap !== null ? capturedAt : cleanRow.marketCapCapturedAt,
      marketCapExpiresAt: market.marketCap !== null ? capturedAt + ttlMs : cleanRow.marketCapExpiresAt,
      liquidity: market.liquidity, volume_5m: market.volume5m,
      pool_created_at: Math.floor(market.pairCreatedAt / 1_000), poolCreatedAt: market.pairCreatedAt,
      pairAddress: market.pairAddress, dexId: market.dexId, ageBasis: 'pool', activityWindow: '5m',
      tokenSourceUpdatedAt: cleanRow.tokenSourceUpdatedAt ?? cleanRow.sourceUpdatedAt,
      tokenCapturedAt: cleanRow.tokenCapturedAt ?? cleanRow.capturedAt,
      capturedAt, sourceUpdatedAt: capturedAt, sampledAt: capturedAt, expiresAt: capturedAt + ttlMs, stale: false,
      marketOverlayProvider: 'DEXSCREENER', marketOverlayCapturedAt: capturedAt, marketOverlayPriceUpdated
    };
  });
}

// AVE remains the discovery source. This one bounded batch request only fills
// the live card's main-pool market fields while AVE's slower per-pool checks
// continue independently. Missing or malformed rows are never guessed.
export class DexBatchMarketOverlay {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 8_000, maxResponseBytes = DEFAULT_MAX_BYTES,
    now = () => Date.now(), ttlMs = 20_000, staleTtlMs = 60_000 } = {}) {
    if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new TypeError('fetch implementation is required');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 8_000);
    this.maxResponseBytes = Math.max(1_024, Number(maxResponseBytes) || DEFAULT_MAX_BYTES);
    this.now = now;
    this.ttlMs = Math.max(5_000, Math.min(30_000, Number(ttlMs) || 20_000));
    this.staleTtlMs = Math.max(this.ttlMs, Math.min(120_000, Number(staleTtlMs) || 60_000));
    this.cache = new Map();
    this.pending = new Map();
  }

  async enrich(chain, rows, { minMarketCap = 0, maxMarketCap = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Array.isArray(rows)) return [];
    const normalizedChain = cleanString(chain, 24).toLowerCase();
    const dexChainId = DEX_BATCH_CHAIN_IDS[normalizedChain];
    if (!dexChainId) return rows;
    const addresses = [...new Set(rows.filter(row => {
      const marketCap = optionalNonNegative(row?.market_cap);
      return row?.marketProvider === 'AVE' && marketCap !== null && marketCap >= minMarketCap && marketCap <= maxMarketCap
        && validAddress(row.address, normalizedChain);
    })
      .map(row => normalizedAddress(row.address, normalizedChain)))].slice(0, 30);
    if (!addresses.length) return rows;
    const key = normalizedChain + ':' + [...addresses].sort().join(',');
    const at = this.now(), cached = this.cache.get(key);
    if (cached?.until > at) return overlayDexMarket(rows, normalizedChain, cached.marketByToken, cached.capturedAt, this.ttlMs);
    let job = this.pending.get(key);
    if (!job) {
      const url = `https://api.dexscreener.com/tokens/v1/${dexChainId}/${addresses.map(encodeURIComponent).join(',')}`;
      job = (async () => {
        const capturedAt = this.now();
        const payload = await requestJson(this.fetchImpl, url, this);
        const marketByToken = parseDexBatch(payload, { chain: normalizedChain, dexChainId, tokenAddresses: addresses, capturedAt });
        const entry = { marketByToken, capturedAt, until: capturedAt + this.ttlMs, staleUntil: capturedAt + this.staleTtlMs };
        if (!this.cache.has(key) && this.cache.size >= 16) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, entry);
        return entry;
      })();
      this.pending.set(key, job);
      job.finally(() => { if (this.pending.get(key) === job) this.pending.delete(key); }).catch(() => {});
    }
    try {
      const entry = await job;
      return overlayDexMarket(rows, normalizedChain, entry.marketByToken, entry.capturedAt, this.ttlMs);
    } catch {
      if (cached?.staleUntil > at) return overlayDexMarket(rows, normalizedChain, cached.marketByToken, cached.capturedAt, this.ttlMs)
        .map((row, index) => row === rows[index] ? row : { ...row, stale: true });
      return rows;
    }
  }
}

const EVM_SECURITY_RULES = Object.freeze([
  ['isHoneypot', 'is_honeypot', true, true, 'GoPlus标记为貔貅'],
  ['openSource', 'is_open_source', false, true, '合约未开源'],
  ['mintable', 'is_mintable', true, true, '合约仍可增发'],
  ['ownerChangeBalance', 'owner_change_balance', true, true, '所有者可修改余额'],
  ['hiddenOwner', 'hidden_owner', true, true, '存在隐藏所有者'],
  ['cannotSellAll', 'cannot_sell_all', true, true, '持有人无法全部卖出'],
  ['selfDestruct', 'selfdestruct', true, false, '合约可自毁'],
  ['externalCall', 'external_call', true, false, '合约包含高风险外部调用'],
  ['slippageModifiable', 'slippage_modifiable', true, false, '滑点或税率可修改'],
  ['personalSlippageModifiable', 'personal_slippage_modifiable', true, false, '可按地址修改滑点或税率'],
  ['transferPausable', 'transfer_pausable', true, false, '代币转账可暂停'],
  ['blacklisted', 'is_blacklisted', true, false, '合约包含黑名单机制'],
  ['tradingCooldown', 'trading_cooldown', true, false, '合约包含交易冷却限制']
]);

const SOL_SECURITY_RULES = Object.freeze([
  ['mintable', 'mintable', true, true, '代币仍可增发'],
  ['freezable', 'freezable', true, true, '代币账户仍可冻结'],
  ['closable', 'closable', true, false, '代币账户可被关闭'],
  ['balanceMutableAuthority', 'balance_mutable_authority', true, false, '存在修改余额权限'],
  ['transferFeeUpgradable', 'transfer_fee_upgradable', true, false, '转账费权限可升级'],
  ['nonTransferable', 'non_transferable', true, false, '代币被标记为不可转账']
]);

function findGoPlusRecord(payload, tokenAddress, chain) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') return null;
  const result = payload.result;
  if (!result || typeof result !== 'object') return null;
  if (Array.isArray(result)) {
    return result.find(row => sameAddress(row?.contract_address || row?.address || row?.mint, tokenAddress, chain)) || null;
  }
  for (const [key, value] of Object.entries(result)) {
    if (sameAddress(key, tokenAddress, chain) && value && typeof value === 'object') return value;
  }
  if (chain === 'sol' && SOL_SECURITY_RULES.some(([, raw]) => Object.hasOwn(result, raw))) return result;
  return null;
}

function parseGoPlus(payload, { chain, tokenAddress }) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    const error = new Error('unexpected GoPlus JSON shape');
    error.code = 'INVALID_JSON_SHAPE';
    throw error;
  }
  if (payload.code !== undefined && ![1, '1'].includes(payload.code)) {
    const error = new Error('GoPlus rejected request');
    error.code = 'UPSTREAM_REJECTED';
    throw error;
  }
  const record = findGoPlusRecord(payload, tokenAddress, chain);
  if (!record) return {
    found: false,
    security: { complete: false, verdict: 'UNKNOWN', fatal: [], unknownFields: ['tokenSecurity'], fields: {}, buyTax: null, sellTax: null }
  };
  const rules = chain === 'sol' ? SOL_SECURITY_RULES : EVM_SECURITY_RULES;
  const fields = {};
  const fatal = [];
  const unknownFields = [];
  for (const [field, rawField, fatalWhen, , reason] of rules) {
    const value = nestedBoolean(record[rawField]);
    fields[field] = value;
    if (value === null) {
      unknownFields.push(field);
    } else if (value === fatalWhen) {
      fatal.push({ field, reason });
    }
  }
  const buyTax = chain === 'sol' ? null : optionalRate(record.buy_tax);
  const sellTax = chain === 'sol' ? null : optionalRate(record.sell_tax);
  if (chain !== 'sol' && buyTax === null) {
    unknownFields.push('buyTax');
  }
  if (chain !== 'sol' && sellTax === null) {
    unknownFields.push('sellTax');
  }
  // An omitted risk flag is not evidence of safety. Keep the source incomplete
  // so callers can recheck instead of treating an unknown field as a clean bill.
  const complete = unknownFields.length === 0;
  return {
    found: true,
    security: {
      complete,
      verdict: fatal.length ? 'FATAL' : complete ? 'NO_FATAL_FLAGS' : 'UNKNOWN',
      fatal,
      unknownFields,
      fields,
      buyTax,
      sellTax
    }
  };
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = optionalNonNegative(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function relativeDifference(left, right) {
  return Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right), Number.EPSILON);
}

function websiteHost(value) {
  const url = safeHttpUrl(value);
  if (!url) return '';
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

function buildConflicts(primary, market, security, thresholds) {
  const conflicts = [];
  const primaryMarket = primary?.market && typeof primary.market === 'object' ? primary.market : primary || {};
  const comparisons = [
    ['priceUsd', firstNumber(primaryMarket.priceUsd, primaryMarket.price), market.priceUsd, thresholds.price],
    ['marketCap', firstNumber(primaryMarket.marketCap, primaryMarket.market_cap), market.marketCap, thresholds.marketCap],
    ['liquidityUsd', firstNumber(primaryMarket.liquidityUsd, primaryMarket.liquidity), market.liquidityUsd, thresholds.liquidity]
  ];
  for (const [field, primaryValue, secondaryValue, threshold] of comparisons) {
    if (primaryValue === null || secondaryValue === null) continue;
    const difference = relativeDifference(primaryValue, secondaryValue);
    if (difference > threshold) conflicts.push({ type: 'MARKET_MISMATCH', field, primary: primaryValue, secondary: secondaryValue, relativeDifference: difference });
  }

  const primaryWebsite = primaryMarket.website || primary?.info?.website || primary?.website;
  const primaryHost = websiteHost(primaryWebsite);
  const secondaryHosts = market.websites.map(websiteHost).filter(Boolean);
  if (primaryHost && secondaryHosts.length && !secondaryHosts.includes(primaryHost)) {
    conflicts.push({ type: 'WEBSITE_MISMATCH', field: 'website', primaryHost, secondaryHosts });
  }

  const primarySecurity = primary?.security && typeof primary.security === 'object' ? primary.security : {};
  const aliases = {
    isHoneypot: ['isHoneypot', 'is_honeypot', 'honeypot'],
    openSource: ['openSource', 'is_open_source'],
    mintable: ['mintable', 'is_mintable'],
    ownerChangeBalance: ['ownerChangeBalance', 'owner_change_balance'],
    hiddenOwner: ['hiddenOwner', 'hidden_owner'],
    cannotSellAll: ['cannotSellAll', 'cannot_sell_all']
  };
  for (const [field, names] of Object.entries(aliases)) {
    const secondaryValue = security.fields?.[field];
    if (secondaryValue === null || secondaryValue === undefined) continue;
    let primaryValue = null;
    for (const name of names) {
      if (Object.hasOwn(primarySecurity, name)) {
        primaryValue = optionalBoolean(primarySecurity[name]);
        break;
      }
    }
    if (primaryValue !== null && primaryValue !== secondaryValue) {
      conflicts.push({ type: 'SECURITY_MISMATCH', field, primary: primaryValue, secondary: secondaryValue });
    }
  }
  return conflicts;
}

function sourceState(status, extra = {}) {
  return { status, ...extra };
}

export class SecondaryValidator {
  constructor({
    fetchImpl = globalThis.fetch,
    timeoutMs = 8_000,
    maxResponseBytes = DEFAULT_MAX_BYTES,
    now = () => Date.now(),
    conflictThresholds = { price: 0.10, marketCap: 0.20, liquidity: 0.25 }
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 8_000);
    this.maxResponseBytes = Math.max(1_024, Number(maxResponseBytes) || DEFAULT_MAX_BYTES);
    this.now = now;
    this.conflictThresholds = {
      price: optionalRate(conflictThresholds.price) ?? 0.10,
      marketCap: optionalRate(conflictThresholds.marketCap) ?? 0.20,
      liquidity: optionalRate(conflictThresholds.liquidity) ?? 0.25
    };
  }

  async validate({ chain, tokenAddress, primary = {} }) {
    const normalizedChain = cleanString(chain, 24).toLowerCase();
    const address = cleanString(tokenAddress, 128);
    const dexChainId = DEX_CHAIN_IDS[normalizedChain];
    const goPlusChainId = GOPLUS_EVM_CHAIN_IDS[normalizedChain];
    const goPlusSupported = normalizedChain === 'sol' || Boolean(goPlusChainId);
    const dexSupported = Boolean(dexChainId);
    const market = emptyMarket();
    let security = { complete: false, verdict: 'UNSUPPORTED', fatal: [], unknownFields: ['tokenSecurity'], fields: {}, buyTax: null, sellTax: null };
    const sources = {
      dexScreener: sourceState(dexSupported ? 'PENDING' : 'UNSUPPORTED'),
      goPlus: sourceState(goPlusSupported ? 'PENDING' : 'UNSUPPORTED')
    };

    if ((dexSupported || goPlusSupported) && !validAddress(address, normalizedChain)) {
      if (dexSupported) sources.dexScreener = sourceState('ERROR', { errorCode: 'INVALID_ADDRESS' });
      if (goPlusSupported) sources.goPlus = sourceState('ERROR', { errorCode: 'INVALID_ADDRESS' });
      return { status: 'DEGRADED', complete: false, checkedAt: this.now(), chain: normalizedChain, tokenAddress: address, sources, market, security, conflicts: [] };
    }

    const dexUrl = dexSupported ? `https://api.dexscreener.com/token-pairs/v1/${dexChainId}/${encodeURIComponent(address)}` : '';
    const goPlusUrl = !goPlusSupported ? '' : normalizedChain === 'sol'
      ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(address)}`
      : `https://api.gopluslabs.io/api/v1/token_security/${goPlusChainId}?contract_addresses=${encodeURIComponent(address)}`;

    const [dexResult, goPlusResult] = await Promise.all([
      dexSupported ? this.fetchDex(dexUrl, { chain: normalizedChain, dexChainId, tokenAddress: address }) : null,
      goPlusSupported ? this.fetchGoPlus(goPlusUrl, { chain: normalizedChain, tokenAddress: address }) : null
    ]);

    if (dexResult) {
      sources.dexScreener = dexResult.source;
      Object.assign(market, dexResult.market);
    }
    if (goPlusResult) {
      sources.goPlus = goPlusResult.source;
      security = goPlusResult.security;
    }
    const conflicts = buildConflicts(primary, market, security, this.conflictThresholds);
    const complete = sources.dexScreener.status === 'OK' && sources.goPlus.status === 'OK'
      && market.complete && security.complete;
    return {
      status: complete ? 'COMPLETE' : 'DEGRADED', complete, checkedAt: this.now(),
      chain: normalizedChain, tokenAddress: address, sources, market, security, conflicts
    };
  }

  async fetchDex(url, context) {
    try {
      const payload = await requestJson(this.fetchImpl, url, this);
      const parsed = parseDexScreener(payload, context);
      return { source: sourceState(parsed.found ? 'OK' : 'NO_DATA'), market: parsed.market };
    } catch (error) {
      return { source: sourceState('ERROR', { errorCode: errorCode(error) }), market: emptyMarket() };
    }
  }

  async fetchGoPlus(url, context) {
    try {
      const payload = await requestJson(this.fetchImpl, url, this);
      const parsed = parseGoPlus(payload, context);
      return { source: sourceState(parsed.found ? 'OK' : 'NO_DATA'), security: parsed.security };
    } catch (error) {
      return {
        source: sourceState('ERROR', { errorCode: errorCode(error) }),
        security: { complete: false, verdict: 'UNKNOWN', fatal: [], unknownFields: ['tokenSecurity'], fields: {}, buyTax: null, sellTax: null }
      };
    }
  }
}

export async function validateSecondary(input, options = {}) {
  return new SecondaryValidator(options).validate(input);
}

export const secondaryChainSupport = Object.freeze({
  dexScreener: Object.freeze({ ...DEX_CHAIN_IDS }),
  goPlus: Object.freeze({ sol: 'solana', ...GOPLUS_EVM_CHAIN_IDS })
});
