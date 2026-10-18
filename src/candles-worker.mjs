#!/usr/bin/env node
/**
 * 每分钟增量聚合 1m K 线。由 collect.mjs 拉起，避免前端/排名全量扫 trades。
 */

import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const INTERVAL_MS = 20_000;

function run() {
  const p = spawn(process.execPath, ['--no-warnings', 'src/candles.ts', '--since-min', '15'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.stdout.write(`[candles] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[candles!] ${d}`));
  p.on('exit', (code) => {
    if (code !== 0) console.error(`[candles] exit ${code}`);
    setTimeout(run, INTERVAL_MS);
  });
}

run();
