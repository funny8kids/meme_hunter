#!/usr/bin/env node
import { spawn } from 'node:child_process';

const INTERVAL_MS = 90_000;
function run() {
  const p = spawn(process.execPath, ['--no-warnings', 'src/dex.ts', '--db', 'data/meme.db', '--limit', '80'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.stdout.write(`[dex] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[dex!] ${d}`));
  p.on('exit', () => setTimeout(run, INTERVAL_MS));
}
run();
