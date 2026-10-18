#!/usr/bin/env node
/**
 * Forward shadow book：不吃资金、不下单，只把候选策略的**未来**信号按真实延迟/成本
 * 记成纸面交易。用于回答一个唯一的问题：它在采集器继续跑之后，是否仍然正期望。
 *
 * 候选：
 *   crash  —— 创建 5–30 分钟、较首笔市值回撤 ≥50%、5m 仍有成交
 *   wallet —— 当前 OOS smart_money / copyable 钱包在买入后 3 秒跟单
 *
 * 两个策略各用一个独立 SQLite，互不污染，也不碰 runner/positions。
 *
 * 用法：
 *   node src/shadow.ts --strategy crash  --shadow-db data/shadow-crash.db
 *   node src/shadow.ts --strategy wallet --shadow-db data/shadow-wallet.db
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { FeatureEngine } from './engine/features.ts';
import { sizeForLiquidity } from './engine/impact.ts';

const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(k);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const STRATEGY = arg('--strategy', 'crash') as 'crash' | 'wallet';
const DB = arg('--db', 'data/meme.db');
const SHADOW_DB = arg('--shadow-db', `data/shadow-${STRATEGY}.db`);
const SIZE = Number(arg('--size', '0.01'));
const POLL = Number(arg('--poll', '2000'));
const ENTRY_DELAY = Number(arg('--entry-delay-ms', '3000'));
const TP = Number(arg('--tp', '1.0'));
const SL = Number(arg('--sl', '0.5'));
const MAX_HOLD_MS = Number(arg('--max-hold-min', '30')) * 60_000;
const COOLDOWN_MS = Number(arg('--cooldown-min', '10')) * 60_000;
const STALE_MS = Number(arg('--stale-min', '15')) * 60_000;
const MIN_WALLETS = Math.max(1, Number(arg('--min-wallets', '1')));
const CONFLUENCE_MS = Number(arg('--confluence-sec', '60')) * 1000;
const EXIT_HAIRCUT = Math.max(0, Math.min(0.5, Number(arg('--exit-haircut', '0.05'))));
const MAX_OPEN = Math.max(1, Number(arg('--max-open', '10')));
const MAX_IMPACT_PCT = Math.max(0.0001, Math.min(0.5, Number(arg('--max-impact-pct', '0.015'))));
const MIN_SIZE_SOL = Math.max(0.0001, Number(arg('--min-size', '0.005')));
const MIN_COPYABILITY = Math.max(0, Math.min(1, Number(arg('--min-copyability', '0'))));
const MIN_OOS_TRADES = Math.max(0, Number(arg('--min-oos', '0')));

mkdirSync(dirname(SHADOW_DB), { recursive: true });
const main = new DatabaseSync(DB, { readOnly: true });
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
  CREATE INDEX IF NOT EXISTS idx_shadow_open ON shadow_trades(open);
  CREATE INDEX IF NOT EXISTS idx_shadow_mint ON shadow_trades(mint);
`);

const getState = (k: string): string | null =>
  (shadow.prepare('SELECT value FROM state WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null;
const setState = (k: string, v: string): void => {
  shadow
    .prepare('INSERT INTO state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(k, v);
};

const maxRow = (main.prepare('SELECT COALESCE(MAX(rowid),0) m FROM trades').get() as { m: number }).m;
let cursor = Number(getState('cursor') ?? maxRow);

const tokenMeta = new Map<string, { symbol: string; name: string; creator: string; createdAt: number }>();
for (const r of main
  .prepare('SELECT mint, symbol, name, creator, created_at FROM tokens')
  .all() as Array<{ mint: string; symbol: string | null; name: string | null; creator: string | null; created_at: number }>) {
  tokenMeta.set(r.mint, {
    symbol: r.symbol ?? '',
    name: r.name ?? '',
    creator: r.creator ?? '',
    createdAt: Number(r.created_at) || 0,
  });
}

let smart = new Set<string>();
if (STRATEGY === 'wallet') {
  for (const r of main
    .prepare(
      `SELECT address FROM wallet_profiles
       WHERE (labels LIKE '%"smart_money"%' OR labels LIKE '%"copyable"%')
         AND copyability >= ? AND oos_trades >= ?
       ORDER BY copyability DESC, score DESC LIMIT 300`
    )
    .all(MIN_COPYABILITY, MIN_OOS_TRADES) as Array<{ address: string }>) {
    smart.add(r.address);
  }
  console.log(`[shadow:wallet] wallets=${smart.size}`);
}

if (STRATEGY === 'crash') {
  console.log(`[shadow:crash] size=${SIZE} tp=${TP} sl=${SL} maxHold=${MAX_HOLD_MS / 60000}m`);
}

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

const smartBuys = new Map<string, Array<{ wallet: string; ts: number }>>();
const features = new FeatureEngine();
const lastMcap = new Map<string, number>();
const lastLiquidity = new Map<string, number>();
const lastTradeAt = new Map<string, number>();
const cooldown = new Map<string, number>();
interface Pending {
  mint: string;
  executeAt: number;
  expiresAt: number;
  sizeSol: number;
}
const pending = new Map<string, Pending>();
interface OpenPos {
  id: number;
  mint: string;
  entryTs: number;
  entryMcap: number;
  sizeSol: number;
}
const open = new Map<string, OpenPos>();

for (const r of shadow.prepare('SELECT * FROM shadow_trades WHERE open = 1').all() as Array<{
  id: number;
  mint: string;
  entry_ts: number;
  entry_mcap: number;
  size_sol: number;
}>) {
  open.set(r.mint, { id: r.id, mint: r.mint, entryTs: r.entry_ts, entryMcap: r.entry_mcap, sizeSol: r.size_sol });
}

const insertTrade = shadow.prepare(`
  INSERT INTO shadow_trades (strategy, mint, symbol, entry_ts, entry_mcap, open, size_sol)
  VALUES (?,?,?,?,?,1,?)
`);
const closeTrade = shadow.prepare(`
  UPDATE shadow_trades SET exit_ts=?, exit_mcap=?, pnl_pct=?, pnl_sol=?, reason=?, open=0 WHERE id=?
`);

const LOG_FILE = join('data', `${basename(SHADOW_DB).replace(/\.db$/, '')}.log`);
function log(line: string): void {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(msg);
  try {
    appendFileSync(LOG_FILE, msg + '\n');
  } catch {
    /* ignore */
  }
}

