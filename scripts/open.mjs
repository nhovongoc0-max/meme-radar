import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureDependencies, projectRoot, withLocalLock } from './setup.mjs';

const port = Number(process.env.RADAR_PORT || 3791);
const url = `http://127.0.0.1:${port}/`;
const instanceId = crypto.createHash('sha256').update(path.join(projectRoot, 'public')).digest('hex').slice(0, 16);

function health() {
  return new Promise((resolve, reject) => {
    const req = http.get(`${url}health`, { timeout: 1500 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 32_000) req.destroy(new Error('端口返回了异常响应。')); });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (response.statusCode !== 200 || data.service !== 'meme-radar' || data.execution !== false
            || data.instanceId !== instanceId) throw new Error(`${port} 端口已有其他服务或另一份雷达，请关闭它或选择其他 RADAR_PORT。`);
          resolve(true);
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('本地端口没有及时回应。')));
    req.on('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
  });
}

function openBrowser() {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('浏览器未能自动打开。')));
  });
}

try {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RADAR_PORT 必须为 1024 到 65535 的整数。');
  await ensureDependencies();
  await withLocalLock('open', async () => {
    if (await health()) return;
    const logs = path.join(projectRoot, 'logs');
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(path.join(logs, 'radar-launch.log'), 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, ['--use-env-proxy', path.join(projectRoot, 'scripts/supervise.mjs')], {
        cwd: projectRoot, env: { ...process.env, RADAR_PORT: String(port) },
        detached: true, windowsHide: true, stdio: ['ignore', fd, fd]
      });
      child.once('error', () => {});
      child.unref();
    } finally { fs.closeSync(fd); }
    for (let attempt = 0; attempt < 60; attempt++) {
      await delay(250);
      if (await health()) return;
      if (child.exitCode !== null || child.signalCode) break;
    }
    throw new Error('雷达未能启动，请查看 logs/radar-launch.log。');
  });
  console.log(`雷达已打开：${url}\n首次使用：展开“AVE API”，填写自己的行情 Key 并保存测试。`);
  if (!process.argv.includes('--no-open')) await openBrowser();
} catch (error) { console.error(`启动未完成：${error.message}\n可手动访问 ${url}`); process.exitCode = 1; }
