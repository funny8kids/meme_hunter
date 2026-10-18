#!/usr/bin/env node
/**
 * 每日证据报告：数据量、验证结论、实验 Top、forward shadow。
 * 只读，不改策略；用于避免“凭感觉继续跑”。
 *
 * 用法：
 *   npm run report:daily
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DB = 'data/meme.db';
const main = new DatabaseSync(DB, { readOnly: true });
main.exec('PRAGMA busy_timeout = 5000;');

const readJson = (path: string): any => {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

const count = (sql: string): number => Number((main.prepare(sql).get() as any)?.c ?? 0);
const activeMinutes = Number((main.prepare('SELECT COUNT(DISTINCT CAST(ts / 60000 AS INTEGER)) c FROM trades').get() as any)?.c ?? 0);
const firstLast = main.prepare('SELECT MIN(ts) a, MAX(ts) b FROM trades').get() as { a: number | null; b: number | null };

function shadow(path: string) {
  if (!existsSync(path)) return null;
  const d = new DatabaseSync(path, { readOnly: true });
  d.exec('PRAGMA busy_timeout = 5000;');
  const rows = d.prepare('SELECT pnl_sol, open FROM shadow_trades ORDER BY pnl_sol ASC').all() as Array<{ pnl_sol: number | null; open: number }>;
  const closed = rows.filter((r) => r.open === 0).map((r) => Number(r.pnl_sol) || 0);
  const n = closed.length;
  const pnl = closed.reduce((a, b) => a + b, 0);
  const wins = closed.filter((x) => x > 0).length;
  const gw = closed.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(closed.filter((x) => x <= 0).reduce((a, b) => a + b, 0));
  const best = n ? closed[n - 1] : 0;
  const median = n ? (n % 2 ? closed[(n - 1) / 2] : (closed[n / 2 - 1] + closed[n / 2]) / 2) : 0;
  d.close();
  return {
    closed: n,
    open: rows.filter((r) => r.open === 1).length,
    pnlSol: Number(pnl.toFixed(6)),
    winRate: n ? Number((wins / n).toFixed(4)) : 0,
    profitFactor: gl > 0 ? Number((gw / gl).toFixed(3)) : gw > 0 ? null : 0,
    bestPnlSol: Number(best.toFixed(6)),
    pnlExBestSol: Number((pnl - Math.max(0, best)).toFixed(6)),
    medianPnlSol: Number(median.toFixed(6)),
    topTradeShare: pnl > 0 && best > 0 ? Number((best / pnl).toFixed(4)) : null,
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  data: {
    tokens: count('SELECT COUNT(*) c FROM tokens'),
    trades: count('SELECT COUNT(*) c FROM trades'),
    migrations: count('SELECT COUNT(*) c FROM migrations'),
    risk: count('SELECT COUNT(*) c FROM token_risk'),
    holders: count('SELECT COUNT(*) c FROM holder_snapshots'),
    dexSnapshots: count('SELECT COUNT(*) c FROM dex_snapshots'),
    candles: count('SELECT COUNT(*) c FROM candles_1m'),
    activeHours: Number((activeMinutes / 60).toFixed(2)),
    firstTradeAt: firstLast.a ? new Date(firstLast.a).toISOString() : null,
    lastTradeAt: firstLast.b ? new Date(firstLast.b).toISOString() : null,
  },
  validation: readJson('data/reports/validation-latest.json'),
  experiments: readJson('data/reports/experiments-latest.json'),
  crashValidation: readJson('data/reports/crash-validation-latest.json'),
  shadow: {
    crash: shadow('data/shadow-crash.db'),
    crash005: shadow('data/shadow-crash-005.db'),
    wallet: shadow('data/shadow-wallet.db'),
    walletConf: shadow('data/shadow-wallet-conf.db'),
    dex: shadow('data/shadow-dex.db'),
  },
};

mkdirSync('data/reports', { recursive: true });
const day = new Date().toISOString().slice(0, 10);
const out = `data/reports/daily-${day}.json`;
writeFileSync(out, JSON.stringify(report, null, 2));

const d = report.data;
console.log(`每日报告 ${day}`);
console.log(`  数据: ${d.tokens} tokens / ${d.trades} trades / ${d.activeHours}h active / risk=${d.risk} / dex=${d.dexSnapshots}`);
console.log(`  v1: ${report.validation?.verdict ?? '—'}`);
console.log(`  experiments: ${report.experiments?.verdict ?? '—'} (${report.experiments?.profitableCount ?? '—'}/${report.experiments?.results?.length ?? '—'})`);
console.log(`  crash OOS: ${report.crashValidation?.verdict ?? '—'}`);
for (const [k, v] of Object.entries(report.shadow)) {
  if (v) console.log(`  shadow ${k}: closed=${v.closed} open=${v.open} pnl=${v.pnlSol} exBest=${v.pnlExBestSol} median=${v.medianPnlSol} top=${v.topTradeShare}`);
}
console.log(`  报告: ${out}`);
