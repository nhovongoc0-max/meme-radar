import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, lstatSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizePoolAddress, normalizeTokenAddress } from './address.mjs';
import { config } from './config.mjs';
import { discoveryScreen } from './scoring.mjs';

// AVE Data REST only. No wallet, signing, trading, arbitrary URL, or retry.
// https://ave-cloud.gitbook.io/data-api/rest/tokens
// https://ave-cloud.gitbook.io/data-api/rest/klines
export const AVE_LIMITS = Object.freeze({ intervalMs: 60000, timeoutMs: 12000, maxBytes: 1048576, dailyCu: 30000, totalCu: 1000000, hourlyCu: 1250, trendingTtlMs: 210000, detailsTtlMs: 30000, klinesTtlMs: 60000 });
export const AVE_CHAINS = Object.freeze({ bsc: 'bsc', eth: 'eth', base: 'base', sol: 'solana', robinhood: 'robinhood', arc: 'arc', stable: 'stable' });
const CU_BY_KIND = Object.freeze({ trending: 5, details: 5, pair: 5, klines: 10 });
const ENRICHMENT_DEFER_MS = 30 * 60000;
const ROUTE_TTL_MS = 30 * 60000;
// One bad pool must not hide a token, but a token may advertise dozens of
// pools. Keep fallback deterministic and small; discovery also shares its
// existing enrichment-read allowance across primary and fallback reads.
const MAX_PAIR_ATTEMPTS = 2;
const PAIR_FALLBACK_CODES = new Set(['AVE_SCHEMA', 'AVE_UPSTREAM', 'AVE_NETWORK', 'AVE_TIMEOUT', 'AVE_SIZE']);
const RATE_BASE_GAP_MS = 60_000;
const RATE_TARGET_GAP_MS = 5 * 60_000;
const RATE_MAX_GAP_MS = 15 * 60_000;
const RATE_RECOVERY_WINDOW_MS = 30 * 60_000;
const RATE_FLOOR_RETRY_MS = 24 * 60 * 60_000;
const ROTATION_READY_TARGET = 3;
const ROTATION_SEEN_LIMIT = 600;
const DOCUMENTED = new Set(['bsc', 'eth', 'base', 'sol']);
const ORIGIN = 'https://prod.ave-api.com';
const lanes = new WeakMap();
function sharedLane(now) {
  if (!lanes.has(now)) lanes.set(now, { tail: Promise.resolve(), nextStart: 0, active: false, lastStart: 0 });
  return lanes.get(now);
}
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const messages = {
  INPUT: 'AVE 只读请求参数无效', CONFIG: 'AVE 行情凭证未配置', DISABLED: 'AVE 行情访问已暂停',
  CHANGED: 'AVE 配置已变化，本次数据未采用', ABORTED: 'AVE 行情请求已取消', TIMEOUT: 'AVE 行情响应超时',
  NETWORK: 'AVE 行情连接失败', SCHEMA: 'AVE 行情格式或链标识不匹配', SIZE: 'AVE 行情响应过大',
  AUTH: 'AVE 行情凭证或权限未通过', QUOTA: 'AVE 配额不足，已停止请求；不会自动购买',
  BUDGET: 'AVE 本机每日行情预算已用完', BUDGET_STORE: 'AVE 本机行情预算无法安全保存',
  TOTAL_BUDGET: 'AVE 本机累计行情预算不足，需人工核对；不会自动续期或购买',
  HOURLY_BUDGET: 'AVE 本机本小时行情预算不足，等待下一 UTC 小时',
  DISCOVERY_RESERVE: 'AVE 优先保留热榜扫描，补充行情与审核查询暂缓',
  RATE_LIMITED: 'AVE 行情限流，已进入冷却', UPSTREAM: 'AVE 行情请求未成功', BUSY: 'AVE 行情队列已满',
};
export class AveError extends Error {
  constructor(kind, status = 502, retryAt = null) {
    super(messages[kind]); this.name = 'AveError'; this.code = 'AVE_' + kind; this.status = status;
    if (retryAt !== null) this.retryAt = retryAt;
  }
}
const fail = (kind, status, retryAt) => new AveError(kind, status, retryAt);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const text = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
const numeric = value => (typeof value === 'number' || typeof value === 'string' && /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const signedNumeric = value => (typeof value === 'number' || typeof value === 'string' && /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) && Number.isFinite(Number(value)) ? Number(value) : null;
const seconds = value => Number.isSafeInteger(value) && value > 0 && value < 100000000000 ? value : null;
const upstreamTime = value => seconds(value) === null ? null : value * 1000;
const day = now => new Date(now).toISOString().slice(0, 10);
const nextDay = now => Date.parse(day(now) + 'T00:00:00.000Z') + 86400000;
const hourStart = now => Math.floor(now / 3600000) * 3600000;
const nextHour = now => hourStart(now) + 3600000;
const keyValid = key => typeof key === 'string' && key.length > 0 && key.length <= 512 && key.trim() === key && !/[\s\x00-\x1f\x7f]/.test(key);
const fingerprint = key => createHash('sha256').update(key).digest('hex');
const rateKinds = new Set(['trending', 'details', 'pair', 'klines']);
const freshRate = () => ({ strikes: 0, successes: 0, last429At: 0, updatedAt: 0, gapMs: RATE_BASE_GAP_MS, floorMs: RATE_BASE_GAP_MS,
  last429Kind: '', lastKindSuccessAt: 0, lastRecoveryAt: 0, lastFloorFailureAt: 0 });
const normalizeRate = rate => {
  const base = freshRate(), strikes = Number.isInteger(rate?.strikes) ? rate.strikes : 0;
  const migratedGap = strikes ? Math.min(RATE_MAX_GAP_MS, RATE_BASE_GAP_MS * 2 ** Math.max(0, strikes - 1)) : RATE_BASE_GAP_MS;
  // Older ledgers did not record the last empirically safe floor. Preserve up
  // to eight minutes from their durable backoff so a restart cannot relearn
  // the same provider limit by repeatedly sending too fast.
  const migratedFloor = strikes ? Math.min(8 * 60_000, Math.max(RATE_BASE_GAP_MS,
    Number.isSafeInteger(rate?.gapMs) ? rate.gapMs : migratedGap)) : RATE_BASE_GAP_MS;
  return { ...base, ...rate, gapMs: Number.isSafeInteger(rate?.gapMs) ? rate.gapMs : migratedGap,
    floorMs: Number.isSafeInteger(rate?.floorMs) ? rate.floorMs : migratedFloor,
    last429Kind: rateKinds.has(rate?.last429Kind) ? rate.last429Kind : '',
    lastKindSuccessAt: Number.isSafeInteger(rate?.lastKindSuccessAt) ? rate.lastKindSuccessAt : 0,
    lastRecoveryAt: Number.isSafeInteger(rate?.lastRecoveryAt) ? rate.lastRecoveryAt : 0,
    lastFloorFailureAt: Number.isSafeInteger(rate?.lastFloorFailureAt) ? rate.lastFloorFailureAt : 0 };
};
const recovering = rate => (rate?.strikes || 0) > 0;
const strikeDelay = strikes => Math.min(RATE_MAX_GAP_MS, RATE_BASE_GAP_MS * 2 ** Math.max(0, strikes - 1));
const spacing = rate => {
  const normalized = normalizeRate(rate);
  const backedOff = Math.max(normalized.floorMs, normalized.gapMs,
    recovering(normalized) ? strikeDelay(normalized.strikes) : RATE_BASE_GAP_MS);
  // A real successful canary earns a controlled speed-up. At the maximum
  // strike level this is exactly 15 -> 8 -> 4 minutes; lower strike levels
  // never become slower merely because recovery is active.
  const stepped = !recovering(normalized) || normalized.successes < 1 ? backedOff
    : normalized.successes < 2 ? backedOff > 8 * 60_000 ? 8 * 60_000 : backedOff > 4 * 60_000 ? 4 * 60_000 : backedOff
      : Math.min(backedOff, 4 * 60_000);
  return Math.max(normalized.floorMs, RATE_BASE_GAP_MS, Math.min(RATE_MAX_GAP_MS, stepped));
};
// A single successful head request is only a recovery probe. Do not unlock
// pagination, enrichment or another unverified chain until the complete
// healthy window has cleared the durable strike state.
const headOnly = rate => recovering(rate);
function requestNotBefore(budget) {
  const stored = Number.isSafeInteger(budget?.nextRequestAt) ? budget.nextRequestAt : 0;
  const rate = normalizeRate(budget?.rateControl);
  if (!recovering(rate)) return stored;
  const anchor = rate.successes > 0 && rate.lastKindSuccessAt > rate.last429At ? rate.lastKindSuccessAt : rate.last429At;
  const adaptive = anchor > 0 ? anchor + spacing(rate) : 0;
  return stored > 0 && adaptive > 0 ? Math.min(stored, adaptive) : Math.max(stored, adaptive);
}
function validRate(rate) {
  return object(rate) && Number.isInteger(rate.strikes) && rate.strikes >= 0 && rate.strikes <= 10
    && Number.isInteger(rate.successes) && rate.successes >= 0 && rate.successes < 5
    && ['last429At', 'updatedAt'].every(key => Number.isSafeInteger(rate[key]) && rate[key] >= 0)
    && (rate.gapMs === undefined || Number.isSafeInteger(rate.gapMs) && rate.gapMs >= RATE_BASE_GAP_MS && rate.gapMs <= RATE_MAX_GAP_MS)
    && (rate.floorMs === undefined || Number.isSafeInteger(rate.floorMs) && rate.floorMs >= RATE_BASE_GAP_MS && rate.floorMs <= RATE_MAX_GAP_MS)
    && (rate.last429Kind === undefined || rateKinds.has(rate.last429Kind) || rate.last429Kind === '')
    && ['lastKindSuccessAt', 'lastRecoveryAt', 'lastFloorFailureAt'].every(key => rate[key] === undefined || Number.isSafeInteger(rate[key]) && rate[key] >= 0);
}
function retryAfterMs(header, at) {
  if (!header || header.length > 128) return 0;
  const target = /^\d+(?:\.\d+)?$/.test(header.trim()) ? at + Number(header) * 1000 : Date.parse(header);
  return Number.isFinite(target) && target > at && target <= 8640000000000000 ? Math.ceil(target - at) : 0;
}
// Classify only. Never retain upstream prose, headers, URLs, credentials or
// request identifiers in logs, snapshots or the durable budget file.
async function errorCategory(response, timeoutMs) {
  const reader = response.body?.getReader?.(); if (!reader) return 'unknown';
  let size = 0, content = '', timer;
  try {
    return await Promise.race([
      new Promise(resolve => { timer = setTimeout(() => resolve('unknown'), timeoutMs); }),
      (async () => {
        const decoder = new TextDecoder();
        while (size < 8192) {
          const part = await reader.read(); if (part.done) break;
          const bytes = part.value.subarray(0, 8192 - size); size += bytes.byteLength;
          content += decoder.decode(bytes, { stream: true });
        }
        if (/quota|credit|balance|insufficient|配额|积分|余额/i.test(content)) return 'quota';
        if (/captcha|challenge|cloudflare|access denied|IP.{0,12}(?:block|limit)/i.test(content)) return 'gateway';
        if (/too many|rate.?limit|frequency|qps|throttl|频率|限流/i.test(content)) return 'rate';
        return 'unknown';
      })()
    ]);
  } catch { return 'unknown'; }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
const address = normalizeTokenAddress;
function input(chain, ca) {
  if (!Object.hasOwn(AVE_CHAINS, chain) || ca !== undefined && !address(chain, ca)) throw fail('INPUT', 400);
  return ca === undefined ? undefined : address(chain, ca);
}
const poolAddress = normalizePoolAddress;
function envelope(raw, trending = false) {
  if (!object(raw)) throw fail('SCHEMA');
  if (Object.hasOwn(raw, 'status')) {
    if (raw.status !== 1 || !object(raw.data)) throw fail('SCHEMA');
    return raw.data;
  }
  if (trending && Array.isArray(raw.tokens) && !Object.hasOwn(raw, 'code') && !Object.hasOwn(raw, 'error')) return raw;
  throw fail('SCHEMA');
}
function checkEcho(row, chain, ca, requireAddress = false) {
  if (!object(row) || row.chain !== AVE_CHAINS[chain]) throw fail('SCHEMA');
  for (const field of ['token', 'address']) if (Object.hasOwn(row, field) && address(chain, row[field]) !== ca) throw fail('SCHEMA');
  if (Object.hasOwn(row, 'token_id') && row.token_id !== ca + '-' + AVE_CHAINS[chain]) throw fail('SCHEMA');
  if (requireAddress && address(chain, row.token) !== ca) throw fail('SCHEMA');
}
function tokenRow(row, chain, ca, required = false) {
  checkEcho(row, chain, ca, required);
  const price = numeric(row.current_price_usd);
  if (!(price > 0)) throw fail('SCHEMA');
  for (const field of ['market_cap', 'tvl', 'main_pair_tvl', 'token_tx_volume_usd_5m',
    'token_buy_volume_u_5m', 'token_sell_volume_u_5m']) {
    if (row[field] != null && numeric(row[field]) === null) throw fail('SCHEMA');
  }
  for (const field of ['holders', 'token_tx_count_5m', 'token_buy_tx_count_5m', 'token_sell_tx_count_5m']) {
    if (row[field] != null && !Number.isSafeInteger(numeric(row[field]))) throw fail('SCHEMA');
  }
  for (const field of ['updated_at', 'launch_at', 'created_at']) {
    // AVE occasionally uses zero as an explicit "not indexed yet" marker.
    // Preserve that as unknown, but reject every other malformed timestamp.
    if (row[field] != null && row[field] !== 0 && seconds(row[field]) === null) throw fail('SCHEMA');
  }
  if (row.token_price_change_5m != null && signedNumeric(row.token_price_change_5m) === null) throw fail('SCHEMA');
  return { token: ca, chain, apiChain: AVE_CHAINS[chain], name: text(row.name, 100), symbol: text(row.symbol, 40),
    current_price_usd: price, market_cap: numeric(row.market_cap), holders: numeric(row.holders), tvl: numeric(row.tvl),
    main_pair_tvl: numeric(row.main_pair_tvl), token_tx_volume_usd_5m: numeric(row.token_tx_volume_usd_5m),
    token_buy_volume_u_5m: numeric(row.token_buy_volume_u_5m), token_sell_volume_u_5m: numeric(row.token_sell_volume_u_5m),
    token_tx_count_5m: numeric(row.token_tx_count_5m), token_buy_tx_count_5m: numeric(row.token_buy_tx_count_5m),
    token_sell_tx_count_5m: numeric(row.token_sell_tx_count_5m), token_price_change_5m: signedNumeric(row.token_price_change_5m),
    launch_at: seconds(row.launch_at), created_at: seconds(row.created_at),
    updated_at: row.updated_at ?? null, sourceUpdatedAt: upstreamTime(row.updated_at),
    identityBasis: row.token === undefined && row.address === undefined ? 'request_path' : 'response' };
}
function outerEcho(raw, chain) {
  if (raw?.chain !== undefined && raw.chain !== AVE_CHAINS[chain]) throw fail('SCHEMA');
}
function parseTrending(raw, chain) {
  outerEcho(raw, chain); const data = envelope(raw, true); outerEcho(data, chain);
  if (!Array.isArray(data.tokens) || data.tokens.length > 100) throw fail('SCHEMA');
  const seen = new Map(), invalid = new Set(), rows = [];
  for (const row of data.tokens) {
    const ca = address(chain, row?.token);
    if (!ca) continue;
    let parsed;
    try { parsed = tokenRow(row, chain, ca, true); }
    catch (error) {
      // A hot-list can contain a newly indexed row before all of its market
      // fields are complete. Drop only that untrusted row; never let one bad
      // item take an otherwise valid chain offline. A wholly invalid nonempty
      // response still fails closed below.
      if (error?.code !== 'AVE_SCHEMA') throw error;
      if (seen.has(ca) || invalid.has(ca)) throw fail('SCHEMA');
      invalid.add(ca);
      continue;
    }
    if (invalid.has(ca)) throw fail('SCHEMA');
    const prior = seen.get(ca);
    if (prior) {
      // AVE's Solana leaderboard can repeat an identical token row. Collapse
      // only an identical validated market identity; conflicting duplicates
      // remain a schema error so one address cannot smuggle two realities.
      if (JSON.stringify(prior) !== JSON.stringify(parsed)) throw fail('SCHEMA');
      continue;
    }
    seen.set(ca, parsed); rows.push(parsed);
  }
  if (data.tokens.length && !rows.length) throw fail('SCHEMA');
  if (data.next_page != null && (!Number.isSafeInteger(data.next_page) || data.next_page < -1)) throw fail('SCHEMA');
  return { rows, nextPage: data.next_page ?? null };
}
function parseDetails(raw, chain, ca) {
  outerEcho(raw, chain); const data = envelope(raw); outerEcho(data, chain);
  if (!object(data.token) || !Array.isArray(data.pairs) || data.pairs.length > 100) throw fail('SCHEMA');
  const token = tokenRow(data.token, chain, ca);
  const pairs = data.pairs.map(p => {
    const pool = poolAddress(chain, p?.pair);
    if (!object(p) || p.chain !== AVE_CHAINS[chain] || !pool || p.updated_at != null && seconds(p.updated_at) === null) throw fail('SCHEMA');
    return { chain, address: ca, pair: pool, amm: text(p.amm, 80), sourceUpdatedAt: upstreamTime(p.updated_at) };
  });
  // is_audited is not a safe/honeypot verdict; pair TVL is not token liquidity.
  return { token, rows: [token], pairs };
}
function pairCandidates(pairs) {
  const seen = new Set(), result = [];
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    // The pair endpoint is addressed only by pool address, so duplicate
    // protocol labels for one pool must not spend the fallback allowance.
    if (!object(pair) || seen.has(pair.pair)) continue;
    seen.add(pair.pair); result.push(pair);
  }
  // Preserve AVE's ranked response order. It is the only upstream ordering
  // signal available, and makes primary -> fallback selection reproducible.
  return result;
}
function parsePair(raw, chain, pair) {
  if (!object(raw) || Object.hasOwn(raw, 'error') || Object.hasOwn(raw, 'code')) throw fail('SCHEMA');
  const data = Object.hasOwn(raw, 'status') ? envelope(raw) : raw;
  if (data.chain !== AVE_CHAINS[chain] || poolAddress(chain, data.pair) !== pair) throw fail('SCHEMA');
  const token0 = address(chain, data.token0_address), token1 = address(chain, data.token1_address), target = address(chain, data.target_token);
  if (!token0 || !token1 || token0 === token1 || !target || target !== token0 && target !== token1) throw fail('SCHEMA');
  const result = { pair, chain, amm: text(data.amm, 80), token0_address: token0, token1_address: token1, target_token: target };
  for (const field of ['created_at', 'updated_at', 'first_trade_at', 'last_trade_at']) {
    if (data[field] != null && seconds(data[field]) === null) throw fail('SCHEMA');
    result[field] = data[field] ?? null;
  }
  for (const field of ['token0_price_usd', 'token1_price_usd', 'tvl', 'market_cap', 'fdv', 'price_ath_u',
    'volume_u_1m', 'volume_u_5m', 'volume_u_1h', 'volume_u_24h', 'buy_volume_u_5m', 'sell_volume_u_5m']) {
    if (data[field] != null && numeric(data[field]) === null) throw fail('SCHEMA');
    result[field] = numeric(data[field]);
  }
  for (const field of ['price_change_1m', 'price_change_5m', 'price_change_1h', 'price_change_24h']) {
    if (data[field] != null && signedNumeric(data[field]) === null) throw fail('SCHEMA');
    result[field] = signedNumeric(data[field]);
  }
  for (const field of ['tx_4h_count', 'tx_24h_count', 'buys_tx_4h_count', 'buys_tx_24h_count', 'sells_tx_4h_count', 'sells_tx_24h_count']) {
    const n = numeric(data[field]);
    if (data[field] != null && !Number.isSafeInteger(n)) throw fail('SCHEMA');
    result[field] = n;
  }
  result.sourceUpdatedAt = upstreamTime(result.updated_at);
  return { pair: result, sourceUpdatedAt: result.sourceUpdatedAt };
}
function parseKlines(raw, chain, ca, capturedAt, fromTime, toTime) {
  outerEcho(raw, chain); const data = envelope(raw); outerEcho(data, chain);
  for (const field of ['address', 'token']) if (data[field] !== undefined && address(chain, data[field]) !== ca) throw fail('SCHEMA');
  if (data.token_id !== undefined && data.token_id !== ca + '-' + AVE_CHAINS[chain] || data.interval !== 1 || !Array.isArray(data.points) || data.points.length > 1000) throw fail('SCHEMA');
  const byTime = new Map(), closedAt = Math.min(capturedAt, toTime ?? capturedAt);
  for (const p of data.points) {
    if (!object(p) || seconds(p.time) === null || p.time % 60 !== 0) throw fail('SCHEMA');
    const candle = { time: p.time * 1000, open: numeric(p.open), high: numeric(p.high), low: numeric(p.low), close: numeric(p.close), volume: numeric(p.volume) };
    if (![candle.open, candle.high, candle.low, candle.close].every(n => n > 0) || candle.volume === null || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.low > candle.high) throw fail('SCHEMA');
    const prior = byTime.get(candle.time);
    if (prior && JSON.stringify(prior) !== JSON.stringify(candle)) throw fail('SCHEMA');
    byTime.set(candle.time, candle);
  }
  const list = [...byTime.values()].filter(p => p.time >= (fromTime ?? Math.floor(capturedAt / 60000) * 60000 - 3600000) && p.time + 60000 <= closedAt).sort((a, b) => a.time - b.time).slice(-60);
  return { chain, address: ca, list, sourceUpdatedAt: list.at(-1)?.time + 60000 || null, scope: 'token_usd_1m', identityBasis: 'request_path', volumeUnit: 'upstream_unspecified' };
}
export function normalizeList(raw, keys = ['list', 'tokens']) {
  for (let i = 0; i < 4; i++) {
    if (Array.isArray(raw)) return raw;
    if (!object(raw)) return [];
    for (const key of keys) if (Array.isArray(raw[key])) return raw[key];
    raw = raw.data;
  }
  return [];
}
export function tokenInfoPrice(info, now = Date.now()) {
  if (info?.marketProvider === 'AVE' && (info.stale !== false || !Number.isFinite(info.capturedAt) || info.capturedAt > now ||
    !Number.isFinite(info.expiresAt) || info.expiresAt <= now)) return null;
  const price = numeric(info?.price?.price ?? info?.price ?? info?.current_price_usd);
  return price > 0 ? price : null;
}
function marketRow(row, capturedAt, now) {
  const sampledAt = row.sourceUpdatedAt;
  const expiresAt = sampledAt === null ? null : Math.min(capturedAt, sampledAt) + AVE_LIMITS.detailsTtlMs;
  const launchedAt = row.launch_at ?? row.created_at;
  const ageBasis = row.launch_at !== null ? 'launch' : row.created_at !== null ? 'token' : null;
  return { address: row.token, chain: row.chain, symbol: row.symbol, name: row.name, source: 'AVE', marketProvider: 'AVE',
    price: row.current_price_usd, market_cap: row.market_cap, holder_count: row.holders, tvl: row.tvl,
    marketCapSourceUpdatedAt: sampledAt, marketCapCapturedAt: capturedAt, marketCapExpiresAt: expiresAt,
    // These are first-party fields from AVE's trending/token response. They
    // are display/discovery market facts, not a contract-risk verdict.
    liquidity: row.main_pair_tvl ?? row.tvl, liquidityBasis: row.main_pair_tvl !== null ? 'main_pair_tvl' : row.tvl !== null ? 'token_tvl' : null,
    creation_timestamp: launchedAt, launch_at: row.launch_at, token_created_at: row.created_at, ageBasis,
    volume_5m: row.token_tx_volume_usd_5m, buy_volume_5m: row.token_buy_volume_u_5m,
    sell_volume_5m: row.token_sell_volume_u_5m, swaps_5m: row.token_tx_count_5m,
    buys_5m: row.token_buy_tx_count_5m, sells_5m: row.token_sell_tx_count_5m,
    price_change_percent5m: row.token_price_change_5m === null ? null : row.token_price_change_5m / 100,
    rug_ratio: null, bundler_rate: null, rat_trader_amount_rate: null, is_wash_trading: null, is_honeypot: null,
    capturedAt, sourceUpdatedAt: sampledAt, sampledAt, expiresAt,
    stale: sampledAt === null || sampledAt > capturedAt + 30000 || now >= expiresAt,
    identityBasis: row.identityBasis, aveUrl: 'https://pro.ave.ai/token/' + row.token + '-' + row.apiChain + '?ref=0001' };
}

function discoveryFactsComplete(row) {
  const age = row.first_trade_at ?? row.pool_created_at ?? row.launch_at ?? row.creation_timestamp;
  return numeric(row.liquidity) !== null && numeric(row.volume_5m) !== null && seconds(age) !== null;
}
function pairMarket(row, result, now) {
  const p = result.pair;
  if (p.chain !== row.chain || p.target_token !== row.address || p.token0_address !== row.address && p.token1_address !== row.address) return row;
  const price = p.token0_address === row.address ? p.token0_price_usd : p.token1_price_usd;
  if (!(price > 0)) return row;
  const sampledAt = p.sourceUpdatedAt, expiresAt = sampledAt === null ? null : Math.min(sampledAt, result.capturedAt) + AVE_LIMITS.detailsTtlMs;
  const hasPoolMarketCap = p.market_cap !== null;
  return { ...row, price, market_cap: hasPoolMarketCap ? p.market_cap : row.market_cap,
    marketCapSourceUpdatedAt: hasPoolMarketCap ? sampledAt : row.marketCapSourceUpdatedAt,
    marketCapCapturedAt: hasPoolMarketCap ? result.capturedAt : row.marketCapCapturedAt,
    marketCapExpiresAt: hasPoolMarketCap ? expiresAt : row.marketCapExpiresAt,
    liquidity: p.tvl, pairAddress: p.pair, dexId: p.amm,
    tokenSourceUpdatedAt: row.sourceUpdatedAt, tokenCapturedAt: row.capturedAt,
    capturedAt: result.capturedAt, sourceUpdatedAt: sampledAt, sampledAt, expiresAt,
    stale: sampledAt === null || sampledAt > result.capturedAt + 30000 || now >= expiresAt,
    pool_created_at: p.created_at, first_trade_at: p.first_trade_at, last_trade_at: p.last_trade_at,
    poolCreatedAt: upstreamTime(p.created_at), firstTradeAt: upstreamTime(p.first_trade_at), lastTradeAt: upstreamTime(p.last_trade_at), ageBasis: 'pool',
    volume_5m: p.volume_u_5m, volume_1h: p.volume_u_1h, volume_24h: p.volume_u_24h,
    buy_volume_5m: p.buy_volume_u_5m, sell_volume_5m: p.sell_volume_u_5m,
    price_change_percent5m: p.price_change_5m === null ? null : p.price_change_5m / 100,
    buys_24h: p.buys_tx_24h_count, sells_24h: p.sells_tx_24h_count, activityWindow: '5m',
    poolEvidence: { source: 'AVE', ...p, capturedAt: result.capturedAt, expiresAt, identityBasis: 'response' } };
}
function auditMeta(partial, requested, now) {
  const endpoints = partial._meta.endpoints;
  const requestedEndpoints = [...requested];
  const transportComplete = requestedEndpoints.every(name => endpoints[name]?.ok === true);
  const marketComplete = ['info', 'pool', 'candles'].every(name => endpoints[name]?.ok === true && endpoints[name]?.state === 'ok') &&
    Number.isFinite(partial.info.market_cap) && Number.isFinite(partial.pool.liquidity) && partial.candles.length > 0;
  const candleAt = endpoints.candles?.sourceUpdatedAt;
  partial._meta = { ...partial._meta, complete: false, evidenceComplete: false,
    transportComplete, marketComplete,
    marketFresh: marketComplete && partial.info.stale === false && Number.isFinite(candleAt) && candleAt <= now && now - candleAt <= 90000,
    missingEvidence: ['security', 'holders', 'traders'], requestedEndpoints,
    capturedAt: partial.info.capturedAt ?? endpoints.candles?.capturedAt ?? null,
    auditedAt: null };
  return partial;
}
function validBudget(value, now) {
  if (value == null) return;
  if (!object(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) || value.day > day(now) ||
    ['blockedUntil', 'quotaUntil', 'nextRequestAt'].some(k => !Number.isFinite(value[k]) || value[k] < 0)) throw fail('BUDGET_STORE', 503);
  if (value.rateControl !== undefined && !validRate(value.rateControl)) throw fail('BUDGET_STORE', 503);
  if (value.budgetVersion === undefined) {
    if (!Number.isSafeInteger(value.used) || value.used < 0) throw fail('BUDGET_STORE', 503);
    return;
  }
  if (value.budgetVersion !== 2 || Object.hasOwn(value, 'used') ||
    ['dailyUsed', 'hourlyUsed', 'totalUsed'].some(k => !Number.isSafeInteger(value[k]) || value[k] < 0) ||
    value.totalUsed < Math.max(value.dailyUsed, value.hourlyUsed) ||
    !Number.isSafeInteger(value.hourStartedAt) || value.hourStartedAt < 0 || value.hourStartedAt % 3600000 || value.hourStartedAt > now || day(value.hourStartedAt) !== value.day ||
    !Number.isSafeInteger(value.periodStartedAt) || value.periodStartedAt <= 0 || value.periodStartedAt > now || typeof value.legacyUsageIncluded !== 'boolean') throw fail('BUDGET_STORE', 503);
  if (value.legacyUsageIncluded) {
    if (!object(value.legacySnapshot) || value.legacySnapshot.budgetVersion !== undefined) throw fail('BUDGET_STORE', 503);
    validBudget(value.legacySnapshot, now);
    if (value.totalUsed < value.legacySnapshot.used) throw fail('BUDGET_STORE', 503);
  } else if (value.legacySnapshot !== null) throw fail('BUDGET_STORE', 503);
}
function normalizedBudget(value, now) {
  if (!value) return null;
  if (value.budgetVersion === 2) return value;
  const legacySnapshot = Object.fromEntries(['day', 'used', 'blockedUntil', 'quotaUntil', 'nextRequestAt'].map(key => [key, value[key]]));
  return { budgetVersion: 2, day: day(now), dailyUsed: value.day === day(now) ? value.used : 0,
    hourStartedAt: hourStart(now), hourlyUsed: value.nextRequestAt >= hourStart(now) && value.nextRequestAt < nextHour(now) ? value.used : 0,
    totalUsed: value.used, periodStartedAt: now, legacyUsageIncluded: true, legacySnapshot,
    blockedUntil: value.blockedUntil, quotaUntil: value.quotaUntil, nextRequestAt: value.nextRequestAt };
}
function mergedBudget(stored, memory, now) {
  validBudget(stored, now); validBudget(memory, now);
  // A v2 process must not silently accept a later downgrade of its ledger.
  if (memory?.budgetVersion === 2 && stored && stored.budgetVersion !== 2) throw fail('BUDGET_STORE', 503);
  const records = [normalizedBudget(stored, now), normalizedBudget(memory, now)].filter(Boolean);
  const max = key => Math.max(0, ...records.map(item => item[key]));
  const legacy = records.filter(item => item.legacyUsageIncluded).sort((a, b) => b.legacySnapshot.used - a.legacySnapshot.used)[0];
  const rateControl = normalizeRate(records.map(item => item.rateControl).filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.strikes - a.strikes || b.successes - a.successes)[0] || freshRate());
  return { budgetVersion: 2, day: day(now), dailyUsed: Math.max(0, ...records.filter(item => item.day === day(now)).map(item => item.dailyUsed)),
    hourStartedAt: hourStart(now), hourlyUsed: Math.max(0, ...records.filter(item => item.hourStartedAt === hourStart(now)).map(item => item.hourlyUsed)),
    totalUsed: max('totalUsed'), periodStartedAt: records.length ? Math.min(...records.map(item => item.periodStartedAt)) : now,
    legacyUsageIncluded: !!legacy, legacySnapshot: legacy ? clone(legacy.legacySnapshot) : null, rateControl: clone(rateControl),
    blockedUntil: max('blockedUntil'), quotaUntil: max('quotaUntil'), nextRequestAt: max('nextRequestAt') };
}

