#!/usr/bin/env node
/**
 * P0 成交流：Solana logsSubscribe -> 解析 pump.fun Anchor TradeEvent -> SQLite
 *
 * 为什么用 logsSubscribe 而不是第三方 API：
 *   pump.fun 把每笔成交以 Anchor event 写进交易日志（"Program data: <base64>"），
 *   订阅程序的日志就能拿到「所有币的所有成交」，不需要 getTransaction（省 RPC 额度），
 *   也不需要任何付费 API。
 *
 * 实测：事件判别符 bddb7fd34ee661ee，解码长度 129 字节。
 *
 * 用法：
 *   npm run trades
 *   RPC_WS=wss://atlas-mainnet.helius-rpc.com/?api-key=xxx npm run trades
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const DB_PATH = process.env.DB_PATH ?? join(ROOT, 'data', 'meme.db');
const RPC_WS = process.env.RPC_WS ?? 'wss://api.mainnet-beta.solana.com';
const FLUSH_MS = Number(process.env.FLUSH_MS ?? 300);

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TRADE_EVENT_DISC = 'bddb7fd34ee661ee';

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
// 两个采集器同时启动时会并发执行 schema/写 WAL；没有 busy_timeout 就会直接报 locked。
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
// 兼容旧库：CREATE TABLE IF NOT EXISTS 不会给已有表加列
try {
  db.exec('ALTER TABLE trades ADD COLUMN received_at INTEGER');
} catch { /* 列已存在 */ }
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_trades_recv ON trades(received_at)');
} catch { /* ignore */ }

const insTrade = db.prepare(`
  INSERT INTO trades (signature, mint, ts, received_at, side, wallet, sol_amount, token_amount,
                      market_cap_sol, v_sol, v_tokens)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(signature, mint) DO NOTHING
`);

// 成交先到、创建事件后到（或进程中途启动）时，兜底建一条最小 token 记录
const ensureToken = db.prepare(`
  INSERT INTO tokens (mint, created_at) VALUES (?, ?)
  ON CONFLICT(mint) DO UPDATE SET created_at = MIN(tokens.created_at, excluded.created_at)
`);

// ---------- Base58 ----------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}

// ---------- 事件解码 ----------

/** pump.fun TradeEvent（Anchor，Borsh） */
function decodeTradeEvent(buf) {
  if (buf.length < 129) return null;
  let o = 8;
  const mint = buf.subarray(o, o + 32); o += 32;
  const solAmount = buf.readBigUInt64LE(o); o += 8;
  const tokenAmount = buf.readBigUInt64LE(o); o += 8;
  const isBuy = buf[o] === 1; o += 1;
  const user = buf.subarray(o, o + 32); o += 32;
  const ts = buf.readBigInt64LE(o); o += 8;
  const vSol = buf.readBigUInt64LE(o); o += 8;
  const vTok = buf.readBigUInt64LE(o); o += 8;
  o += 16; // real_sol_reserves, real_token_reserves（当前用途不大）

  const tsMs = Number(ts) * 1000;
  const sol = Number(solAmount) / 1e9;
  const now = Date.now();
  // 防止 Borsh 错位/异常事件污染统计（曾出现 ts=-5e21、单笔 79 万 SOL）
  if (!Number.isFinite(tsMs) || tsMs <= 0 || tsMs > now + 60_000) return null;
  if (!Number.isFinite(sol) || sol <= 0 || sol > 100_000) return null;

  const SOL = 1e9;
  const TOK = 1e6; // pump 代币统一 6 位小数
  const vSolF = Number(vSol) / SOL;
  const vTokF = Number(vTok) / TOK;
  const totalSupply = 1_000_000_000; // pump.fun 固定 10 亿枚
  const priceSol = vTokF > 0 ? vSolF / vTokF : null;

  return {
    mint: bs58(mint),
    wallet: bs58(user),
    side: isBuy ? 'buy' : 'sell',
    solAmount: sol,
    tokenAmount: Number(tokenAmount) / TOK,
    vSol: vSolF,
    vTokens: vTokF,
    marketCapSol: priceSol ? priceSol * totalSupply : null,
    ts: tsMs,
  };
}

// ---------- 批量写 ----------

let pending = [];
let flushTimer = null;

function enqueue(t) {
  pending.push(t);
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

function flush() {
  flushTimer = null;
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  db.exec('BEGIN');
  try {
    for (const t of batch) {
      ensureToken.run(t.mint, t.receivedAt);
      insTrade.run(t.signature, t.mint, t.ts, t.receivedAt, t.side, t.wallet,
        t.solAmount, t.tokenAmount, t.marketCapSol, t.vSol, t.vTokens);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[flush] 写入失败：', err.message);
  }
}

// ---------- 统计 ----------

const stats = { tx: 0, trades: 0, buys: 0, sells: 0, otherEvents: 0, reconnects: 0 };
let startedAt = Date.now(), firstAt = null;

setInterval(() => {
  const mins = Math.max((Date.now() - startedAt) / 60000, 0.01);
  console.log(
    `[stats] ${mins.toFixed(1)}min tx=${stats.tx} trade=${stats.trades}` +
    ` (${(stats.trades / mins).toFixed(0)}/min) buy=${stats.buys} sell=${stats.sells}` +
    ` other=${stats.otherEvents} reconnects=${stats.reconnects}` +
    (firstAt ? ` firstEvent=${((firstAt - startedAt) / 1000).toFixed(1)}s` : '')
  );
}, 15000).unref();

// ---------- WebSocket ----------

let ws = null, backoff = 1000, closing = false, nextId = 1, subId = null;

function connect() {
  console.log(`[ws] 连接 ${RPC_WS}`);
  ws = new WebSocket(RPC_WS);

  ws.addEventListener('open', () => {
    backoff = 1000;
    subId = nextId++;
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: subId, method: 'logsSubscribe',
      params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'confirmed' }],
    }));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }

    if (msg.id === subId) {
      if (msg.error) console.error('[ws] 订阅失败：', JSON.stringify(msg.error));
      else console.log('[ws] 已订阅 pump.fun 程序日志，subscriptionId=', msg.result);
      return;
    }
    if (!msg.params?.result?.value) return;

    const value = msg.params.result.value;
    const signature = value.signature;
    const logs = value.logs ?? [];
    stats.tx++;

    for (const line of logs) {
      if (!line.startsWith('Program data: ')) continue;
      let buf;
      try { buf = Buffer.from(line.slice('Program data: '.length), 'base64'); }
      catch { continue; }
      if (buf.length < 8) continue;

      const disc = buf.subarray(0, 8).toString('hex');
      if (disc !== TRADE_EVENT_DISC) { stats.otherEvents++; continue; }

      const t = decodeTradeEvent(buf);
      if (!t) continue;
      stats.trades++;
      if (t.side === 'buy') stats.buys++; else stats.sells++;
      if (!firstAt) firstAt = Date.now();
      enqueue({ ...t, signature, receivedAt: Date.now() });
    }
  });

  ws.addEventListener('close', (ev) => {
    if (closing) return;
    stats.reconnects++;
    console.warn(`[ws] 断开 (code=${ev.code})，${backoff}ms 后重连`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  });

  ws.addEventListener('error', () => {});
}

function shutdown(sig) {
  closing = true;
  console.log(`\n[exit] 收到 ${sig}，刷盘并退出`);
  clearTimeout(flushTimer);
  flush();
  try { ws?.close(); } catch {}
  try { db.close(); } catch {}
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startedAt = Date.now();
connect();
