#!/usr/bin/env node
/**
 * 单进程总控：collect + server + paper runner + 全部 shadow。
 *
 * 为什么需要：
 *   - 7 天 forward 样本最怕进程悄悄死掉；
 *   - 每个 child 单独重启，collect 内部再管理 ingest/trades/candles/dex/enrich；
 *   - 退出时先停 children，避免半写状态。
 *
 * 用法：
 *   npm run up
 *   npm run down
 *
 * 生产长期运行建议用 deploy/meme-hunter.service (systemd --user)。
 */

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA = join(ROOT, 'data');
const PID = join(DATA, 'supervisor.pid');
const LOG = join(DATA, 'supervisor.log');
mkdirSync(DATA, { recursive: true });

const NODE = process.execPath;
const SERVICES = [
  { name: 'collect', args: ['src/collect.mjs'] },
  { name: 'server', args: ['src/server.mjs', '--port', '8787', '--db', 'data/meme.db'] },
  { name: 'runner', args: ['src/runner.ts', '--sim', '--poll', '1500'] },
  { name: 'shadow-crash', args: ['src/shadow.ts', '--strategy', 'crash', '--shadow-db', 'data/shadow-crash.db', '--size', '0.02', '--poll', '2000'] },
  { name: 'shadow-crash-005', args: ['src/shadow.ts', '--strategy', 'crash', '--shadow-db', 'data/shadow-crash-005.db', '--size', '0.05', '--poll', '2000'] },
  { name: 'shadow-wallet', args: ['src/shadow.ts', '--strategy', 'wallet', '--shadow-db', 'data/shadow-wallet.db', '--size', '0.02', '--poll', '2000'] },
  { name: 'shadow-wallet-conf', args: ['src/shadow.ts', '--strategy', 'wallet', '--min-wallets', '2', '--shadow-db', 'data/shadow-wallet-conf.db', '--size', '0.02', '--poll', '2000'] },
  { name: 'shadow-wallet-conf-q', args: ['src/shadow.ts', '--strategy', 'wallet', '--min-wallets', '2', '--min-copyability', '0.45', '--min-oos', '4', '--shadow-db', 'data/shadow-wallet-conf-q.db', '--size', '0.05', '--max-open', '5', '--poll', '2000'] },
  { name: 'shadow-dex', args: ['src/shadow-dex.ts', '--shadow-db', 'data/shadow-dex.db', '--size', '0.02', '--poll', '30000'] },
];

function log(line) {
  const msg = `[supervisor ${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(msg);
  try { appendFileSync(LOG, msg); } catch { /* ignore */ }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

if (existsSync(PID)) {
  const old = Number(readFileSync(PID, 'utf8').trim());
  if (old && alive(old)) {
    console.error(`supervisor 已在运行 pid=${old}`);
    process.exit(2);
  }
}
writeFileSync(PID, String(process.pid));

const children = new Map();
let stopping = false;

function start(service) {
  if (stopping) return;
  const child = spawn(NODE, ['--no-warnings', ...service.args], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(service.name, child);
  log(`start ${service.name} pid=${child.pid}`);

  const prefix = (tag) => (buf) => {
    for (const line of buf.toString().split('\n')) {
      if (line.trim()) process.stdout.write(`[${tag}] ${line}\n`);
    }
  };
  child.stdout.on('data', prefix(service.name));
  child.stderr.on('data', prefix(`${service.name}!`));

  child.on('exit', (code, signal) => {
    children.delete(service.name);
    log(`exit ${service.name} code=${code ?? '—'} signal=${signal ?? '—'}`);
    if (!stopping) {
      const delay = code === 0 ? 2000 : 5000;
      log(`restart ${service.name} in ${delay}ms`);
      setTimeout(() => start(service), delay);
    }
  });
  child.on('error', (e) => log(`spawn error ${service.name}: ${e.message}`));
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`收到 ${signal}，停止 ${children.size} 个 child`);
  for (const [name, child] of children) {
    log(`stop ${name} pid=${child.pid}`);
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  setTimeout(() => {
    for (const [, child] of children) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    try { rmSync(PID); } catch { /* ignore */ }
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log(`启动 ${SERVICES.length} 个服务`);
for (const s of SERVICES) start(s);
