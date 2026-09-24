import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'public', 'index.html'), 'utf8');

test('AVE opens token chart/trading with the author referral and never substitutes the pool or source URL', () => {
  const start = html.indexOf('const AVE_INVITE_URL =');
  const end = html.indexOf('function candidateRow', start);
  const context = { t: key => key, escapeHtml: value => String(value).replaceAll('&', '&amp;'), safeUrl: () => '', officialXHandle: () => '' };
  vm.runInNewContext(html.slice(start, end) + ';this.links = actionLinks;this.tokenUrl = aveTokenUrl;', context);
  for (const chain of ['bsc', 'eth', 'base', 'robinhood', 'sol']) {
    const address = chain === 'sol' ? 'So11111111111111111111111111111111111111112' : '0x059ecb64e45b6211f1390d5f28cc909203ca7777';
    const links = context.links({ chain, address, pairAddress: 'wrong-pool', gmgnUrl: 'https://gmgn.ai/override' });
    assert.ok(links.includes('https://pro.ave.ai/token/' + address + '-' + (chain === 'sol' ? 'solana' : chain) + '?ref=0001'));
    assert.ok(links.includes('aveTrade')); assert.doesNotMatch(links, /wrong-pool/);
    assert.match(links, /data-action="copy"/); assert.doesNotMatch(links, /gmgn.ai/);
  }
  for (const row of [{ chain:'unknown',address:'0x059ecb64e45b6211f1390d5f28cc909203ca7777' },
    { chain:'arc',address:'0x059ecb64e45b6211f1390d5f28cc909203ca7777' },
    { chain:'stable',address:'0x059ecb64e45b6211f1390d5f28cc909203ca7777' },
    { chain:'bsc',address:'not-a-ca' }, { chain:'bsc',address:'0x059ecb64e45b6211f1390d5f28cc909203ca7777?ref=evil' }]) {
    assert.equal(context.tokenUrl(row.chain,row.address), null);
    assert.match(context.links(row), /https:\/\/share\.ave\.ai\?lang=zh-cn&amp;code=0001/);
    assert.doesNotMatch(context.links(row), /pro\.ave\.ai/);
  }
  assert.match(html, /id="ave-api-key"[^>]*type="password"/);
  assert.doesNotMatch(html, /ave-data-key|ave-trade-key|data-ave-kind/);
  const connector = html.slice(html.indexOf('let aveBusy'), html.indexOf('async function refresh()'));
  assert.doesNotMatch(connector, /localStorage|sessionStorage|window.open|privateKey|signTransaction/);
});

test('AVE failed retest updates the Data badge while retaining the failure notice and saved-key summary', async () => {
  const elements = Object.fromEntries(['ave-api-key', 'ave-config-status', 'ave-data-status', 'aveSummary', 'aveSettings']
    .map(id => [id, { dataset: {}, textContent: '', value: '' }]));
  const context = {
    byId: id => elements[id], t: key => key,
    document: { querySelectorAll: () => [] }, AbortSignal,
    fetch: async () => ({ ok: false, json: async () => ({ error: 'AVE_AUTH',
      ave: { configured: true, data: { configured: true, status: 'error' }, trade: { configured: false, status: 'disabled' } } }) }),
  };
  vm.runInNewContext(html.slice(html.indexOf('let aveBusy'), html.indexOf('async function refresh()'))
    + ';this.change = changeAve;this.render = renderAveConnection;', context);
  context.render({ configured: true, data: { status: 'connected' } });
  assert.equal(elements['ave-data-status'].textContent, 'aveChecked');
  await context.change('configure');
  assert.equal(elements['ave-data-status'].textContent, 'aveFailed');
  assert.equal(elements['aveSummary'].textContent, ' · aveKeySaved');
  assert.match(elements['ave-config-status'].textContent, /AVE_AUTH/);
});

test('所有内联脚本均可通过语法解析', () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 2);
  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script[1]));
});

