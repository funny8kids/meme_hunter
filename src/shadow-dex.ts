#!/usr/bin/env node
/**
 * Forward shadow：迁移后 DEX 策略。
 *
 * 只用 DexScreener 快照（不假装有 DEX 逐笔历史）：
 *   迁移后 2–30 分钟、流动性 ≥ $5k → 观察入场
 *   TP +50% / SL -30% / 30 分钟超时
 *
 * 独立 SQLite，不碰 runner/positions，不吃资金。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sizeForLiquidity } from './engine/impact.ts';

const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(k);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const MAIN = arg('--db', 'data/meme.db');
const SHADOW_DB = arg('--shadow-db', 'data/shadow-dex.db');
const SIZE = Number(arg('--size', '0.02'));
const POLL = Number(arg('--poll', '30000'));
const TP = Number(arg('--tp', '0.5'));
const SL = Number(arg('--sl', '0.3'));
const MAX_HOLD_MS = Number(arg('--max-hold-min', '30')) * 60_000;
const MIN_LIQ = Number(arg('--min-liquidity', '5000'));
const DELAY_MS = Number(arg('--delay-min', '2')) * 60_000;
const EXIT_HAIRCUT = Math.max(0, Math.min(0.5, Number(arg('--exit-haircut', '0.05'))));
const MAX_OPEN = Math.max(1, Number(arg('--max-open', '5')));
const SOL_USD = Math.max(1, Number(arg('--sol-usd', '200')));
const MAX_IMPACT_PCT = Math.max(0.0001, Math.min(0.5, Number(arg('--max-impact-pct', '0.015'))));
const MIN_SIZE_SOL = Math.max(0.0001, Number(arg('--min-size', '0.005')));

mkdirSync(dirname(SHADOW_DB), { recursive: true });
const main = new DatabaseSync(MAIN, { readOnly: true });
main.exec('PRAGMA busy_timeout = 10000;');
const shadow = new DatabaseSync(SHADOW_DB);
shadow.exec('PRAGMA busy_timeout = 10000;');
shadow.exec(`
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS shadow_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy TEXT NOT NULL,
    mint TEXT NOT NULL,
    symbol TEXT,
    entry_ts INTEGER NOT NULL,
    entry_mcap REAL NOT NULL,
    exit_ts INTEGER,
    exit_mcap REAL,
    pnl_pct REAL,
    pnl_sol REAL,
    reason TEXT,
    open INTEGER NOT NULL DEFAULT 1,
    size_sol REAL NOT NULL
  );
`);
const getState = (k: string): string | null =>
  (shadow.prepare('SELECT value FROM state WHERE key=?').get(k) as { value: string } | undefined)?.value ?? null;
const setState = (k: string, v: string): void => {
  shadow.prepare('INSERT INTO state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
};

const maxTs = (main.prepare('SELECT COALESCE(MAX(ts),0) m FROM dex_snapshots').get() as { m: number }).m;
let cursor = Number(getState('cursor') ?? maxTs);
const insert = shadow.prepare(
  `INSERT INTO shadow_trades (strategy, mint, symbol, entry_ts, entry_mcap, open, size_sol)
   VALUES ('dex', ?, ?, ?, ?, 1, ?)`
);
const closeStmt = shadow.prepare(
  `UPDATE shadow_trades SET exit_ts=?, exit_mcap=?, pnl_pct=?, pnl_sol=?, reason=?, open=0 WHERE id=?`
);
const open = new Map<
  string,
  { id: number; mint: string; entryTs: number; entryPrice: number; symbol: string; sizeSol: number }
>();
for (const r of shadow.prepare('SELECT * FROM shadow_trades WHERE open=1').all() as Array<{
  id: number;
  mint: string;
  entry_ts: number;
  entry_mcap: number;
  symbol: string | null;
  size_sol: number;
}>) {
  open.set(r.mint, {
    id: r.id,
    mint: r.mint,
    entryTs: r.entry_ts,
    entryPrice: r.entry_mcap,
    symbol: r.symbol ?? '',
    sizeSol: r.size_sol,
  });
}
const cooldown = new Map<string, number>();
const riskStmt = main.prepare('SELECT risk_score, risk_flags FROM token_risk WHERE mint = ?');
function blockedByRisk(mint: string): boolean {
  const r = riskStmt.get(mint) as { risk_score: number | null; risk_flags: string | null } | undefined;
  if (!r) return false;
  if ((r.risk_score ?? 0) >= 70) return true;
  try {
    const flags = JSON.parse(r.risk_flags ?? '[]') as string[];
    return flags.some((f) => ['honeypot', 'mint_authority', 'freeze_authority', 'dev_rug_history', 'top10_over_50pct'].includes(f));
  } catch {
    return false;
  }
}
const meta = new Map<string, { symbol: string }>();
for (const r of main.prepare('SELECT mint, symbol FROM tokens').all() as Array<{
  mint: string;
  symbol: string | null;
}>) {
  meta.set(r.mint, { symbol: r.symbol ?? '' });
}

function log(line: string): void {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(msg);
  try { appendFileSync('data/shadow-dex.log', msg + '\n'); } catch { /* ignore */ }
}