function close(mint: string, ts: number, mcap: number, reason: string, haircut = 1): void {
  const p = open.get(mint);
  if (!p) return;
  const exitPrice = mcap * haircut * (1 - EXIT_HAIRCUT);
  const gross = p.entryMcap > 0 ? exitPrice / p.entryMcap - 1 : -1;
  // 往返：平台费 2% + 额外滑点 3% + 固定优先费 0.001 SOL
  const costPct = 0.05;
  const pnlSol = p.sizeSol * gross - p.sizeSol * costPct - 0.001;
  closeTrade.run(ts, exitPrice, gross, pnlSol, reason, p.id);
  open.delete(mint);
  cooldown.set(mint, ts + COOLDOWN_MS);
  log(`CLOSE ${mint.slice(0, 8)} ${reason} gross=${(gross * 100).toFixed(1)}% pnl=${pnlSol.toFixed(5)} SOL`);
}

function openPos(mint: string, ts: number, mcap: number, sizeSol: number): void {
  if (open.has(mint) || !(mcap > 0) || !(sizeSol > 0)) return;
  const meta = tokenMeta.get(mint);
  const res = insertTrade.run(STRATEGY, mint, meta?.symbol ?? '', ts, mcap, sizeSol);
  const id = Number(res.lastInsertRowid);
  open.set(mint, { id, mint, entryTs: ts, entryMcap: mcap, sizeSol });
  log(`OPEN ${mint.slice(0, 8)} mcap=${mcap.toFixed(2)} size=${sizeSol.toFixed(4)} symbol=${meta?.symbol ?? ''}`);
}