test('所有显式像素字号均不小于14像素', () => {
  const sizes = [...html.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
  assert.ok(sizes.length > 0);
  assert.ok(sizes.every(size => size >= 14));
});

test('看板明确区分累计、本轮和近30分钟口径', () => {
  assert.match(html, /<h1[^>]*>Meme雷达开源版<\/h1>/);
  assert.match(html, /class="mark">雷达<\/div>/);
  assert.match(html, /扫描轮次[\s\S]*累计/);
  assert.match(html, /发现代币[\s\S]*本轮/);
  assert.match(html, /深度审计[\s\S]*近30分钟/);
  assert.match(html, /链上候选\/待人工看X/);
  assert.doesNotMatch(html, /最终候选/);
});

test('自动筛选替代人工通过，保留历史标记兼容且不下单', () => {
  assert.match(html, /robinhoodRadarManualMarksV1/);
  assert.doesNotMatch(html, /data-action="pass"/);
  assert.doesNotMatch(html, /data-action="ignore"/);
  assert.match(html, /id="advancedPanel"[^>]*>/);
  assert.doesNotMatch(html, /id="advancedPanel"[^>]*\bopen\b/);
  assert.match(html, /value="new" selected/);
  assert.match(html, /class="compact-audits"/);
  assert.match(html, /复制合约/);
  assert.match(html, /官网无/);
  assert.match(html, /访问官网/);
  assert.match(html, /safeUrl\(row\.info && row\.info\.website\)/);
  assert.match(html, /officialXHandle/);
  assert.match(html, /normalizeXHandle/);
  assert.match(html, /reservedXPaths/);
  assert.match(html, /普通钱包代理数量未知/);
  assert.match(html, /noopener noreferrer/);
  assert.match(html, /只扫描、不交易/);
});

test('前端X入口拒绝站内功能页并只生成单层用户名链接', () => {
  const start = html.indexOf('const reservedXPaths = new Set(');
  const end = html.indexOf('function officialXHandle', start);
  assert.ok(start >= 0 && end > start);
  const context = { URL };
  vm.runInNewContext(html.slice(start, end) + '\nthis.normalize = normalizeXHandle;', context);
  assert.equal(context.normalize('https://x.com/search?q=test'), '');
  assert.equal(context.normalize('https://x.com/home'), '');
  assert.equal(context.normalize('x.com/real_handle'), 'real_handle');
  assert.equal(context.normalize('@real_handle'), 'real_handle');
  assert.equal(context.normalize('https://example.com/x.com/fake'), '');
  assert.equal('https://x.com/' + encodeURIComponent(context.normalize('x.com/real_handle')), 'https://x.com/real_handle');
});

test('六语切换持久化并支持阿拉伯语RTL', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'ar']) {
    assert.match(html, new RegExp('<option value="' + locale + '"'));
  }
  assert.match(html, /memeRadarLanguageV1/);
  assert.match(html, /document\.documentElement\.dir = currentLocale === 'ar' \? 'rtl' : 'ltr'/);
  assert.match(html, /html\[dir="rtl"\]/);
  assert.match(html, /data-i18n="appTitle"/);
  assert.match(html, /data-i18n="auditTitle"/);
  assert.match(html, /t\(statusKeys\[data\.status\]/);
  assert.doesNotMatch(html, /GMGN多链候选雷达 · 只扫描、只筛选、永不下单/);
});

