#!/usr/bin/env node
/**
 * 迁移后 DEX 快照：DexScreener -> dex_snapshots。
 *
 * 解决 pump.fun 毕业后的盲区：价格、USD 流动性、24h volume/pairs。
 * 只做快照，不做历史回填（DexScreener 没有历史 K 线接口）。
 *
 * 用法：
 *   node src/dex.ts --db data/meme.db --limit 80
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(k);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const DB = arg('--db', 'data/meme.db');
const LIMIT = Number(arg('--limit', '80'));
const BASE = 'https://api.dexscreener.com/latest/dex/tokens';

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 10000;');
db.exec(readFileSync(join(process.cwd(), 'src', 'schema.sql'), 'utf8'));

const stmt = db.prepare(`
  SELECT m.mint, MAX(m.ts) migrated_at, t.symbol, t.name
  FROM migrations m LEFT JOIN tokens t ON t.mint = m.mint
  GROUP BY m.mint
  ORDER BY migrated_at DESC LIMIT ?
`);
const rows = stmt.all(LIMIT) as Array<{ mint: string; migrated_at: number; symbol: string | null; name: string | null }>;
if (!rows.length) {
  console.log('[dex] no migrations');
  process.exit(0);
}

const up = db.prepare(`
  INSERT INTO dex_snapshots (
    mint, ts, pair_address, dex_id, price_usd, liquidity_usd, fdv_usd,
    volume_24h_usd, price_change_24h, buys_24h, sells_24h, raw
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(mint, ts) DO UPDATE SET
    pair_address=excluded.pair_address, dex_id=excluded.dex_id,
    price_usd=excluded.price_usd, liquidity_usd=excluded.liquidity_usd,
    fdv_usd=excluded.fdv_usd, volume_24h_usd=excluded.volume_24h_usd,
    price_change_24h=excluded.price_change_24h, buys_24h=excluded.buys_24h,
    sells_24h=excluded.sells_24h, raw=excluded.raw
`);

interface Pair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
}

const now = Date.now();
const bucket = Math.floor(now / 60_000) * 60_000;
let written = 0;

for (const r of rows) {
  try {
    const res = await fetch(`${BASE}/${r.mint}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.log(`[dex] ${r.mint.slice(0, 8)} http ${res.status}`);
      continue;
    }
    const json = (await res.json()) as { pairs?: Pair[] };
    const pairs = (json.pairs ?? []).filter((p) => p.chainId === 'solana');
    const p = pairs.sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0];
    if (!p) {
      console.log(`[dex] ${r.mint.slice(0, 8)} no pair`);
      continue;
    }
    up.run(
      r.mint,
      bucket,
      p.pairAddress ?? null,
      p.dexId ?? null,
      Number(p.priceUsd) || null,
      Number(p.liquidity?.usd) || null,
      Number(p.fdv) || null,
      Number(p.volume?.h24) || null,
      Number(p.priceChange?.h24) || null,
      Number(p.txns?.h24?.buys) || null,
      Number(p.txns?.h24?.sells) || null,
      JSON.stringify({
        dex: p.dexId,
        pair: p.pairAddress,
        liquidityUsd: p.liquidity?.usd,
        volume24h: p.volume?.h24,
        priceChange24h: p.priceChange?.h24,
      })
    );
    written++;
    console.log(
      `[dex] ${r.symbol || r.mint.slice(0, 8)} ${p.dexId} liq=$${Math.round(Number(p.liquidity?.usd) || 0)} vol24=$${Math.round(Number(p.volume?.h24) || 0)}`
    );
  } catch (e) {
    console.log(`[dex] ${r.mint.slice(0, 8)} ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 260));
}

db.prepare(
  `INSERT INTO meta (key, value, updated_at) VALUES ('dex', ?, ?)
   ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
).run(JSON.stringify({ mints: rows.length, written, bucket }), Date.now());
db.close();
console.log(`[dex] done ${written}/${rows.length}`);