// Contains only aggregate CU/cooldown counters, never the key or API payloads.
// A fail-closed exclusive lock makes each update atomic across local processes.
export function createAveBudgetStore(directory) {
  if (typeof directory !== 'string' || !directory) throw fail('INPUT', 400);
  const folder = resolve(directory), file = join(folder, 'ave-read-budget.json'), lock = join(folder, 'ave-read-budget.lock');
  return {
    transact(update) {
      let fd, temporary;
      try {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) throw fail('BUDGET_STORE', 503);
        fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        let previous = null;
        try {
          const stat = lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw fail('BUDGET_STORE', 503);
          const readFd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          try { previous = JSON.parse(readFileSync(readFd, 'utf8')); } finally { closeSync(readFd); }
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        const next = update(previous);
        if (!object(next) || typeof next.then === 'function') throw fail('BUDGET_STORE', 503);
        if (previous?.budgetVersion === 2 && (next.budgetVersion !== 2 || Object.hasOwn(next, 'used') || next.totalUsed < previous.totalUsed)) throw fail('BUDGET_STORE', 503);
        temporary = join(folder, '.ave-read-budget-' + randomUUID() + '.tmp');
        const out = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        try { writeFileSync(out, JSON.stringify(next) + '\n'); fsyncSync(out); } finally { closeSync(out); }
        renameSync(temporary, file); temporary = undefined;
        if (process.platform !== 'win32') { const d = openSync(folder, constants.O_RDONLY); try { fsyncSync(d); } finally { closeSync(d); } }
        return clone(next);
      } catch (error) { if (error instanceof AveError) throw error; throw fail('BUDGET_STORE', 503); }
      finally {
        if (temporary) try { unlinkSync(temporary); } catch { /* Best effort for this owned temp only. */ }
        if (fd !== undefined) { closeSync(fd); try { unlinkSync(lock); } catch { /* Left-over lock remains fail-closed. */ } }
      }
    }
  };
}