function step(): void {
  const rows = main
    .prepare(
      `SELECT rowid AS rid, mint, ts, side, wallet, sol_amount, market_cap_sol, v_sol
       FROM trades WHERE rowid > ? AND market_cap_sol IS NOT NULL AND side IN ('buy','sell')
       ORDER BY rowid ASC LIMIT 1000`
    )
    .all(cursor) as Array<{
    rid: number;
    mint: string;
    ts: number;
    side: string;
    wallet: string;
    sol_amount: number;
    market_cap_sol: number;
    v_sol: number;
  }>;
  if (!rows.length) return;

  for (const r of rows) {
    cursor = Number(r.rid);
    const ts = Number(r.ts);
    const mcap = Number(r.market_cap_sol);
    const prevTradeAt = lastTradeAt.get(r.mint);
    lastMcap.set(r.mint, mcap);
    if (Number(r.v_sol) > 0) lastLiquidity.set(r.mint, Number(r.v_sol));
    lastTradeAt.set(r.mint, ts);

    // 1) 已知持仓：先检查离场
    for (const [mint, p] of open) {
      const cur = lastMcap.get(mint) ?? p.entryMcap;
      const mult = p.entryMcap > 0 ? cur / p.entryMcap : 1;
      const staleRef = mint === r.mint ? prevTradeAt : lastTradeAt.get(mint);
      if (mult >= 1 + TP) close(mint, ts, cur, 'take_profit');
      else if (mult <= 1 - SL) close(mint, ts, cur, 'stop_loss');
      else if (ts - p.entryTs >= MAX_HOLD_MS) close(mint, ts, cur, 'timeout');
      else if (staleRef != null && ts - staleRef > STALE_MS) close(mint, ts, cur, 'stale_exit', 0.5);
    }

    // 2) 延迟入场
    if (STRATEGY === 'crash') {
      // 只对新成交建特征；FeatureEngine 会从首笔成交兜底
      const evt = {
        seq: Number(r.rid),
        tsWall: ts,
        tsMono: ts,
        v: 1,
        type: 'Trade' as const,
        payload: {
          mint: r.mint,
          side: r.side === 'sell' ? ('sell' as const) : ('buy' as const),
          wallet: r.wallet ?? '',
          sol: Number(r.sol_amount) || 0,
          tokens: 0,
          vSol: 0,
          vTokens: 0,
          mcapSol: mcap,
          sig: `shadow-${r.rid}`,
        },
      };
      features.onEvent(evt);
    }

    const pe = pending.get(r.mint);
    if (pe && ts >= pe.executeAt) {
      pending.delete(r.mint);
      openPos(r.mint, ts, mcap, pe.sizeSol);
    }

    // 3) 新信号
    if (open.has(r.mint) || pending.has(r.mint)) continue;
    if (open.size >= MAX_OPEN) continue;
    const cool = cooldown.get(r.mint);
    if (cool !== undefined && ts < cool) continue;

    let signal = false;
    if (STRATEGY === 'wallet') {
      if (r.side === 'buy' && r.wallet && smart.has(r.wallet)) {
        const arr = smartBuys.get(r.mint) ?? [];
        arr.push({ wallet: r.wallet, ts });
        while (arr.length && arr[0].ts < ts - CONFLUENCE_MS) arr.shift();
        smartBuys.set(r.mint, arr);
        const unique = new Set(arr.map((x) => x.wallet)).size;
        if (unique >= MIN_WALLETS) signal = true;
      }
    } else {
      const f = features.get(r.mint);
      if (f && f.ageSec >= 300 && f.ageSec <= 1800 && f.growthX <= 0.5 && f.trades5m >= 3) signal = true;
    }
    if (!signal) continue;
    if (blockedByRisk(r.mint)) continue;
    const sizeSol = Math.min(
      SIZE,
      sizeForLiquidity(SIZE, lastLiquidity.get(r.mint) ?? 0, MAX_IMPACT_PCT)
    );
    if (sizeSol < MIN_SIZE_SOL) continue;

    pending.set(r.mint, {
      mint: r.mint,
      executeAt: ts + ENTRY_DELAY,
      expiresAt: ts + ENTRY_DELAY + 30_000,
      sizeSol,
    });
  }

  // 过期未成交：用墙钟，不依赖该币是否还有成交
  const now = Date.now();
  for (const [mint, p] of pending) {
    if (now > p.expiresAt) pending.delete(mint);
  }

  setState('cursor', String(cursor));
  shadow.prepare(
    `INSERT INTO state (key,value) VALUES ('updated_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(String(Date.now()));
}

log(`START strategy=${STRATEGY} cursor=${cursor} size=${SIZE} impact<=${(MAX_IMPACT_PCT * 100).toFixed(2)}% minSize=${MIN_SIZE_SOL} minWallets=${MIN_WALLETS} minCopy=${MIN_COPYABILITY} minOOS=${MIN_OOS_TRADES} confluence=${CONFLUENCE_MS / 1000}s maxOpen=${MAX_OPEN} shadow=${SHADOW_DB}`);
setInterval(() => {
  try {
    step();
  } catch (e) {
    console.error('[shadow] step error', e);
  }
}, POLL);
step();
