import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('    function sortRows(rows, sortValue)');
const end = html.indexOf('    const reservedXPaths', start);
const candidateStart = html.indexOf('    function candidateRow(');
const candidateEnd = html.indexOf('    function activeChain(', candidateStart);
const T = 1_900_000_000_000, A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
const row = (address = A, extra = {}) => ({ chain: 'bsc', address, symbol: address === A ? 'ALERT' : 'OTHER', status: 'X_REVIEW',
  qualified: true, auditedAt: T, staleAt: T + 600000, marketCap: 40000, discoveryScore: address === A ? 1 : 99, deep: { chainPass: true }, ...extra });
const liveRow = source => ({ ...source, source: 'live', status: 'LIVE_READY', qualified: true,
  auditEligible: true, stale: false, discoveryState: 'READY', sourceUpdatedAt: source.auditedAt,
  expiresAt: source.staleAt, firstSeenAt: source.auditedAt, newAt: source.auditedAt });

function harness(rows = [row(), row(B)], extraChains = {}) {
  let now = T, switches = 0;
  const elements = new Map(), events = {}, copied = [], storage = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: id === 'filterSelect' ? 'all' : id === 'sortSelect' ? 'score_desc' : '',
      hidden: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, scrollIntoView() { this.scrolled = true; }, focus() { this.focused = true; } });
    return elements.get(id);
  };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const auditRows = { bsc: rows, ...extraChains };
  const allRows = Object.fromEntries(Object.entries(auditRows).map(([chain, list]) => [chain, list.map(liveRow)]));
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } }, byId: el, document: { getElementById: el },
    window: { addEventListener(type, fn) { events[type] = fn; } }, rowsCache: rows,
    liveData: { chain: 'bsc', rows: allRows.bsc },
    lastData: { activeChain: 'bsc' }, manualMarks: {}, chainSwitching: false,
    chainCatalog: [{ id: 'bsc', label: 'BSC' }, { id: 'eth', label: 'Ethereum' }, { id: 'sol', label: 'Solana' }], chainLabel: c => c.label,
    addressIdentity: value => /^0x[0-9a-f]{40}$/i.test(String(value)) ? value.toLowerCase() : String(value),
    activeChain: data => data.activeChain, backendDisposition: r => r.status === 'X_REVIEW' ? 'chain' : r.status === 'WAIT_RECHECK' ? 'waiting' : 'rejected',
    number: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    t: (key, vars) => key + (vars ? ':' + JSON.stringify(vars) : ''), escapeHtml: escape, formatClock: value => String(value),
    rowMatches: (r, query, filter) => (!query || (r.symbol + r.address).toLowerCase().includes(query)) && (filter !== 'rejected' || r.status === 'HARD_REJECT'),
    readStorage: (key, fallback) => storage.get(key) || fallback, copyText: value => { copied.push(value); },
    switchActiveChain: async chain => { switches++; context.lastData = { activeChain: chain };
      context.rowsCache = auditRows[chain] || []; context.liveData = { chain, rows: allRows[chain] || [] }; },
    mergedPolicy: () => ({ minOrdinaryWallets: 8 }), candidateFreshness: () => ({ className: '', tone: '', label: '' }),
    candidateAuditAge: (r, now) => now - r.auditedAt, knownAtMost: () => true,
    checkLine: () => '', failureReasons: () => [], officialXHandle: () => '', markFor: () => null,
    hasFiniteValue: Number.isFinite, formatPercent: String, formatMoney: String, formatCount: String,
    safeMessage: String, annotationFor: () => ({}), radarLinks: () => '', renderLive: () => {}, statusBadge: r => r.status, currentLocale: 'en',
    fetch() { throw Error('Spotlight must not fetch automatically'); },
  });
  vm.runInContext(html.slice(start, end) + html.slice(candidateStart, candidateEnd)
    + ';this.rank=voiceSpotlightRank;this.start=startVoiceSpotlight;this.locate=locateVoiceSpotlight;this.draw=renderCandidates;this.attach=attachVoiceSpotlight;', context);
  context.attach();
  const snapshot = (chains = allRows) => {
    const normalized = Object.fromEntries(Object.entries(chains).map(([chain, list]) => [chain, list.map(function (item) {
      return item.source === 'live' ? item : liveRow(item);
    })]));
    const chain = context.lastData.activeChain;
    context.liveData = { chain, rows: normalized[chain] || [] };
    events['radar-snapshot']({ detail: { chains: normalized } });
  };
  snapshot(); context.draw();
  return { context, events, el, storage, copied, snapshot, allRows, get switches() { return switches; }, advance(ms) { now += ms; },
    alert(list = [rows[0]], id = 1) { events['radar-voice-start']({ detail: { id, startedAt: now, rows: list.map(liveRow) } }); },
    choose(item) { el('voiceSpotlight').listeners.change({ target: { id: 'voiceSpotlightQueue', value: item.chain + ':' + item.address } }); },
    click(action) { el('voiceSpotlight').listeners.click({ target: { closest: () => ({ disabled: false, dataset: { voiceAction: action } }) } }); } };
}

