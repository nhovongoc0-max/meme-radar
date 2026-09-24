// A contract remains deduplicated for the full seven-day discovery window.
// Quote refreshes, page rotation and interrupted playback must never make the
// same contract sound like a newly discovered coin again.
export const VOICE_TTL = 7 * 24 * 60 * 60_000;
export const voiceKey = row => `${row.chain}:${row.chain === 'sol' ? row.address : row.address.toLowerCase()}`;
export function voiceEligible(row, now) {
  const statusReady = row?.source === 'live' ? row.status === 'LIVE_READY' : row?.status === 'X_REVIEW';
  return typeof row?.address === 'string' && typeof row?.chain === 'string'
    && row.qualified === true && statusReady
    && Number.isFinite(row.auditedAt) && row.auditedAt > 0 && row.auditedAt <= now
    && now - row.auditedAt <= 10 * 60_000 && row.staleAt > now;
}

// Snapshot eligibility is independent of UI sorting, manual approvals and feed
// arrivals. A waiting token can be promoted, but baseline candidates stay quiet.
export class VoiceAlerts {
  constructor() { this.reset(); }
  reset(now = Date.now()) {
    this.startedAt = now; this.chains = new Set(); this.quiet = new Map(); this.pending = new Map();
  }
  ingest(snapshot, now = Date.now(), ignored = () => false) {
    const current = new Map();
    for (const [chain, rows] of Object.entries(snapshot?.chains || {})) {
      if (!Array.isArray(rows)) continue;
      const first = !this.chains.has(chain);
      for (const row of rows) {
        if (row?.chain !== chain || !voiceEligible(row, now) || ignored(row)) continue;
        const key = voiceKey(row);
        current.set(key, row);
        if (first || row.auditedAt < this.startedAt) this.quiet.set(key, now);
        if (this.quiet.has(key)) this.quiet.set(key, now); // A continuously qualified row is not new after seven days.
        if (!this.quiet.has(key)) this.pending.set(key, row);
      }
      this.chains.add(chain);
    }
    for (const [key, at] of this.quiet) if (now - at >= VOICE_TTL) this.quiet.delete(key);
    for (const key of this.pending.keys()) if (!current.has(key)) this.pending.delete(key);
    // Scanning chains can be disabled then enabled. Re-enable establishes a new baseline.
    for (const chain of this.chains) if (!Object.hasOwn(snapshot?.chains || {}, chain)) this.chains.delete(chain);
  }
  batch(notified = {}, now = Date.now(), ignored = () => false) {
    for (const row of this.pending.values()) {
      const key = voiceKey(row);
      if (Number.isFinite(notified[key]) && now - notified[key] < VOICE_TTL) {
        this.quiet.set(key, now); this.pending.delete(key);
      }
    }
    return [...this.pending.values()].filter(row => voiceEligible(row, now) && !ignored(row)
      && !(Number.isFinite(notified[voiceKey(row)]) && now - notified[voiceKey(row)] < VOICE_TTL));
  }
  acknowledge(rows, now = Date.now()) {
    for (const row of rows) { this.pending.delete(voiceKey(row)); this.quiet.set(voiceKey(row), now); }
  }
}
