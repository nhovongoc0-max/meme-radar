import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GmgnKeyStore, normalizeGmgnApiKey } from '../src/gmgn-key-store.mjs';

// chmod mode bits are meaningful on POSIX; Windows access is governed by ACLs.
function assertPosixMode(file, expected) {
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, expected);
}

const validKey = () => `gmgn_${'a1'.repeat(16)}`;

test('GMGN key store validates the key and keeps it in a private state file', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-radar-key-'));
  const stateDir = path.join(temporaryRoot, 'state');
  try {
    const store = new GmgnKeyStore(stateDir);
    const key = validKey();
    assert.equal(store.save(key), true);
    assert.equal(store.configured(), true);
    assert.equal(store.get(), key);
    assert.equal(fs.readFileSync(store.file, 'utf8'), `${key}\n`);
    assertPosixMode(stateDir, 0o700);
    assertPosixMode(store.file, 0o600);

    assert.throws(() => store.save('gmgn_too_short'), { code: 'INVALID_GMGN_API_KEY' });
    assert.equal(store.get(), key);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('GMGN key validation rejects whitespace, wrong prefixes and unsafe characters', () => {
  const key = validKey();
  assert.equal(normalizeGmgnApiKey(key), key);
  assert.equal(normalizeGmgnApiKey(` ${key} `), key);
  assert.equal(normalizeGmgnApiKey(`other_${'a'.repeat(32)}`), '');
  assert.equal(normalizeGmgnApiKey(`gmgn_${'a'.repeat(23)}`), '');
  assert.equal(normalizeGmgnApiKey(`gmgn_${'a'.repeat(24)}!`), '');
  assert.equal(normalizeGmgnApiKey(null), '');
});

test('each new GMGN API setup gets a fresh pending Ed25519 key without exposing the private key', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-radar-pair-'));
  try {
    const store = new GmgnKeyStore(path.join(temporaryRoot, 'state'));
    const first = store.onboarding();
    assert.equal(first.algorithm, 'Ed25519');
    assert.match(first.publicKey, /^-----BEGIN PUBLIC KEY-----/);
    assert.equal(first.createUrl.startsWith('https://gmgn.ai/ai/generateapi?pbk='), true);
    assert.equal(JSON.stringify(first).includes('PRIVATE KEY'), false);
    const firstPrivate = store.verificationPrivateKey();
    assert.match(firstPrivate, /^-----BEGIN PRIVATE KEY-----/);
    assertPosixMode(store.pendingSigningFile, 0o600);

    assert.equal(store.onboarding().publicKey, first.publicKey);
    const second = store.onboarding({ regenerate: true });
    assert.notEqual(second.publicKey, first.publicKey);
    assert.notEqual(store.verificationPrivateKey(), firstPrivate);
    assert.equal(store.activatePending(), true);
    assert.equal(fs.existsSync(store.pendingSigningFile), false);
    assertPosixMode(store.signingFile, 0o600);
    assert.equal(store.verificationPrivateKey(), '');

    const third = store.onboarding();
    assert.notEqual(third.publicKey, second.publicKey);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