function close(mint: string, ts: number, price: number, reason: string): void {
  const p = open.get(mint);
  if (!p) return;
  const exitPrice = price * (1 - EXIT_HAIRCUT);
  const gross = p.entryPrice > 0 ? exitPrice / p.entryPrice - 1 : -1;
  const pnl = p.entryPrice > 0 ? p.sizeSol * gross - p.sizeSol * 0.03 - 0.001 : -p.sizeSol;
  closeStmt.run(ts, exitPrice, gross, pnl, reason, p.id);
  open.delete(mint);
  cooldown.set(mint, ts + 15 * 60_000);
  log(`CLOSE ${p.symbol || mint.slice(0, 8)} ${reason} ${(gross * 100).toFixed(1)}% ${pnl.toFixed(5)}`);
}

function step(): void {
  const rows = main
    .prepare(
      `SELECT d.mint, d.ts, d.price_usd, d.liquidity_usd, d.dex_id, m.ts AS migrated_at, t.symbol
       FROM dex_snapshots d
       JOIN migrations m ON m.mint = d.mint
       LEFT JOIN tokens t ON t.mint = d.mint
       WHERE d.ts > ? ORDER BY d.ts ASC LIMIT 300`
    )
    .all(cursor) as Array<{
    mint: string;
    ts: number;
    price_usd: number;
    liquidity_usd: number;
    dex_id: string;
    migrated_at: number;
    symbol: string | null;
  }>;
  if (!rows.length) return;

  for (const r of rows) {
    cursor = Math.max(cursor, r.ts);
    const price = Number(r.price_usd);
    if (!(price > 0)) continue;

    const p = open.get(r.mint);
    if (p) {
      const mult = p.entryPrice > 0 ? price / p.entryPrice : 1;
      if (mult >= 1 + TP) close(r.mint, r.ts, price, 'take_profit');
      else if (mult <= 1 - SL) close(r.mint, r.ts, price, 'stop_loss');
      else if (r.ts - p.entryTs >= MAX_HOLD_MS) close(r.mint, r.ts, price, 'timeout');
      continue;
    }
    if (open.has(r.mint)) continue;
    if (open.size >= MAX_OPEN) continue;
    const cool = cooldown.get(r.mint);
    if (cool !== undefined && r.ts < cool) continue;
    const age = r.ts - Number(r.migrated_at);
    if (age < DELAY_MS || age > 30 * 60_000) continue;
    if ((Number(r.liquidity_usd) || 0) < MIN_LIQ) continue;
    if (blockedByRisk(r.mint)) continue;
    const symbol = r.symbol ?? meta.get(r.mint)?.symbol ?? '';
    const sizeSol = Math.min(
      SIZE,
      sizeForLiquidity(SIZE, (Number(r.liquidity_usd) || 0) / SOL_USD, MAX_IMPACT_PCT)
    );
    if (sizeSol < MIN_SIZE_SOL) continue;
    const res = insert.run(r.mint, symbol, r.ts, price, sizeSol);
    open.set(r.mint, {
      id: Number(res.lastInsertRowid),
      mint: r.mint,
      entryTs: r.ts,
      entryPrice: price,
      symbol,
      sizeSol,
    });
    log(`OPEN ${symbol || r.mint.slice(0, 8)} $${price} liq=$${Math.round(Number(r.liquidity_usd))} size=${sizeSol.toFixed(4)}`);
  }
  setState('cursor', String(cursor));
  setState('updated_at', String(Date.now()));
}

log(`START dex shadow cursor=${cursor} size=${SIZE} liq>=$${MIN_LIQ} maxOpen=${MAX_OPEN} impact<=${(MAX_IMPACT_PCT * 100).toFixed(2)}% solUsd=${SOL_USD}`);
setInterval(() => {
  try { step(); } catch (e) { console.error('[shadow-dex]', e); }
}, POLL);
step();
