#!/usr/bin/env node
/**
 * A1 适配层：实现 GMGN OpenAPI 的接口形状，数据来自我们自己的 SQLite。
 *
 * 设计原则：
 *   - 只读主库，不让前端把采集库写坏；
 *   - 所有「未知」字段返回 null，绝不伪造 0；
 *   - 静态文件 + API 同源，零构建、零前端框架；
 *   - 每个聚合接口都有短 TTL 缓存，轮询不会把 SQLite 打爆。
 *
 * 启动：node src/server.mjs --port 8787
 * 鉴权：X-APIKEY（本地模式默认不校验，设置 API_KEY 后启用）
 */

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { extname, join } from 'node:path';
import { RULES, STRATEGY_VERSION, TIER_THRESHOLDS } from './engine/scorer.ts';
import { DEFAULT_LIMITS } from './engine/risk.ts';
import { quoteImpact, roundTripCost, maxSizeForImpact, minSizeForCost } from './engine/impact.ts';

const PORT = Number(argValue('--port') ?? process.env.PORT ?? 8787);
const DB_PATH = argValue('--db') ?? process.env.DB_PATH ?? 'data/meme.db';
const API_KEY = process.env.API_KEY ?? '';
const VALIDATION_PATH = process.env.VALIDATION_PATH ?? 'data/reports/validation-latest.json';
const EXPERIMENTS_PATH = process.env.EXPERIMENTS_PATH ?? 'data/reports/experiments-latest.json';
const CRASH_VALIDATION_PATH = process.env.CRASH_VALIDATION_PATH ?? 'data/reports/crash-validation-latest.json';
const LIVE_RECONCILE_PATH = process.env.LIVE_RECONCILE_PATH ?? 'data/reports/live-reconcile-latest.json';
const HALT_PATH = process.env.HALT_PATH ?? 'data/HALT';
const JOBS_DIR = process.env.JOBS_DIR ?? 'data/jobs';
const RUNNER_PID = process.env.RUNNER_PID ?? 'data/runner.pid';
const CONSOLE_TOKEN = process.env.CONSOLE_TOKEN ?? '';
const STARTED_AT = Date.now();

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (!existsSync(DB_PATH)) {
  console.error(`数据库不存在: ${DB_PATH}`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000;');
mkdirSync(JOBS_DIR, { recursive: true });

// 旧库可能没有 received_at（本地接收时间）；探测后使用兼容 SQL。
const HAS_RECEIVED_AT = (() => {
  try {
    return db.prepare('PRAGMA table_info(trades)').all().some((c) => c.name === 'received_at');
  } catch {
    return false;
  }
})();
const RECEIVED_AT_COL = HAS_RECEIVED_AT ? 'received_at' : 'ts AS received_at';

// ---------- 工具 ----------

const ok = (data) => ({ code: 0, data: { code: 0, data }, message: 'success', reason: '' });
const err = (code, message) => ({ code, data: null, message, reason: message });

const INTERVALS = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '6h': 21_600_000,
  '24h': 86_400_000,
};

const TOTAL_SUPPLY = 1_000_000_000;
// 观察本地 migrations 记录：毕业/迁移时市值集中在 ~410.88 SOL。
// 这是经验值，UI 标为「估算」，不当作精确链上状态。
const GRADUATION_MCAP_SOL = 410.88;
const DAY = 86_400_000;

function json(res, body, status = 200) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-apikey, x-console-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(s);
}

function round(n, d = 6) {
  const f = 10 ** d;
  return Math.round((Number(n) || 0) * f) / f;
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

function curveProgress(mcapSol, migrated) {
  if (migrated) return 1;
  // 未迁移但市值超过经验毕业线时，最多显示 99%，避免「100% 还在 curve」的矛盾
  return Math.min(0.99, clamp01(Number(mcapSol) / GRADUATION_MCAP_SOL));
}

function pctChange(last, base) {
  if (!Number.isFinite(last) || !Number.isFinite(base) || base <= 0) return null;
  return round(((last - base) / base) * 100, 4);
}

function safeNum(n) {
  return Number.isFinite(Number(n)) ? Number(n) : null;
}

function lastTradeTs() {
  return (
    db.prepare('SELECT MAX(ts) AS m FROM trades WHERE market_cap_sol IS NOT NULL').get()?.m ?? 0
  );
}

function anchorTs() {
  // 行情窗口以「最后一笔成交的事件时间」为锚。
  // 不用 Date.now()：链上事件时间与容器墙钟可能有分钟级偏差，混用会让
  // 1m/5m 涨跌和成交量窗口整体错位。
  const last = lastTradeTs();
  return last > 0 ? last : Date.now();
}

const tokenMetaCache = { at: 0, map: new Map() };
function tokenMetaMap() {
  if (Date.now() - tokenMetaCache.at < 30_000) return tokenMetaCache.map;
  const map = new Map();
  for (const r of db.prepare('SELECT * FROM tokens').all()) map.set(r.mint, r);
  tokenMetaCache.at = Date.now();
  tokenMetaCache.map = map;
  return map;
}

// 单币最新成交用索引点查，避免每次 signals/positions 都做全表 GROUP BY。
// 135 条信号 × 1ms 远低于一次 258ms 的全量 join。
const latestTradeStmt = db.prepare(
  `SELECT market_cap_sol, v_sol, v_tokens, ts, ${RECEIVED_AT_COL}
   FROM trades
   WHERE mint = ? AND market_cap_sol IS NOT NULL
   ORDER BY ts DESC LIMIT 1`
);

const cache = new Map();
function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = fn();
  cache.set(key, { at: now, value });
  return value;
}

/** 读取辅助库；文件不存在时返回空数组，不让整个 UI 挂掉 */
function aux(dbPath, sql, params = []) {
  if (!existsSync(dbPath)) return [];
  try {
    const d = new DatabaseSync(dbPath, { readOnly: true });
    d.exec('PRAGMA busy_timeout = 5000;');
    const rows = d.prepare(sql).all(...params);
    d.close();
    return rows;
  } catch {
    return [];
  }
}

function safeQuery(sql, params = []) {
  try {
    return db.prepare(sql).get(...params) ?? null;
  } catch {
    return null;
  }
}

