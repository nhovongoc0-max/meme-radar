import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.mjs';
import { Scanner } from '../src/scanner.mjs';

function stateFixture({ activeChain, activeAttemptAt, otherChain, otherAttemptAt }) {
  const scope = attemptAt => ({
    candidates: [], rejected: [], auditQueue: [], outcomes: [], sourceHealth: {},
    lastAttemptAt: attemptAt
  });
  return {
    value: {
      activeChain,
      ...scope(activeAttemptAt),
      events: [], riskExclusions: {},
      chainStates: { [otherChain]: scope(otherAttemptAt) }
    },
    save(next = this.value) { this.value = structuredClone(next); }
  };
}

function schedulerProvider(recoveryActive, headOnly = recoveryActive) {
  return {
    nextAllowedAt: 0,
    snapshot: () => ({
      recovery: { active: recoveryActive, headOnly },
      chains: {
        bsc: { documented: true },
        robinhood: { documented: false }
      }
    })
  };
}

async function startOnce({ recoveryActive, headOnly = recoveryActive, activeChain, activeAttemptAt, otherChain, otherAttemptAt }) {
  const state = stateFixture({ activeChain, activeAttemptAt, otherChain, otherAttemptAt });
  const controls = { value: { enabledChains: ['bsc', 'robinhood'] } };
  const scanner = new Scanner({
    provider: schedulerProvider(recoveryActive, headOnly),
    state,
    controls,
    settings: { ...config, chain: activeChain, scanIntervalMs: 3_600_000 }
  });
  const visits = [];
  scanner.cycle = async () => { visits.push(scanner.activeChain); };
  await scanner.start();
  scanner.stop();
  return { scanner, visits };
}

test('Scanner.start prefers documented BSC during AVE recovery even when unverified Robinhood is least recently attempted', async () => {
  const { scanner, visits } = await startOnce({
    recoveryActive: true,
    activeChain: 'robinhood',
    activeAttemptAt: 1,
    otherChain: 'bsc',
    otherAttemptAt: 999
  });
  assert.deepEqual(visits, ['bsc']);
  assert.equal(scanner.activeChain, 'bsc');
});

test('Scanner.start preserves least-recently-attempted rotation outside AVE recovery', async () => {
  const { scanner, visits } = await startOnce({
    recoveryActive: false,
    activeChain: 'bsc',
    activeAttemptAt: 999,
    otherChain: 'robinhood',
    otherAttemptAt: 1
  });
  assert.deepEqual(visits, ['robinhood']);
  assert.equal(scanner.activeChain, 'robinhood');
});

test('Scanner.start keeps the documented BSC probe lane while recovery remains active even with a legacy false headOnly flag', async () => {
  const { scanner, visits } = await startOnce({
    recoveryActive: true,
    headOnly: false,
    activeChain: 'bsc',
    activeAttemptAt: 999,
    otherChain: 'robinhood',
    otherAttemptAt: 1
  });
  assert.deepEqual(visits, ['bsc']);
  assert.equal(scanner.activeChain, 'bsc');
});

test('Scanner.start hydrates durable recovery before selecting the first chain after restart', async () => {
  const state = stateFixture({ activeChain: 'bsc', activeAttemptAt: 999, otherChain: 'robinhood', otherAttemptAt: 1 });
  const controls = { value: { enabledChains: ['bsc', 'robinhood'] } };
  let hydrated = false;
  const provider = schedulerProvider(false);
  provider.hydrate = async () => { hydrated = true; provider.snapshot = schedulerProvider(true).snapshot; };
  const scanner = new Scanner({ provider, state, controls,
    settings: { ...config, chain: 'bsc', scanIntervalMs: 3_600_000 } });
  const visits = [];
  scanner.cycle = async () => { visits.push(scanner.activeChain); };
  await scanner.start(); scanner.stop();
  assert.equal(hydrated, true);
  assert.deepEqual(visits, ['bsc']);
});

test('Scanner.start wakes at an existing recovery deadline without adding another full scan interval', async () => {
  const state = stateFixture({ activeChain: 'bsc', activeAttemptAt: 1, otherChain: 'robinhood', otherAttemptAt: 2 });
  const controls = { value: { enabledChains: ['bsc', 'robinhood'] } };
  const provider = schedulerProvider(true);
  provider.nextAllowedAt = Date.now() + 30_000;
  const scanner = new Scanner({ provider, state, controls,
    settings: { ...config, chain: 'bsc', scanIntervalMs: 3_600_000 } });
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  let scheduled = 0;
  try {
    globalThis.setTimeout = (_callback, delay) => { scheduled = delay; return 1; };
    globalThis.clearTimeout = () => {};
    await scanner.start(); scanner.stop();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.ok(scheduled > 29_000 && scheduled <= 30_000, `unexpected recovery delay ${scheduled}`);
});

test('Scanner.start waits for the normal AVE transport lane without entering a false scanning state', async () => {
  const state = stateFixture({ activeChain: 'bsc', activeAttemptAt: 1, otherChain: 'robinhood', otherAttemptAt: 2 });
  const controls = { value: { enabledChains: ['bsc', 'robinhood'] } };
  const provider = schedulerProvider(false);
  provider.schedulerReadyAt = Date.now() + 30_000;
  const scanner = new Scanner({ provider, state, controls,
    settings: { ...config, chain: 'bsc', scanIntervalMs: 3_600_000 } });
  let cycles = 0;
  scanner.cycle = async () => { cycles++; };
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  let scheduled = 0;
  try {
    globalThis.setTimeout = (_callback, delay) => { scheduled = delay; return 1; };
    globalThis.clearTimeout = () => {};
    await scanner.start(); scanner.stop();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.equal(cycles, 0);
  assert.ok(scheduled > 29_000 && scheduled <= 30_000, `unexpected transport delay ${scheduled}`);
});

test('multi-chain view can only switch among chains enabled for scanning', () => {
  const state = stateFixture({ activeChain: 'bsc', activeAttemptAt: 1, otherChain: 'robinhood', otherAttemptAt: 2 });
  const controls = { value: { enabledChains: ['bsc', 'robinhood'] } };
  const scanner = new Scanner({ provider: schedulerProvider(false), state, controls, settings: { ...config, chain: 'bsc' } });

  assert.deepEqual(scanner.switchChain('robinhood'), {
    activeChain: 'robinhood', pendingChain: '', queued: false
  });
  assert.throws(() => scanner.switchChain('sol'), error =>
    error?.code === 'CHAIN_NOT_ENABLED' && error?.statusCode === 409);
  assert.equal(scanner.activeChain, 'bsc');
  assert.deepEqual(controls.value.enabledChains, ['bsc', 'robinhood']);
});
