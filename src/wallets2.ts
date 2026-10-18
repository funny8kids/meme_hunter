#!/usr/bin/env node
/**
 * 钱包 OOS 画像 v2。
 *
 * 不用“最近一次 10x”给钱包贴标签，而是：
 *   - 时间切分：前 70% 训练 / 后 30% OOS
 *   - 每币净 SOL、峰值、持仓时间、早期买入率
 *   - 标签：smart_money / sniper / insider / dev / fresh / insufficient
 *   - copyability：OOS 胜率 × 峰值 × 持仓时间 × 样本量
 *
 * 用法：
 *   node src/wallets2.ts --db data/meme.db --days 30
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(k);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const DB_PATH = arg('--db', 'data/meme.db');
const DAYS = Number(arg('--days', '30'));
const MIN_TRADES = Number(arg('--min-trades', '3'));

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 10000;');
db.exec('PRAGMA journal_mode = WAL;');
db.exec(readFileSync(join(process.cwd(), 'src', 'schema.sql'), 'utf8'));

const range = db.prepare('SELECT MIN(ts) a, MAX(ts) b FROM trades WHERE ts > 0').get() as { a: number; b: number };
const firstTs = Math.max(0, Number(range.a) || 0);
const lastTs = Math.max(firstTs, Number(range.b) || Date.now());
const since = Math.max(firstTs, lastTs - DAYS * 86_400_000);
const cut = firstTs + (lastTs - firstTs) * 0.7;

const tokenFirst = new Map<string, number>();
for (const r of db.prepare('SELECT mint, MIN(ts) t FROM trades GROUP BY mint').all() as Array<{
  mint: string;
  t: number;
}>) {
  tokenFirst.set(r.mint, r.t);
}

const outcomes = new Map<string, { peak: number; rugged: number }>();
for (const r of db.prepare('SELECT mint, peak_x, rugged FROM outcomes').all() as Array<{
  mint: string;
  peak_x: number | null;
  rugged: number | null;
}>) {
  outcomes.set(r.mint, { peak: Number(r.peak_x) || 1, rugged: Number(r.rugged) || 0 });
}

const creators = new Set(
  (db.prepare('SELECT DISTINCT creator FROM tokens WHERE creator IS NOT NULL').all() as Array<{
    creator: string;
  }>).map((r) => r.creator)
);

const rows = db
  .prepare(
    `SELECT wallet, mint,
            SUM(CASE WHEN side = 'buy' THEN sol_amount ELSE 0 END) AS buy_sol,
            SUM(CASE WHEN side = 'sell' THEN sol_amount ELSE 0 END) AS sell_sol,
            SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END) AS buys,
            SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END) AS sells,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts
     FROM trades
     WHERE ts >= ? AND side IN ('buy','sell') AND wallet IS NOT NULL AND wallet <> ''
     GROUP BY wallet, mint`
  )
  .all(since) as Array<{
  wallet: string;
  mint: string;
  buy_sol: number;
  sell_sol: number;
  buys: number;
  sells: number;
  first_ts: number;
  last_ts: number;
}>;

interface TokenStat {
  mint: string;
  buySol: number;
  sellSol: number;
  buys: number;
  sells: number;
  firstTs: number;
  lastTs: number;
  netSol: number;
  peakX: number;
  rugged: number;
  early: boolean;
  early10s: boolean;
  holdSec: number | null;
}

interface WalletAgg {
  address: string;
  tokens: TokenStat[];
  firstSeen: number;
  lastSeen: number;
  buys: number;
  sells: number;
}

const wallets = new Map<string, WalletAgg>();
for (const r of rows) {
  let w = wallets.get(r.wallet);
  if (!w) {
    w = { address: r.wallet, tokens: [], firstSeen: r.first_ts, lastSeen: r.last_ts, buys: 0, sells: 0 };
    wallets.set(r.wallet, w);
  }
  const firstTradeTs = tokenFirst.get(r.mint) ?? r.first_ts;
  const peak = outcomes.get(r.mint)?.peak ?? 1;
  const rugged = outcomes.get(r.mint)?.rugged ?? 0;
  const holdSec = r.sells > 0 ? Math.max(0, r.last_ts - r.first_ts) / 1000 : null;
  w.tokens.push({
    mint: r.mint,
    buySol: Number(r.buy_sol) || 0,
    sellSol: Number(r.sell_sol) || 0,
    buys: Number(r.buys) || 0,
    sells: Number(r.sells) || 0,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    netSol: (Number(r.sell_sol) || 0) - (Number(r.buy_sol) || 0),
    peakX: peak,
    rugged,
    early: r.first_ts <= firstTradeTs + 60_000,
    early10s: r.first_ts <= firstTradeTs + 10_000,
    holdSec,
  });
  w.firstSeen = Math.min(w.firstSeen, r.first_ts);
  w.lastSeen = Math.max(w.lastSeen, r.last_ts);
  w.buys += Number(r.buys) || 0;
  w.sells += Number(r.sells) || 0;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stats(tokens: TokenStat[]) {
  const wins = tokens.filter((t) => t.netSol > 0);
  const winRate = tokens.length ? wins.length / tokens.length : 0;
  const avgPeak = tokens.length ? tokens.reduce((a, t) => a + t.peakX, 0) / tokens.length : 0;
  const bestPeak = tokens.reduce((a, t) => Math.max(a, t.peakX), 0);
  const net = tokens.reduce((a, t) => a + t.netSol, 0);
  const holds = tokens.map((t) => t.holdSec).filter((x): x is number => x != null && x > 0);
  const early = tokens.length ? tokens.filter((t) => t.early).length / tokens.length : 0;
  const early10s = tokens.length ? tokens.filter((t) => t.early10s).length / tokens.length : 0;
  return { wins: wins.length, winRate, avgPeak, bestPeak, net, medianHold: median(holds), early, early10s };
}

const up = db.prepare(`
  INSERT INTO wallet_profiles (
    address, updated_at, window_days, trades, tokens_traded, buys, sells, first_seen, last_seen,
    realized_proxy_sol, win_rate, avg_peak_x, median_hold_sec, best_peak_x, max_drawdown_pct, score,
    labels, oos_trades, oos_win_rate, oos_avg_peak_x, early_buy_rate, copyability, insufficient
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(address) DO UPDATE SET
    updated_at=excluded.updated_at, window_days=excluded.window_days, trades=excluded.trades,
    tokens_traded=excluded.tokens_traded, buys=excluded.buys, sells=excluded.sells,
    first_seen=excluded.first_seen, last_seen=excluded.last_seen,
    realized_proxy_sol=excluded.realized_proxy_sol, win_rate=excluded.win_rate,
    avg_peak_x=excluded.avg_peak_x, median_hold_sec=excluded.median_hold_sec,
    best_peak_x=excluded.best_peak_x, max_drawdown_pct=excluded.max_drawdown_pct,
    score=excluded.score, labels=excluded.labels, oos_trades=excluded.oos_trades,
    oos_win_rate=excluded.oos_win_rate, oos_avg_peak_x=excluded.oos_avg_peak_x,
    early_buy_rate=excluded.early_buy_rate, copyability=excluded.copyability,
    insufficient=excluded.insufficient
`);

db.exec('BEGIN');
let written = 0;
try {
  db.exec('DELETE FROM wallet_profiles');
  for (const w of wallets.values()) {
    if (w.tokens.length < 0) continue;
    const all = stats(w.tokens);
    const oosTokens = w.tokens.filter((t) => t.firstTs >= cut);
    const oos = stats(oosTokens);
    if (w.tokens.length < MIN_TRADES) {
      // 仍然保留，但标记样本不足，前端可过滤
    }

    const ordered = [...w.tokens].sort((a, b) => a.firstTs - b.firstTs);
    let equity = 0;
    let peak = 0;
    let maxDdSol = 0;
    for (const t of ordered) {
      equity += t.netSol;
      peak = Math.max(peak, equity);
      maxDdSol = Math.max(maxDdSol, peak - equity);
    }
    const maxDdPct = peak > 0 ? (maxDdSol / peak) * 100 : 0;

    const hold = all.medianHold;
    const holdFactor = hold == null ? 0.5 : hold < 10 ? 0.55 : hold <= 3600 ? 1 : hold <= 86_400 ? 0.75 : 0.4;
    const sampleFactor = Math.min(1, oosTokens.length / 10);
    const profitable = all.net > 0 && (oosTokens.length < 3 || oos.net > 0);
    const copyability = Math.max(
      0,
      Math.min(
        1,
        (oos.winRate * Math.min(1.5, Math.max(0.5, oos.avgPeak / 2)) * holdFactor * sampleFactor) *
          (profitable ? 1 : 0.25)
      )
    );

    const positiveTokens = w.tokens.filter((t) => t.netSol > 0);
    const positiveSum = positiveTokens.reduce((a, t) => a + t.netSol, 0);
    const topPositive = positiveTokens.reduce((a, t) => Math.max(a, t.netSol), 0);
    const topShare = positiveSum > 0 ? topPositive / positiveSum : 0;
    const concentrated = topShare >= 0.7 && w.tokens.length >= 5;
    const labels: string[] = [];
    if (creators.has(w.address)) labels.push('dev');
    if (oosTokens.length < 3) labels.push('insufficient');
    if (profitable && oos.winRate >= 0.55 && oosTokens.length >= 3 && oos.avgPeak >= 1.5 && !concentrated) {
      labels.push('smart_money');
    }
    if (all.net < -0.05) labels.push('unprofitable');
    if (all.early >= 0.6 && (hold == null || hold < 120) && w.buys >= 3) labels.push('sniper');
    if (all.early10s >= 0.8 && w.buys >= 3) labels.push('insider_early');
    if (w.tokens.length < 3) labels.push('fresh');
    if (copyability >= 0.5 && profitable && !concentrated) labels.push('copyable');
    if (concentrated) labels.push('one_hit');
    if (w.tokens.length >= 10 && topShare <= 0.4 && profitable) labels.push('diversified');
    if (w.tokens.length >= 10 && w.buys >= 10 && w.sells > 0 && w.buys / w.sells >= 0.7 && w.buys / w.sells <= 1.4 && (hold ?? 0) > 0 && (hold ?? 0) < 300) labels.push('high_turnover');

    const winRate = all.winRate;
    const avgPeak = Math.max(1, all.avgPeak);
    const baseScore = (winRate * avgPeak - (1 - winRate)) * Math.min(1, w.tokens.length / 12);
    const score = (baseScore * 0.4 + copyability * 0.6) * (profitable ? 1 : 0.3);

    up.run(
      w.address,
      Date.now(),
      DAYS,
      w.buys + w.sells,
      w.tokens.length,
      w.buys,
      w.sells,
      w.firstSeen,
      w.lastSeen,
      Number(all.net.toFixed(6)),
      Number(winRate.toFixed(4)),
      Number(avgPeak.toFixed(4)),
      hold == null ? null : Number(hold.toFixed(1)),
      Number(all.bestPeak.toFixed(4)),
      Number(maxDdPct.toFixed(2)),
      Number(score.toFixed(4)),
      JSON.stringify([...new Set(labels)]),
      oosTokens.length,
      Number(oos.winRate.toFixed(4)),
      Number(oos.avgPeak.toFixed(4)),
      Number(all.early.toFixed(4)),
      Number(copyability.toFixed(4)),
      oosTokens.length < 3 ? 1 : 0
    );
    written++;
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

const summary = db.prepare(`
  SELECT COUNT(*) n,
         SUM(CASE WHEN copyability >= 0.5 THEN 1 ELSE 0 END) copyable,
         SUM(CASE WHEN oos_trades >= 3 THEN 1 ELSE 0 END) oos_ok,
         SUM(CASE WHEN labels LIKE '%smart_money%' THEN 1 ELSE 0 END) smart
  FROM wallet_profiles
`).get();
console.log(`[wallets2] wallets=${written} summary=${JSON.stringify(summary)} cut=${new Date(cut).toISOString()}`);
db.close();
