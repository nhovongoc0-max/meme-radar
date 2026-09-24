import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, readJsonWithBackup } from './local-store.mjs';

function cleanCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const { rawDiscovery: _rawDiscovery, ...clean } = candidate;
  return clean;
}

function defaultState() {
  return {
    version: 2,
    status: 'STARTING',
    generatedAt: 0,
    lastAttemptAt: 0,
    lastSuccessAt: 0,
    nextCycleAt: 0,
    cycleStartedAt: 0,
    scanInProgress: false,
    activeChain: 'robinhood',
    pendingChain: '',
    supportedChains: ['sol', 'bsc', 'base', 'eth', 'robinhood'],
    chainStates: {},
    riskExclusions: {},
    scanCount: 0,
    discoveredCount: 0,
    prequalifiedCount: 0,
    candidates: [],
    rejected: [],
    auditQueue: [],
    auditQueueStats: { total: 0, due: 0, neverAudited: 0, waitingRecheck: 0 },
    outcomes: [],
    outcomeSummary: {
      minimumSample: 50, calibrationReady: false,
      tracked: 0, completed5m: 0, completed15m: 0, completed30m: 0,
      completed1h: 0, completed2h: 0, completed6h: 0, completed24h: 0
    },
    sourceHealth: {},
    events: []
  };
}

function migrateState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    version: 2,
    scanInProgress: false,
    candidates: Array.isArray(raw.candidates) ? raw.candidates.map(cleanCandidate) : [],
    rejected: Array.isArray(raw.rejected) ? raw.rejected : [],
    auditQueue: Array.isArray(raw.auditQueue) ? raw.auditQueue : [],
    outcomes: Array.isArray(raw.outcomes) ? raw.outcomes : [],
    events: Array.isArray(raw.events) ? raw.events : []
  };
}

export class RadarState {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'radar.json');
    this.value = this.load();
  }

  load() {
    const loaded = readJsonWithBackup(this.file, defaultState());
    const value = migrateState(loaded.value);
    if (loaded.recovered) value.events.unshift({ at: Date.now(), type: 'STATE_RECOVERED', message: '主状态文件异常，已从本机备份恢复' });
    return value;
  }

  save(next = this.value) {
    this.value = next;
    atomicJson(this.file, next);
  }

  event(type, message, data = {}) {
    const events = this.value.events || [];
    events.unshift({ at: Date.now(), type, message, ...data });
    this.value.events = events.slice(0, 500);
  }
}
