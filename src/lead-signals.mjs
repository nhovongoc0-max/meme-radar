import { normalizePoolAddress } from './address.mjs';

// Observation heuristics, not a safety verdict or a backtested trading signal.
// Consume existing quotes only: no timers, transport, credentials or disk state.
const MINUTE = 60_000, WINDOW = 20 * MINUTE, SPAN = 5 * MINUTE;
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
const identity = row => `${row.chain}:${row.chain === 'sol' ? row.address : row.address.toLowerCase()}`;
const fresh = (row, now) => row?.marketProvider === 'AVE' && row.auditEligible === true
  && row.discoveryState === 'READY' && row.stale === false && row.retainedSnapshot !== true
  && positive(row.sourceUpdatedAt) && row.sourceUpdatedAt <= row.capturedAt && row.capturedAt <= now
  && now - row.sourceUpdatedAt <= MINUTE && row.expiresAt > now;
const activeVolume = row => positive(row.volume5m) && positive(row.liquidity)
  && row.volume5m >= Math.max(1000, row.liquidity * .05);
const newLead = (row, now) => positive(row.qualifiedAt) && row.qualifiedAt <= now && now - row.qualifiedAt < 2 * MINUTE;
const empty = () => ({ reasonCodes: [], momentum: null });

// Whitelist projection shared by live snapshots and the HTTP/voice boundary.
export function publicLeadSignal(row, now = Date.now()) {
  if (!fresh(row, now)) return empty();
  const codes = new Set(['ACTIVE_VOLUME', 'LIQUIDITY_RISING', 'NEW_LEAD']);
  const reasonCodes = [...new Set((Array.isArray(row.reasonCodes) ? row.reasonCodes : [])
    .filter(code => codes.has(code) && (code !== 'NEW_LEAD' || newLead(row, now))))].slice(0, 2);
  const m = row.momentum;
  const valid = ['ACTIVE', 'COOLING'].includes(m?.state) && positive(m.eventAt) && m.eventAt <= now
    && positive(m.evidenceAt) && m.evidenceAt === row.sourceUpdatedAt
    && Number.isInteger(m.samples) && m.samples >= 1 && m.samples <= 21
    && Number.isFinite(m.spanMs) && m.spanMs >= 0 && m.spanMs <= WINDOW;
  const validActive = m?.state !== 'ACTIVE' || m.samples >= 3 && m.spanMs >= SPAN;
  return { reasonCodes, momentum: valid && validActive ? {
    state: m.state, eventAt: m.eventAt, evidenceAt: m.evidenceAt, samples: m.samples, spanMs: m.spanMs
  } : null };
}

export class LeadSignals {
  constructor() { this.history = new Map(); }
  reset() { this.history.clear(); }
  observe(input, rows, chain, now) {
    for (const [key, item] of this.history) if (now - item.seenAt > WINDOW) this.history.delete(key);
    const eligible = new Set(rows.filter(row => fresh(row, now)).map(identity));
    // A known failure revokes all providers/pools for that token. A rotated
    // page is merely absence, not positive evidence and not a renewed clock.
    const failed = new Set(input.filter(row => row && typeof row.address === 'string' && row.chain === chain
      && positive(row.sourceUpdatedAt) && row.sourceUpdatedAt <= row.capturedAt && row.capturedAt <= now
      && now - row.sourceUpdatedAt <= MINUTE && row.expiresAt > now)
      .map(identity).filter(key => !eligible.has(key)));
    for (const [key, item] of this.history) if (failed.has(item.token)) this.history.delete(key);
    return rows.map(row => this.observeRow(row, now));
  }
  observeRow(row, now) {
    if (!fresh(row, now)) return { ...row, ...empty() };
    let rising = false, momentum = null;
    const pool = normalizePoolAddress(row.chain, row.pairAddress);
    if (pool && ['AVE', 'DEXSCREENER'].includes(row.observationProvider) && positive(row.price)
      && positive(row.liquidity) && positive(row.volume5m)) {
      // Each provider/pool has its own timeline. Alternating AVE/DEX reads
      // cannot be counted as changes between unrelated sources or pools.
      const token = identity(row), key = `${token}:${row.observationProvider}:${pool}`;
      let item = this.history.get(key);
      if (!item) item = { token, seenAt: now, points: [], state: 'WATCH', eventAt: 0, cooldown: 0 };
      item.seenAt = now;
      item.points = item.points.filter(p => row.sourceUpdatedAt - p.at <= WINDOW);
      const previous = item.points.at(-1);
      if (previous && row.sourceUpdatedAt < previous.at) return { ...row, ...empty() };
      const changed = !previous || [row.price, row.liquidity, row.volume5m, row.buys5m, row.sells5m]
        .some((value, i) => value !== previous.values[i]);
      if (previous && row.sourceUpdatedAt === previous.at && changed) {
        this.history.delete(key); return { ...row, ...empty() };
      }
      if (item.state === 'COOLING' && now - item.eventAt > WINDOW) item.state = 'WATCH';
      const drop = previous && row.sourceUpdatedAt > previous.at
        && (row.liquidity <= previous.liquidity * .8 || row.price <= previous.price * .85);
      // Neither a repeated timestamp nor an unchanged payload is a new sample.
      if (changed && (drop || !previous || row.sourceUpdatedAt - previous.at >= MINUTE)) {
        if (drop) {
          item.points = []; item.state = 'COOLING'; item.eventAt = now; item.cooldown = now + SPAN;
        }
        item.points.push({ at: row.sourceUpdatedAt, price: row.price, liquidity: row.liquidity,
          volume: row.volume5m, active: activeVolume(row), values: [row.price, row.liquidity, row.volume5m, row.buys5m, row.sells5m] });
        item.points = item.points.slice(-21);
      }
      const first = item.points[0], last = item.points.at(-1);
      const spanMs = first && last ? last.at - first.at : 0;
      const enough = item.points.length >= 3 && spanMs >= SPAN;
      const steady = enough && item.points.every(p => p.active && p.liquidity >= first.liquidity * .9)
        && row.liquidity >= first.liquidity * .95 && row.price >= first.price
        && (row.price >= first.price * 1.03 || row.volume5m >= first.volume * 1.25);
      if (steady && now >= item.cooldown) {
        if (item.state !== 'ACTIVE') item.eventAt = now;
        item.state = 'ACTIVE';
      } else if (item.state === 'ACTIVE') item.state = 'WATCH';
      rising = enough && row.liquidity >= first.liquidity * 1.1;
      if (item.state !== 'WATCH') momentum = { state: item.state, eventAt: item.eventAt,
        evidenceAt: row.sourceUpdatedAt, samples: item.points.length, spanMs };
      if (!this.history.has(key) && this.history.size >= 1500) this.history.delete(this.history.keys().next().value);
      this.history.set(key, item);
    }
    const reasonCodes = [rising && 'LIQUIDITY_RISING', activeVolume(row) && 'ACTIVE_VOLUME', newLead(row, now) && 'NEW_LEAD'].filter(Boolean).slice(0, 2);
    return { ...row, ...publicLeadSignal({ ...row, reasonCodes, momentum }, now) };
  }
}
