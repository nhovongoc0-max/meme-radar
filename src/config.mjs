import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export const config = Object.freeze({
  chain: 'robinhood',
  // Only expose chains with either published AVE support or a successful
  // production observation. Arc/Stable were speculative slugs with no local
  // success history or secondary safety coverage, so advertising them as
  // usable made an empty tab look like a healthy chain.
  supportedChains: Object.freeze(['sol', 'bsc', 'base', 'eth', 'robinhood']),
  port: boundedInteger(process.env.RADAR_PORT, 3791, 1024, 65_535),
  scanIntervalMs: boundedInteger(process.env.SCAN_INTERVAL_MS, 300_000, 30_000, 30 * 60_000),
  // The public fast-feed build performs one hot-list request per turn. Deep
  // token reads are opt-in because a second endpoint can have a stricter
  // provider rate bucket and must never stall the primary discovery lane.
  maxDeepAuditsPerCycle: boundedInteger(process.env.MAX_DEEP_AUDITS_PER_CYCLE, 0, 0, 12),
  auditCycleBudgetMs: 80_000,
  // Historical K-line backfills are optional; live observations still track outcomes.
  outcomeReadsPerCycle: 0,
  xReviewMode: 'manual',
  minAgeSec: 5 * 60,
  maxAgeSec: 7 * 86400,
  discoveryMinMarketCap: 10_000,
  discoveryMaxMarketCap: 150_000,
  priorityMinMarketCap: 20_000,
  priorityMaxMarketCap: 80_000,
  minLiquidity: 3_000,
  strictLiquidity: 8_000,
  // Fast alerts should favor current activity. These are dynamic opportunity
  // gates, not permanent contract-risk exclusions.
  matureMarketAgeSec: 60 * 60,
  oldMarketAgeSec: 6 * 60 * 60,
  minMatureVolume5mUsd: 100,
  minOldVolume5mUsd: 250,
  minMatureTurnover5m: 0.005,
  minOldTurnover5m: 0.01,
  maxCollapsedAthRatio: 0.10,
  strongRebound1h: 0.20,
  maxRugRatio: 0.20,
  maxTop10Rate: 0.30,
  maxInsiderRate: 0.15,
  maxBundlerRate: 0.15,
  maxSniperHoldRate: 0.08,
  maxBotHoldRate: 0.20,
  maxLinkedHoldRate: 0.10,
  maxBuyTax: 0.05,
  maxSellTax: 0.05,
  maxTaxAsymmetry: 0.02,
  minLpLockedRate: 0.80,
  minOrdinaryWallets: 8,
  dynamicRecheckMs: 2 * 60_000,
  chainPassRecheckMs: 5 * 60_000,
  hardRejectRecheckMs: 6 * 60 * 60_000,
  queueRetentionMs: 24 * 60 * 60_000,
  candidateRetentionMs: 2 * 60 * 60_000,
  staleCandidateMs: 10 * 60_000,
  outcomeRetentionMs: 7 * 24 * 60 * 60_000,
  stateDir: path.join(ROOT, 'state'),
  publicDir: path.join(ROOT, 'public')
});
