#!/usr/bin/env node
/**
 * 钱包画像：从自己的成交数据里回算「谁是聪明钱」，零 API 成本。
 *
 * 每条记录的买 buy 都被当成一次「下注」：
 *   - 前向收益：该笔买入之后 W 分钟内的峰值倍数（≤ 数据边界）
 *   - 命中：峰值 ≥ --win-x（默认 2 倍）
 *   - 现金流：卖出总额 − 买入总额（数据集内的已实现盈亏代理）
 *   - 抢早率：买入发生在币创建后 --early-sec 秒内的比例
 *
 * 输出：写入 wallets 表 + 排行榜（按期望倍数 / 按现金流两种视角）。
 *
 * 诚实的边界：
 *   - 只覆盖我们采集到的币；未平仓的买入计为已支出（现金流偏保守）。
 *   - 「买入后峰值」不等于该钱包真的卖在了峰值，这是上限而非已实现收益。
 *   - 需要至少几天的数据才谈得上统计意义（先用 --min-buys 过滤）。
 *
 * 用法：
 *   node src/wallets.ts --db data/meme.db --min-buys 5 --top 20
 */

import { DatabaseSync } from 'node:sqlite';
import { buildFwdWindowMax, median } from './engine/forwardmath.ts';

// ---------------- 参数 ----------------

const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(k);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};

const DB_PATH = arg('--db', 'data/meme.db');
const WINDOW_MS = Number(arg('--window-min', '60')) * 60_000;
const WIN_X = Number(arg('--win-x', '2'));
const EARLY_SEC = Number(arg('--early-sec', '60'));
const MIN_BUYS = Number(arg('--min-buys', '3'));
const TOP = Number(arg('--top', '20'));
const ROW_LIMIT = Number(arg('--limit', '5000000'));
const WRITE = !argv.includes('--no-write');

// ---------------- 数据模型 ----------------

interface TradeRow {
  mint: string;
  ts: number;
  side: string | null;
  wallet: string | null;
  sol_amount: number | null;
  token_amount: number | null;
  market_cap_sol: number | null;
  v_sol: number | null;
  v_tokens: number | null;
}

interface WalletAgg {
  address: string;
  firstSeen: number;
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  mints: Set<string>;
  wins: number;
  peakMults: number[];
  earlyBuys: number;
  buyAgeSum: number;
}

function newWallet(address: string, ts: number): WalletAgg {
  return {
    address,
    firstSeen: ts,
    buys: 0,
    sells: 0,
    solIn: 0,
    solOut: 0,
    mints: new Set<string>(),
    wins: 0,
    peakMults: [],
    earlyBuys: 0,
    buyAgeSum: 0,
  };
}

// ---------------- 读取 ----------------

const db = new DatabaseSync(DB_PATH, { readOnly: true });

// 币创建时间（用于抢早率；缺失时用该币首笔成交时间兜底）
const createdAt = new Map<string, number>();
for (const t of db
  .prepare('SELECT mint, created_at FROM tokens')
  .all() as Array<{ mint: string; created_at: number | null }>) {
  if (t.created_at != null) createdAt.set(t.mint, t.created_at);
}

const stmt = db.prepare(
  `SELECT mint, ts, side, wallet, sol_amount, token_amount, market_cap_sol, v_sol, v_tokens
   FROM trades
   WHERE market_cap_sol IS NOT NULL AND side IN ('buy','sell') AND wallet IS NOT NULL
   ORDER BY mint ASC, ts ASC, rowid ASC
   LIMIT ?`
);

const wallets = new Map<string, WalletAgg>();
const total = { trades: 0, buysm: 0, wallets: 0 };
const t0 = Date.now();

function processMint(mint: string, rows: TradeRow[]): void {
  const n = rows.length;
  const ts = new Float64Array(n);
  const mcap = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ts[i] = rows[i].ts;
    mcap[i] = rows[i].market_cap_sol ?? 0;
  }
  const fwd = buildFwdWindowMax(ts, mcap, WINDOW_MS);
  const created = createdAt.get(mint) ?? ts[0];

  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const w = String(r.wallet);
    let a = wallets.get(w);
    if (!a) {
      a = newWallet(w, r.ts);
      wallets.set(w, a);
    }
    if (r.ts < a.firstSeen) a.firstSeen = r.ts;
    a.mints.add(mint);

    const sol = r.sol_amount ?? 0;
    if (r.side === 'buy') {
      total.buysm++;
      a.buys++;
      a.solIn += sol;
      const ageSec = Math.max(0, (r.ts - created) / 1000);
      a.buyAgeSum += ageSec;
      if (ageSec <= EARLY_SEC) a.earlyBuys++;
      const peak = fwd[i];
      if (Number.isFinite(peak) && mcap[i] > 0) {
        const mult = peak / mcap[i];
        a.peakMults.push(mult);
        if (mult >= WIN_X) a.wins++;
      }
    } else {
      a.sells++;
      a.solOut += sol;
    }
  }
  total.trades += n;
}

let currentMint: string | null = null;
let currentRows: TradeRow[] = [];
for (const row of stmt.iterate(ROW_LIMIT) as IterableIterator<TradeRow>) {
  if (row.mint !== currentMint) {
    if (currentMint !== null && currentRows.length) processMint(currentMint, currentRows);
    currentMint = row.mint;
    currentRows = [];
  }
  currentRows.push(row);
}
if (currentMint !== null && currentRows.length) processMint(currentMint, currentRows);
db.close();

total.wallets = wallets.size;
const elapsedMs = Date.now() - t0;

// ---------------- 汇总 ----------------