function safeRows(sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function readValidation() {
  if (!existsSync(VALIDATION_PATH)) return null;
  try {
    return JSON.parse(readFileSync(VALIDATION_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function compactValidation(v) {
  if (!v) return null;
  return {
    generatedAt: v.generatedAt,
    verdict: v.verdict,
    verdictLabel: v.verdictLabel,
    strategyVersion: v.strategyVersion,
    reasons: v.reasons ?? [],
    gates: v.gates ?? [],
    dataAudit: v.dataAudit ?? null,
    walkForward: v.walkForward ?? null,
    costs: (v.costs ?? []).map((s) => ({
      id: s.id,
      label: s.label,
      aggregate: {
        closed: s.aggregate?.closed,
        pnlSol: s.aggregate?.pnlSol,
        expectancySol: s.aggregate?.expectancySol,
        winRate: s.aggregate?.winRate,
        profitFactor: s.aggregate?.profitFactor,
        maxDrawdownPct: s.aggregate?.maxDrawdownPct,
      },
    })),
    latency: (v.latency ?? []).map((s) => ({
      id: s.id,
      label: s.label,
      aggregate: {
        closed: s.aggregate?.closed,
        pnlSol: s.aggregate?.pnlSol,
        expectancySol: s.aggregate?.expectancySol,
      },
    })),
    randomBaseline: v.randomBaseline
      ? {
          probability: v.randomBaseline.probability,
          edgeVsRandomSol: v.randomBaseline.edgeVsRandomSol,
          aggregate: {
            closed: v.randomBaseline.aggregate?.closed,
            expectancySol: v.randomBaseline.aggregate?.expectancySol,
          },
        }
      : null,
    statistics: v.statistics
      ? {
          bootstrap: v.statistics.bootstrap,
          ruleQuality: v.statistics.ruleQuality,
        }
      : null,
    sensitivity: v.sensitivity
      ? {
          best: v.sensitivity.best,
          medianExpectancySol: v.sensitivity.medianExpectancySol,
          profitablePct: v.sensitivity.profitablePct,
          cells: (v.sensitivity.cells ?? []).length,
        }
      : null,
    recommendations: v.recommendations ?? [],
    limitations: v.limitations ?? [],
  };
}

// ---------- 市场榜单 ----------

const sparkStmt = db.prepare(
  `SELECT close FROM candles_1m WHERE mint = ? ORDER BY bucket DESC LIMIT 36`
);

// 只对当前页的币计算 1m/5m/1h/24h 细节；全部走 1m 物化 K 线。
const periodStmt = db.prepare(
  `SELECT
     (SELECT COALESCE(SUM(volume),0) FROM candles_1m WHERE mint = ? AND bucket >= ?) AS vol_5m,
     (SELECT COALESCE(SUM(volume),0) FROM candles_1m WHERE mint = ? AND bucket >= ?) AS vol_1h,
     (SELECT COALESCE(SUM(volume),0) FROM candles_1m WHERE mint = ? AND bucket >= ?) AS vol_24h,
     (SELECT close FROM candles_1m WHERE mint = ? AND bucket <= ? ORDER BY bucket DESC LIMIT 1) AS base_1m,
     (SELECT close FROM candles_1m WHERE mint = ? AND bucket <= ? ORDER BY bucket DESC LIMIT 1) AS base_5m,
     (SELECT close FROM candles_1m WHERE mint = ? AND bucket <= ? ORDER BY bucket DESC LIMIT 1) AS base_1h,
     (SELECT close FROM candles_1m WHERE mint = ? AND bucket <= ? ORDER BY bucket DESC LIMIT 1) AS base_24h`
);

function sparkForMint(mint) {
  const rows = sparkStmt.all(mint).map((r) => Number(r.close) * TOTAL_SUPPLY).reverse();
  if (rows.length <= 1) return rows;
  const step = Math.max(1, Math.floor(rows.length / 32));
  const out = [];
  for (let i = 0; i < rows.length; i += step) out.push(round(rows[i], 4));
  if (out[out.length - 1] !== rows[rows.length - 1]) out.push(round(rows[rows.length - 1], 4));
  return out;
}

/**
 * 市场榜单：先用 SQL 聚合到「每币一行」，再在 JS 里排序/分页。
 * 旧版把 24h 的 8 万行全量拉到 Node 再逐币扫，单次 500ms；
 * 这里把扫描留在 SQLite，返回 ~1500 行，sparkline 只对当前页 25 个币点查。
 */
function marketRank(q) {
  const interval = INTERVALS[q.get('interval')] ? q.get('interval') : '1h';
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 25), 1), 100);
  const offset = Math.max(0, Number(q.get('offset') ?? 0));
  const sort = q.get('sort') ?? 'volume';
  const search = (q.get('q') ?? '').trim().toLowerCase();
  const span = INTERVALS[interval];

  const anchor = Math.floor(anchorTs() / 60_000) * 60_000;
  const since24 = anchor - DAY;
  const spanStart = anchor - span;
  const start1m = anchor - INTERVALS['1m'];
  const start5m = anchor - INTERVALS['5m'];
  const start1h = anchor - INTERVALS['1h'];
  const start24h = since24;

  // 主查询只扫 1m 物化 K 线，单次 ~30ms；不再把 15 万条 trades 拉进 Node。
  const rows = db
    .prepare(
      `WITH agg AS (
         SELECT mint,
                MIN(bucket) AS first_bucket,
                MAX(bucket) AS last_bucket,
                SUM(volume) AS volume,
                SUM(buys) AS buys,
                SUM(sells) AS sells,
                SUM(swaps) AS swaps
         FROM candles_1m
         WHERE bucket >= ?
         GROUP BY mint
       )
       SELECT a.mint, a.first_bucket, a.last_bucket, a.volume, a.buys, a.sells, a.swaps,
              f.open AS first_price,
              l.close AS last_price,
              l.v_sol AS last_vsol,
              l.v_tokens AS last_vtokens
       FROM agg a
       JOIN candles_1m f ON f.mint = a.mint AND f.bucket = a.first_bucket
       JOIN candles_1m l ON l.mint = a.mint AND l.bucket = a.last_bucket`
    )
    .all(spanStart);

  if (!rows.length) {
    return { rank: [], total: 0, offset, limit, interval, anchorTs: anchor, generatedAt: Date.now() };
  }

  const metas = tokenMetaMap();
  const migrated = new Set(safeRows('SELECT mint FROM migrations').map((r) => r.mint));
  const out = [];

  for (const r of rows) {
    const meta = metas.get(r.mint) ?? {};
    if (search) {
      const hay = `${r.mint} ${meta.symbol ?? ''} ${meta.name ?? ''}`.toLowerCase();
      if (!hay.includes(search)) continue;
    }
    const lastMcap = (Number(r.last_price) || 0) * TOTAL_SUPPLY;
    const firstMcap = (Number(r.first_price) || 0) * TOTAL_SUPPLY || lastMcap;
    const change = pctChange(lastMcap, firstMcap);
    const isMigrated = migrated.has(r.mint);

    out.push({
      address: r.mint,
      chain: 'sol',
      name: meta.name ?? '',
      symbol: meta.symbol ?? '',
      price: round(lastMcap / TOTAL_SUPPLY, 12),
      price_change_percent: change,
      first_mcap: round(firstMcap, 4),
      price_change_percent1m: null,
      price_change_percent5m: null,
      price_change_percent1h: null,
      price_change_percent24h: null,
      volume: round(r.volume, 4),
      volume_5m: null,
      volume_1h: null,
      volume_24h: null,
      liquidity: round(r.last_vsol ?? 0, 4),
      market_cap: round(lastMcap, 4),
      swaps: r.swaps ?? 0,
      buys: r.buys ?? 0,
      sells: r.sells ?? 0,
      holder_count: null,
      top_10_holder_rate: null,
      launchpad: meta.pool ?? 'pump',
      age_sec: meta.created_at ? Math.max(0, Math.round((Date.now() - meta.created_at) / 1000)) : null,
      created_at: meta.created_at ?? null,
      dev_buy_sol: round(meta.sol_amount ?? 0, 4),
      progress: curveProgress(lastMcap, isMigrated),
      is_migrated: isMigrated,
      stale_sec: Math.max(0, Math.round((Date.now() - (Number(r.last_bucket) + 60_000)) / 1000)),
      spark: [],
      last_trade_ts: Number(r.last_bucket) + 60_000,
    });
  }

  const sorters = {
    volume: (a, b) => (b.volume ?? 0) - (a.volume ?? 0),
    change: (a, b) => (b.price_change_percent ?? -Infinity) - (a.price_change_percent ?? -Infinity),
    mcap: (a, b) => (b.market_cap ?? 0) - (a.market_cap ?? 0),
    age: (a, b) => (a.age_sec ?? Infinity) - (b.age_sec ?? Infinity),
    trades: (a, b) => (b.swaps ?? 0) - (a.swaps ?? 0),
    progress: (a, b) => (b.progress ?? 0) - (a.progress ?? 0),
  };
  out.sort(sorters[sort] ?? sorters.volume);

  const page = out.slice(offset, offset + limit);
  for (const row of page) {
    const p = periodStmt.get(
      row.address, start5m,
      row.address, start1h,
      row.address, start24h,
      row.address, start1m,
      row.address, start5m,
      row.address, start1h,
      row.address, start24h
    );
    const fallbackMcap = row.first_mcap > 0 ? row.first_mcap : row.market_cap;
    const changeFor = (basePrice) => {
      const mcap = Number(basePrice) * TOTAL_SUPPLY;
      return pctChange(row.market_cap, mcap > 0 ? mcap : fallbackMcap);
    };
    row.price_change_percent1m = changeFor(p?.base_1m);
    row.price_change_percent5m = changeFor(p?.base_5m);
    row.price_change_percent1h = changeFor(p?.base_1h);
    row.price_change_percent24h = changeFor(p?.base_24h);
    row.volume_5m = round(p?.vol_5m ?? 0, 4);
    row.volume_1h = round(p?.vol_1h ?? 0, 4);
    row.volume_24h = round(p?.vol_24h ?? 0, 4);
    const riskRow = safeQuery('SELECT risk_score FROM token_risk WHERE mint = ?', [row.address]);
    row.risk_score = riskRow?.risk_score ?? null;
    const lastTrade = latestTradeStmt.get(row.address);
    if (lastTrade) {
      row.stale_sec = Math.max(0, Math.round((Date.now() - Number(lastTrade.received_at ?? lastTrade.ts)) / 1000));
      row.last_trade_ts = lastTrade.ts;
    }
    row.spark = sparkForMint(row.address);
  }

  return {
    rank: page,
    total: out.length,
    offset,
    limit,
    interval,
    anchorTs: anchor,
    generatedAt: Date.now(),
  };
}

// ---------- 新币雷达 ----------

function trenchMap(t, latest, migrated = false) {
  const lastMcap = latest?.market_cap_sol ?? t.market_cap_sol ?? 0;
  return {
    address: t.mint,
    name: t.name ?? '',
    symbol: t.symbol ?? '',
    market_cap: round(lastMcap, 4),
    dev_buy_sol: round(t.sol_amount ?? 0, 4),
    created_at: t.created_at,
    age_sec: Math.max(0, Math.round((Date.now() - t.created_at) / 1000)),
    progress: curveProgress(lastMcap, migrated),
    v_sol: round(latest?.v_sol ?? t.v_sol ?? 0, 4),
    is_migrated: migrated,
  };
}

function trenches(q) {
  // 新币窗口用本地墙钟（tokens.created_at 是采集器本地时间），
  // 价格窗口才用链上事件时间。
  const now = Date.now();
  const anchor = now;
  let newCut = now - 30 * 60_000;
  let rows = db
    .prepare(
      `SELECT mint, name, symbol, market_cap_sol, sol_amount, created_at, v_sol
       FROM tokens WHERE created_at >= ? ORDER BY created_at DESC LIMIT 80`
    )
    .all(newCut);
  if (!rows.length) {
    const last = safeQuery('SELECT MAX(created_at) AS m FROM tokens')?.m;
    if (last) {
      newCut = last - 30 * 60_000;
      rows = db
        .prepare(
          `SELECT mint, name, symbol, market_cap_sol, sol_amount, created_at, v_sol
           FROM tokens WHERE created_at >= ? ORDER BY created_at DESC LIMIT 80`
        )
        .all(newCut);
    }
  }

  const latestStmt = db.prepare(
    'SELECT market_cap_sol, v_sol, v_tokens, ts FROM trades WHERE mint = ? ORDER BY ts DESC LIMIT 1'
  );
  const migratedSet = new Set(
    safeRows('SELECT mint FROM migrations').map((r) => r.mint)
  );
  const mapped = rows.map((t) => trenchMap(t, latestStmt.get(t.mint), migratedSet.has(t.mint)));

  const migrated = safeRows(
    `SELECT m.mint, m.ts, m.pool, t.name, t.symbol, t.market_cap_sol, t.created_at
     FROM migrations m LEFT JOIN tokens t ON t.mint = m.mint
     ORDER BY m.ts DESC LIMIT 50`
  ).map((m) => ({
    address: m.mint,
    name: m.name ?? '',
    symbol: m.symbol ?? '',
    market_cap: round(
      safeQuery('SELECT market_cap_sol m FROM trades WHERE mint=? ORDER BY ts DESC LIMIT 1', [m.mint])?.m ??
        m.market_cap_sol ??
        0,
      4
    ),
    created_at: m.created_at ?? null,
    migrated_at: m.ts,
    pool: m.pool ?? null,
    age_sec: m.created_at ? Math.max(0, Math.round((anchor - m.created_at) / 1000)) : null,
    is_migrated: true,
  }));

  return {
    anchorTs: anchor,
    counts: {
      created: mapped.length,
      near_completion: mapped.filter((t) => t.progress >= 0.6 && t.progress < 1).length,
      completed: migrated.length,
    },
    new_creation: mapped,
    near_completion: mapped.filter((t) => t.progress >= 0.6 && t.progress < 1),
    completed: migrated,
  };
}

// ---------- 单币 ----------

function tokenInfo(q) {
  const address = q.get('address');
  if (!address) return null;
  const meta = db
    .prepare(
      'SELECT mint, creator, name, symbol, uri, pool, market_cap_sol, sol_amount, v_sol, v_tokens, created_at FROM tokens WHERE mint = ?'
    )
    .get(address);
  if (!meta) return null;

  const anchor = anchorTs();
  const now = Date.now();
  const last = db
    .prepare(
      `SELECT ts, ${RECEIVED_AT_COL}, side, wallet, sol_amount, token_amount, market_cap_sol, v_sol, v_tokens, signature
       FROM trades WHERE mint = ? ORDER BY ts DESC LIMIT 1`
    )
    .get(address);
  const first = db
    .prepare(
      `SELECT ts, market_cap_sol FROM trades WHERE mint = ? AND market_cap_sol IS NOT NULL ORDER BY ts ASC LIMIT 1`
    )
    .get(address);
  const agg = db
    .prepare(
      `SELECT COUNT(*) swaps,
              SUM(CASE WHEN side='buy' THEN 1 ELSE 0 END) buys,
              SUM(CASE WHEN side='sell' THEN 1 ELSE 0 END) sells,
              SUM(sol_amount) volume,
              MIN(market_cap_sol) low,
              MAX(market_cap_sol) high,
              MIN(ts) first_ts,
              MAX(ts) last_ts
       FROM trades WHERE mint = ? AND ts >= ? AND market_cap_sol IS NOT NULL`
    )
    .get(address, anchor - INTERVALS['1h']);
  const peak = db
    .prepare('SELECT MAX(market_cap_sol) m FROM trades WHERE mint = ?')
    .get(address)?.m;
  const migrated = safeQuery('SELECT ts, pool FROM migrations WHERE mint = ?', [address]);

  const lastMcap = Number(last?.market_cap_sol ?? meta.market_cap_sol ?? 0);
  const before1h = db
    .prepare(
      `SELECT market_cap_sol m FROM trades
       WHERE mint = ? AND ts <= ? AND market_cap_sol IS NOT NULL
       ORDER BY ts DESC LIMIT 1`
    )
    .get(address, anchor - INTERVALS['1h'])?.m;
  const firstIn1h = db
    .prepare(
      `SELECT market_cap_sol m FROM trades
       WHERE mint = ? AND ts >= ? AND market_cap_sol IS NOT NULL
       ORDER BY ts ASC LIMIT 1`
    )
    .get(address, anchor - INTERVALS['1h'])?.m;
  const base1h = Number(before1h ?? firstIn1h ?? first?.market_cap_sol ?? 0);

  const dex = safeQuery('SELECT * FROM dex_snapshots WHERE mint = ? ORDER BY ts DESC LIMIT 1', [address]);
  return {
    address,
    chain: 'sol',
    name: meta.name,
    symbol: meta.symbol,
    uri: meta.uri,
    creator: meta.creator,
    pool: meta.pool,
    price: round(lastMcap / TOTAL_SUPPLY, 12),
    market_cap: round(lastMcap, 4),
    peak_market_cap: round(peak ?? lastMcap, 4),
    liquidity: round(last?.v_sol ?? meta.v_sol ?? 0, 4),
    v_sol: round(last?.v_sol ?? meta.v_sol ?? 0, 4),
    v_tokens: round(last?.v_tokens ?? meta.v_tokens ?? 0, 4),
    total_supply: TOTAL_SUPPLY,
    price_change_percent1h: pctChange(lastMcap, base1h),
    volume_1h: round(agg?.volume ?? 0, 4),
    buys_1h: agg?.buys ?? 0,
    sells_1h: agg?.sells ?? 0,
    swaps_1h: agg?.swaps ?? 0,
    high_1h: round(agg?.high ?? lastMcap, 4),
    low_1h: round(agg?.low ?? lastMcap, 4),
    created_at: meta.created_at,
    age_sec: meta.created_at ? Math.max(0, Math.round((now - meta.created_at) / 1000)) : null,
    stale_sec: last ? Math.max(0, Math.round((now - Number(last.received_at ?? last.ts)) / 1000)) : null,
    last_trade: last
      ? {
          ts: last.ts,
          side: last.side,
          wallet: last.wallet,
          sol: round(last.sol_amount, 6),
          tokens: round(last.token_amount, 4),
          price: round(lastMcap / TOTAL_SUPPLY, 12),
          sig: last.signature,
        }
      : null,
    progress: curveProgress(lastMcap, Boolean(migrated)),
    is_on_curve: !migrated,
    is_migrated: Boolean(migrated),
    migrated_at: migrated?.ts ?? null,
    social: {},
    dex: dex
      ? {
          id: dex.dex_id,
          pair: dex.pair_address,
          price_usd: round(dex.price_usd, 10),
          liquidity_usd: round(dex.liquidity_usd, 2),
          volume_24h_usd: round(dex.volume_24h_usd, 2),
          price_change_24h: round(dex.price_change_24h, 2),
          ts: dex.ts,
        }
      : null,
  };
}

function tokenSecurity(q) {
  const address = q.get('address');
  if (!address) return null;
  const meta = db.prepare('SELECT mint FROM tokens WHERE mint = ?').get(address);
  if (!meta) return null;

  const last = db
    .prepare('SELECT v_sol, v_tokens, market_cap_sol FROM trades WHERE mint = ? ORDER BY ts DESC LIMIT 1')
    .get(address);

  return {
    address,
    // 只有链上可观测的部分；未知字段一律 null，绝不伪造 0
    is_honeypot: null,
    buy_tax: null,
    sell_tax: null,
    is_open_source: null,
    renounced_mint: null,
    renounced_freeze_account: null,
    burn_status: null,
    top_10_holder_rate: null,
    holder_count: null,
    liquidity: round(last?.v_sol ?? 0, 4),
    market_cap: round(last?.market_cap_sol ?? 0, 4),
    _local: {
      note: '字段为 null 表示本地暂未计算，不是「安全」',
      has_curve: Boolean(last?.v_tokens),
    },
  };
}

function tokenKline(q) {
  const address = q.get('address');
  const resolution = INTERVALS[q.get('resolution')] ? q.get('resolution') : '1m';
  const span = INTERVALS[resolution];
  if (!address) return null;

  // 优先读 1m 物化 K 线；没有物化时回退到原始成交。
  const base = db
    .prepare(
      `SELECT bucket, open, high, low, close, volume, swaps
       FROM candles_1m WHERE mint = ? ORDER BY bucket ASC`
    )
    .all(address);

  let list;

  if (base.length) {
    const buckets = new Map();
    for (const c of base) {
      const b = Math.floor(c.bucket / span) * span;
      const cur = buckets.get(b);
      if (!cur) {
        buckets.set(b, {
          time: Math.floor(b / 1000),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: Number(c.volume) || 0,
          swaps: Number(c.swaps) || 0,
        });
      } else {
        cur.high = Math.max(cur.high, c.high);
        cur.low = Math.min(cur.low, c.low);
        cur.close = c.close;
        cur.volume += Number(c.volume) || 0;
        cur.swaps += Number(c.swaps) || 0;
      }
    }
    list = [...buckets.values()];
  } else {
    const rows = db
      .prepare(
        `SELECT ts, market_cap_sol, sol_amount
         FROM trades WHERE mint = ? AND market_cap_sol IS NOT NULL
         ORDER BY ts ASC`
      )
      .all(address);
    if (rows.length === 0) return { list: [], meta: null };
    const buckets = new Map();
    for (const r of rows) {
      const b = Math.floor(r.ts / span) * span;
      const price = r.market_cap_sol / TOTAL_SUPPLY;
      const cur = buckets.get(b);
      if (!cur) {
        buckets.set(b, {
          time: Math.floor(b / 1000),
          open: price,
          high: price,
          low: price,
          close: price,
          volume: Number(r.sol_amount) || 0,
          swaps: 1,
        });
      } else {
        cur.high = Math.max(cur.high, price);
        cur.low = Math.min(cur.low, price);
        cur.close = price;
        cur.volume += Number(r.sol_amount) || 0;
        cur.swaps++;
      }
    }
    list = [...buckets.values()];
  }

  const first = list[0];
  const last = list[list.length - 1];

  return {
    list,
    meta: {
      resolution,
      from: first.time * 1000,
      to: last.time * 1000,
      open: first.open,
      close: last.close,
      high: list.reduce((a, x) => Math.max(a, x.high), -Infinity),
      low: list.reduce((a, x) => Math.min(a, x.low), Infinity),
      volume: round(list.reduce((a, x) => a + x.volume, 0), 4),
      change: pctChange(last.close, first.open),
      candles: list.length,
      price: last.close,
      market_cap: last.close * TOTAL_SUPPLY,
    },
  };
}

function tokenTrades(q) {
  const address = q.get('address');
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 40), 1), 100);
  if (!address) return null;
  const rows = db
    .prepare(
      `SELECT ts, side, wallet, sol_amount, token_amount, market_cap_sol, signature
       FROM trades WHERE mint = ? ORDER BY ts DESC LIMIT ?`
    )
    .all(address, limit);
  return {
    trades: rows.map((r) => ({
      ts: r.ts,
      side: r.side,
      wallet: r.wallet,
      sol: round(r.sol_amount, 6),
      tokens: round(r.token_amount, 4),
      price: round((r.market_cap_sol ?? 0) / TOTAL_SUPPLY, 12),
      market_cap: round(r.market_cap_sol, 4),
      sig: r.signature,
    })),
    total: rows.length,
    limit,
  };
}

