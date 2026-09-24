import { mkdirSync, lstatSync, chmodSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Only this documented Data GET is reachable. No quote, approval, signing,
// broadcasting, custom host or automatic scanner calls in this connector.
export const AVE_CHECKS = Object.freeze({
  data: { url: 'https://prod.ave-api.com/v2/tokens/0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c-bsc', header: 'X-API-KEY' },
});
export class AveError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const failure = (code, message, status) => { throw new AveError(code, message, status); };
const keyValue = value => {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{8,1024}$/.test(value.trim()))
    failure('AVE_KEY', '请填写 AVE API Key，不是钱包私钥或助记词');
  return value.trim();
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateAveCheck(kind, body) {
  if (kind === 'data') {
    const token = body?.data?.token, price = token?.current_price_usd;
    if (body?.status !== 1 || !object(token) || token.chain !== 'bsc'
      || !['number', 'string'].includes(typeof price) || !String(price).trim()
      || !Number.isFinite(Number(price)) || Number(price) <= 0
      || (token.token !== undefined && (typeof token.token !== 'string' || token.token.toLowerCase() !== '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c')))
      failure('AVE_SCHEMA', 'AVE 行情响应未通过校验', 502);
  } else failure('AVE_KIND', '未知 AVE 接口类型');
}
export function createAveSettings({ directory, fetchImpl = fetch, now = Date.now, verifyData, onChange = () => {} }) {
  const file = join(directory, 'ave-credentials.json');
  let key = '', requiresReentry = false, health = {}, busy = false, nextAt = 0;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid AVE configuration');
    chmodSync(file, 0o600);
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value.schema === 2 && typeof value.key === 'string') {
      key = value.key ? keyValue(value.key) : '';
    } else if (value.schema === 1 && object(value.keys)
      && !Object.keys(value.keys).some(k => !['data', 'trade'].includes(k))) {
      // Migrate identical/one-sided legacy credentials in memory only. Never
      // arbitrarily choose between two different saved secrets or erase either.
      const unique = [...new Set(Object.values(value.keys).map(keyValue))];
      if (unique.length > 1) requiresReentry = true;
      else key = unique[0] || '';
    } else throw new Error('Invalid AVE configuration');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('AVE 本机配置无法读取；原文件保留');
  }
  const save = updated => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Invalid configuration directory');
    chmodSync(directory, 0o700);
    const temporary = join(directory, 'ave-credentials-' + randomUUID() + '.tmp');
    writeFileSync(temporary, JSON.stringify({ schema: 2, key: updated }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
    key = updated; requiresReentry = false;
  };
  const snapshot = () => ({
    configured: Boolean(key), requiresReentry, hasStoredKey: Boolean(key) || requiresReentry,
    data: { configured: Boolean(key), status: 'untested', ...health.data },
    trade: { configured: false, status: 'disabled' },
    executionReady: false,
    executionReason: '仅接入 AVE 行情；没有连接钱包、签名或下单能力',
  });
  const safeError = e => {
    // The injected shared client may use a different error class. Never return
    // its raw message, request URL, body, headers or credential fingerprint.
    const codes = {
      AVE_AUTH: ['AVE_AUTH', 'AVE 行情 Key 或权限未通过', 400],
      AVE_RATE_LIMIT: ['AVE_RATE_LIMIT', 'AVE 已限流，冷却一分钟；不会自动重试', 429],
      AVE_RATE_LIMITED: ['AVE_RATE_LIMIT', 'AVE 已限流，冷却一分钟；不会自动重试', 429],
      AVE_QUOTA: ['AVE_QUOTA', 'AVE 配额不足；不会自动购买', 429],
      AVE_BUDGET: ['AVE_BUDGET', 'AVE 本机每日行情预算已用完', 429],
      AVE_BUDGET_STORE: ['AVE_STORAGE', 'AVE 本机行情预算无法安全保存', 503],
      AVE_SCHEMA: ['AVE_SCHEMA', 'AVE 行情响应未通过校验', 502],
      AVE_SIZE: ['AVE_SCHEMA', 'AVE 行情响应未通过校验', 502],
      AVE_TIMEOUT: ['AVE_TIMEOUT', 'AVE 行情连接超时', 504],
      AVE_CHANGED: ['AVE_CHANGED', 'AVE 配置已变化，本次测试未采用', 409],
      AVE_ABORTED: ['AVE_ABORTED', 'AVE 行情测试已取消', 409],
      AVE_DISABLED: ['AVE_DISABLED', 'AVE 行情访问已暂停', 409],
      AVE_BUSY: ['AVE_BUSY', 'AVE 行情队列已满，请稍后再试', 429],
    };
    const value = codes[e?.code] || ['AVE_CONNECT', 'AVE 行情连接失败，请检查网络', 502];
    return new AveError(...value);
  };
  const changed = reason => {
    try { onChange({ reason }); } catch { failure('AVE_RELOAD', 'AVE 配置已保存，但扫描器刷新未完成；请重启程序', 503); }
  };
  async function check(kind, candidate) {
    const endpoint = AVE_CHECKS[kind];
    const response = await fetchImpl(endpoint.url, { method: 'GET', headers: { [endpoint.header]: candidate, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(12000) });
    if ([401, 403].includes(response.status)) failure('AVE_AUTH', 'AVE Key 或该接口权限未通过', 400);
    if (response.status === 429) { nextAt = now() + 60000; failure('AVE_RATE_LIMIT', 'AVE 已限流，冷却一分钟；不会自动重试', 429); }
    if (!response.ok) failure('AVE_UPSTREAM', 'AVE 服务暂不可用', 502);
    if (Number(response.headers?.get('content-length')) > 1_000_000) failure('AVE_SCHEMA', 'AVE 响应过大，已停止读取', 502);
    let content = '';
    for await (const chunk of response.body) {
      content += Buffer.from(chunk).toString('utf8');
      if (Buffer.byteLength(content) > 1_000_000) failure('AVE_SCHEMA', 'AVE 响应过大，已停止读取', 502);
    }
    let data; try { data = JSON.parse(content); } catch { failure('AVE_SCHEMA', 'AVE 返回内容无法解析', 502); }
    validateAveCheck(kind, data);
    return { status: 'connected', checkedAt: now(), message: '行情接口测试通过；本次查询约 5 CU，不代表可下单' };
  }
  async function configure(body, checkAuthority = () => {}) {
    if (!object(body) || Object.keys(body).some(k => k !== 'key')) failure('AVE_INPUT', 'AVE 配置格式错误，请刷新页面');
    const candidate = body.key === '' || body.key === undefined ? key : keyValue(body.key);
    if (!candidate) failure('AVE_KEY', requiresReentry ? '旧配置有两把不同 Key，请重新填写一个 AVE API Key' : '请先填写 AVE API Key');
    if (busy) failure('AVE_BUSY', 'AVE 测试正在进行，请稍候', 409);
    if (nextAt > now()) failure('AVE_COOLDOWN', 'AVE 请求冷却中，请稍后再试', 429);
    checkAuthority();
    busy = true; nextAt = now() + 2000;
    try {
      let result;
      checkAuthority();
      try {
        if (typeof verifyData === 'function') {
          const verified = await verifyData(candidate);
          if (verified === false) failure('AVE_SCHEMA', 'AVE 行情响应未通过校验', 502);
          result = { status: 'connected', checkedAt: now(), message: '行情接口测试通过；本次查询约 5 CU，不代表可下单' };
        } else result = await check('data', candidate);
      } catch (error) {
        const safe = safeError(error);
        if (safe.code === 'AVE_RATE_LIMIT') nextAt = now() + 60_000;
        checkAuthority();
        if (candidate === key) health = { data: { status: 'error', checkedAt: now(), message: safe.message, code: safe.code } };
        throw safe;
      }
      checkAuthority();
      // Data verification is mandatory. No trade capability can rescue a failure.
      try { save(candidate); } catch { failure('AVE_STORAGE', 'AVE 本机保存失败，原 Key 保留', 503); }
      health = { data: result };
      changed('configured');
      return snapshot();
    } finally { busy = false; }
  }
  function remove(body) {
    if (!object(body) || Object.keys(body).length) failure('AVE_INPUT', 'AVE 配置格式错误，请刷新页面');
    if (busy) failure('AVE_BUSY', '请等待当前 AVE 测试结束再移除', 409);
    try { save(''); } catch { failure('AVE_STORAGE', 'AVE 本机保存失败，原 Key 保留', 503); }
    health = {}; changed('removed');
    return snapshot();
  }
  return { snapshot, configure, remove, getKey: () => key };
}
