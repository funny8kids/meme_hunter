#!/usr/bin/env node
/**
 * 采集总控：一条命令跑两个采集器，任何一个挂掉自动拉起。
 *
 *   ingest.mjs   PumpPortal：新币创建 + 迁移 + 低市值逐笔成交
 *   trades.mjs   Solana logsSubscribe：全量 pump.fun 成交（Anchor 解码）
 *
 * 用法：
 *   npm run collect              # 前台常驻（Ctrl-C 退出）
 *   nohup npm run collect > data/collector.log 2>&1 &   # 后台常驻
 *
 * 设计：不引入任何依赖。子进程崩溃 → 指数退避重启；总控退出 → 先把子进程杀干净。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

mkdirSync(join(ROOT, 'data'), { recursive: true });

const CHILDREN = [
  { name: 'ingest', script: join(__dirname, 'ingest.mjs') },
  { name: 'trades', script: join(__dirname, 'trades.mjs') },
  // 1m K 线增量聚合，供排名/图表使用
  { name: 'candles', script: join(__dirname, 'candles-worker.mjs') },
  { name: 'dex', script: join(__dirname, 'dex-worker.mjs') },
  // 持续补全新币的安全/持有者数据，避免候选信号没有风险 veto
  { name: 'enrich', script: join(__dirname, 'enrich-worker.mjs') },
];

const LOG_PATH = join(ROOT, 'data', 'collector.log');

function log(line) {
  const msg = `[collect ${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(msg);
  try {
    appendFileSync(LOG_PATH, msg);
  } catch {
    /* 日志写不了不影响采集 */
  }
}

let closing = false;
const procs = new Map(); // name -> { proc, restarts, backoff }

function start(entry) {
  const p = spawn(process.execPath, ['--no-warnings', entry.script], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = procs.get(entry.name) ?? { restarts: 0, backoff: 2000 };
  state.proc = p;
  procs.set(entry.name, state);
  log(`${entry.name} 启动 pid=${p.pid}`);

  p.stdout.on('data', (d) => process.stdout.write(`[${entry.name}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${entry.name}!] ${d}`));

  p.on('exit', (code, signal) => {
    if (closing) return;
    state.restarts++;
    log(`${entry.name} 退出 code=${code} signal=${signal}，${state.backoff}ms 后重启（第 ${state.restarts} 次）`);
    setTimeout(() => {
      if (!closing) start(entry);
    }, state.backoff);
    // 稳定运行 2 分钟则重置退避
    state.backoff = Math.min(state.backoff * 2, 60_000);
    setTimeout(() => {
      state.backoff = 2000;
    }, 120_000).unref();
  });
}

function shutdown(sig) {
  if (closing) return;
  closing = true;
  log(`收到 ${sig}，停止所有采集器`);
  for (const { proc } of procs.values()) {
    try {
      proc.kill('SIGTERM');
    } catch {}
  }
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log('采集总控启动（ingest + trades）');
log('提示：数据写入 data/meme.db；查看进度用 tail -f data/collector.log');
for (const c of CHILDREN) start(c);