// ---------- 信号 / 仓位 / 订单 ----------

function signals(q) {
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 50), 1), 200);
  const offset = Math.max(0, Number(q.get('offset') ?? 0));
  const tier = q.get('tier') ?? '';
  const total =
    aux('data/signals.db', 'SELECT COUNT(*) AS c FROM signals')[0]?.c ?? 0;
  const rows = aux(
    'data/signals.db',
    `SELECT id, mint, ts, score, tier, evidence, strategy_version, acted FROM signals
     ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}`
  );
  const metas = tokenMetaMap();
  const out = rows
    .filter((r) => !tier || r.tier === tier)
    .map((r) => {
      const meta = metas.get(r.mint) ?? {};
      const last = latestTradeStmt.get(r.mint);
      return {
        id: r.id,
        mint: r.mint,
        symbol: meta.symbol ?? '',
        name: meta.name ?? '',
        ts: r.ts,
        score: r.score,
        tier: r.tier,
        evidence: safeJson(r.evidence),
        strategy_version: r.strategy_version,
        acted: Boolean(r.acted),
        market_cap: round(last?.market_cap_sol ?? 0, 4),
        age_sec: meta.created_at ? Math.max(0, Math.round((Date.now() - meta.created_at) / 1000)) : null,
      };
    });
  return { signals: out, total, offset, limit, tier: tier || null };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}

function positions() {
  const rows = aux(
    'data/positions.db',
    'SELECT mint, qty, cost_sol, entry_price, entry_mcap, opened_at, intent_id, evidence, peak_mcap FROM positions'
  );
  const metas = tokenMetaMap();
  const now = Date.now();
  const out = rows.map((r) => {
    const last = latestTradeStmt.get(r.mint);
    const meta = metas.get(r.mint) ?? {};
    const currentMcap = last?.market_cap_sol ?? r.entry_mcap ?? 0;
    return {
      mint: r.mint,
      symbol: meta.symbol ?? '',
      name: meta.name ?? '',
      qty: r.qty,
      cost_sol: r.cost_sol,
      entry_price: r.entry_price,
      entry_mcap: r.entry_mcap,
      current_mcap: round(currentMcap, 4),
      pnl_pct: r.entry_mcap > 0 ? round(((currentMcap - r.entry_mcap) / r.entry_mcap) * 100, 3) : 0,
      peak_mcap: r.peak_mcap,
      peak_x: r.entry_mcap > 0 ? round(r.peak_mcap / r.entry_mcap, 4) : 1,
      opened_at: r.opened_at,
      age_sec: r.opened_at ? Math.max(0, Math.round((now - r.opened_at) / 1000)) : null,
      evidence: safeJson(r.evidence),
    };
  });
  return {
    positions: out,
    total_cost_sol: round(out.reduce((a, p) => a + (p.cost_sol ?? 0), 0), 6),
    total_current_sol: round(
      out.reduce((a, p) => {
        const mult = p.entry_mcap > 0 ? p.current_mcap / p.entry_mcap : 1;
        return a + (p.cost_sol ?? 0) * mult;
      }, 0),
      6
    ),
  };
}

