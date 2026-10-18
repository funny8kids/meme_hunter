#!/usr/bin/env node
/**
 * 1 分钟 K 线物化。
 *
 * 服务端排名/图表不再每次扫全量 trades。采集器持续写 trades，本任务负责
 * 增量聚合到 candles_1m。可反复运行，幂等 upsert。
 *
 * 关键：先在内存聚合，再短事务写入；绝不在持有写锁时扫描 10 万行 trades。
 *
 * 用法：
 *   node src/candles.ts --db data/meme.db            # 增量（最近 10 分钟 + 缺口）
 *   node src/candles.ts --db data/meme.db --rebuild  # 全量重建
 *   node src/candles.ts --db data/meme.db --since-min 120
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
const REBUILD = argv.includes('--rebuild');
const SINCE_MIN = Number(arg('--since-min', '10'));
const TOTAL_SUPPLY = 1_000_000_000;

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 15000;');
db.exec('PRAGMA journal_mode = WAL;');
db.exec(readFileSync(join(process.cwd(), 'src', 'schema.sql'), 'utf8'));

const upsert = db.prepare(`
  INSERT INTO candles_1m (mint, bucket, open, high, low, close, volume, buys, sells, swaps, v_sol, v_tokens)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(mint, bucket) DO UPDATE SET
    open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
    volume=excluded.volume, buys=excluded.buys, sells=excluded.sells, swaps=excluded.swaps,
    v_sol=excluded.v_sol, v_tokens=excluded.v_tokens
`);

if (REBUILD) {
  db.exec('BEGIN IMMEDIATE');
  db.exec('DELETE FROM candles_1m');
  db.exec('COMMIT');
}

const lastBucket = db.prepare('SELECT MAX(bucket) b FROM candles_1m').get() as { b: number | null };
const since = REBUILD || lastBucket.b == null
  ? 0
  : Math.max(0, lastBucket.b - SINCE_MIN * 60_000);

const stmt = db.prepare(`
  SELECT mint, ts, side, sol_amount, market_cap_sol, v_sol, v_tokens
  FROM trades
  WHERE ts >= ? AND market_cap_sol IS NOT NULL AND side IN ('buy','sell')
  ORDER BY mint ASC, ts ASC, rowid ASC
`);

interface Bucket {
  mint: string;
  bucket: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buys: number;
  sells: number;
  swaps: number;
  vSol: number;
  vTokens: number;
}

// 先只读聚合，不持有写锁
const buckets = new Map<string, Bucket>();
let rows = 0;
for (const r of stmt.iterate(since) as IterableIterator<{
  mint: string;
  ts: number;
  side: string;
  sol_amount: number | null;
  market_cap_sol: number | null;
  v_sol: number | null;
  v_tokens: number | null;
}>) {
  rows++;
  const price = Number(r.market_cap_sol) / TOTAL_SUPPLY;
  const bucket = Math.floor(Number(r.ts) / 60_000) * 60_000;
  const key = `${r.mint}:${bucket}`;
  let cur = buckets.get(key);
  if (!cur) {
    cur = {
      mint: r.mint,
      bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
      buys: 0,
      sells: 0,
      swaps: 0,
      vSol: 0,
      vTokens: 0,
    };
    buckets.set(key, cur);
  }
  cur.high = Math.max(cur.high, price);
  cur.low = Math.min(cur.low, price);
  cur.close = price;
  cur.volume += Number(r.sol_amount) || 0;
  if (r.side === 'buy') cur.buys++;
  else cur.sells++;
  cur.swaps++;
  cur.vSol = Number(r.v_sol) || cur.vSol;
  cur.vTokens = Number(r.v_tokens) || cur.vTokens;
}

let written = 0;
try {
  db.exec('BEGIN IMMEDIATE');
  for (const cur of buckets.values()) {
    upsert.run(
      cur.mint,
      cur.bucket,
      cur.open,
      cur.high,
      cur.low,
      cur.close,
      cur.volume,
      cur.buys,
      cur.sells,
      cur.swaps,
      cur.vSol,
      cur.vTokens
    );
    written++;
  }
  db.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES ('candles', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(JSON.stringify({ rows, buckets: buckets.size, written, since, rebuild: REBUILD }), Date.now());
  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch { /* ignore */ }
  throw e;
}

console.log(
  `[candles] rows=${rows} buckets=${buckets.size} written=${written} since=${since ? new Date(since).toISOString() : 'all'}`
);
db.close();