export class AveClient {
  #keyProvider; #fetch; #now; #pause; #allowed; #timeout; #store; #lane; #pending = new Map(); #cache = new Map();
  #fingerprint = null; #budget = null; #observed = new Set();
  #budgetPauseUntil = 0; #hourPauseUntil = 0; #nonTrendingPauseUntil = 0;
  #enrichLimit; #maxTrendingPages; #rotateTrendingPages; #enrichmentTtl; #pairTtl; #minimumGap; #discovery = new Map(); #discoveryPending = new Map(); #cursors = new Map();
  #trendingPages = new Map();
  #enrichmentDeferrals = new Map(); #routes = new Map();
  #diagnostics = [];
  constructor({ apiKeyProvider = () => '', fetchImpl = fetch, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), allowed = () => true,
    directory, budgetStore, readBudget, saveBudget, dailyBudgetCu = AVE_LIMITS.dailyCu, totalBudgetCu = AVE_LIMITS.totalCu,
    hourlyBudgetCu = AVE_LIMITS.hourlyCu, discoveryReserveCu = Math.floor(dailyBudgetCu * 0.1 / 5) * 5, timeoutMs = AVE_LIMITS.timeoutMs,
    enrichLimit = 6, maxTrendingPages = 3, rotateTrendingPages = false, enrichmentTtlMs = AVE_LIMITS.detailsTtlMs, pairTtlMs = AVE_LIMITS.detailsTtlMs,
    minimumGapMs = RATE_BASE_GAP_MS } = {}) {
    if (typeof apiKeyProvider !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof pause !== 'function' || typeof allowed !== 'function' ||
      !Number.isSafeInteger(dailyBudgetCu) || dailyBudgetCu < 1 || dailyBudgetCu > AVE_LIMITS.dailyCu || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > AVE_LIMITS.timeoutMs ||
      !Number.isSafeInteger(totalBudgetCu) || totalBudgetCu < 1 || totalBudgetCu > AVE_LIMITS.totalCu ||
      !Number.isSafeInteger(hourlyBudgetCu) || hourlyBudgetCu < 1 || hourlyBudgetCu > AVE_LIMITS.dailyCu ||
      !Number.isSafeInteger(discoveryReserveCu) || discoveryReserveCu < 0 || discoveryReserveCu > dailyBudgetCu || discoveryReserveCu % 5 ||
      !!readBudget !== !!saveBudget || !Number.isInteger(enrichLimit) || enrichLimit < 0 || enrichLimit > 6 ||
      !Number.isInteger(maxTrendingPages) || maxTrendingPages < 1 || maxTrendingPages > 3 || typeof rotateTrendingPages !== 'boolean'
      || rotateTrendingPages && maxTrendingPages !== 1 ||
      !Number.isSafeInteger(minimumGapMs) || minimumGapMs < RATE_BASE_GAP_MS || minimumGapMs > RATE_MAX_GAP_MS ||
      !Number.isSafeInteger(enrichmentTtlMs) || enrichmentTtlMs < 30000 || enrichmentTtlMs > AVE_LIMITS.trendingTtlMs ||
      !Number.isSafeInteger(pairTtlMs) || pairTtlMs < 20000 || pairTtlMs > 30000) throw fail('INPUT', 400);
    this.#keyProvider = apiKeyProvider; this.#fetch = fetchImpl; this.#now = now; this.#pause = pause; this.#allowed = allowed; this.#timeout = timeoutMs; this.#lane = sharedLane(now);
    this.#enrichLimit = enrichLimit; this.#maxTrendingPages = maxTrendingPages; this.#rotateTrendingPages = rotateTrendingPages; this.#minimumGap = minimumGapMs;
    this.#enrichmentTtl = enrichmentTtlMs; this.#pairTtl = pairTtlMs;
    // Callback stores are for a single shared instance only; file store is atomic across instances.
    this.#store = budgetStore || (directory ? createAveBudgetStore(directory) : readBudget && saveBudget ? {
      transact: async update => { const next = update(await readBudget()); await saveBudget(clone(next)); return next; }
    } : null);
    if (typeof this.#store?.transact !== 'function') throw fail('BUDGET_STORE', 503);
    this.dailyBudgetCu = dailyBudgetCu; this.totalBudgetCu = totalBudgetCu; this.hourlyBudgetCu = hourlyBudgetCu;
    this.keyEpoch = 0; this.disabled = false; this.nextAllowedAt = 0; this.schedulerReadyAt = 0;
    // This is a local reserve, not a promise of platform quota or all-day
    // coverage for every enabled chain. Round down to one 5-CU request.
    this.discoveryReserveCu = discoveryReserveCu;
    this.metrics = { requests: 0, cacheHits: 0, rateLimits: 0, estimatedCu: 0, scope: 'session', discoveryCacheHits: 0,
      byKind: Object.fromEntries(Object.keys(CU_BY_KIND).map(kind => [kind, { requests: 0, cacheHits: 0, estimatedCu: 0 }])) }; this.lastDiscoveryHealth = null;
  }
  #credential() {
    let key; try { key = this.#keyProvider(); } catch { throw fail('CONFIG', 400); }
    if (!keyValid(key)) throw fail('CONFIG', 400);
    const fp = fingerprint(key);
    if (this.#fingerprint !== fp) {
      if (this.#fingerprint !== null) this.resetCredentials({ disabled: this.disabled });
      this.#fingerprint = fp;
    }
    return { key, fp };
  }
  async configured() { try { this.#credential(); return !this.disabled; } catch { return false; } }
  async hydrate() {
    await this.#updateBudget(budget => {
      const rate = normalizeRate(budget.rateControl || freshRate());
      if (rate.floorMs >= this.#minimumGap && rate.gapMs >= this.#minimumGap) return budget;
      return { ...budget, rateControl: { ...rate, floorMs: Math.max(rate.floorMs, this.#minimumGap),
        gapMs: Math.max(rate.gapMs, this.#minimumGap), updatedAt: this.#now() } };
    });
    return this.snapshot();
  }
  resetCredentials({ disabled = false } = {}) {
    this.keyEpoch++; this.disabled = disabled; this.#fingerprint = null; this.#cache.clear(); this.#observed.clear(); this.lastDiscoveryHealth = null;
    this.#discovery.clear(); for (const job of this.#discoveryPending.values()) job.controller.abort(); this.#discoveryPending.clear(); this.#cursors.clear(); this.#trendingPages.clear();
    this.#enrichmentDeferrals.clear(); this.#routes.clear();
    for (const job of this.#pending.values()) job.controller.abort();
    this.#pending.clear();
  }
  #alive(job) {
    if (job.controller.signal.aborted) throw fail('ABORTED', 499);
    if (job.epoch !== this.keyEpoch) throw fail('CHANGED', 409);
    let permitted = false; try { permitted = this.#allowed() === true; } catch { /* Do not expose callback errors. */ }
    if (!permitted || this.disabled && !job.verification) throw fail('DISABLED', 403);
    if (job.verification) {
      if (!keyValid(job.verificationKey)) throw fail('CONFIG', 400);
      return job.verificationKey;
    }
    const c = this.#credential();
    if (c.fp !== job.fingerprint || job.epoch !== this.keyEpoch) throw fail('CHANGED', 409);
    return c.key;
  }
  async #updateBudget(update) {
    try {
      const next = await this.#store.transact(stored => {
        const current = mergedBudget(stored, this.#budget, this.#now());
        // Publish already-persisted pauses even when the requested reservation is
        // rejected, so scanner.nextAllowedAt can stop subsequent audit attempts.
        this.#budget = current;
        this.#syncPauses(current);
        return update(current);
      });
      this.#budget = next; this.#syncPauses(next);
      return next;
    } catch (error) { if (error instanceof AveError) throw error; throw fail('BUDGET_STORE', 503); }
  }
  #syncPauses(budget) {
    const at = this.#now();
    this.#budgetPauseUntil = budget.dailyUsed + 5 > this.dailyBudgetCu ? nextDay(at) : 0;
    this.#hourPauseUntil = budget.hourlyUsed + 5 > this.hourlyBudgetCu ? nextHour(at) : 0;
    this.#nonTrendingPauseUntil = budget.dailyUsed + 5 > this.dailyBudgetCu - this.discoveryReserveCu ? nextDay(at) : 0;
    // Recompute rather than retaining an old local daily pause after a limit
    // increase. Total exhaustion is a manual state, never an infinite timer.
    // During recovery, publish the physical request lane's durable start time
    // to the scheduler. Otherwise a scan cycle starts early, waits inside the
    // request, and can be killed by the supervisor watchdog before its probe.
    const nextRequestAt = requestNotBefore(budget);
    this.schedulerReadyAt = nextRequestAt > at ? nextRequestAt : 0;
    const recoveryProbeAt = recovering(budget.rateControl) && nextRequestAt > at ? nextRequestAt : 0;
    this.nextAllowedAt = Math.max(0, budget.blockedUntil > at ? budget.blockedUntil : 0, budget.quotaUntil > at ? budget.quotaUntil : 0,
      recoveryProbeAt, this.#budgetPauseUntil, this.#hourPauseUntil);
  }
  async #reserve(job, cu) {
    while (true) {
      this.#alive(job);
      let waitUntil = 0, denied = null;
      await this.#updateBudget(b => {
        const at = this.#now();
        // Persist a migration even when this request is denied. This also
        // installs the v2 old-writer guard before any subsequent request.
        const deny = (kind, retryAt = null) => { denied = fail(kind, kind === 'QUOTA' ? 402 : 429, retryAt); return b; };
        if (b.quotaUntil > at) return deny('QUOTA', b.quotaUntil);
        if (b.blockedUntil > at) return deny('RATE_LIMITED', b.blockedUntil);
        if (job.kind !== 'trending' && headOnly(b.rateControl)) return deny('DISCOVERY_RESERVE', at + AVE_LIMITS.trendingTtlMs);
        if (b.totalUsed + cu > this.totalBudgetCu) return deny('TOTAL_BUDGET');
        // A 10-CU Kline must not pause an otherwise affordable 5-CU trending
        // request. Only a genuinely exhausted minimum request pauses all work.
        if (b.dailyUsed + CU_BY_KIND.trending > this.dailyBudgetCu) return deny('BUDGET', nextDay(at));
        if (b.hourlyUsed + cu > this.hourlyBudgetCu) return deny('HOURLY_BUDGET', nextHour(at));
        if (job.kind !== 'trending' && b.dailyUsed + cu > this.dailyBudgetCu - this.discoveryReserveCu) return deny('DISCOVERY_RESERVE', nextDay(at));
        const nextRequestAt = requestNotBefore(b);
        if (nextRequestAt > at) { waitUntil = nextRequestAt; return b; }
        return { ...b, dailyUsed: b.dailyUsed + cu, hourlyUsed: b.hourlyUsed + cu, totalUsed: b.totalUsed + cu,
          nextRequestAt: at + spacing(b.rateControl) };
      });
      if (denied) throw denied;
      if (!waitUntil) { this.metrics.estimatedCu += cu; this.metrics.byKind[job.kind].estimatedCu += cu; return; }
      await this.#pause(Math.min(30000, Math.max(0, waitUntil - this.#now()))); this.#alive(job);
    }
  }
  async #httpError(response, diagnostic, controller) {
    const at = this.#now();
    if (response.status === 402 || response.status === 429) {
      // Some AVE gateways report exhausted credits as HTTP 429. Classify the
      // bounded response before writing durable state so quota exhaustion does
      // not masquerade as a short rate pause and trigger useless probes.
      const category = await errorCategory(response, Math.max(1, Math.min(250, this.#timeout / 4)));
      if (!controller.signal.aborted && category !== 'unknown') diagnostic.category = category;
      const quota = response.status === 402 || category === 'quota';
      const delay = retryAfterMs(response.headers?.get?.('retry-after'), at);
      const rate = normalizeRate(this.#budget?.rateControl || freshRate());
      const strikes = Math.min(10, rate.strikes + 1);
      // Learn a durable sustainable floor instead of returning to a one-minute
      // burst after every recovery. Escalation within one incident learns up
      // to eight minutes; if that already-proven floor later fails again after
      // a complete recovery, promote it to the fifteen-minute ceiling.
      const floorMs = rate.strikes === 0 && rate.floorMs >= 8 * 60_000
        ? RATE_MAX_GAP_MS
        : rate.strikes === 0 && rate.floorMs >= RATE_TARGET_GAP_MS
          ? 8 * 60_000
          : Math.min(8 * 60_000, Math.max(rate.floorMs, strikeDelay(strikes)));
      const retryAt = quota ? Math.max(nextDay(at), at + delay) : at + Math.max(delay, strikeDelay(strikes));
      // Keep every client sharing this process behind the provider's actual
      // Retry-After boundary, even when that boundary exceeds our adaptive
      // steady-state spacing.
      if (!quota) this.#lane.nextStart = Math.max(this.#lane.nextStart, retryAt);
      this.nextAllowedAt = Math.max(this.nextAllowedAt, retryAt); if (!quota) this.metrics.rateLimits++;
      const field = quota ? 'quotaUntil' : 'blockedUntil';
      this.#budget = { ...this.#budget, [field]: retryAt,
        rateControl: quota ? rate : { ...rate, strikes, successes: 0,
          gapMs: Math.min(RATE_MAX_GAP_MS, Math.max(rate.gapMs, floorMs, strikeDelay(strikes))), floorMs,
          last429At: at, last429Kind: diagnostic.endpoint, lastKindSuccessAt: 0,
          lastFloorFailureAt: rate.floorMs >= RATE_TARGET_GAP_MS ? at : rate.lastFloorFailureAt, updatedAt: at } };
      try { await this.#updateBudget(b => ({ ...b, [field]: Math.max(b[field], retryAt), rateControl: clone(this.#budget.rateControl) })); } catch { /* In-memory stop still applies. */ }
      Object.assign(diagnostic, { retryAt, retryAfterMs: delay, category: quota ? 'quota' : category });
      throw fail(quota ? 'QUOTA' : 'RATE_LIMITED', response.status, retryAt);
    }
    if (response.status === 401 || response.status === 403) throw fail('AUTH', 400);
    if (!response.ok) throw fail('UPSTREAM');
  }
  async #body(response) {
    const declared = response.headers?.get?.('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > AVE_LIMITS.maxBytes)) throw fail('SIZE');
    if (!response.body?.getReader) throw fail('SCHEMA');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > AVE_LIMITS.maxBytes) throw fail('SIZE'); chunks.push(part.value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) { if (error instanceof AveError) throw error; throw fail('SCHEMA'); }
    finally { void reader.cancel().catch(() => {}); }
  }
  async #network(job, path, kind, chain) {
    const controller = new AbortController(); let timer, timedOut = false;
    // A timed-out/aborted transport may take time to acknowledge cancellation.
    // Do not release the physical request lane merely because Promise.race won.
    if (this.#lane.active) throw fail('BUSY', 503);
    this.#lane.active = true;
    const startedAt = this.#now(), previousStart = this.#lane.lastStart;
    const diagnostic = { at: startedAt, endpoint: kind, chain, httpStatus: 0, category: 'unknown',
      startGapMs: previousStart ? Math.max(0, startedAt - previousStart) : null, durationMs: 0, retryAt: 0, retryAfterMs: 0 };
    const abort = () => controller.abort(); job.controller.signal.addEventListener('abort', abort, { once: true });
    const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(fail(timedOut ? 'TIMEOUT' : 'ABORTED', timedOut ? 504 : 499)), { once: true }));
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(fail('TIMEOUT', 504)); }, this.#timeout); });
    const operation = (async () => {
      try {
        const key = this.#alive(job); this.metrics.requests++; this.metrics.byKind[job.kind].requests++;
        this.#lane.lastStart = startedAt;
        const response = await this.#fetch(ORIGIN + path, { method: 'GET', headers: { 'X-API-KEY': key, Accept: 'application/json' }, redirect: 'error', credentials: 'omit', signal: controller.signal });
        if (controller.signal.aborted) throw fail('ABORTED', 499);
        this.#alive(job); diagnostic.httpStatus = response.status;
        await this.#httpError(response, diagnostic, controller); const raw = await this.#body(response); this.#alive(job);
        if (controller.signal.aborted) throw fail('ABORTED', 499);
        diagnostic.category = 'ok';
        return JSON.parse(JSON.stringify(raw, (_, value) => typeof value === 'string' ? value.split(key).join('[已移除凭证]') : value));
      } finally {
        diagnostic.durationMs = Math.max(0, this.#now() - startedAt);
        if (timedOut) diagnostic.category = 'timeout';
        else if (controller.signal.aborted && !diagnostic.httpStatus) diagnostic.category = 'cancelled';
        this.#diagnostics.push(diagnostic); this.#diagnostics = this.#diagnostics.slice(-20);
        const next = this.#now() + spacing(this.#budget?.rateControl);
        this.#lane.nextStart = Math.max(this.#lane.nextStart, next);
        try { await this.#updateBudget(b => ({ ...b, nextRequestAt: Math.max(b.nextRequestAt, next) })); }
        finally { this.#lane.active = false; }
      }
    })();
    try {
      return await Promise.race([deadline, cancelled, operation]);
    } catch (error) { if (error instanceof AveError) throw error; throw fail(timedOut ? 'TIMEOUT' : 'NETWORK', timedOut ? 504 : 502); }
    finally { clearTimeout(timer); controller.abort(); job.controller.signal.removeEventListener('abort', abort); }
  }
  async #execute(job, kind, chain, ca, range) {
    this.#alive(job); validBudget(this.#budget, this.#now());
    if (this.#lane.active) throw fail('BUSY', 503);
    const wait = Math.max(0, this.#lane.nextStart - this.#now());
    if (wait) await this.#pause(wait);
    this.#alive(job); await this.#reserve(job, CU_BY_KIND[kind]); this.#alive(job);
    let path = kind === 'trending' ? '/v2/tokens/trending?chain=' + AVE_CHAINS[chain] + '&current_page=' + job.page + '&page_size=100' :
      kind === 'details' ? '/v2/tokens/' + ca + '-' + AVE_CHAINS[chain] :
      kind === 'pair' ? '/v2/pairs/' + ca + '-' + AVE_CHAINS[chain] :
      '/v2/klines/token/' + ca + '-' + AVE_CHAINS[chain] + '?interval=1&limit=60';
    if (range) path += '&from_time=' + range.from / 1000 + '&to_time=' + range.to / 1000;
    const raw = await this.#network(job, path, kind, chain), capturedAt = this.#now(); this.#alive(job);
    const parsed = kind === 'trending' ? parseTrending(raw, chain) : kind === 'details' ? parseDetails(raw, chain, ca) : kind === 'pair' ? parsePair(raw, chain, ca) : parseKlines(raw, chain, ca, capturedAt, range?.from, range?.to);
    // Cached reads never reach this point. During recovery, trending is the
    // only permitted canary. This also lets a prior details/pair 429 recover
    // without deadlocking behind the non-trending safety gate.
    await this.#updateBudget(b => {
      const rate = normalizeRate(b.rateControl || freshRate());
      if (rate.last429At > capturedAt) return b;
      if (!rate.strikes) {
        // After one successful request at the learned safe floor, cautiously
        // probe the user's five-minute target. A failed five-minute probe is
        // remembered for 24 hours and immediately returns to eight minutes.
        if (job.kind !== 'trending' || rate.floorMs <= this.#minimumGap
          || capturedAt - rate.lastFloorFailureAt < RATE_FLOOR_RETRY_MS) return b;
        const floorMs = rate.floorMs > 8 * 60_000 ? 8 * 60_000 : this.#minimumGap;
        return { ...b, nextRequestAt: Math.min(b.nextRequestAt, capturedAt + floorMs),
          rateControl: { ...rate, floorMs, gapMs: floorMs, updatedAt: this.#now() } };
      }
      const successes = rate.successes + 1;
      const lastKindSuccessAt = job.kind === 'trending' ? capturedAt : rate.lastKindSuccessAt;
      const checkpoint = Math.max(rate.last429At, rate.lastRecoveryAt);
      const recovered = successes >= 5 && capturedAt - checkpoint >= RATE_RECOVERY_WINDOW_MS
        && lastKindSuccessAt > rate.last429At;
      // Five real successes, the formerly failing endpoint, and a continuous
      // thirty-minute healthy window are enough to end recovery. Decrementing
      // one historical strike per window could starve a healthy secondary
      // chain for many hours even though the provider had already recovered.
      const strikes = recovered ? 0 : rate.strikes;
      const nextRate = { ...rate, successes: recovered ? 0 : Math.min(4, successes), strikes,
        // A healthy window clears the incident, not the empirical safe floor.
        // Keeping that floor prevents a 4/8-minute key from immediately
        // falling back to one minute and repeating the same 429 loop.
        gapMs: recovered ? rate.floorMs : rate.gapMs,
        lastKindSuccessAt, lastRecoveryAt: recovered ? capturedAt : rate.lastRecoveryAt,
        // updatedAt orders durable state writes, not the start of health.
        updatedAt: this.#now() };
      const nextGap = spacing(nextRate);
      return { ...b,
        nextRequestAt: Math.min(b.nextRequestAt, capturedAt + nextGap),
        rateControl: nextRate };
    });
    const nextGap = spacing(this.#budget?.rateControl);
    this.#lane.nextStart = Math.min(this.#lane.nextStart, capturedAt + nextGap);
    const value = { ...parsed, source: 'AVE', chain, capturedAt, cacheHit: false };
    if (!job.verification) {
      if (parsed.rows?.length) this.#observed.add(chain);
      if (this.#cache.size >= 256) this.#cache.delete(this.#cache.keys().next().value);
      this.#cache.set(job.key, { until: capturedAt + (kind === 'trending' ? AVE_LIMITS.trendingTtlMs : kind === 'details' ? AVE_LIMITS.detailsTtlMs : kind === 'pair' ? this.#pairTtl : AVE_LIMITS.klinesTtlMs), value });
    }
    return value;
  }
  #subscribe(job, signal) {
    job.subscribers++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, result) => { if (settled) return; settled = true; job.subscribers--; signal?.removeEventListener('abort', abort); fn(result); };
      const abort = () => { finish(reject, fail('ABORTED', 499)); if (!job.subscribers && !job.done) job.controller.abort(); };
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      job.promise.then(value => finish(resolve, clone(value)), error => finish(reject, error));
    });
  }
  #request(kind, chain, ca, { signal, verificationKey, range, page = 0 } = {}) {
    try {
      if (kind === 'pair') { input(chain); ca = poolAddress(chain, ca); }
      else ca = input(chain, ca);
      if (kind !== 'trending' && !ca) throw fail('INPUT', 400);
      if (!Number.isInteger(page) || page < 0 || page > 2 || kind !== 'trending' && page !== 0) throw fail('INPUT', 400);
      validBudget(this.#budget, this.#now());
      if (range && (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from <= 0 || range.from % 60000 || range.to % 60000 || range.to <= range.from || range.to - range.from > 3600000 || range.to > this.#now())) throw fail('INPUT', 400);
      if (signal?.aborted) throw fail('ABORTED', 499);
      const verification = verificationKey !== undefined;
      if (verification && !keyValid(verificationKey)) throw fail('INPUT', 400);
      const fp = verification ? fingerprint(verificationKey) : this.#credential().fp;
      const key = fp + ':' + kind + ':' + chain + ':' + (ca || '') + ':' + (range ? range.from + '-' + range.to : '') + ':' + page + (verification ? ':verify' : '');
      const hit = this.#cache.get(key);
      const probe = { epoch: this.keyEpoch, fingerprint: fp, controller: new AbortController(), verification, verificationKey, kind, page };
      this.#alive(probe);
      if (!verification && hit && hit.until > this.#now()) {
        this.metrics.cacheHits++; this.metrics.byKind[kind].cacheHits++;
        return Promise.resolve({ ...clone(hit.value), cacheHit: true });
      }
      let job = this.#pending.get(key);
      if (!job) {
        if (this.#pending.size >= 16) throw fail('BUSY', 429);
        job = { ...probe, key, subscribers: 0, done: false };
        job.promise = this.#lane.tail.then(() => this.#execute(job, kind, chain, ca, range)); this.#pending.set(key, job);
        this.#lane.tail = job.promise.then(() => {}, () => {});
        const done = () => { job.done = true; if (this.#pending.get(key) === job) this.#pending.delete(key); };
        job.promise.then(done, done);
      }
      return this.#subscribe(job, signal);
    } catch (error) { return Promise.reject(error instanceof AveError ? error : fail('INPUT', 400)); }
  }
  trending(chain, options) { return this.#request('trending', chain, undefined, options); }
  details(chain, ca, options) { return this.#request('details', chain, ca, options); }
  pairDetails(chain, pair, options) { return this.#request('pair', chain, pair, options); }
  tokenKlines(chain, ca, options) { return this.#request('klines', chain, ca, options); }
  async verifyApiKey(key, { signal } = {}) {
    const result = await this.#request('details', 'bsc', WBNB, { signal, verificationKey: key });
    return { connected: true, provider: 'AVE', readonly: true, capturedAt: result.capturedAt, estimatedCu: 5 };
  }
  // Scanner may defer a known market/risk rejection, but must not register
  // missing/stale evidence. This changes scheduling only, never risk verdicts.
  // Original evidence time caps the delay; polling an old row cannot renew it.
  deferEnrichment(chain, ca, { evidenceAt, until } = {}) {
    try { ca = input(chain, ca); } catch { return false; }
    const at = this.#now();
    if (!ca || !Number.isSafeInteger(evidenceAt) || evidenceAt <= 0 || evidenceAt > at ||
      !Number.isSafeInteger(until) || until <= at) return false;
    const expiresAt = Math.min(until, evidenceAt + ENRICHMENT_DEFER_MS);
    if (expiresAt <= at) return false;
    for (const [key, entry] of this.#enrichmentDeferrals) if (entry.until <= at) this.#enrichmentDeferrals.delete(key);
    const key = chain + ':' + ca, previous = this.#enrichmentDeferrals.get(key);
    if (previous && evidenceAt <= previous.evidenceAt) return false;
    if (!previous && this.#enrichmentDeferrals.size >= 512) this.#enrichmentDeferrals.delete(this.#enrichmentDeferrals.keys().next().value);
    this.#enrichmentDeferrals.set(key, { evidenceAt, until: expiresAt });
    return true;
  }
  #rememberRoute(chain, ca, pairs) {
    const key = chain + ':' + ca, at = this.#now(), candidates = pairCandidates(pairs);
    if (!candidates.length) { this.#routes.delete(key); return null; }
    const previous = this.#routes.get(key);
    const previousPair = previous?.until > at ? previous.candidates?.[previous.nextPairIndex]?.pair : null;
    const retained = previousPair ? candidates.findIndex(pair => pair.pair === previousPair) : -1;
    if (!previous && this.#routes.size >= 512) this.#routes.delete(this.#routes.keys().next().value);
    const route = { pairs: clone(pairs), candidates: clone(candidates), nextPairIndex: retained >= 0 ? retained : 0, until: at + ROUTE_TTL_MS };
    this.#routes.set(key, route); return route;
  }
  #pairPlan(chain, ca, pairs, maximum = MAX_PAIR_ATTEMPTS) {
    const key = chain + ':' + ca, at = this.#now(); let route = this.#routes.get(key);
    if (!route || route.until <= at) {
      if (route) this.#routes.delete(key);
      route = this.#rememberRoute(chain, ca, pairs);
    }
    if (!route?.candidates?.length || maximum <= 0) return [];
    const start = route.nextPairIndex % route.candidates.length, count = Math.min(maximum, route.candidates.length);
    return Array.from({ length: count }, (_, offset) => {
      const index = (start + offset) % route.candidates.length;
      return { index, pair: route.candidates[index] };
    });
  }
  #finishPairAttempt(chain, ca, index, success) {
    const route = this.#routes.get(chain + ':' + ca);
    if (!route?.candidates?.length || index < 0 || index >= route.candidates.length) return;
    route.nextPairIndex = success ? index : (index + 1) % route.candidates.length;
  }
  async #discover(chain, options, epoch) {
    try {
      // Hydrate durable recovery state before deciding how much work to do.
      // A restart must not briefly restore the full discovery batch.
      await this.#updateBudget(b => b);
      if (epoch !== this.keyEpoch) throw fail('CHANGED', 409);
      if (this.#budget.quotaUntil > this.#now()) throw fail('QUOTA', 402, this.#budget.quotaUntil);
      if (this.#budget.blockedUntil > this.#now()) throw fail('RATE_LIMITED', 429, this.#budget.blockedUntil);
      // Recovery starts with one real head-list success, never a cached read.
      // Decide before the request so its success cannot unlock a burst here.
      const recovery = recovering(this.#budget?.rateControl), onlyHead = headOnly(this.#budget?.rateControl);
      const rotation = this.#rotateTrendingPages ? this.#trendingPages.get(chain) || { page: 0, tail: 1 } : { page: 0, tail: 1 };
      let page = rotation.page;
      const result = await this.trending(chain, { ...options, page });
      const rows = result.rows.map(row => marketRow(row, result.capturedAt, this.#now()));
      const inScope = row => row.market_cap === null || row.market_cap >= 10000 && row.market_cap <= 150000;
      // AVE documents paginated trending, not an unfiltered new-token feed.
      // Widen discovery only while this sample has too few in-scope leads;
      // each page is separately cached, charged and serialized (max 3 pages).
      let pageResult = result, pageError = null, pages = 1;
      const seen = new Set(rows.map(row => row.address));
      while (!recovery && rows.filter(inScope).length < Math.max(6, this.#enrichLimit) && pages < this.#maxTrendingPages &&
        Number.isInteger(pageResult.nextPage) && pageResult.nextPage > page && pageResult.nextPage <= 2) {
        page = pageResult.nextPage;
        try { pageResult = await this.trending(chain, { ...options, page }); }
        catch (error) {
          if (['AVE_CHANGED', 'AVE_ABORTED', 'AVE_DISABLED', 'AVE_CONFIG'].includes(error.code)) throw error;
          pageError = error; break;
        }
        pages++;
        const additional = pageResult.rows.filter(row => !seen.has(row.token));
        for (const row of additional) { seen.add(row.token); rows.push(marketRow(row, pageResult.capturedAt, this.#now())); }
        if (!additional.length) break;
      }
      // Retain a complete old observation as a whole, never mix old pool facts
      // with a fresh hot-list clock. Expired observations stay non-actionable.
      const previous = new Map((this.#discovery.get(chain)?.rows || []).map(row => [row.address, row]));
      const candidates = rows.map((row, index) => ({ row, index })).filter(({ row }) => inScope(row));
      for (const { row, index } of candidates) {
        const old = previous.get(row.address);
        const routeKey = chain + ':' + row.address, route = this.#routes.get(routeKey);
        if (route && route.until <= this.#now()) this.#routes.delete(routeKey);
        else if (route?.pairs?.length) rows[index] = { ...rows[index], pairs: clone(route.pairs) };
        if (old?.pairAddress && this.#now() - old.capturedAt <= ENRICHMENT_DEFER_MS) {
          rows[index] = { ...clone(old), stale: old.stale || this.#now() >= old.expiresAt };
        }
      }
      const eligible = candidates.filter(({ row }) => !(this.#enrichmentDeferrals.get(chain + ':' + row.address)?.until > this.#now()));
      const pauseAfterPage = pageError && ['AVE_RATE_LIMITED', 'AVE_AUTH', 'AVE_QUOTA', 'AVE_BUDGET',
        'AVE_HOURLY_BUDGET', 'AVE_TOTAL_BUDGET', 'AVE_BUDGET_STORE'].includes(pageError.code);
      const limit = pauseAfterPage || onlyHead ? 0 : Math.min(eligible.length, this.#enrichLimit, recovery ? 1 : this.#enrichLimit);
      const start = this.#cursors.get(chain) || 0, selected = [];
      // Finish a known route first, then rotate incomplete observations. This
      // removes repeated token-detail calls without promoting stale quotes.
      const missingFacts = eligible.filter(({ index }) => !discoveryFactsComplete(rows[index]));
      // Complete first-party trending facts need no per-token call. Legacy
      // pair-enriched rows still refresh once no genuinely incomplete row is
      // waiting, preserving route rotation without starving new candidates.
      const incomplete = missingFacts.length ? missingFacts : eligible.filter(({ index }) => rows[index].poolEvidence);
      const routed = incomplete.filter(({ index }) => Array.isArray(rows[index].pairs) && rows[index].pairs.length);
      if (routed.length && limit) selected.push(routed[start % routed.length]);
      let walked = 0;
      const pool = incomplete;
      while (selected.length < limit && walked < pool.length) {
        const candidate = pool[(start + walked++) % pool.length];
        if (!selected.includes(candidate)) selected.push(candidate);
      }
      const enrichment = { attempted: 0, enriched: 0, deferred: candidates.length - eligible.length,
        complete: true, pausedCode: pauseAfterPage ? pageError.code : null, pausedUntil: pauseAfterPage ? pageError.retryAt ?? null : null,
        errors: pageError ? [{ code: pageError.code, message: pageError.message }] : [] };
      // The existing token allowance remains the main bound. Permit only one
      // extra network read for fallback across the whole discovery round, so
      // a bad primary pool can be bypassed without multiplying a six-token
      // round into twelve serialized requests.
      const enrichmentReadLimit = limit ? Math.min(limit * MAX_PAIR_ATTEMPTS, limit + 1) : 0;
      let enrichmentReads = 0;
      for (const { row, index } of selected) {
        if (enrichmentReads >= enrichmentReadLimit) break;
        if (epoch !== this.keyEpoch) throw fail('CHANGED', 409);
        enrichment.attempted++;
        try {
          let detailRow = rows[index], pairs = Array.isArray(detailRow.pairs) ? detailRow.pairs : [];
          if (!pairs.length) {
            enrichmentReads++;
            const details = await this.details(chain, row.address, options);
            const protocols = new Map(details.pairs.map(pair => [pair.chain + ':' + pair.pair + ':' + pair.amm, pair]));
            pairs = [...protocols.values()];
            detailRow = { ...detailRow, pairs: clone(pairs) };
            rows[index] = detailRow;
            if (pairs.length) this.#rememberRoute(chain, row.address, pairs);
            // Resolve only one network stage per token in a discovery round.
            // The next round reuses this route and asks only for the pool.
            continue;
          }
          let lastError = null;
          const plan = this.#pairPlan(chain, row.address, pairs, Math.min(MAX_PAIR_ATTEMPTS, enrichmentReadLimit - enrichmentReads));
          for (const selectedPair of plan) {
            enrichmentReads++;
            try {
              const pair = await this.pairDetails(chain, selectedPair.pair.pair, options);
              const enriched = pairMarket(detailRow, pair, this.#now());
              if (enriched.pairAddress) {
                rows[index] = enriched; enrichment.enriched++;
                this.#finishPairAttempt(chain, row.address, selectedPair.index, true);
                lastError = null; break;
              }
              this.#finishPairAttempt(chain, row.address, selectedPair.index, false);
            } catch (error) {
              this.#finishPairAttempt(chain, row.address, selectedPair.index, false);
              lastError = error;
              if (!PAIR_FALLBACK_CODES.has(error.code)) throw error;
            }
          }
          if (!rows[index].pairAddress && lastError) throw lastError;
        } catch (error) {
          if (['AVE_CHANGED', 'AVE_ABORTED', 'AVE_DISABLED', 'AVE_CONFIG'].includes(error.code)) throw error;
          if (rows[index].pairAddress) rows[index] = { ...rows[index], stale: true };
          enrichment.complete = false;
          if (['AVE_DISCOVERY_RESERVE', 'AVE_HOURLY_BUDGET', 'AVE_TOTAL_BUDGET'].includes(error.code)) {
            enrichment.pausedCode = error.code; enrichment.pausedUntil = error.retryAt ?? null; break;
          }
          enrichment.errors.push({ address: row.address, code: error.code, message: error.message });
          if (error.code === 'AVE_RATE_LIMITED') { enrichment.pausedCode = error.code; enrichment.pausedUntil = error.retryAt; }
          if (['AVE_AUTH', 'AVE_QUOTA', 'AVE_BUDGET', 'AVE_RATE_LIMITED', 'AVE_BUDGET_STORE'].includes(error.code)) break;
        }
      }
      if (epoch !== this.keyEpoch) throw fail('CHANGED', 409);
      // A healthy connection is distinct from finishing all eligible market
      // enrichment: deferral, sampling limits, or an unbound pool stay partial.
      enrichment.complete = !enrichment.pausedCode && enrichment.errors.length === 0 && rows
        .filter(inScope).every(discoveryFactsComplete);
      if (!pauseAfterPage && !onlyHead) this.#cursors.set(chain, pool.length ? (start + Math.max(1, walked)) % pool.length : 0);
      if (this.#rotateTrendingPages) {
        let tail = rotation.tail >= 1 && rotation.tail <= 2 ? rotation.tail : 1;
        const seenReady = rotation.seenReady instanceof Set ? rotation.seenReady : new Set();
        // Decide the next paid page from the same safety screen used by the
        // visible AVE shortlist. Merely having many rows in the market-cap
        // band must not pin a chain to page zero when none can be shown.
        const ready = rows.filter(row => discoveryScreen(row, { ...config, chain }, this.#now() / 1000).pass);
        const novelReady = ready.filter(row => !seenReady.has(row.address));
        for (const row of ready) {
          // Refresh insertion order so the bounded set represents recent
          // actionable membership, not every address seen for the session.
          seenReady.delete(row.address); seenReady.add(row.address);
        }
        while (seenReady.size > ROTATION_SEEN_LIMIT) seenReady.delete(seenReady.values().next().value);
        let nextPage = 0;
        if (page === 0) {
          const hasTail = Number.isInteger(result.nextPage) && result.nextPage > 0;
          if (hasTail && novelReady.length < ROTATION_READY_TARGET) nextPage = tail;
        } else {
          tail = Number.isInteger(pageResult.nextPage) && pageResult.nextPage > page && pageResult.nextPage <= 2
            ? pageResult.nextPage : 1;
        }
        this.#trendingPages.set(chain, { page: nextPage, tail, seenReady });
      }
      const checkedAt = Math.max(result.capturedAt, pageResult.capturedAt, ...rows.map(row => row.capturedAt || 0));
      const health = { provider: 'AVE', complete: enrichment.errors.length === 0,
        trending: { ok: !pageError, count: rows.length, cacheHit: result.cacheHit && pageResult.cacheHit, capturedAt: Math.max(result.capturedAt, pageResult.capturedAt), code: pageError?.code },
        coverage: { pages, page, inRange: candidates.length, maxPages: this.#maxTrendingPages }, enrichment, checkedAt };
      // Recover the incomplete enrichment after cooldown instead of replaying
      // its old error for the full hot-list TTL. Trending keeps its own cache.
      const until = enrichment.pausedCode === 'AVE_RATE_LIMITED' ? Math.min(this.#now() + this.#enrichmentTtl, enrichment.pausedUntil) : this.#now() + this.#enrichmentTtl;
      this.lastDiscoveryHealth = health; this.#discovery.set(chain, { until, rows: clone(rows), health: clone(health) });
      return rows;
    } catch (error) {
      if (epoch === this.keyEpoch) this.lastDiscoveryHealth = { provider: 'AVE', complete: false, trending: { ok: false, code: error.code, message: error.message }, checkedAt: this.#now() };
      throw error;
    }
  }
  async discover(chain = 'robinhood', options = {}) {
    input(chain); const credential = this.#credential(), epoch = this.keyEpoch;
    this.#alive({ epoch, fingerprint: credential.fp, controller: new AbortController() });
    if (options.signal?.aborted) throw fail('ABORTED', 499);
    validBudget(this.#budget, this.#now());
    const cached = this.#discovery.get(chain);
    if (cached && cached.until > this.#now()) {
      this.lastDiscoveryHealth = clone(cached.health); this.metrics.cacheHits++; this.metrics.discoveryCacheHits++;
      return clone(cached.rows).map(row => ({ ...row, stale: row.stale || row.expiresAt === null || this.#now() >= row.expiresAt }));
    }
    // Discovery enrichment is single-flight too, so scanner + live view never
    // rotate or charge the same six candidates twice in one refresh.
    let job = this.#discoveryPending.get(chain);
    if (!job) {
      job = { controller: new AbortController(), subscribers: 0, done: false };
      job.promise = this.#discover(chain, { ...options, signal: job.controller.signal }, epoch); this.#discoveryPending.set(chain, job);
      const done = () => { job.done = true; if (this.#discoveryPending.get(chain) === job) this.#discoveryPending.delete(chain); };
      job.promise.then(done, done);
    }
    return this.#subscribe(job, options.signal);
  }
  async live(chain = 'robinhood', { refresh = true, ...options } = {}) {
    if (refresh === false) {
      input(chain);
      if (options.signal?.aborted) throw fail('ABORTED', 499);
      const cached = this.#discovery.get(chain), at = this.#now();
      const tokens = cached ? clone(cached.rows).map(row => ({ ...row, stale: row.stale || !Number.isFinite(row.expiresAt) || at >= row.expiresAt })) : [];
      // Scanner owns refresh. A passive UI must neither consume CU nor
      // replace another chain's discovery health or any source timestamps.
      return { tokens, capturedAt: cached?.health?.checkedAt ?? null, interval: null, coverage: 'trending_sample' };
    }
    const rows = await this.discover(chain, options);
    return { tokens: rows, capturedAt: this.lastDiscoveryHealth?.checkedAt ?? null, interval: null, coverage: 'trending_sample' };
  }
  async audit(ca, nowSec = Math.floor(this.#now() / 1000), chain = 'robinhood', { shouldStopEarly, signal } = {}) {
    input(chain, ca); this.#credential(); const epoch = this.keyEpoch;
    const requested = new Set(['info']);
    const unknown = () => ({ ok: false, state: 'unverified', code: 'AVE_FIELD_UNVERIFIED', message: 'AVE 已核实只读接口未提供该审核证据' });
    const endpoints = { info: unknown(), security: unknown(), pool: unknown(), holders: unknown(), traders: unknown(), candles: unknown() };
    let details = null, firstError = null;
    try { details = await this.details(chain, ca, { signal }); endpoints.info = { ok: true, state: 'ok', capturedAt: details.capturedAt, sourceUpdatedAt: details.token.sourceUpdatedAt }; }
    catch (error) { firstError = error; endpoints.info = { ok: false, state: 'error', code: error.code, message: error.message }; }
    const partial = { info: details ? { ...marketRow(details.token, details.capturedAt, this.#now()), pairs: clone(details.pairs) } : {}, security: {}, pool: {}, pairs: details?.pairs || [], holders: [], traders: [], candles: [],
      _meta: { provider: 'AVE', complete: false, marketComplete: false, endpoints, capturedAt: details?.capturedAt ?? null, auditedAt: null } };
    if (signal?.aborted) throw fail('ABORTED', 499);
    if (epoch !== this.keyEpoch) throw fail('CHANGED', 409);
    if (firstError && ['AVE_AUTH', 'AVE_QUOTA', 'AVE_BUDGET', 'AVE_HOURLY_BUDGET', 'AVE_TOTAL_BUDGET', 'AVE_DISCOVERY_RESERVE', 'AVE_RATE_LIMITED', 'AVE_CHANGED', 'AVE_ABORTED', 'AVE_DISABLED', 'AVE_BUDGET_STORE'].includes(firstError.code)) throw firstError;
    if (shouldStopEarly?.(partial)) { partial._meta.earlyExit = true; return auditMeta(partial, requested, this.#now()); }
    if (details?.pairs.length) {
      requested.add('pool');
      this.#rememberRoute(chain, ca, details.pairs);
      let lastError = null, lastUnbound = null;
      for (const selectedPair of this.#pairPlan(chain, ca, details.pairs)) {
        try {
          const pair = await this.pairDetails(chain, selectedPair.pair.pair, { signal });
          const enriched = pairMarket(partial.info, pair, this.#now());
          if (enriched.pairAddress) {
            partial.info = enriched; partial.pool = { liquidity: enriched.liquidity, pairAddress: enriched.pairAddress, capturedAt: enriched.capturedAt, sourceUpdatedAt: enriched.sourceUpdatedAt };
            endpoints.pool = { ok: true, state: 'ok', capturedAt: enriched.capturedAt, sourceUpdatedAt: enriched.sourceUpdatedAt };
            this.#finishPairAttempt(chain, ca, selectedPair.index, true);
            lastError = null; lastUnbound = null; break;
          }
          lastUnbound = pair; this.#finishPairAttempt(chain, ca, selectedPair.index, false);
        } catch (error) {
          this.#finishPairAttempt(chain, ca, selectedPair.index, false); lastError = error;
          if (!PAIR_FALLBACK_CODES.has(error.code)) break;
        }
      }
      if (endpoints.pool.state !== 'ok') {
        if (lastUnbound) endpoints.pool = { ok: true, state: 'unverified', bound: false, code: 'AVE_POOL_TARGET_UNVERIFIED', capturedAt: lastUnbound.capturedAt };
        else if (lastError) {
          if (['AVE_CHANGED', 'AVE_ABORTED', 'AVE_DISABLED', 'AVE_CONFIG', 'AVE_HOURLY_BUDGET', 'AVE_TOTAL_BUDGET', 'AVE_DISCOVERY_RESERVE'].includes(lastError.code)) throw lastError;
          endpoints.pool = { ok: false, state: 'error', code: lastError.code, message: lastError.message };
        }
      }
    }
    let klines;
    requested.add('candles');
    try { klines = await this.tokenKlines(chain, ca, { signal }); endpoints.candles = { ok: true, state: 'ok', capturedAt: klines.capturedAt, sourceUpdatedAt: klines.sourceUpdatedAt }; }
    catch (error) { if (!details) throw firstError || error; if (['AVE_DISCOVERY_RESERVE', 'AVE_HOURLY_BUDGET', 'AVE_TOTAL_BUDGET'].includes(error.code)) throw error; endpoints.candles = { ok: false, state: 'error', code: error.code, message: error.message }; }
    if (signal?.aborted) throw fail('ABORTED', 499);
    if (epoch !== this.keyEpoch) throw fail('CHANGED', 409);
    partial.candles = klines?.list || [];
    // Fetching market data never refreshes the audit clock or creates a security pass.
    return auditMeta(partial, requested, this.#now());
  }
  async priceAt(ca, targetAt, chain = 'robinhood', options = {}) {
    if (!Number.isFinite(targetAt) || targetAt <= 0 || targetAt > this.#now()) return null;
    const end = Math.min(Math.floor(this.#now() / 60000) * 60000, Math.ceil(targetAt / 60000) * 60000 + 60000);
    const result = await this.tokenKlines(chain, ca, { ...options, range: { from: end - 180000, to: end } });
    const nearest = result.list.map(row => ({ at: row.time + 60000, price: row.close, source: 'AVE_1M_CLOSE', capturedAt: result.capturedAt })).filter(row => Math.abs(row.at - targetAt) <= 60000).sort((a, b) => Math.abs(a.at - targetAt) - Math.abs(b.at - targetAt))[0];
    return nearest || null;
  }
  snapshot() {
    const at = this.#now();
    // Cache-only reads may cross UTC midnight without touching the ledger.
    // Project today's usage for display; never rewrite/refund persisted usage.
    const today = day(at), budget = this.#budget && this.#budget.day <= today ? {
      ...clone(this.#budget), day: today, dailyUsed: this.#budget.day === today ? this.#budget.dailyUsed : 0,
      hourStartedAt: hourStart(at), hourlyUsed: this.#budget.hourStartedAt === hourStart(at) ? this.#budget.hourlyUsed : 0
    } : null;
    if (budget) this.#syncPauses(budget);
    const manualResetRequired = !!budget && budget.totalUsed + 5 > this.totalBudgetCu;
    const pauseCode = manualResetRequired ? 'AVE_TOTAL_BUDGET' : budget?.quotaUntil > at ? 'AVE_QUOTA' : budget?.blockedUntil > at ? 'AVE_RATE_LIMITED' :
      this.#budgetPauseUntil > at ? 'AVE_BUDGET' : this.#hourPauseUntil > at ? 'AVE_HOURLY_BUDGET' : null;
    return { provider: 'AVE', readonly: true, dailyLimit: this.dailyBudgetCu, totalLimit: this.totalBudgetCu, hourlyLimit: this.hourlyBudgetCu,
      nextAllowedAt: this.nextAllowedAt, pauseCode, manualResetRequired, pending: this.#pending.size,
      recovery: { active: recovering(budget?.rateControl), headOnly: headOnly(budget?.rateControl), auditAllowed: !recovering(budget?.rateControl) },
      transport: { spacingMs: spacing(budget?.rateControl), strikes: budget?.rateControl?.strikes || 0,
        last429At: budget?.rateControl?.last429At || 0, active: this.#lane.active, recent: clone(this.#diagnostics) },
      discoveryReserveCu: this.discoveryReserveCu, nonTrendingPausedUntil: this.#nonTrendingPauseUntil > at ? this.#nonTrendingPauseUntil : 0,
      metrics: clone(this.metrics), budget: budget ? { ...budget, used: budget.dailyUsed, remaining: Math.max(0, this.dailyBudgetCu - budget.dailyUsed),
        totalRemaining: Math.max(0, this.totalBudgetCu - budget.totalUsed), hourlyRemaining: Math.max(0, this.hourlyBudgetCu - budget.hourlyUsed), hourlyResetAt: nextHour(at),
        hourUsed: budget.hourlyUsed, hourRemaining: Math.max(0, this.hourlyBudgetCu - budget.hourlyUsed),
        // Completeness refers only to local accounting since periodStartedAt,
        // never to the provider account, quota balance, or a billing period.
        historyComplete: !budget.legacyUsageIncluded,
        nonTrendingRemaining: Math.max(0, this.dailyBudgetCu - this.discoveryReserveCu - budget.dailyUsed), basis: 'local_estimated_cu' } : null,
      chains: Object.fromEntries(Object.keys(AVE_CHAINS).map(chain => [chain, { apiChain: AVE_CHAINS[chain], documented: DOCUMENTED.has(chain), state: this.#observed.has(chain) ? 'observed' : 'unverified' }])) };
  }
}