interface Row {
  address: string;
  buys: number;
  mints: number;
  wins: number;
  winRate: number;
  avgPeakX: number;
  medPeakX: number;
  cashflowSol: number;
  earlyPct: number;
  avgAgeSec: number;
  score: number;
}

const rows: Row[] = [];
for (const a of wallets.values()) {
  if (a.buys < MIN_BUYS) continue;
  const winRate = a.buys ? a.wins / a.buys : 0;
  const avgPeakX = a.peakMults.length ? a.peakMults.reduce((x, y) => x + y, 0) / a.peakMults.length : 0;
  const medPeakX = median(a.peakMults);
  // score = 期望倍数代理：胜率 × 平均峰值倍数（都是「买入后」口径，口径一致可比较）
  const score = winRate * avgPeakX;
  rows.push({
    address: a.address,
    buys: a.buys,
    mints: a.mints.size,
    wins: a.wins,
    winRate,
    avgPeakX,
    medPeakX,
    cashflowSol: a.solOut - a.solIn,
    earlyPct: a.buys ? a.earlyBuys / a.buys : 0,
    avgAgeSec: a.buys ? a.buyAgeSum / a.buys : 0,
    score,
  });
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : '—');
const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;

console.log(`\n═══ 钱包画像 ═══  [${DB_PATH}]`);
console.log(
  `成交 ${total.trades} 笔（买 ${total.buysm}）  钱包 ${total.wallets} 个  ` +
    `过滤后（≥${MIN_BUYS} 次买入）${rows.length} 个  耗时 ${(elapsedMs / 1000).toFixed(1)}s`
);
if (!rows.length) {
  console.log('数据太少，先积累几天再跑。');
  process.exit(0);
}

const byScore = [...rows].sort((a, b) => b.score - a.score).slice(0, TOP);
const byCash = [...rows].sort((a, b) => b.cashflowSol - a.cashflowSol).slice(0, TOP);

console.log(`\n① 按「期望倍数」排序（胜率 × 平均峰值倍数）`);
console.log(
  '   ' +
    '钱包'.padEnd(12) +
    '买入'.padStart(6) +
    '币数'.padStart(6) +
    `胜率(≥${WIN_X}x)`.padStart(11) +
    '平均峰值'.padStart(9) +
    '中位'.padStart(7) +
    '抢早率'.padStart(8) +
    'score'.padStart(8)
);
for (const r of byScore) {
  console.log(
    '   ' +
      short(r.address).padEnd(12) +
      String(r.buys).padStart(6) +
      String(r.mints).padStart(6) +
      pct(r.winRate).padStart(11) +
      f2(r.avgPeakX).padStart(9) +
      f2(r.medPeakX).padStart(7) +
      pct(r.earlyPct).padStart(8) +
      f2(r.score).padStart(8)
  );
}

console.log(`\n② 按「现金流」排序（卖出 − 买入，数据集内的已实现盈亏代理）`);
console.log('   ' + '钱包'.padEnd(12) + '买入'.padStart(6) + '卖出'.padStart(6) + '现金流(SOL)'.padStart(13) + '胜率'.padStart(8));
for (const r of byCash) {
  const a = wallets.get(r.address)!;
  console.log(
    '   ' +
      short(r.address).padEnd(12) +
      String(r.buys).padStart(6) +
      String(a.sells).padStart(6) +
      `+${f2(r.cashflowSol)}`.padStart(13) +
      pct(r.winRate).padStart(8)
  );
}

console.log('\n↑ 用法：把 ① 里高胜率 + 高抢早率的钱包记下来（GS 里 add_wallet），');
console.log('  它们在「大赢币」上早买的币，就是你的跟单候选信号源。');

// ---------------- 落库 ----------------

if (WRITE) {
  const rw = new DatabaseSync(DB_PATH);
  rw.exec('PRAGMA busy_timeout = 5000;');
  rw.exec('PRAGMA journal_mode = WAL;');
  rw.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      address        TEXT PRIMARY KEY,
      first_seen     INTEGER,
      trades         INTEGER DEFAULT 0,
      tokens_traded  INTEGER DEFAULT 0,
      wins           INTEGER DEFAULT 0,
      win_rate       REAL,
      avg_peak_x     REAL,
      score          REAL,
      updated_at     INTEGER
    );
  `);
  const up = rw.prepare(
    `INSERT INTO wallets (address, first_seen, trades, tokens_traded, wins, win_rate, avg_peak_x, score, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(address) DO UPDATE SET
       first_seen=excluded.first_seen, trades=excluded.trades, tokens_traded=excluded.tokens_traded,
       wins=excluded.wins, win_rate=excluded.win_rate, avg_peak_x=excluded.avg_peak_x,
       score=excluded.score, updated_at=excluded.updated_at`
  );
  const now = Date.now();
  let written = 0;
  rw.exec('BEGIN');
  try {
    for (const a of wallets.values()) {
      if (a.buys < 1) continue;
      const winRate = a.buys ? a.wins / a.buys : 0;
      const avgPeakX = a.peakMults.length ? a.peakMults.reduce((x, y) => x + y, 0) / a.peakMults.length : 0;
      up.run(
        a.address,
        a.firstSeen,
        a.buys + a.sells,
        a.mints.size,
        a.wins,
        winRate,
        avgPeakX,
        winRate * avgPeakX,
        now
      );
      written++;
    }
    rw.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES ('wallets', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    ).run(JSON.stringify({ wallets: total.wallets, analyzed: rows.length, winX: WIN_X, windowMin: WINDOW_MS / 60000 }), now);
    rw.exec('COMMIT');
  } catch (e) {
    rw.exec('ROLLBACK');
    throw e;
  }
  rw.close();
  console.log(`\nwallets 表已更新：${written} 个钱包`);
}