function orders() {
  const rows = aux(
    'data/orders.db',
    'SELECT id, mint, side, sol, state, sig, reason, attempts, created_at, updated_at FROM orders ORDER BY created_at DESC LIMIT 50'
  );
  const counts = {};
  for (const r of aux('data/orders.db', 'SELECT state, COUNT(*) c FROM orders GROUP BY state')) {
    counts[r.state] = r.c;
  }
  return { orders: rows, counts };
}

// ---------- 情报 / 钱包 / 控制台 ----------


function dexMarkets(q) {
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 50), 1), 100);
  const sort = q.get('sort') ?? 'liquidity';
  const order = sort === 'volume' ? 'd.volume_24h_usd DESC'
    : sort === 'change' ? 'd.price_change_24h DESC'
    : sort === 'recent' ? 'd.ts DESC'
    : 'd.liquidity_usd DESC';
  const rows = safeRows(
    `WITH latest AS (SELECT mint, MAX(ts) ts FROM dex_snapshots GROUP BY mint)
     SELECT d.*, t.symbol, t.name, t.created_at,
            r.risk_score, r.risk_flags, m.pool, m.ts migrated_at
     FROM dex_snapshots d
     JOIN latest l ON l.mint = d.mint AND l.ts = d.ts
     LEFT JOIN tokens t ON t.mint = d.mint
     LEFT JOIN token_risk r ON r.mint = d.mint
     LEFT JOIN migrations m ON m.mint = d.mint
     ORDER BY ${order} LIMIT ?`,
    [limit]
  );
  return {
    markets: rows.map((r) => ({
      ...r,
      risk_flags: safeJson(r.risk_flags),
      price_usd: round(r.price_usd, 10),
      liquidity_usd: round(r.liquidity_usd, 2),
      fdv_usd: round(r.fdv_usd, 2),
      volume_24h_usd: round(r.volume_24h_usd, 2),
      price_change_24h: round(r.price_change_24h, 2),
    })),
    total: rows.length,
    sort,
  };
}

function smartMoney(q) {
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 60), 1), 200);
  const side = q.get('side') ?? '';
  const minCopy = Math.max(0, Math.min(1, Number(q.get('min_copyability') ?? '0')));
  const anchor = anchorTs();
  const params = [anchor - 6 * 3600_000];
  let where = `t.ts >= ? AND t.wallet IS NOT NULL
    AND (w.labels LIKE '%"smart_money"%' OR w.labels LIKE '%"copyable"%')
    AND (w.copyability >= ? OR w.oos_trades >= 3)`;
  params.push(minCopy);
  if (side === 'buy' || side === 'sell') {
    where += ' AND t.side = ?';
    params.push(side);
  }
  const rows = safeRows(
    `SELECT t.mint, t.ts, t.side, t.sol_amount, t.market_cap_sol, t.wallet,
            w.labels, w.copyability, w.score, w.oos_trades, w.oos_win_rate,
            m.symbol, m.name, o.peak_x, o.rugged, r.risk_score
     FROM trades t
     JOIN wallet_profiles w ON w.address = t.wallet
     LEFT JOIN tokens m ON m.mint = t.mint
     LEFT JOIN outcomes o ON o.mint = t.mint
     LEFT JOIN token_risk r ON r.mint = t.mint
     WHERE ${where}
     ORDER BY t.ts DESC LIMIT ?`,
    [...params, limit]
  );
  return {
    trades: rows.map((r) => ({
      ...r,
      labels: safeJson(r.labels),
      sol_amount: round(r.sol_amount, 4),
      market_cap_sol: round(r.market_cap_sol, 4),
      peak_x: r.peak_x == null ? null : round(r.peak_x, 4),
      copyability: round(r.copyability, 4),
      score: round(r.score, 4),
    })),
    limit,
    side: side || null,
    minCopyability: minCopy,
  };
}

function tokenTraders(q) {
  const address = q.get('address');
  if (!address) return null;
  const rows = safeRows(
    `SELECT t.wallet,
            SUM(CASE WHEN t.side='buy' THEN t.sol_amount ELSE 0 END) buy_sol,
            SUM(CASE WHEN t.side='sell' THEN t.sol_amount ELSE 0 END) sell_sol,
            COUNT(*) n, MIN(t.ts) first_ts, MAX(t.ts) last_ts,
            w.labels, w.copyability, w.oos_win_rate, w.score
     FROM trades t LEFT JOIN wallet_profiles w ON w.address = t.wallet
     WHERE t.mint = ? AND t.wallet IS NOT NULL
     GROUP BY t.wallet ORDER BY buy_sol DESC LIMIT 25`,
    [address]
  );
  return {
    traders: rows.map((r) => ({
      ...r,
      labels: safeJson(r.labels),
      buy_sol: round(r.buy_sol, 4),
      sell_sol: round(r.sell_sol, 4),
      copyability: round(r.copyability, 4),
      oos_win_rate: r.oos_win_rate == null ? null : round(r.oos_win_rate, 4),
    })),
  };
}


function tokenBatch(q) {
  const raw = (q.get('addresses') ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 50);
  if (!raw.length) return { tokens: [] };
  const ph = raw.map(() => '?').join(',');
  const rows = safeRows(
    `SELECT t.mint, t.name, t.symbol, t.created_at, t.market_cap_sol,
            (SELECT market_cap_sol FROM trades WHERE mint=t.mint AND market_cap_sol IS NOT NULL ORDER BY ts DESC LIMIT 1) last_mcap,
            (SELECT v_sol FROM trades WHERE mint=t.mint ORDER BY ts DESC LIMIT 1) last_vsol,
            (SELECT ts FROM trades WHERE mint=t.mint ORDER BY ts DESC LIMIT 1) last_ts,
            r.risk_score, r.risk_flags,
            EXISTS(SELECT 1 FROM migrations m WHERE m.mint=t.mint) migrated
     FROM tokens t LEFT JOIN token_risk r ON r.mint=t.mint
     WHERE t.mint IN (${ph})`,
    raw
  );
  return {
    tokens: rows.map((r) => ({
      address: r.mint,
      name: r.name ?? '',
      symbol: r.symbol ?? '',
      price: round((Number(r.last_mcap ?? r.market_cap_sol) || 0) / TOTAL_SUPPLY, 12),
      market_cap: round(Number(r.last_mcap ?? r.market_cap_sol) || 0, 4),
      liquidity: round(r.last_vsol ?? 0, 4),
      age_sec: r.created_at ? Math.max(0, Math.round((Date.now() - r.created_at) / 1000)) : null,
      stale_sec: r.last_ts ? Math.max(0, Math.round((Date.now() - r.last_ts) / 1000)) : null,
      risk_score: r.risk_score,
      risk_flags: safeJson(r.risk_flags),
      is_migrated: Boolean(r.migrated),
      progress: r.migrated ? 1 : Math.min(0.99, (Number(r.last_mcap ?? r.market_cap_sol) || 0) / GRADUATION_MCAP_SOL),
      spark: sparkForMint(r.mint),
    })),
  };
}

function tokenRisk(q) {
  const address = q.get('address');
  if (!address) return null;
  const r = safeQuery('SELECT * FROM token_risk WHERE mint = ?', [address]);
  const holders = safeRows(
    'SELECT rank, address, amount, pct FROM holder_snapshots WHERE mint = ? ORDER BY rank ASC LIMIT 20',
    [address]
  );
  const social = safeQuery('SELECT * FROM token_social WHERE mint = ?', [address]);
  const meta = safeQuery('SELECT creator, uri FROM tokens WHERE mint = ?', [address]);
  const dev = meta?.creator
    ? safeQuery('SELECT * FROM dev_history WHERE creator = ?', [meta.creator])
    : null;
  const risk = r
    ? {
        ...r,
        risk_flags: safeJson(r.risk_flags),
        raw: undefined,
      }
    : null;
  return {
    address,
    risk,
    holders,
    social,
    dev,
    traders: tokenTraders(q)?.traders ?? [],
    updatedAt: r?.checked_at ?? null,
  };
}