test('alert card is first below the header, appears only after playback event and pins the actual existing row', () => {
  assert.ok(html.indexOf('id="voiceSpotlight"') < html.indexOf('id="notice"'));
  const h = harness();
  assert.equal(h.el('voiceSpotlight').hidden, true);
  const first = h.el('candidates').innerHTML; assert.ok(first.indexOf(B) < first.indexOf(A));
  h.alert();
  assert.equal(h.el('live-card-' + encodeURIComponent('bsc:' + A)).scrolled, true);
  assert.equal(h.el('live-card-' + encodeURIComponent('bsc:' + A)).focused, true);
  assert.equal(h.el('voiceSpotlight').hidden, false); assert.match(h.el('voiceSpotlight').innerHTML, /voiceSpotlightPlaying/);
  const body = h.el('candidates').innerHTML;
  assert.ok(body.indexOf(A) < body.indexOf(B)); assert.match(body, /voice-spotlight-row/); assert.match(body, /voiceSpotlightRow/);
  assert.equal(h.context.rowsCache.length, 2); assert.equal(h.switches, 0);
  h.events['radar-voice-finish']({ detail: { id: 999, completed: true } }); assert.match(h.el('voiceSpotlight').innerHTML, /voiceSpotlightPlaying/);
  h.events['radar-voice-finish']({ detail: { id: 1, completed: false } }); assert.match(h.el('voiceSpotlight').innerHTML, /voiceSpotlightInterrupted/);
});

test('batch queue selects the corresponding CA while preserving filters until an explicit locate click', async () => {
  const h = harness(); h.alert([row(), row(B)]);
  assert.match(h.el('voiceSpotlight').innerHTML, /voiceSpotlightQueue/);
  h.choose(row(B)); assert.equal(h.context.rank(row(B), T), 0); assert.equal(h.context.rank(row(), T), 1);
  h.el('liveSearch').value = 'no-match'; h.el('searchInput').value = 'no-match'; h.context.draw();
  assert.match(h.el('voiceSpotlight').innerHTML, /voiceSpotlightFiltered/); assert.doesNotMatch(h.el('candidates').innerHTML, /voice-spotlight-row/);
  assert.equal(h.el('searchInput').value, 'no-match');
  await h.context.locate();
  assert.equal(h.el('searchInput').value, 'no-match');
  assert.equal(h.el('liveSearch').value, ''); assert.equal(h.el('liveSort').value, 'new');
  assert.equal(h.el('live-card-' + encodeURIComponent('bsc:' + B)).focused, true);
  h.click('copy'); assert.deepEqual(h.copied, [B]);
  h.click('dismiss'); assert.equal(h.el('voiceSpotlight').hidden, true); assert.doesNotMatch(h.el('candidates').innerHTML, /voice-spotlight-row/);
});

