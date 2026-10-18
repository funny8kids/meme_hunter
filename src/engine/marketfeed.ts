/**
 * 市场数据 -> 事件流适配器。
 *
 * 生产：读 SQLite 的 trades 表（已有采集器写入），按 ts 升序重放。
 * 不依赖 tokens.created_at（本地时钟），避免与链上时间混用造成时序错乱。
 */

import { DatabaseSync } from 'node:sqlite';
import type { Envelope, Trade } from './types.ts';

interface TradeRow {
  signature: string;
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

interface TokenRow {
  mint: string;
  created_at: number | null;
  creator: string | null;
  name: string | null;
  symbol: string | null;
  sol_amount: number | null;
  initial_buy: number | null;
  market_cap_sol: number | null;
  v_sol: number | null;
  v_tokens: number | null;
  pool: string | null;
}

export function loadFromDb(dbPath: string, limit = 5_000_000): Envelope[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000;');

  const tokens = new Map<string, TokenRow>();
  for (const t of db
    .prepare('SELECT mint, created_at, creator, name, symbol, sol_amount, initial_buy, market_cap_sol, v_sol, v_tokens, pool FROM tokens')
    .all() as TokenRow[]) {
    tokens.set(t.mint, t);
  }

  const rows = db
    .prepare(
      `SELECT signature, mint, ts, side, wallet, sol_amount, token_amount,
              market_cap_sol, v_sol, v_tokens
       FROM trades
       WHERE side IN ('buy','sell') AND market_cap_sol IS NOT NULL
       ORDER BY ts ASC, rowid ASC
       LIMIT ?`
    )
    .all(limit) as TradeRow[];
  db.close();

  const out: Envelope[] = [];
  const seen = new Set<string>();
  // 去重键必须是「签名 + mint」：一笔交易里可以有多个 mint 的成交
  // （此前只按签名去重，会把同一笔交易中其它 mint 的成交整条丢掉）
  const seenSig = new Set<string>();
  let seq = 0;

  for (const r of rows) {
    const dedupeKey = `${r.signature}:${r.mint}`;
    if (seenSig.has(dedupeKey)) continue;
    seenSig.add(dedupeKey);

    if (!seen.has(r.mint)) {
      seen.add(r.mint);
      const meta = tokens.get(r.mint);
      seq++;
      out.push({
        seq,
        tsWall: r.ts,
        tsMono: r.ts,
        v: 1,
        type: 'TokenCreated',
        payload: {
          mint: r.mint,
          creator: meta?.creator ?? '',
          name: meta?.name ?? '',
          symbol: meta?.symbol ?? '',
          pool: meta?.pool ?? 'pump',
          devBuySol: r.wallet && r.wallet === meta?.creator ? (r.sol_amount ?? 0) : (meta?.sol_amount ?? 0),
          devBuyTokens: meta?.initial_buy ?? 0,
          // 用采集器记录的创建时间计算 ageSec；只有晚于首笔成交的异常时钟才丢弃
          createdAt:
            meta?.created_at != null && meta.created_at <= r.ts + 60_000
              ? meta.created_at
              : r.ts,
          mcapSol: meta?.market_cap_sol ?? r.market_cap_sol ?? 0,
          vSol: meta?.v_sol ?? r.v_sol ?? 0,
          vTokens: meta?.v_tokens ?? r.v_tokens ?? 0,
          sig: r.signature,
        },
      });
    }

    seq++;
    const trade: Trade = {
      mint: r.mint,
      side: (r.side === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell',
      wallet: r.wallet ?? '',
      sol: r.sol_amount ?? 0,
      tokens: r.token_amount ?? 0,
      vSol: r.v_sol ?? 0,
      vTokens: r.v_tokens ?? 0,
      mcapSol: r.market_cap_sol ?? 0,
      sig: r.signature,
    };
    out.push({ seq, tsWall: r.ts, tsMono: r.ts, v: 1, type: 'Trade', payload: trade });
  }

  return out;
}
