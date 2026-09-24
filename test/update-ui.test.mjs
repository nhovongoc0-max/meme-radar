import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
const releaseUrl = 'https://github.com/nhovongoc0-max/meme-radar/releases/latest';

function attribute(source, name) {
  const match = source.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? match[2] : null;
}

const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(match => ({
  attributes: match[1],
  href: attribute(match[1], 'href'),
  text: match[2].replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim(),
}));

test('页面仅提供一个安全的“下载最新版”链接', () => {
  const labelledLinks = anchors.filter(link => link.text === '下载最新版');
  assert.equal(labelledLinks.length, 1, '应仅有一个“下载最新版”链接');

  const [link] = labelledLinks;
  assert.equal(link.href, releaseUrl);
  assert.equal(attribute(link.attributes, 'target'), '_blank');

  const rel = new Set((attribute(link.attributes, 'rel') || '').toLowerCase().split(/\s+/).filter(Boolean));
  assert.ok(rel.has('noopener'), 'rel 应包含 noopener');
  assert.ok(rel.has('noreferrer'), 'rel 应包含 noreferrer');
  assert.equal(anchors.filter(candidate => candidate.href === releaseUrl).length, 1, '最新版发布地址不应重复出现');
});

test('页面不再包含本地安装更新流程', () => {
  for (const forbidden of [
    /\bupdateDialog\b/,
    /\bupdateInstall\b/,
    /update-ui\.mjs/,
    /\/api\/update-install/,
    /INSTALL_UPDATE/,
  ]) {
    assert.doesNotMatch(html, forbidden);
  }
});

test('生产启动不接入自动安装器，也不再提供旧更新页面模块', () => {
  assert.doesNotMatch(main, /\bcreateUpdater\b|\bonUpdateReady\b/);
  assert.doesNotMatch(server, /['"]\/update-ui\.mjs['"]/);
});