test('cross-chain identity never pins the same address on the wrong chain; switching requires a user action', async () => {
  const eth = row(A, { chain: 'eth' }), h = harness(undefined, { eth: [eth] });
  h.alert([eth]); assert.equal(h.switches, 0); assert.equal(h.context.rank(row(), T), Infinity);
  assert.match(h.el('voiceSpotlight').innerHTML, /Ethereum/); assert.doesNotMatch(h.el('candidates').innerHTML, /voice-spotlight-row/);
  await h.context.locate(); assert.equal(h.switches, 1); assert.equal(h.context.lastData.activeChain, 'eth');
  assert.match(h.el('candidates').innerHTML, /voice-spotlight-row/);
});

test('rejected, ignored, stale, missing, offline and no-longer-qualified alerts stay informational, never re-enter or stay pinned', async () => {
  for (const mode of ['reject', 'ignored', 'stale', 'missing', 'offline', 'changed']) {
    const h = harness(); h.alert();
    if (mode === 'reject') { h.context.rowsCache[0].status = 'HARD_REJECT'; h.context.rowsCache[0].qualified = false; h.snapshot(); }
    if (mode === 'ignored') { h.storage.set('robinhoodRadarManualMarksV1', { ['bsc:' + A]: { decision: 'ignored' } }); h.events.storage({ key: 'robinhoodRadarManualMarksV1' }); }
    if (mode === 'stale') { h.advance(600001); h.snapshot(); }
    if (mode === 'missing') { h.context.rowsCache = [row(B)]; h.snapshot({ bsc: [row(B)] }); }
    if (mode === 'offline') h.events['radar-offline']();
    if (mode === 'changed') {
      h.context.rowsCache[0].status = 'WAIT_RECHECK'; h.context.rowsCache[0].qualified = false;
      h.snapshot({ bsc: [{ ...h.allRows.bsc[0], status: 'LIVE_WAIT', qualified: false,
        auditEligible: false, discoveryState: 'PENDING' }, h.allRows.bsc[1]] });
    }
    assert.equal(h.context.rank(row(), T + (mode === 'stale' ? 600001 : 0)), Infinity, mode);
    assert.doesNotMatch(h.el('candidates').innerHTML, /voice-spotlight-row/, mode);
    assert.match(h.el('voiceSpotlight').innerHTML, /data-voice-action="locate" disabled/, mode);
    await h.context.locate(); assert.equal(h.switches, 0);
    if (mode === 'missing') assert.equal(h.context.rowsCache.length, 1);
  }
});

test('a newer alert replaces the old batch; names are escaped; invalid and future start events cannot create cards', () => {
  const h = harness([row(A, { symbol: '<img src=x onerror=alert(1)>' }), row(B)]);
  h.context.start({ id: 1, startedAt: T + 1, rows: [row()] }); assert.equal(h.el('voiceSpotlight').hidden, true);
  h.alert([row(C, { chain: 'unknown' })]); assert.equal(h.el('voiceSpotlight').hidden, true);
  h.alert(); assert.ok(h.el('voiceSpotlight').innerHTML.includes('&lt;img')); assert.doesNotMatch(h.el('voiceSpotlight').innerHTML, /<img/);
  h.alert([row(B)], 2); assert.equal(h.context.rank(row(), T), Infinity); assert.equal(h.context.rank(row(B), T), 0);
  h.events.pagehide(); assert.equal(h.el('voiceSpotlight').hidden, true); assert.doesNotMatch(h.el('candidates').innerHTML, /voice-spotlight-row/);
});


test('a pending user chain switch cannot locate a replaced or dismissed alert', async () => {
  for (const change of ['new', 'dismiss']) {
    const eth = row(A, { chain: 'eth' }), h = harness(undefined, { eth: [eth] });
    h.alert([eth]);
    let release;
    h.context.switchActiveChain = () => new Promise(resolve => { release = () => {
      h.context.lastData = { activeChain: 'eth' }; h.context.rowsCache = [eth]; resolve();
    }; });
    h.el('searchInput').value = 'keep-my-filter';
    const pending = h.context.locate();
    if (change === 'new') h.alert([row(B)], 2);
    else h.click('dismiss');
    release(); await pending;
    assert.equal(h.el('searchInput').value, 'keep-my-filter', change);
    assert.notEqual(h.el('voice-candidate-' + encodeURIComponent('eth:' + A)).focused, true, change);
  }
});
