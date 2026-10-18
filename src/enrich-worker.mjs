#!/usr/bin/env node
import { spawn } from 'node:child_process';

const INTERVAL_MS = 120_000;
const LIMIT = process.env.ENRICH_LIMIT ?? '8';

function run() {
  const p = spawn(process.execPath, ['--no-warnings', 'src/enrich.ts', '--limit', LIMIT, '--no-social'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.stdout.write(`[enrich] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[enrich!] ${d}`));
  p.on('exit', () => setTimeout(run, INTERVAL_MS));
}

run();
