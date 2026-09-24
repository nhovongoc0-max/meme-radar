import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('community distribution has platform launchers and excludes private runtime data', () => {
  for (const file of ['安装并启动.command', '安装并启动.bat', 'START-HERE-WINDOWS.bat', 'START-WINDOWS.bat', 'TEST-WINDOWS.bat', 'README-WINDOWS.txt', 'README.md', 'SECURITY.md',
    'THIRD_PARTY_NOTICES.md', 'docs/EDITION-BOUNDARY.md', 'docs/RELEASE-CHECKLIST.md']) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} should exist`);
  }
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const rule of ['state/**', 'logs/**', '.env', '.npmrc']) assert.match(ignore, new RegExp(`^${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('Windows test launcher runs in foreground so it can be stopped cleanly', () => {
  const launcher = fs.readFileSync(path.join(root, 'TEST-WINDOWS.bat'), 'utf8');
  assert.match(launcher, /node --use-env-proxy src\\main\.mjs/);
  assert.match(launcher, /start "" \/B node scripts\\wait-and-open\.mjs/i);
  assert.doesNotMatch(launcher, /scripts\\open\.mjs|start[^\r\n]*src\\main\.mjs/i);
});

test('portable Windows launcher uses only its bundled runtime', () => {
  const launcher = fs.readFileSync(path.join(root, 'packaging/windows-portable/OPEN-MEME-RADAR.bat'), 'utf8');
  assert.match(launcher, /"runtime\\node\.exe" --use-env-proxy src\\main\.mjs/);
  assert.doesNotMatch(launcher, /where node|npm|powershell/i);
});

test('portable EXE bootstrap only starts the bundled read-only application', () => {
  const launcher = fs.readFileSync(path.join(root, 'packaging/windows-portable/launcher.cjs'), 'utf8');
  assert.match(launcher, /runtime', 'node\.exe/);
  assert.match(launcher, /src', 'main\.mjs/);
  assert.doesNotMatch(launcher, /https?:|powershell|cmd\.exe|private.?key|swap/i);
});

test('Windows launcher stays local and does not require administrator privileges', () => {
  const launcher = fs.readFileSync(path.join(root, 'START-WINDOWS.bat'), 'utf8');
  assert.match(launcher, /node scripts\\open\.mjs/);
  assert.match(launcher, /cd \/d "%~dp0"/);
  assert.doesNotMatch(launcher, /powershell|runas|netsh|reg(?:\.exe)?\s+add/i);
});

test('open-source release metadata uses AGPL and remains blocked from accidental npm publishing', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, 'AGPL-3.0-only');
  assert.equal(fs.existsSync(path.join(root, 'LICENSE')), true);
});

test('community production entry uses only local AVE credentials and never loads a GMGN client or key store', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.mjs'), 'utf8');
  assert.match(main, /import\s*\{\s*AveClient\s*\}\s*from\s*['"]\.\/ave\.mjs['"]/);
  assert.match(main, /apiKeyProvider:\s*\(\)\s*=>\s*ave\.getKey\(\)/);
  assert.match(main, /verifyData:\s*key\s*=>\s*market\.verifyApiKey\(key\)/);
  assert.match(main, /minimumGapMs:\s*5\s*\*\s*60_000/);
  assert.match(main, /new Scanner\(\{ provider: market/);
  assert.match(main, /new LiveDiscovery\(\{ provider: market/);
  assert.doesNotMatch(main, /(?:import[^;]+from\s*['"]\.\/gmgn|new\s+Gmgn|process\.env\.(?:GMGN|AVE)|saveGmgnKey:|getGmgnOnboarding:)/);
});