test('语言下拉使用地球图标和深色高对比选项', () => {
  assert.match(html, /class="language-icon" aria-hidden="true">🌐<\/span>/);
  assert.match(html, /class="visually-hidden" data-i18n="languageLabel">语言<\/span>/);
  assert.match(html, /\.language-select\s*\{[\s\S]*?color-scheme:\s*dark/);
  assert.match(html, /\.language-select option\s*\{[\s\S]*?background:\s*#0b151a;[\s\S]*?color:\s*#f2faf8/);
  assert.match(html, /\.language-select:focus-visible\s*\{[\s\S]*?outline:\s*1px solid #61cbd4/);
  assert.doesNotMatch(html, /\.language-select\s*\{[\s\S]*?background:\s*transparent/);
});

test('语音播报提供独立的中英文手动切换，最近成功与限频状态分开显示', () => {
  assert.match(html, /id="voiceLanguage"[^>]*>[\s\S]*?<option value="zh">中文<\/option>[\s\S]*?<option value="en">English<\/option>/);
  assert.match(html, /memeRadarLastSuccessAtV2:/);
  assert.match(html, /recentSuccess/);
  assert.doesNotMatch(html, /robinhoodRadarLastSuccessAtV1/);
});

test('翻译词典完整覆盖静态挂点和动态文案键', () => {
  const dictionarySource = html.replace(/\r\n/g, '\n').match(/const messages = (\{[\s\S]*?\n    \});\n\n    let currentLocale/);
  assert.ok(dictionarySource, '应能提取翻译词典');
  const messages = vm.runInNewContext('(' + dictionarySource[1] + ')');
  for (const [key, values] of Object.entries(messages)) {
    assert.ok(Array.isArray(values), key + ' 应为数组');
    assert.equal(values.length, 6, key + ' 应包含六种语言');
    assert.ok(values.every(value => typeof value === 'string' && value.length > 0), key + ' 不应有空翻译');
  }
  const staticKeys = [...html.matchAll(/data-i18n(?:-placeholder|-aria)?="([^"]+)"/g)].map(match => match[1]);
  const dynamicKeys = [...html.matchAll(/\bt\('([^']+)'/g)].map(match => match[1]);
  for (const key of new Set([...staticKeys, ...dynamicKeys])) assert.ok(messages[key], '缺少翻译键：' + key);
});

test('多链切换仅向本地后端提交白名单链标识', () => {
  for (const chain of ['sol', 'bsc', 'base', 'eth', 'robinhood']) {
    assert.match(html, new RegExp("id: '" + chain + "'"));
  }
  assert.match(html, /fetch\('\/api\/active-chain'/);
  assert.match(html, /JSON\.stringify\(\{ chain: chain \}\)/);
  assert.match(html, /renderChainSwitcher\(null\)/);
});

test('页面不再公开展示严格筛选规则', () => {
  assert.doesNotMatch(html, /严格筛选标准/);
  assert.doesNotMatch(html, /Strict screening rules/);
  assert.doesNotMatch(html, /data-i18n="criterion[1-8]"/);
  assert.doesNotMatch(html, /\bcriteriaTitle\s*:/);
  assert.doesNotMatch(html, /class="criteria"/);
});

test('AVE 单 Key 仅提交给同源接口且不会持久化或回显', () => {
  assert.match(html, /id="ave-api-key"[^>]*type="password"[^>]*autocomplete="off"[^>]*spellcheck="false"[^>]*maxlength="1024"/);
  assert.match(html, /id="ave-key-form"/);
  assert.match(html, /id="ave-config-status"[^>]*aria-live="polite"/);
  const start = html.indexOf('async function changeAve');
  const end = html.indexOf('async function refresh', start);
  assert.ok(start >= 0 && end > start);
  const source = html.slice(start, end);
  assert.match(source, /fetch\('\/api\/ave-' \+ action/);
  assert.match(source, /body: JSON\.stringify\(body\)/);
  assert.match(source, /byId\('ave-api-key'\)\.value = ''/);
  assert.match(source, /if \(!response\.ok\) throw/);
  assert.match(source, /renderAveConnection\(result\.ave\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|readStorage|writeStorage/);
  assert.doesNotMatch(source, /console\.|innerHTML|textContent\s*=\s*result\./);
});

test('生产页面无 GMGN 配置流程，AVE 行情不请求钱包私钥或交易权限', () => {
  assert.doesNotMatch(html, /id="(?:gmgnKeyInput|gmgnKeyButton|gmgnKeyStatus|gmgnOnboardingButton|gmgnPublicKey)"/);
  assert.doesNotMatch(html, /fetch\(['"]\/api\/gmgn|connectGmgnApi|prepareGmgnOnboarding/);
  assert.doesNotMatch(html, /gmgn-private-key|privateKey\s*=|eth_requestAccounts|signTransaction|sendTransaction/);
  assert.match(html, /https:\/\/cloud\.ave\.ai\//);
  assert.doesNotMatch(html, /仅测试行情，约 5 CU。单 Key，无需钱包。/);
  assert.doesNotMatch(html, /id="ave-trade-status"|ave-data-key|ave-trade-key/);
});

test('看板包含新鲜度、运行进度和动态降级支持', () => {
  assert.match(html, /最近扫描尝试/);
  assert.match(html, /最近成功扫描/);
  assert.match(html, /下轮扫描/);
  assert.match(html, /数据新鲜度/);
  assert.match(html, /scanInProgress/);
  assert.match(html, /WAIT_RECHECK/);
  assert.match(html, /HARD_REJECT/);
  assert.match(html, /筛选后表现验证/);
  assert.match(html, /30分钟结果/);
  assert.match(html, /2小时结果/);
  assert.match(html, /24小时结果/);
  assert.match(html, /未满50个只做观察，不用于调参/);
  assert.match(html, /prefers-reduced-motion/);
});

test('候选表明确展示GoPlus与DexScreener交叉验证', () => {
  assert.match(html, /GoPlus一票否决/);
  assert.match(html, /GoPlus未见致命项/);
  assert.match(html, /Dex复核/);
  assert.match(html, /多源数据冲突/);
});
