import { normalizePoolAddress, validTokenAddress } from './address.mjs';

export const LIVE_LEAD_RETENTION_MS = 30 * 60_000;

const number = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const count = value => {
  const parsed = number(value);
  return parsed !== null && parsed >= 0 && Number.isInteger(parsed) ? parsed : null;
};
const text = (value, maximum) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maximum);
const safeText = (value, maximum) => /gmgn_[a-z0-9]{8,}|bearer\s|api[_ -]?key|private[_ -]?key|passphrase|secret/i.test(String(value))
  ? '?' : text(value, maximum);
const identity = (chain, address) => chain === 'sol' ? address : address.toLowerCase();
const clock = value => {
  const parsed = number(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};
const safeUrl = value => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password ? url.href.slice(0, 500) : '';
  } catch {
    return '';
  }
};

// A live lead is a durable display receipt for a token that passed a real,
// fresh discovery screen. It deliberately preserves the original evidence
// clocks: retaining a card must never make an old quote look fresh or make it
// eligible for speech/audit again.
export function sanitizeLiveLead(source, fallbackChain = '') {
  if (!source || typeof source !== 'object') return null;
  const chain = text(source.chain || fallbackChain, 24).toLowerCase();
  const address = text(source.address, 80);
  if (!chain || !validTokenAddress(chain, address) || source.marketProvider !== 'AVE') return null;
  const qualifiedAt = clock(source.qualifiedAt ?? source.firstSeenAt ?? source.newAt);
  const lastConfirmedAt = clock(source.lastConfirmedAt ?? source.qualifiedAt);
  const displayUntil = clock(source.displayUntil);
  if (!qualifiedAt || !lastConfirmedAt || !displayUntil || displayUntil <= lastConfirmedAt
    || displayUntil - lastConfirmedAt > 60 * 60_000) return null;
  return {
    chain,
    address: identity(chain, address),
    marketProvider: 'AVE',
    symbol: safeText(source.symbol || '?', 30),
    name: safeText(source.name, 80),
    marketCap: number(source.marketCap),
    liquidity: number(source.liquidity),
    price: number(source.price),
    createdAt: number(source.createdAt),
    ageBasis: ['pool', 'trade', 'launch', 'token'].includes(source.ageBasis) ? source.ageBasis : 'unknown',
    capturedAt: clock(source.capturedAt),
    sourceUpdatedAt: clock(source.sourceUpdatedAt),
    expiresAt: clock(source.expiresAt),
    poolCreatedAt: clock(source.poolCreatedAt),
    firstTradeAt: clock(source.firstTradeAt),
    volume5m: number(source.volume5m),
    buys5m: count(source.buys5m),
    sells5m: count(source.sells5m),
    holders: count(source.holders),
    pairAddress: normalizePoolAddress(chain, text(source.pairAddress, 80)) || '',
    website: safeUrl(source.website),
    twitter: /^[A-Za-z0-9_]{1,15}$/.test(String(source.twitter || '')) ? String(source.twitter) : '',
    priorityBand: source.priorityBand === true,
    discoveryScore: number(source.discoveryScore),
    firstSeenAt: clock(source.firstSeenAt) || qualifiedAt,
    newAt: clock(source.newAt) || qualifiedAt,
    qualifiedAt,
    lastConfirmedAt,
    displayUntil,
    displayEligible: true
  };
}

export function reconcileLiveLeads(previous, observations, {
  chain,
  confirmedAt,
  retentionMs = LIVE_LEAD_RETENTION_MS
} = {}) {
  const at = clock(confirmedAt);
  const duration = Number.isFinite(Number(retentionMs))
    ? Math.max(5 * 60_000, Math.min(60 * 60_000, Number(retentionMs)))
    : LIVE_LEAD_RETENTION_MS;
  if (!at || !chain) return [];
  const byAddress = new Map();
  for (const source of Array.isArray(previous) ? previous : []) {
    const lead = sanitizeLiveLead(source, chain);
    if (lead && lead.chain === chain && lead.displayUntil > at) byAddress.set(identity(chain, lead.address), lead);
  }
  for (const observation of Array.isArray(observations) ? observations : []) {
    const address = text(observation?.address || observation?.lead?.address, 80);
    if (!validTokenAddress(chain, address)) continue;
    const key = identity(chain, address);
    // Seeing a token fail the current screen, or receiving a hard-risk veto,
    // is an explicit elimination. Merely missing from a rotated page is not.
    if (observation.eligible !== true || observation.hardRejected === true) {
      byAddress.delete(key);
      continue;
    }
    const old = byAddress.get(key);
    const source = observation.lead || observation;
    const qualifiedAt = old?.qualifiedAt || clock(source.qualifiedAt ?? source.firstSeenAt ?? source.newAt) || at;
    const lead = sanitizeLiveLead({
      ...source,
      chain,
      address,
      qualifiedAt,
      firstSeenAt: old?.firstSeenAt || clock(source.firstSeenAt) || qualifiedAt,
      newAt: old?.newAt || clock(source.newAt) || qualifiedAt,
      lastConfirmedAt: at,
      displayUntil: at + duration
    }, chain);
    if (lead) byAddress.set(key, lead);
  }
  return [...byAddress.values()]
    .filter(lead => lead.displayUntil > at)
    .sort((a, b) => b.lastConfirmedAt - a.lastConfirmedAt || Number(b.priorityBand) - Number(a.priorityBand)
      || (b.volume5m || 0) - (a.volume5m || 0))
    .slice(0, 200);
}

export function activeLiveLeads(source, chain, now = Date.now()) {
  return (Array.isArray(source) ? source : []).flatMap(row => {
    const lead = sanitizeLiveLead(row, chain);
    return lead && lead.chain === chain && lead.displayUntil > now ? [lead] : [];
  });
}