function walletsList(q) {
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 50), 1), 200);
  const offset = Math.max(0, Number(q.get('offset') ?? 0));
  const label = q.get('label') ?? '';
  const sort = q.get('sort') ?? 'score';
  const search = (q.get('q') ?? '').trim().toLowerCase();
  const allowedLabels = new Set([
    'smart_money', 'copyable', 'sniper', 'insider_early', 'dev', 'fresh', 'insufficient', 'unprofitable',
  ]);
  const where = [];
  const params = [];
  if (label && allowedLabels.has(label)) {
    where.push('labels LIKE ?');
    params.push(`%"${label}"%`);
  }
  if (search) {
    where.push('LOWER(address) LIKE ?');
    params.push(`%${search}%`);
  }
  const sorters = {
    score: 'score DESC',
    copyability: 'copyability DESC',
    pnl: 'realized_proxy_sol DESC',
    win_rate: 'win_rate DESC',
    oos: 'oos_win_rate DESC',
    recent: 'last_seen DESC',
    trades: 'trades DESC',
  };
  const order = sorters[sort] ?? sorters.score;
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = safeQuery(`SELECT COUNT(*) c FROM wallet_profiles ${sqlWhere}`, params)?.c ?? 0;
  const rows = safeRows(
    `SELECT * FROM wallet_profiles ${sqlWhere} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return {
    wallets: rows.map((w) => ({ ...w, labels: safeJson(w.labels) })),
    total,
    limit,
    offset,
    label: label || null,
    sort,
  };
}

function walletDetail(q) {
  const address = q.get('address');
  if (!address) return null;
  const profile = safeQuery('SELECT * FROM wallet_profiles WHERE address = ?', [address]);
  const trades = db
    .prepare(
      `SELECT t.mint, t.ts, t.side, t.sol_amount, t.token_amount, t.market_cap_sol,
              m.symbol, m.name, o.peak_x, o.rugged
       FROM trades t
       LEFT JOIN tokens m ON m.mint = t.mint
       LEFT JOIN outcomes o ON o.mint = t.mint
       WHERE t.wallet = ? ORDER BY t.ts DESC LIMIT 80`
    )
    .all(address);
  return {
    address,
    profile: profile ? { ...profile, labels: safeJson(profile.labels) } : null,
    trades: trades.map((t) => ({
      ...t,
      sol_amount: round(t.sol_amount, 6),
      token_amount: round(t.token_amount, 4),
      market_cap_sol: round(t.market_cap_sol, 4),
    })),
  };
}


function shadowSummary(dbPath, costPct = 0.05) {
  if (!existsSync(dbPath)) return { available: false, trades: 0, open: 0, closed: 0, pnlSol: 0, winRate: 0, profitFactor: 0 };
  try {
    const d = new DatabaseSync(dbPath, { readOnly: true });
    d.exec('PRAGMA busy_timeout = 5000;');
    const row = d.prepare(`SELECT COUNT(*) n,
      SUM(CASE WHEN open=0 THEN 1 ELSE 0 END) closed,
      SUM(CASE WHEN open=1 THEN 1 ELSE 0 END) open,
      SUM(CASE WHEN open=0 AND pnl_sol>0 THEN 1 ELSE 0 END) wins,
      COALESCE(SUM(CASE WHEN open=0 THEN pnl_sol ELSE 0 END),0) pnl,
      COALESCE(SUM(CASE WHEN open=0 AND pnl_sol>0 THEN pnl_sol ELSE 0 END),0) grossWin,
      COALESCE(SUM(CASE WHEN open=0 AND pnl_sol<=0 THEN -pnl_sol ELSE 0 END),0) grossLoss
      FROM shadow_trades`).get();
    const updated = d.prepare("SELECT value FROM state WHERE key='updated_at'").get()?.value ?? null;
    const closed = d
      .prepare('SELECT pnl_sol, size_sol FROM shadow_trades WHERE open=0 ORDER BY pnl_sol ASC')
      .all();
    d.close();
    const closedPnl = closed.map((x) => Number(x.pnl_sol) || 0);
    const n = closedPnl.length;
    const best = n ? closedPnl[n - 1] : 0;
    const median = n ? (n % 2 ? closedPnl[(n - 1) / 2] : (closedPnl[n / 2 - 1] + closedPnl[n / 2]) / 2) : 0;
    const pnl = Number(row.pnl ?? 0);
    const pnlExBest = pnl - Math.max(0, best);
    const costs = closed.map((x) => (Number(x.size_sol) || 0) * costPct + 0.001);
    const costSol = costs.reduce((a, b) => a + b, 0);
    const grossPnl = pnl + costSol;
    const grossRows = closed.map((x, i) => (Number(x.pnl_sol) || 0) + costs[i]).sort((a, b) => a - b);
    const bestGross = grossRows.length ? grossRows[grossRows.length - 1] : 0;
    const grossExBest = grossPnl - Math.max(0, bestGross);
    const totalSize = closed.reduce((a, x) => a + (Number(x.size_sol) || 0), 0);
    return {
      available: true,
      trades: row.n ?? 0,
      closed: row.closed ?? 0,
      open: row.open ?? 0,
      wins: row.wins ?? 0,
      pnlSol: round(pnl, 6),
      winRate: row.closed ? (row.wins ?? 0) / row.closed : 0,
      profitFactor: row.grossLoss > 0 ? (row.grossWin ?? 0) / row.grossLoss : (row.grossWin > 0 ? null : 0),
      bestPnlSol: round(best, 6),
      pnlExBestSol: round(pnlExBest, 6),
      medianPnlSol: round(median, 6),
      topTradeShare: pnl > 0 && best > 0 ? round(best / pnl, 4) : null,
      grossPnlSol: round(grossPnl, 6),
      costSol: round(costSol, 6),
      grossExBestSol: round(grossExBest, 6),
      avgCostPct: totalSize > 0 ? round(costSol / totalSize, 4) : 0,
      updatedAt: updated ? Number(updated) : null,
    };
  } catch {
    return { available: false, trades: 0, open: 0, closed: 0, pnlSol: 0, winRate: 0, profitFactor: 0 };
  }
}

function shadowStatus() {
  return {
    crash: shadowSummary('data/shadow-crash.db'),
    crash_005: shadowSummary('data/shadow-crash-005.db'),
    wallet: shadowSummary('data/shadow-wallet.db'),
    wallet_conf: shadowSummary('data/shadow-wallet-conf.db'),
    wallet_conf_q: shadowSummary('data/shadow-wallet-conf-q.db'),
    dex: shadowSummary('data/shadow-dex.db', 0.03),
  };
}

function liveStatus() {
  const read = (path) => {
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  };
  const v = readValidation();
  const crash = read(CRASH_VALIDATION_PATH);
  const reconcile = read(LIVE_RECONCILE_PATH);
  const halt = existsSync(HALT_PATH);
  const network = process.env.NETWORK ?? 'mainnet-beta';
  const publicKey = process.env.SOLANA_PUBLIC_KEY ?? '';
  const rpcUrl = process.env.RPC_URL ?? '';
  const allowLive = process.env.ALLOW_LIVE === '1';
  const dryRun = process.env.DRY_RUN !== '0';
  const orderData = orders();
  const positionData = positions();
  const unknownOrders = Number(orderData.counts?.UNKNOWN ?? 0);
  const checks = [
    { id: 'validation', label: 'v1 验证', pass: v?.verdict === 'GO_LIVE', detail: v?.verdict ?? '未运行' },
    { id: 'crash', label: 'crash OOS', pass: crash?.verdict === 'GO_LIVE', detail: crash?.verdict ?? '未运行' },
    { id: 'allow', label: 'ALLOW_LIVE', pass: allowLive, detail: allowLive ? '已允许' : '未设置' },
    { id: 'dry', label: 'DRY_RUN', pass: !dryRun, detail: dryRun ? '仍为 dry-run' : '已关闭' },
    { id: 'rpc', label: 'RPC', pass: Boolean(rpcUrl), detail: rpcUrl ? '已配置' : '未配置' },
    { id: 'wallet', label: '钱包 public key', pass: Boolean(publicKey), detail: publicKey ? publicKey.slice(0, 6) + '…' : '未配置' },
    { id: 'halt', label: 'HALT', pass: !halt, detail: halt ? '存在 HALT' : 'OFF' },
    { id: 'reconcile', label: '对账', pass: reconcile?.ok === true, detail: reconcile ? (reconcile.ok ? '通过' : '不平') : '未运行' },
    { id: 'orders', label: 'UNKNOWN 订单', pass: unknownOrders === 0, detail: `${unknownOrders} 笔` },
  ];
  const ready = checks.every((c) => c.pass);
  const status = halt ? 'HALT' : ready ? 'LIVE_READY' : dryRun ? 'DRY_RUN' : 'LOCKED';
  return {
    network,
    status,
    ready,
    allowLive,
    dryRun,
    rpcConfigured: Boolean(rpcUrl),
    publicKey: publicKey || null,
    walletSource: publicKey ? 'SOLANA_PUBLIC_KEY' : null,
    halt,
    validation: { verdict: v?.verdict ?? null, generatedAt: v?.generatedAt ?? null },
    crashValidation: { verdict: crash?.verdict ?? null, generatedAt: crash?.generatedAt ?? null },
    checks,
    risk: {
      maxSolPerTrade: Number(process.env.MAX_SOL_PER_TRADE ?? '0.02'),
      maxPortfolioSol: Number(process.env.MAX_PORTFOLIO_SOL ?? '0.1'),
      maxPositions: DEFAULT_LIMITS.maxPositions,
      dailyLossPct: DEFAULT_LIMITS.dailyLossPct,
    },
    orders: orderData.orders.slice(0, 20),
    orderCounts: orderData.counts,
    positions: positionData.positions,
    reconcile,
    checkedAt: Date.now(),
  };
}

function shadowEquity(dbPath) {
  if (!existsSync(dbPath)) return null;
  try {
    const d = new DatabaseSync(dbPath, { readOnly: true });
    d.exec('PRAGMA busy_timeout = 5000;');
    const rows = d.prepare(
      'SELECT exit_ts, pnl_sol FROM shadow_trades WHERE open=0 AND exit_ts IS NOT NULL ORDER BY exit_ts ASC'
    ).all();
    d.close();
    let cum = 0;
    const points = rows.map((r) => {
      cum += Number(r.pnl_sol) || 0;
      return { ts: Number(r.exit_ts), pnl: round(cum, 6) };
    });
    return { trades: rows.length, pnlSol: round(cum, 6), points };
  } catch {
    return null;
  }
}

function performance() {
  const paths = {
    crash: 'data/shadow-crash.db',
    crash_005: 'data/shadow-crash-005.db',
    wallet: 'data/shadow-wallet.db',
    wallet_conf: 'data/shadow-wallet-conf.db',
    wallet_conf_q: 'data/shadow-wallet-conf-q.db',
    dex: 'data/shadow-dex.db',
  };
  const books = {};
  const all = [];
  for (const [name, path] of Object.entries(paths)) {
    if (!existsSync(path)) continue;
    try {
      const d = new DatabaseSync(path, { readOnly: true });
      d.exec('PRAGMA busy_timeout = 5000;');
      const rows = d.prepare(
        'SELECT exit_ts, pnl_sol FROM shadow_trades WHERE open=0 AND exit_ts IS NOT NULL ORDER BY exit_ts ASC'
      ).all();
      d.close();
      let cum = 0;
      const points = rows.map((r) => {
        cum += Number(r.pnl_sol) || 0;
        all.push({ ts: Number(r.exit_ts), pnl: Number(r.pnl_sol) || 0 });
        return { ts: Number(r.exit_ts), pnl: round(cum, 6) };
      });
      books[name] = { trades: rows.length, pnlSol: round(cum, 6), points };
    } catch {
      /* ignore */
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  let cum = 0;
  const aggregate = all.map((r) => {
    cum += r.pnl;
    return { ts: r.ts, pnl: round(cum, 6) };
  });
  const equity = Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [name, shadowEquity(path)])
  );
  return {
    generatedAt: Date.now(),
    books,
    aggregate,
    equity,
    summary: shadowStatus(),
  };
}

function alertsList(q) {
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 50), 1), 200);
  return { events: recentEvents(limit) };
}

// ---------- 统计 / 总览 ----------

function stats() {
  const tokens = safeQuery('SELECT COUNT(*) c FROM tokens')?.c ?? 0;
  const trades = safeQuery('SELECT COUNT(*) c FROM trades')?.c ?? 0;
  const last = safeQuery('SELECT MAX(ts) m FROM trades')?.m ?? 0;
  const lastReceived = HAS_RECEIVED_AT
    ? (safeQuery('SELECT MAX(COALESCE(received_at, ts)) m FROM trades')?.m ?? last)
    : last;
  const lastToken = safeQuery('SELECT MAX(created_at) m FROM tokens')?.m ?? 0;
  const lastMin = safeQuery('SELECT COUNT(*) c FROM trades WHERE ts >= ?', [last - 60_000])?.c ?? 0;
  const vol = safeQuery('SELECT COALESCE(SUM(sol_amount),0) v FROM trades')?.v ?? 0;
  const mints = safeQuery('SELECT COUNT(DISTINCT mint) m FROM trades')?.m ?? 0;
  const signals = aux('data/signals.db', 'SELECT COUNT(*) c FROM signals')[0]?.c ?? 0;
  const positionRows = aux('data/positions.db', 'SELECT COUNT(*) c FROM positions')[0]?.c ?? 0;
  const confirmed = aux('data/orders.db', "SELECT COUNT(*) c FROM orders WHERE state='CONFIRMED'")[0]?.c ?? 0;
  return {
    tokens,
    trades,
    lastTradeTs: last,
    lastReceivedTs: lastReceived,
    dataAgeSec: lastReceived ? Math.max(0, Math.round((Date.now() - lastReceived) / 1000)) : null,
    lastTokenTs: lastToken,
    ingestAgeSec: lastToken ? Math.max(0, Math.round((Date.now() - lastToken) / 1000)) : null,
    tradeRate1m: lastMin,
    volumeSol: round(vol, 4),
    tradedMints: mints,
    signals,
    positions: positionRows,
    confirmedOrders: confirmed,
  };
}

function marketSummary() {
  const anchor = anchorTs();
  const since = anchor - INTERVALS['1h'];
  const t = safeQuery(
    `SELECT COUNT(*) swaps,
            COALESCE(SUM(sol_amount),0) volume,
            SUM(CASE WHEN side='buy' THEN 1 ELSE 0 END) buys,
            SUM(CASE WHEN side='sell' THEN 1 ELSE 0 END) sells,
            COUNT(DISTINCT mint) mints
     FROM trades WHERE ts >= ? AND market_cap_sol IS NOT NULL`,
    [since]
  ) ?? {};
  const localSince = Date.now() - INTERVALS['1h'];
  const created = safeQuery('SELECT COUNT(*) c FROM tokens WHERE created_at >= ?', [localSince])?.c ?? 0;
  const migrated = safeQuery('SELECT COUNT(*) c FROM migrations WHERE ts >= ?', [localSince])?.c ?? 0;
  const total = safeQuery('SELECT COUNT(*) c FROM tokens')?.c ?? 0;
  const reached2x = safeQuery('SELECT COUNT(*) c FROM outcomes WHERE peak_x >= 2')?.c ?? 0;
  const outcomes = safeQuery('SELECT COUNT(*) c FROM outcomes')?.c ?? 0;
  return {
    window: '1h',
    swaps: t.swaps ?? 0,
    volumeSol: round(t.volume ?? 0, 4),
    buys: t.buys ?? 0,
    sells: t.sells ?? 0,
    buySellRatio: (t.sells ?? 0) > 0 ? round((t.buys ?? 0) / t.sells, 3) : null,
    tradedMints: t.mints ?? 0,
    newTokens: created,
    migrations: migrated,
    totalTokens: total,
    outcomeMints: outcomes,
    p2: outcomes > 0 ? round(reached2x / outcomes, 4) : null,
    anchorTs: anchor,
  };
}

function overview() {
  const st = stats();
  const pos = positions();
  const sig = aux(
    'data/signals.db',
    'SELECT id, mint, ts, score, tier, evidence, acted FROM signals ORDER BY ts DESC LIMIT 1'
  )[0];
  const meta = tokenMetaMap();
  let lastSignal = null;
  if (sig) {
    const m = meta.get(sig.mint) ?? {};
    lastSignal = {
      id: sig.id,
      mint: sig.mint,
      symbol: m.symbol ?? '',
      name: m.name ?? '',
      ts: sig.ts,
      score: sig.score,
      tier: sig.tier,
      evidence: safeJson(sig.evidence),
      acted: Boolean(sig.acted),
    };
  }
  let collectorLogAgeSec = null;
  try {
    collectorLogAgeSec = Math.round((Date.now() - statSync('data/collector.log').mtimeMs) / 1000);
  } catch {
    /* ignore */
  }
  const validation = compactValidation(readValidation());
  const intel = safeQuery(`
    SELECT
      (SELECT COUNT(*) FROM token_risk) AS riskChecked,
      (SELECT COUNT(*) FROM token_risk WHERE risk_score >= 70) AS highRisk,
      (SELECT COUNT(*) FROM holder_snapshots) AS holderRows,
      (SELECT COUNT(*) FROM token_social) AS social,
      (SELECT COUNT(*) FROM dev_history) AS devs,
      (SELECT COUNT(*) FROM candles_1m) AS candles,
      (SELECT COUNT(*) FROM dex_snapshots) AS dex,
      (SELECT COUNT(*) FROM wallet_profiles) AS wallets,
      (SELECT COUNT(*) FROM wallet_profiles WHERE labels LIKE '%\"smart_money\"%') AS smartWallets,
      (SELECT COUNT(*) FROM wallet_profiles WHERE labels LIKE '%\"copyable\"%') AS copyableWallets
  `) ?? {};
  return {
    stats: st,
    intel,
    market: marketSummary(),
    positions: {
      count: pos.positions.length,
      costSol: pos.total_cost_sol,
      currentSol: pos.total_current_sol,
      pnlPct:
        pos.total_cost_sol > 0
          ? round(((pos.total_current_sol - pos.total_cost_sol) / pos.total_cost_sol) * 100, 3)
          : 0,
    },
    lastSignal,
    validation: validation
      ? { verdict: validation.verdict, verdictLabel: validation.verdictLabel, generatedAt: validation.generatedAt }
      : null,
    health: {
      lastTradeTs: st.lastTradeTs,
      lastReceivedTs: st.lastReceivedTs,
      dataAgeSec: st.dataAgeSec,
      lastTokenTs: st.lastTokenTs,
      ingestAgeSec: st.ingestAgeSec,
      collectorLogAgeSec,
      db: DB_PATH,
    },
    generatedAt: Date.now(),
  };
}

function analytics() {
  const o = safeQuery(`
    SELECT COUNT(*) n,
      SUM(CASE WHEN peak_x >= 1.5 THEN 1 ELSE 0 END) p15,
      SUM(CASE WHEN peak_x >= 2 THEN 1 ELSE 0 END) p2,
      SUM(CASE WHEN peak_x >= 5 THEN 1 ELSE 0 END) p5,
      SUM(CASE WHEN peak_x >= 10 THEN 1 ELSE 0 END) p10,
      SUM(rugged) rug,
      AVG(peak_x) avg_peak
    FROM outcomes`);
  const outcomes =
    o && o.n > 0
      ? {
          n: o.n,
          p15: (o.p15 ?? 0) / o.n,
          p2: (o.p2 ?? 0) / o.n,
          p5: (o.p5 ?? 0) / o.n,
          p10: (o.p10 ?? 0) / o.n,
          rugged: (o.rug ?? 0) / o.n,
          avgPeak: o.avg_peak ?? null,
        }
      : null;

  const wallets = safeRows(
    `SELECT address, trades, tokens_traded, wins, win_rate, avg_peak_x, score
     FROM wallets WHERE trades >= 3 ORDER BY score DESC LIMIT 12`
  );
  const meta = safeRows('SELECT key, value, updated_at FROM meta');
  const fresh = {};
  for (const m of meta) fresh[m.key] = m.updated_at;
  const validation = compactValidation(readValidation());

  return {
    outcomes,
    outcomesUpdatedAt: fresh['analyze'] ?? null,
    walletsUpdatedAt: fresh['wallets'] ?? null,
    topWallets: wallets,
    signalsTotal: aux('data/signals.db', 'SELECT COUNT(*) n FROM signals')[0]?.n ?? 0,
    validation,
  };
}

function validationLatest(q) {
  const v = cached('validation:latest', 5000, () => readValidation());
  if (!v) return { available: false, report: null };
  if (q.get('compact') === '1') return { available: true, report: compactValidation(v) };
  return { available: true, report: v };
}

function strategy() {
  return {
    version: STRATEGY_VERSION,
    thresholds: TIER_THRESHOLDS,
    rules: RULES.map((r) => ({
      id: r.id,
      desc: r.desc,
      weight: r.weight,
      veto: Boolean(r.veto),
    })),
    notes: [
      '规则可解释、可归因、可版本化；不使用 ML。',
      'STRATEGY_VERSION 是规则集指纹，参数改动会生成新版本。',
      '验证器会按规则做 FDR 多重检验；q 值高说明该规则可能只是噪声。',
    ],
  };
}

function search(q) {
  const term = (q.get('q') ?? '').trim();
  if (!term) return { results: [] };
  const like = `%${term}%`;
  const rows = db
    .prepare(
      `SELECT mint, name, symbol, created_at, market_cap_sol
       FROM tokens
       WHERE mint LIKE ? OR symbol LIKE ? OR name LIKE ?
       ORDER BY CASE WHEN symbol LIKE ? THEN 0 ELSE 1 END, created_at DESC
       LIMIT 12`
    )
    .all(like, like, like, like);
  return {
    results: rows.map((r) => ({
      address: r.mint,
      name: r.name,
      symbol: r.symbol,
      created_at: r.created_at,
      market_cap: round(r.market_cap_sol ?? 0, 4),
    })),
  };
}

// ---------- 控制台 / 后台任务 ----------

const jobs = new Map();
let activeJob = null;

function persistJob(job) {
  try {
    writeFileSync(
      join(JOBS_DIR, `${job.id}.json`),
      JSON.stringify({
        id: job.id,
        action: job.action,
        status: job.status,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        exitCode: job.exitCode,
        pid: job.pid,
        log: job.logPath,
      })
    );
  } catch {
    /* 控制台日志写不了不影响交易 */
  }
}

function loadJobs() {
  try {
    for (const f of readdirSync(JOBS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const j = JSON.parse(readFileSync(join(JOBS_DIR, f), 'utf8'));
      if (j.status === 'running') j.status = 'unknown';
      jobs.set(j.id, { ...j, logPath: j.log });
    }
  } catch {
    /* ignore */
  }
}
loadJobs();

function jobList(limit = 20) {
  return [...jobs.values()]
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, limit)
    .map((j) => ({
      id: j.id,
      action: j.action,
      status: j.status,
      startedAt: j.startedAt,
      endedAt: j.endedAt,
      exitCode: j.exitCode,
      pid: j.pid,
      log: j.logPath,
    }));
}

function tailFile(path, lines = 80) {
  if (!path || !existsSync(path)) return '';
  try {
    const text = readFileSync(path, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function startJob(action, scriptArgs, env = {}) {
  if (activeJob && activeJob.status === 'running') {
    return { ok: false, error: 'busy', job: activeJob };
  }
  const id = `${Date.now()}-${action}`;
  const logPath = join(JOBS_DIR, `${id}.log`);
  const out = createWriteStream(logPath, { flags: 'a' });
  const job = {
    id,
    action,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    pid: null,
    logPath,
  };
  const child = spawn(process.execPath, ['--no-warnings', ...scriptArgs], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  job.pid = child.pid;
  jobs.set(id, job);
  activeJob = job;
  persistJob(job);
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.on('error', (e) => {
    out.write(`\n[spawn] ${e.message}\n`);
  });
  child.on('exit', (code) => {
    job.status = code === 0 ? 'done' : 'failed';
    job.exitCode = code;
    job.endedAt = Date.now();
    persistJob(job);
    out.end();
    activeJob = null;
  });
  return { ok: true, job };
}

function runnerPid() {
  try {
    return Number(readFileSync(RUNNER_PID, 'utf8').trim()) || null;
  } catch {
    return null;
  }
}

function runnerStatus() {
  const pid = runnerPid();
  if (pid) {
    try {
      process.kill(pid, 0);
      return { running: true, pid };
    } catch {
      /* fall through */
    }
  }
  // 兼容手动 `npm run runner`（没有写 pid 文件）
  try {
    const out = execFileSync('pgrep', ['-f', 'src/runner.ts'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
    if (out.length) return { running: true, pid: Number(out[0]), external: true };
  } catch {
    /* no runner */
  }
  return { running: false, pid: null };
}

function startPaperRunner() {
  const st = runnerStatus();
  if (st.running) return { ok: true, running: true, pid: st.pid };
  const fd = openSync('data/runner.log', 'a');
  const child = spawn(process.execPath, ['--no-warnings', 'src/runner.ts', '--sim', '--poll', '1500'], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  child.unref();
  writeFileSync(RUNNER_PID, String(child.pid));
  return { ok: true, running: true, pid: child.pid };
}

function stopPaperRunner() {
  const st = runnerStatus();
  const pid = runnerPid() ?? st.pid;
  if (!pid) return { ok: true, running: false };
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  try {
    rmSync(RUNNER_PID, { force: true });
  } catch {
    /* ignore */
  }
  return { ok: true, running: false, pid };
}

function consoleStatus() {
  const counts = safeQuery(`
    SELECT
      (SELECT COUNT(*) FROM tokens) AS tokens,
      (SELECT COUNT(*) FROM trades) AS trades,
      (SELECT COUNT(*) FROM migrations) AS migrations,
      (SELECT COUNT(*) FROM token_risk) AS risk,
      (SELECT COUNT(*) FROM holder_snapshots) AS holders,
      (SELECT COUNT(*) FROM token_social) AS social,
      (SELECT COUNT(*) FROM dev_history) AS devs,
      (SELECT COUNT(*) FROM candles_1m) AS candles,
      (SELECT COUNT(*) FROM dex_snapshots) AS dex,
      (SELECT COUNT(*) FROM wallet_profiles) AS wallets
  `) ?? {};
  const highRisk = safeQuery('SELECT COUNT(*) c FROM token_risk WHERE risk_score >= 70')?.c ?? 0;
  const lastTrade = lastTradeTs();
  const lastReceived = HAS_RECEIVED_AT
    ? (safeQuery('SELECT MAX(COALESCE(received_at, ts)) m FROM trades')?.m ?? lastTrade)
    : lastTrade;
  const lastToken = safeQuery('SELECT MAX(created_at) m FROM tokens')?.m ?? 0;
  let dbSize = null;
  let logSize = null;
  try { dbSize = statSync(DB_PATH).size; } catch { /* ignore */ }
  try { logSize = statSync('data/collector.log').size; } catch { /* ignore */ }
  const v = readValidation();
  return {
    server: {
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      port: PORT,
      db: DB_PATH,
    },
    data: {
      ...counts,
      highRisk,
      lastTradeTs: lastTrade,
      lastReceivedTs: lastReceived,
      dataAgeSec: lastReceived ? Math.round((Date.now() - lastReceived) / 1000) : null,
      ingestAgeSec: lastToken ? Math.round((Date.now() - lastToken) / 1000) : null,
      collectorLogAgeSec: (() => {
        try { return Math.round((Date.now() - statSync('data/collector.log').mtimeMs) / 1000); } catch { return null; }
      })(),
      dbSize,
      logSize,
    },
    validation: v ? { verdict: v.verdict, generatedAt: v.generatedAt } : null,
    halt: existsSync(HALT_PATH),
    runner: runnerStatus(),
    activeJob: activeJob ? jobList(1)[0] : null,
    jobs: jobList(15),
    events: recentEvents(15),
  };
}

function recentEvents(limit = 20) {
  const signals = aux(
    'data/signals.db',
    `SELECT id, mint, ts, tier, score, evidence FROM signals ORDER BY ts DESC LIMIT ${limit}`
  ).map((s) => ({
    type: 'signal',
    ts: s.ts,
    level: s.tier === 'A' ? 'high' : 'info',
    title: `${s.tier} ${s.score} · ${s.mint.slice(0, 6)}…`,
    detail: s.mint,
  }));
  const migrations = safeRows(
    `SELECT m.mint, m.ts, m.pool, t.symbol FROM migrations m
     LEFT JOIN tokens t ON t.mint = m.mint ORDER BY m.ts DESC LIMIT ${limit}`
  ).map((m) => ({
    type: 'migration',
    ts: m.ts,
    level: 'info',
    title: `迁移 ${m.symbol ?? m.mint.slice(0, 6)} → ${m.pool ?? 'dex'}`,
    detail: m.mint,
  }));
  const risk = safeRows(
    `SELECT mint, checked_at, risk_score, risk_flags FROM token_risk
     WHERE risk_score >= 70 ORDER BY checked_at DESC LIMIT ${limit}`
  ).map((r) => ({
    type: 'risk',
    ts: r.checked_at,
    level: 'high',
    title: `风险 ${Math.round(r.risk_score)} · ${r.mint.slice(0, 6)}…`,
    detail: r.risk_flags,
  }));
  return [...signals, ...migrations, ...risk].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

function consoleJob(q) {
  const id = q.get('id') ?? '';
  const job = jobs.get(id);
  if (!job) return null;
  return { ...job, logTail: tailFile(job.logPath, Number(q.get('lines') ?? 120)) };
}

function consoleJobs() {
  return { jobs: jobList(40), active: activeJob ? jobList(1)[0] : null, runner: runnerStatus() };
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body || '{}'); } catch { return null; }
}

async function consoleAction(req) {
  if (CONSOLE_TOKEN && req.headers['x-console-token'] !== CONSOLE_TOKEN) {
    return { error: 'unauthorized' };
  }
  const body = await readBody(req);
  if (!body) return { error: 'bad_json' };
  const action = String(body.action ?? '');
  if (action === 'halt') {
    writeFileSync(HALT_PATH, `${body.reason ?? 'manual'}\n${new Date().toISOString()}\n`);
    return { ok: true, halt: true };
  }
  if (action === 'clear-halt') {
    if (existsSync(HALT_PATH)) rmSync(HALT_PATH);
    return { ok: true, halt: false };
  }
  if (action === 'paper-start') return startPaperRunner();
  if (action === 'paper-stop') return stopPaperRunner();
  if (action === 'enrich-one') {
    const mint = String(body.mint ?? '').trim();
    if (!mint) return { error: 'missing_mint' };
    return startJob('enrich-one', ['src/enrich.ts', '--db', DB_PATH, '--mints', mint, '--rebuild']);
  }
  const defs = {
    validate: ['src/validate.ts', '--db', DB_PATH],
    experiments: ['src/experiments.ts', '--db', DB_PATH],
    enrich: ['src/enrich.ts', '--db', DB_PATH, '--limit', '30', '--no-social', '--dex'],
    candles: ['src/candles.ts', '--db', DB_PATH, '--since-min', '30'],
    wallets: ['src/wallets2.ts', '--db', DB_PATH],
    analyze: ['src/analyze.ts', '--db', DB_PATH],
  };
  const def = defs[action];
  if (!def) return { error: 'unknown_action' };
  return startJob(action, def);
}

// ---------- 路由 ----------

const routes = {
  'GET /v1/overview': () => cached('overview', 3000, overview),
  'GET /v1/market/rank': (q) => cached(`rank:${q}`, 6000, () => marketRank(q)),
  'POST /v1/trenches': (q) => cached('trenches', 5000, () => trenches(q)),
  'GET /v1/trenches': (q) => cached('trenches', 5000, () => trenches(q)),
  'GET /v1/token/info': (q) => cached(`info:${q.get('address')}`, 3000, () => tokenInfo(q)),
  'GET /v1/token/security': (q) => cached(`sec:${q.get('address')}`, 10_000, () => tokenSecurity(q)),
  'GET /v1/token/kline': (q) =>
    cached(`kline:${q.get('address')}:${q.get('resolution')}`, 3000, () => tokenKline(q)),
  'GET /v1/token/trades': (q) =>
    cached(`tt:${q.get('address')}:${q.get('limit')}`, 2000, () => tokenTrades(q)),
  'GET /v1/token/risk': (q) =>
    cached(`risk:${q.get('address')}`, 2000, () => tokenRisk(q)),
  'GET /v1/token/batch': (q) => cached(`batch:${q.get('addresses')}`, 3000, () => tokenBatch(q)),
  'GET /v1/token/traders': (q) =>
    cached(`traders:${q.get('address')}`, 3000, () => tokenTraders(q)),
  'GET /v1/dex/markets': (q) => cached(`dex:${q}`, 5000, () => dexMarkets(q)),
  'GET /v1/smart-money': (q) => cached(`smart:${q}`, 4000, () => smartMoney(q)),
  'GET /v1/wallets': (q) => cached(`wallets:${q}`, 4000, () => walletsList(q)),
  'GET /v1/wallet': (q) => cached(`wallet:${q.get('address')}`, 4000, () => walletDetail(q)),
  'GET /v1/live/status': () => cached('live:status', 3000, liveStatus),
  'GET /v1/alerts': (q) => cached(`alerts:${q.get('limit')}`, 5000, () => alertsList(q)),
  'GET /v1/console/status': () => cached('console:status', 2500, consoleStatus),
  'GET /v1/console/jobs': () => consoleJobs(),
  'GET /v1/console/job': (q) => consoleJob(q),
  'POST /v1/console/action': (q, req) => consoleAction(req),
  'GET /v1/market/token_kline': (q) =>
    cached(`kline:${q.get('address')}:${q.get('resolution')}`, 3000, () => tokenKline(q)),
  'GET /v1/trade/quote': (q) => tradeQuote(q),
  'GET /v1/trade/impact': (q) => cached(`impact:${q}`, 2000, () => tradeImpact(q)),
  'GET /v1/stats': () => cached('stats', 3000, stats),
  'GET /v1/signals': (q) => cached(`signals:${q}`, 4000, () => signals(q)),
  'GET /v1/positions': () => cached('positions', 4000, positions),
  'GET /v1/orders': () => cached('orders', 5000, orders),
  'GET /v1/analytics': () => cached('analytics', 10_000, analytics),
  'GET /v1/validation/latest': (q) => validationLatest(q),
  'GET /v1/shadow': () => cached('shadow', 2500, shadowStatus),
  'GET /v1/performance': () => cached('performance', 5000, performance),
  'GET /v1/experiments/latest': () => cached('experiments:latest', 5000, () => {
    if (!existsSync(EXPERIMENTS_PATH)) return { available: false, report: null };
    try { return { available: true, report: JSON.parse(readFileSync(EXPERIMENTS_PATH, 'utf8')) }; } catch { return { available: false, report: null }; }
  }),
  'GET /v1/strategy': () => strategy(),
  'GET /v1/search': (q) => cached(`search:${q.get('q') ?? ''}`, 3000, () => search(q)),
};

function tradeImpact(q) {
  const mint = q.get('mint') ?? q.get('address');
  if (!mint) return null;
  const sizeSol = Math.max(0, Number(q.get('size_sol') ?? '0.02'));
  const last = safeQuery('SELECT v_sol, market_cap_sol, ts FROM trades WHERE mint = ? ORDER BY ts DESC LIMIT 1', [mint]);
  const liquiditySol = Number(last?.v_sol ?? 0);
  if (!(sizeSol > 0) || !(liquiditySol > 0)) {
    return { mint, sizeSol, liquiditySol: last?.v_sol ?? null, available: false, reason: 'no_liquidity' };
  }
  const feeBps = Math.max(0, Number(q.get('fee_bps') ?? '100'));
  const prioritySol = Math.max(0, Number(q.get('priority_sol') ?? '0.0005'));
  const slipBps = Math.max(0, Number(q.get('slip_bps') ?? '150'));
  const maxImpactPct = Math.max(0.0001, Math.min(0.5, Number(q.get('max_impact_pct') ?? '0.015')));
  const maxCostPct = Math.max(0.001, Math.min(0.5, Number(q.get('max_cost_pct') ?? '0.08')));
  const buy = quoteImpact('buy', { sizeSol, liquiditySol, feeBps, prioritySol, extraSlipBps: slipBps, maxImpactPct });
  const sell = quoteImpact('sell', { sizeSol, liquiditySol, feeBps, prioritySol, extraSlipBps: slipBps, maxImpactPct });
  const trip = roundTripCost({ sizeSol, liquiditySol, feeBps, prioritySol, extraSlipBps: slipBps, maxImpactPct });
  return {
    mint,
    available: true,
    sizeSol: round(sizeSol, 6),
    liquiditySol: round(liquiditySol, 4),
    lastMcapSol: round(Number(last?.market_cap_sol ?? 0), 4),
    buy,
    sell,
    roundTrip: trip,
    maxSizeAtImpact: round(maxSizeForImpact(liquiditySol, maxImpactPct), 6),
    maxImpactPct,
    maxCostPct,
    minSizeForCost: round(minSizeForCost({ prioritySol, feeBps, extraSlipBps: slipBps, maxCostPct }), 6),
    ts: last?.ts ?? null,
  };
}

async function tradeQuote(q) {
  const inputMint = q.get('input_token') ?? q.get('input_mint');
  const outputMint = q.get('output_token') ?? q.get('output_mint');
  const amount = q.get('amount');
  if (!inputMint || !outputMint || !amount) return null;

  // 报价走 Jupiter 公共端点（免费），失败就明确报错，不编造价格
  const url =
    `https://lite-api.jup.ag/swap/v1/quote?inputMint=${encodeURIComponent(inputMint)}` +
    `&outputMint=${encodeURIComponent(outputMint)}&amount=${encodeURIComponent(amount)}` +
    `&slippageBps=${encodeURIComponent(q.get('slippage_bps') ?? '100')}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`jupiter ${res.status}`);
  return await res.json();
}

// ---------- 静态前端 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const WEB_ROOT = join(process.cwd(), 'web');

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (rel.includes('..')) return false;
  const file = join(WEB_ROOT, rel);
  if (!existsSync(file)) return false;
  const body = readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': extname(file) === '.html' ? 'no-store' : 'no-cache',
  });
  res.end(body);
  return true;
}

function streamHandler(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
  });
  res.write('retry: 3000\n\n');
  const send = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client closed */
    }
  };
  let lastSignal = aux('data/signals.db', 'SELECT COALESCE(MAX(id),0) m FROM signals')[0]?.m ?? 0;
  let lastMigration = safeQuery('SELECT COALESCE(MAX(ts),0) m FROM migrations')?.m ?? 0;
  let lastRisk = safeQuery('SELECT COALESCE(MAX(checked_at),0) m FROM token_risk')?.m ?? 0;
  let lastHealth = 0;

  send('hello', { ts: Date.now(), server: PORT });

  const timer = setInterval(() => {
    try {
      const newSignals = aux(
        'data/signals.db',
        `SELECT id, mint, ts, score, tier, evidence FROM signals WHERE id > ? ORDER BY id ASC LIMIT 20`,
        [lastSignal]
      );
      for (const s of newSignals) {
        lastSignal = Math.max(lastSignal, s.id);
        const meta = tokenMetaMap().get(s.mint) ?? {};
        const last = latestTradeStmt.get(s.mint);
        send('signal', {
          id: s.id,
          mint: s.mint,
          symbol: meta.symbol ?? '',
          name: meta.name ?? '',
          ts: s.ts,
          score: s.score,
          tier: s.tier,
          evidence: safeJson(s.evidence),
          market_cap: round(last?.market_cap_sol ?? 0, 4),
        });
      }

      const migrations = safeRows(
        `SELECT m.mint, m.ts, m.pool, t.symbol, t.name
         FROM migrations m LEFT JOIN tokens t ON t.mint=m.mint
         WHERE m.ts > ? ORDER BY m.ts ASC LIMIT 10`,
        [lastMigration]
      );
      for (const m of migrations) {
        lastMigration = Math.max(lastMigration, m.ts);
        send('migration', m);
      }

      const risks = safeRows(
        `SELECT mint, checked_at, risk_score, risk_flags FROM token_risk
         WHERE checked_at > ? AND risk_score >= 60 ORDER BY checked_at ASC LIMIT 10`,
        [lastRisk]
      );
      for (const r of risks) {
        lastRisk = Math.max(lastRisk, r.checked_at);
        send('risk', {
          mint: r.mint,
          ts: r.checked_at,
          risk_score: r.risk_score,
          flags: safeJson(r.risk_flags),
        });
      }

      const now = Date.now();
      if (now - lastHealth > 4500) {
        lastHealth = now;
        const st = stats();
        send('health', {
          ts: now,
          dataAgeSec: st.dataAgeSec,
          tradeRate1m: st.tradeRate1m,
          tokens: st.tokens,
          trades: st.trades,
          signals: st.signals,
          positions: st.positions,
          validation: readValidation()?.verdict ?? null,
        });
      }
    } catch (e) {
      send('error', { message: String(e?.message ?? e) });
    }
  }, 2500);

  req.on('close', () => {
    clearInterval(timer);
    try { res.end(); } catch { /* ignore */ }
  });
}

// 独立告警循环：Telegram 未配置时只推进游标，不影响本地 SSE。
let alertSignalId = (aux('data/signals.db', 'SELECT COALESCE(MAX(id),0) m FROM signals')[0]?.m ?? 0);
let alertRiskTs = (safeQuery('SELECT COALESCE(MAX(checked_at),0) m FROM token_risk')?.m ?? 0);
let alertMigrationTs = (safeQuery('SELECT COALESCE(MAX(ts),0) m FROM migrations')?.m ?? 0);

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 3500), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* 告警失败不影响主流程 */
  }
}

setInterval(() => {
  const metas = tokenMetaMap();
  const sigs = aux(
    'data/signals.db',
    `SELECT id, mint, ts, score, tier FROM signals WHERE id > ? ORDER BY id ASC LIMIT 10`,
    [alertSignalId]
  );
  for (const s of sigs) {
    alertSignalId = Math.max(alertSignalId, s.id);
    const meta = metas.get(s.mint) ?? {};
    void telegram(
      `🟢 ${s.tier} ${s.score} · $${meta.symbol || s.mint.slice(0, 6)}\n${s.mint}\nhttps://dexscreener.com/solana/${s.mint}`
    );
  }
  const risks = safeRows(
    `SELECT mint, checked_at, risk_score, risk_flags FROM token_risk WHERE checked_at > ? AND risk_score >= 70 ORDER BY checked_at ASC LIMIT 5`,
    [alertRiskTs]
  );
  for (const r of risks) {
    alertRiskTs = Math.max(alertRiskTs, r.checked_at);
    void telegram(`🔴 RISK ${Math.round(r.risk_score)} · ${r.mint}\n${r.risk_flags ?? ''}`);
  }
  const migrations = safeRows(
    `SELECT m.mint, m.ts, m.pool FROM migrations m WHERE m.ts > ? ORDER BY m.ts ASC LIMIT 5`,
    [alertMigrationTs]
  );
  for (const m of migrations) {
    alertMigrationTs = Math.max(alertMigrationTs, m.ts);
    void telegram(`🚀 迁移 ${m.mint}\n${m.pool ?? 'dex'}`);
  }
}, 5000).unref();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-apikey, x-console-token',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  if (url.pathname === '/v1/stream') return streamHandler(req, res);

  if (serveStatic(url.pathname, res)) return;

  if (url.pathname === '/health') {
    const last = lastTradeTs();
    const v = readValidation();
    return json(res, {
      ok: true,
      db: DB_PATH,
      ts: Date.now(),
      lastTradeTs: last,
      dataAgeSec: last ? Math.round((Date.now() - last) / 1000) : null,
      validation: v ? { verdict: v.verdict, generatedAt: v.generatedAt } : null,
    });
  }
  if (url.pathname === '/metrics') {
    const counts = {};
    for (const r of safeRows('SELECT COUNT(*) c FROM trades')) counts.trades = r.c;
    for (const r of safeRows('SELECT COUNT(*) c FROM tokens')) counts.tokens = r.c;
    for (const r of aux('data/signals.db', 'SELECT COUNT(*) c FROM signals')) counts.signals = r.c;
    for (const r of aux('data/positions.db', 'SELECT COUNT(*) c FROM positions')) counts.positions = r.c;
    const lines = Object.entries(counts).map(([k, v]) => `meme_${k}_total ${v}`);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(`# TYPE meme_trades_total counter\n${lines.join('\n')}\n`);
  }

  if (API_KEY && req.headers['x-apikey'] !== API_KEY) {
    return json(res, err(401, 'invalid api key'), 401);
  }

  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return json(res, err(404, `no route: ${key}`), 404);

  try {
    const t0 = Date.now();
    const data = await handler(url.searchParams, req);
    const ms = Date.now() - t0;
    if (ms > 250) console.log(`[slow] ${key} ${ms}ms`);
    if (data === null) return json(res, err(400, 'missing or invalid params'), 400);
    json(res, ok(data));
  } catch (e) {
    json(res, err(500, String(e?.message ?? e)), 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] http://127.0.0.1:${PORT}  db=${DB_PATH}`);
  console.log('[server] 路由: ' + Object.keys(routes).join(', '));
});
