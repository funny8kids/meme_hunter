#!/usr/bin/env node
/**
 * P0 采集器：PumpPortal WebSocket -> SQLite
 *
 * 零第三方依赖：WebSocket 用 Node 22+ 内置，SQLite 用 node:sqlite。
 *
 * 策略（对应方案里的「分级处理」）：
 *   1) 全量订阅 create / migration —— 不花 RPC、不花 API 额度
 *   2) 只对「低市值 + 新创建」的币订阅逐笔成交，且并发订阅数有上限
 *   3) 其余币等到进入候选池再由 enrich 阶段按需回查
 *
 * 用法：
 *   npm run ingest
 *   TRADE_MAX_MCAP_SOL=45 TRADE_MAX_MINTS=40 npm run ingest
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const DB_PATH = process.env.DB_PATH ?? join(ROOT, 'data', 'meme.db');
const WS_URL = process.env.WS_URL ?? 'wss://pumpportal.fun/api/data';
const TRADE_MAX_MCAP_SOL = Number(process.env.TRADE_MAX_MCAP_SOL ?? 45);
const TRADE_MAX_MINTS = Number(process.env.TRADE_MAX_MINTS ?? 40);
const FLUSH_MS = Number(process.env.FLUSH_MS ?? 250);
const STATS_MS = Number(process.env.STATS_MS ?? 15000);

// ---------- 存储 ----------

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

const insToken = db.prepare(`
  INSERT INTO tokens (mint, created_at, creator, name, symbol, uri, pool,
                      initial_buy, sol_amount, bonding_curve, market_cap_sol,
                      v_sol, v_tokens, is_mayhem)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(mint) DO UPDATE SET
    -- trades.mjs 可能先用「首笔成交」建了占位行；创建事件晚到时必须补齐元数据，
    -- 而不是 DO NOTHING 把名字/创建者/创建时间永久丢掉。
    created_at      = MIN(tokens.created_at, excluded.created_at),
    creator         = COALESCE(tokens.creator, excluded.creator),
    name            = COALESCE(tokens.name, excluded.name),
    symbol          = COALESCE(tokens.symbol, excluded.symbol),
    uri             = COALESCE(tokens.uri, excluded.uri),
    pool            = COALESCE(tokens.pool, excluded.pool),
    initial_buy     = COALESCE(tokens.initial_buy, excluded.initial_buy),
    sol_amount      = COALESCE(tokens.sol_amount, excluded.sol_amount),
    bonding_curve   = COALESCE(tokens.bonding_curve, excluded.bonding_curve),
    market_cap_sol  = COALESCE(tokens.market_cap_sol, excluded.market_cap_sol),
    v_sol           = COALESCE(tokens.v_sol, excluded.v_sol),
    v_tokens        = COALESCE(tokens.v_tokens, excluded.v_tokens),
    is_mayhem       = COALESCE(tokens.is_mayhem, excluded.is_mayhem)
`);

const insTrade = db.prepare(`
  INSERT INTO trades (signature, mint, ts, received_at, side, wallet, sol_amount, token_amount,
                      market_cap_sol, v_sol, v_tokens)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(signature, mint) DO NOTHING
`);

const insMigration = db.prepare(`
  INSERT INTO migrations (mint, ts, pool) VALUES (?,?,?)
  ON CONFLICT(mint) DO NOTHING
`);

// 写入缓冲：每 FLUSH_MS 一个事务，避免高频单条写入
let pending = [];
let flushTimer = null;

function enqueue(kind, payload) {
  pending.push([kind, payload]);
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

function flush() {
  flushTimer = null;
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  db.exec('BEGIN');
  try {
    for (const [kind, p] of batch) {
      if (kind === 'token') insToken.run(
        p.mint, p.created_at, p.creator, p.name, p.symbol, p.uri, p.pool,
        p.initial_buy, p.sol_amount, p.bonding_curve, p.market_cap_sol,
        p.v_sol, p.v_tokens, p.is_mayhem
      );
      else if (kind === 'trade') insTrade.run(
        p.signature, p.mint, p.ts, p.received_at, p.side, p.wallet, p.sol_amount,
        p.token_amount, p.market_cap_sol, p.v_sol, p.v_tokens
      );
      else if (kind === 'migration') insMigration.run(p.mint, p.ts, p.pool);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[flush] 写入失败：', err.message);
  }
}

// ---------- 订阅管理（有上限的 LRU） ----------

const subscribed = new Map(); // mint -> true，Map 保持插入顺序，天然 LRU
let ws = null;

function maybeSubscribeTrades(mint, marketCapSol) {
  if (!Number.isFinite(marketCapSol) || marketCapSol > TRADE_MAX_MCAP_SOL) return;
  if (subscribed.has(mint)) return;
  if (subscribed.size >= TRADE_MAX_MINTS) {
    // 淘汰最早订阅的
    const oldest = subscribed.keys().next().value;
    subscribed.delete(oldest);
    send({ method: 'unsubscribeTokenTrade', keys: [oldest] });
  }
  subscribed.set(mint, true);
  send({ method: 'subscribeTokenTrade', keys: [mint] });
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ---------- 统计 ----------

const stats = { creates: 0, trades: 0, migrations: 0, msgs: 0, reconnects: 0 };
let startedAt = Date.now();

setInterval(() => {
  const mins = (Date.now() - startedAt) / 60000;
  console.log(
    `[stats] ${mins.toFixed(1)}min  create=${stats.creates} (${(stats.creates / mins).toFixed(1)}/min)` +
    ` trade=${stats.trades} migration=${stats.migrations}` +
    ` subs=${subscribed.size} reconnects=${stats.reconnects}`
  );
}, STATS_MS).unref();

// ---------- WebSocket ----------

let backoff = 1000;
let closing = false;

function connect() {
  console.log(`[ws] 连接 ${WS_URL}`);
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    backoff = 1000;
    send({ method: 'subscribeNewToken' });
    send({ method: 'subscribeMigration' });
    // 重连后必须把仍有效的逐笔订阅恢复，否则这些币的成交永久丢失。
    // 注意：不要 clear()，Map 里的键就是「当前希望订阅的集合」。
    for (const mint of subscribed.keys()) {
      send({ method: 'subscribeTokenTrade', keys: [mint] });
    }
    console.log(`[ws] 已连接，订阅 create / migration + 恢复 ${subscribed.size} 个逐笔订阅`);
  });

  ws.addEventListener('message', (ev) => {
    stats.msgs++;
    let data;
    try { data = JSON.parse(String(ev.data)); } catch { return; }
    for (const evt of Array.isArray(data) ? data : [data]) handleEvent(evt);
  });

  ws.addEventListener('error', () => {
    // close 事件随后会触发，这里只记录
  });

  ws.addEventListener('close', (ev) => {
    if (closing) return;
    stats.reconnects++;
    console.warn(`[ws] 断开 (code=${ev.code})，${backoff}ms 后重连`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  });
}

function handleEvent(evt) {
  if (!evt || typeof evt !== 'object') return;
  if (evt.message) return; // 订阅确认之类的文本

  const now = Date.now();
  const type = evt.txType;

  if (type === 'create') {
    stats.creates++;
    enqueue('token', {
      mint: evt.mint,
      created_at: now,
      creator: evt.traderPublicKey ?? null,
      name: evt.name ?? null,
      symbol: evt.symbol ?? null,
      uri: evt.uri ?? null,
      pool: evt.pool ?? null,
      initial_buy: num(evt.initialBuy),
      sol_amount: num(evt.solAmount),
      bonding_curve: evt.bondingCurveKey ?? null,
      market_cap_sol: num(evt.marketCapSol),
      v_sol: num(evt.vSolInBondingCurve),
      v_tokens: num(evt.vTokensInBondingCurve),
      is_mayhem: evt.is_mayhem_mode ? 1 : 0,
    });
    maybeSubscribeTrades(evt.mint, num(evt.marketCapSol));

    // 只打印「首买不算太小」的，避免刷屏
    if ((num(evt.solAmount) ?? 0) >= 0.5) {
      console.log(
        `[new] ${evt.symbol ?? '?'} ${String(evt.name ?? '').slice(0, 20)}` +
        ` mcap=${(num(evt.marketCapSol) ?? 0).toFixed(1)}SOL` +
        ` devBuy=${(num(evt.solAmount) ?? 0).toFixed(2)}SOL ${evt.mint}`
      );
    }
    return;
  }

  if (type === 'buy' || type === 'sell') {
    stats.trades++;
    enqueue('trade', {
      signature: evt.signature,
      mint: evt.mint,
      ts: now,
      received_at: now,
      side: type,
      wallet: evt.traderPublicKey ?? null,
      sol_amount: num(evt.solAmount),
      token_amount: num(evt.tokenAmount),
      market_cap_sol: num(evt.marketCapSol),
      v_sol: num(evt.vSolInBondingCurve),
      v_tokens: num(evt.vTokensInBondingCurve),
    });
    return;
  }

  if (type === 'migrate' || evt.migrated === true) {
    stats.migrations++;
    enqueue('migration', { mint: evt.mint, ts: now, pool: evt.pool ?? null });
    console.log(`[migrate] ${evt.mint} -> ${evt.pool ?? 'dex'}`);
  }
}

function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- 退出 ----------

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
