import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('AVE API management opens the cloud login page in a protected new tab', () => {
  const link = html.match(/<a\s+href="([^"]+)"\s+target="_blank"\s+rel="noopener noreferrer"\s+data-i18n="aveManage">/);
  assert.ok(link, 'AVE API management link must exist');
  assert.equal(link[1], 'https://cloud.ave.ai/login');
  assert.doesNotMatch(html, /href="https:\/\/cloud\.ave\.ai\/"/);
});
