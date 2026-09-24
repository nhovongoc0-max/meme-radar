import { validTokenAddress } from './address.mjs';

const EVM_POOL = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SOL_POOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const clean = value => typeof value === 'string' ? value.trim() : '';
const normalized = (value, chain) => chain === 'sol' ? clean(value) : clean(value).toLowerCase();
const poolAddress = (value, chain) => {
  const address = clean(value);
  return (chain === 'sol' ? SOL_POOL : EVM_POOL).test(address) ? normalized(address, chain) : '';
};
const tokenAddress = (value, chain) => validTokenAddress(chain, clean(value)) ? normalized(value, chain) : '';
const finite = value => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const nonnegative = value => {
  const parsed = finite(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
};
const seconds = value => {
  const parsed = finite(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const freshClock = (capturedAt, sourceUpdatedAt, expiresAt, now) => {
  capturedAt = finite(capturedAt); sourceUpdatedAt = finite(sourceUpdatedAt); expiresAt = finite(expiresAt);
  return capturedAt > 0 && sourceUpdatedAt > 0 && expiresAt > now && sourceUpdatedAt <= capturedAt
    && capturedAt <= now && now - sourceUpdatedAt <= 60_000;
};

export function verifiedAvePoolEvidence(row, chain, { requireRowPair = false } = {}) {
  const pool = row?.poolEvidence;
  const token = tokenAddress(row?.address, chain);
  if (!token || !pool || pool.source !== 'AVE' || pool.identityBasis !== 'response' || pool.chain !== chain) return null;
  const pair = poolAddress(pool.pair, chain), target = tokenAddress(pool.target_token, chain);
  const token0 = tokenAddress(pool.token0_address, chain), token1 = tokenAddress(pool.token1_address, chain);
  if (!pair || !target || target !== token || !token0 || !token1 || token0 === token1 || token !== token0 && token !== token1) return null;
  const rowPair = poolAddress(row?.pairAddress, chain);
  if (requireRowPair && rowPair !== pair) return null;
  return { pool, pair, token, token0, token1, rowPair };
}

export function verifiedPoolMarket(row, chain, now = Date.now()) {
  if (row?.marketOverlayProvider === 'DEXSCREENER') {
    const pair = poolAddress(row.pairAddress, chain), token = tokenAddress(row.address, chain);
    const liquidity = nonnegative(row.liquidity), volume5m = nonnegative(row.volume_5m), createdAt = seconds(row.pool_created_at);
    if (!token || row.chain !== chain || !pair || liquidity === null || volume5m === null || createdAt === null
      || !freshClock(row.capturedAt, row.sourceUpdatedAt, row.expiresAt, now)) return null;
    return { source: 'DEXSCREENER', pair, liquidity, volume5m, poolCreatedAt: createdAt };
  }
  const identity = verifiedAvePoolEvidence(row, chain, { requireRowPair: true });
  if (!identity || !freshClock(identity.pool.capturedAt, identity.pool.sourceUpdatedAt, identity.pool.expiresAt, now)) return null;
  const liquidity = nonnegative(identity.pool.tvl), volume5m = nonnegative(identity.pool.volume_u_5m);
  const poolCreatedAt = seconds(identity.pool.created_at), firstTradeAt = seconds(identity.pool.first_trade_at);
  if (liquidity === null || volume5m === null || poolCreatedAt === null && firstTradeAt === null) return null;
  return { source: 'AVE', pair: identity.pair, liquidity, volume5m, poolCreatedAt, firstTradeAt, evidence: identity.pool };
}
