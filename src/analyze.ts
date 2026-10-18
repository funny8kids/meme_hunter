#!/usr/bin/env node
/**
 * 结局分析：回答「这套系统值不值得投钱」的第一个问题。
 *
 * 产出四类决策信息（全部来自自己采集的真实成交数据，零 API 成本）：
 *   1) 生死漏斗   —— 有多少币在创建 1 小时后还活着，峰值倍数分布
 *   2) 入场时点表 —— 延迟 L 秒入场，后续 1 小时内达到 1.5x / 2x / 5x 的比例
 *   3) 规则质量   —— 每条评分规则「首次命中」后的前向峰值，与基准对比（lift）
 *   4) 否决误杀   —— 每条 veto 规则拦掉的币里，有多少其实会涨（误杀率）
 *
 * 同时回填 outcomes 表（t+30s/5m/1h/24h 价格、峰值、是否归零）。
 *
 * 用法：
 *   node src/analyze.ts --db data/meme.db
 *   node src/analyze.ts --db data/meme.db --window-min 60 --json data/reports/analyze.json
 *
 * 诚实的边界：
 *   - 峰值倍数 ≠ 可实现收益。摩擦 5~10%/往返会再打折。
 *     可实现的数字看 `npm run backtest`，本报告只回答「是否存在大波动机会」。
 *   - 规则统计用「每币首次命中」避免同一枚币刷屏；基准是所有评估时点的池化值。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { FeatureEngine } from './engine/features.ts';
import { scoreFeatures, RULES, STRATEGY_VERSION } from './engine/scorer.ts';
import { buildSuffixMax, buildFwdWindowMax, lastIndexAtOrBefore, firstIndexAtOrAfter, median } from './engine/forwardmath.ts';
import type { Envelope } from './engine/types.ts';

// ---------------- 参数 ----------------

const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(k);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};

const DB_PATH = arg('--db', 'data/meme.db');
const WINDOW_MS = Number(arg('--window-min', '60')) * 60_000;
const ROW_LIMIT = Number(arg('--limit', '5000000'));
const WRITE_OUTCOMES = !argv.includes('--no-write');
const JSON_OUT = arg('--json', '');
const LAGS_SEC = [0, 15, 30, 60, 120, 300, 600];

const TOTAL_SUPPLY = 1_000_000_000;

// ---------------- 读取 ----------------

interface TokenRow {
  mint: string;
  created_at: number | null;
  creator: string | null;
  name: string | null;
  symbol: string | null;
  initial_buy: number | null;
  sol_amount: number | null;
  market_cap_sol: number | null;
  v_sol: number | null;
  v_tokens: number | null;
  pool: string | null;
}

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

const db = new DatabaseSync(DB_PATH, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000;');

const tokens = new Map<string, TokenRow>();
for (const t of db
  .prepare(
    'SELECT mint, created_at, creator, name, symbol, initial_buy, sol_amount, market_cap_sol, v_sol, v_tokens, pool FROM tokens'
  )
  .all() as TokenRow[]) {
  tokens.set(t.mint, t);
}

// ---------------- 统计容器 ----------------

interface FwdAgg {
  samples: number;
  c15: number;
  c2: number;
  c5: number;
  mults: number[]; // 1h 前向峰值倍数（用于精确中位数）
  sumMult: number;
}

function newAgg(): FwdAgg {
  return { samples: 0, c15: 0, c2: 0, c5: 0, mults: [], sumMult: 0 };
}

function addFwd(agg: FwdAgg, mult: number): void {
  agg.samples++;
  if (mult >= 1.5) agg.c15++;
  if (mult >= 2) agg.c2++;
  if (mult >= 5) agg.c5++;
  agg.mults.push(mult);
  agg.sumMult += mult;
}

const baseline = newAgg();
const ruleAgg = new Map<string, FwdAgg & { desc: string; veto: boolean }>();
for (const r of RULES) ruleAgg.set(r.id, { ...newAgg(), desc: r.desc, veto: !!r.veto });

const lagAgg = LAGS_SEC.map(() => newAgg());
const lagAlive = LAGS_SEC.map(() => 0);

const funnel = {
  mints: 0,
  alive1h: 0,
  peak15: 0,
  peak2: 0,
  peak5: 0,
  peak10: 0,
  rugged: 0,
  trades: 0,
  createdAtSource: { tokensRow: 0, firstTrade: 0 },
};

const outcomes: Array<{
  mint: string;
  price_30s: number | null;
  price_5m: number | null;
  price_1h: number | null;
  price_24h: number | null;
  peak_x: number;
  peak_at: number | null;
  rugged: number;
}> = [];

let firstEventTs = Infinity;
let lastEventTs = -Infinity;

// ---------------- 单币处理 ----------------

function processMint(mint: string, rows: TradeRow[]): void {
  const n = rows.length;
  const ts = new Float64Array(n);
  const mcap = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ts[i] = rows[i].ts;
    mcap[i] = rows[i].market_cap_sol ?? 0;
  }

  const meta = tokens.get(mint);
  const firstTs = ts[0];
  const created = Math.min(meta?.created_at ?? firstTs, firstTs);
  if (meta?.created_at != null && meta.created_at <= firstTs) funnel.createdAtSource.tokensRow++;
  else funnel.createdAtSource.firstTrade++;

  firstEventTs = Math.min(firstEventTs, firstTs);
  lastEventTs = Math.max(lastEventTs, ts[n - 1]);

  // ---- 生死漏斗 ----
  funnel.mints++;
  funnel.trades += n;
  let peak = -Infinity;
  let peakAt = -1;
  for (let i = 0; i < n; i++) {
    if (mcap[i] > peak) {
      peak = mcap[i];
      peakAt = i;
    }
  }
  const peakX = mcap[0] > 0 ? peak / mcap[0] : 0;
  const alive1h = ts[n - 1] - firstTs >= WINDOW_MS;
  if (alive1h) funnel.alive1h++;
  if (peakX >= 1.5) funnel.peak15++;
  if (peakX >= 2) funnel.peak2++;
  if (peakX >= 5) funnel.peak5++;
  if (peakX >= 10) funnel.peak10++;
  const rugged = !alive1h && peakX < 1.5 ? 1 : 0;
  if (rugged) funnel.rugged++;

  // ---- outcomes 回填 ----
  const pAt = (offsetMs: number): number | null => {
    const idx = lastIndexAtOrBefore(ts, firstTs + offsetMs);
    return idx >= 0 ? mcap[idx] : null;
  };
  outcomes.push({
    mint,
    price_30s: pAt(30_000),
    price_5m: pAt(5 * 60_000),
    price_1h: pAt(WINDOW_MS),
    price_24h: pAt(24 * 60 * 60_000),
    peak_x: peakX,
    peak_at: peakAt >= 0 ? ts[peakAt] : null,
    rugged,
  });

  // ---- 预计算前向峰值 ----
  const suffixMax = buildSuffixMax(mcap);
  const fwd1h = buildFwdWindowMax(ts, mcap, WINDOW_MS);

  const fwdAt = (j: number): number | null => {
    if (j >= n - 1) return null;
    const p = fwd1h[j];
    return Number.isFinite(p) ? p : null;
  };

  // ---- 入场时点表 ----
  for (let k = 0; k < LAGS_SEC.length; k++) {
    const idx = firstIndexAtOrAfter(ts, firstTs + LAGS_SEC[k] * 1000);
    if (idx < 0 || mcap[idx] <= 0) continue;
    lagAlive[k]++;
    const p = fwdAt(idx);
    if (p != null) addFwd(lagAgg[k], p / mcap[idx]);
  }

  // ---- 规则质量（用与实盘/回测相同的特征与评分代码） ----
  const features = new FeatureEngine();
  const createdEvt: Envelope = {
    seq: 0,
    tsWall: created,
    tsMono: created,
    v: 1,
    type: 'TokenCreated',
    payload: {
      mint,
      creator: meta?.creator ?? '',
      name: meta?.name ?? '',
      symbol: meta?.symbol ?? '',
      pool: meta?.pool ?? 'pump',
      devBuySol: meta?.sol_amount ?? 0,
      devBuyTokens: meta?.initial_buy ?? 0,
      createdAt: created,
      mcapSol: meta?.market_cap_sol ?? mcap[0],
      vSol: meta?.v_sol ?? rows[0].v_sol ?? 0,
      vTokens: meta?.v_tokens ?? rows[0].v_tokens ?? 0,
      sig: `create:${mint}`,
    },
  };
  features.onEvent(createdEvt);

  let seq = 0;
  const firedThisMint = new Set<string>();

  for (let j = 0; j < n; j++) {
    const r = rows[j];
    seq++;
    const evt: Envelope = {
      seq,
      tsWall: ts[j],
      tsMono: ts[j],
      v: 1,
      type: 'Trade',
      payload: {
        mint,
        side: r.side === 'sell' ? 'sell' : 'buy',
        wallet: r.wallet ?? '',
        sol: r.sol_amount ?? 0,
        tokens: r.token_amount ?? 0,
        vSol: r.v_sol ?? 0,
        vTokens: r.v_tokens ?? 0,
        mcapSol: mcap[j],
        sig: `t:${mint}:${j}`,
      },
    };
    features.onEvent(evt);

    const f = features.get(mint);
    if (!f) continue;

    // 基准：每个评估时点的前向 1h 峰值（池化）
    const pBase = fwdAt(j);
    if (pBase != null && mcap[j] > 0) addFwd(baseline, pBase / mcap[j]);

    const s = scoreFeatures(f);
    const hits = [...s.evidence, ...s.vetoed];
    if (!hits.length) continue;
    const pFwd = fwdAt(j);
    if (pFwd == null || mcap[j] <= 0) continue;
    const mult = pFwd / mcap[j];

    for (const id of hits) {
      if (firedThisMint.has(id)) continue;
      firedThisMint.add(id);
      const agg = ruleAgg.get(id);
      if (agg) addFwd(agg, mult);
    }
  }
}

// ---------------- 流式遍历（按 mint 分组，逐币释放内存） ----------------

const stmt = db.prepare(
  `SELECT mint, ts, side, wallet, sol_amount, token_amount, market_cap_sol, v_sol, v_tokens
   FROM trades
   WHERE market_cap_sol IS NOT NULL AND side IN ('buy','sell')
   ORDER BY mint ASC, ts ASC, rowid ASC
   LIMIT ?`
);

const t0 = Date.now();
let currentMint: string | null = null;
let currentRows: TradeRow[] = [];
let groups = 0;

for (const row of stmt.iterate(ROW_LIMIT) as IterableIterator<TradeRow>) {
  if (row.mint !== currentMint) {
    if (currentMint !== null && currentRows.length) {
      processMint(currentMint, currentRows);
      groups++;
    }
    currentMint = row.mint;
    currentRows = [];
  }
  currentRows.push(row);
}
if (currentMint !== null && currentRows.length) {
  processMint(currentMint, currentRows);
  groups++;
}
db.close();

const elapsedMs = Date.now() - t0;

// ---------------- 输出 ----------------

const pct = (a: number, b: number): string => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : '—');

function lift(agg: FwdAgg, base: FwdAgg): string {
  if (!agg.samples || !base.samples || base.samples === 0) return '—';
  const a = agg.c2 / agg.samples;
  const b = base.c2 / base.samples;
  if (b === 0) return a > 0 ? '∞' : '—';
  return `${(a / b).toFixed(2)}x`;
}

console.log(`\n═══ 结局分析 ═══  [${DB_PATH}]`);
console.log(`策略版本 ${STRATEGY_VERSION}   前向窗口 ${WINDOW_MS / 60000} 分钟   耗时 ${(elapsedMs / 1000).toFixed(1)}s`);
if (funnel.mints === 0) {
  console.error('没有可用成交数据。先跑采集器：npm run collect');
  process.exit(1);
}
console.log(
  `数据窗口 ${new Date(firstEventTs).toISOString()} → ${new Date(lastEventTs).toISOString()}` +
    `（${((lastEventTs - firstEventTs) / 3600000).toFixed(1)} 小时）`
);

console.log(`\n① 生死漏斗（${funnel.mints} 个有成交的币 / ${funnel.trades} 笔成交）`);
console.log(
  `   1 小时后仍有成交（活着的）    ${String(funnel.alive1h).padStart(7)}  ${pct(funnel.alive1h, funnel.mints)}`
);
console.log(`   峰值 ≥1.5x                   ${String(funnel.peak15).padStart(7)}  ${pct(funnel.peak15, funnel.mints)}`);
console.log(`   峰值 ≥2x                     ${String(funnel.peak2).padStart(7)}  ${pct(funnel.peak2, funnel.mints)}`);
console.log(`   峰值 ≥5x                     ${String(funnel.peak5).padStart(7)}  ${pct(funnel.peak5, funnel.mints)}`);
console.log(`   峰值 ≥10x                    ${String(funnel.peak10).padStart(7)}  ${pct(funnel.peak10, funnel.mints)}`);
console.log(`   疑似归零（1h 内死且 <1.5x）  ${String(funnel.rugged).padStart(7)}  ${pct(funnel.rugged, funnel.mints)}`);
console.log('');
console.log('   ↑ 这个数字决定项目生死：≥2x 的比例太低（<5%）说明只能靠极快的手速/内幕，零售别做；');
console.log('     有一定比例（>10%）说明存在「筛选 + 上班族可执行」的空间。');

console.log(`\n② 入场时点表（从创建起延迟 L 秒买入 → 后续 ${WINDOW_MS / 60000} 分钟内峰值分布）`);
console.log('   ' + '延迟'.padEnd(8) + '样本'.padStart(8) + '≥1.5x'.padStart(9) + '≥2x'.padStart(9) + '≥5x'.padStart(9) + '中位倍数'.padStart(10));
for (let k = 0; k < LAGS_SEC.length; k++) {
  const a = lagAgg[k];
  const label = LAGS_SEC[k] >= 60 ? `${LAGS_SEC[k] / 60}m` : `${LAGS_SEC[k]}s`;
  console.log(
    '   ' +
      label.padEnd(8) +
      String(a.samples).padStart(8) +
      pct(a.c15, a.samples).padStart(9) +
      pct(a.c2, a.samples).padStart(9) +
      pct(a.c5, a.samples).padStart(9) +
      f2(median(a.mults)).padStart(10)
  );
}

console.log(`\n③ 规则质量（每币首次命中后的前向峰值倍数 vs 基准）`);
console.log(
  '   ' +
    '规则'.padEnd(14) +
    '命中币数'.padStart(10) +
    '≥2x'.padStart(9) +
    '中位倍数'.padStart(10) +
    'lift'.padStart(8)
);
console.log(
  '   ' +
    '（基准）'.padEnd(14) +
    String(baseline.samples).padStart(10) +
    pct(baseline.c2, baseline.samples).padStart(9) +
    f2(median(baseline.mults)).padStart(10) +
    '1.00x'.padStart(8)
);
for (const r of RULES.filter((x) => !x.veto)) {
  const a = ruleAgg.get(r.id)!;
  console.log(
    '   ' +
      r.id.padEnd(14) +
      String(a.samples).padStart(10) +
      pct(a.c2, a.samples).padStart(9) +
      f2(median(a.mults)).padStart(10) +
      lift(a, baseline).padStart(8)
  );
}
console.log('   ↑ lift > 1 才有筛选价值；lift ≈ 1 的规则等于没筛。基准=所有评估时点池化。');

console.log(`\n④ 否决规则误杀率（被否决后仍然 ≥2x 的比例，越高越说明这条 veto 在误杀）`);
for (const r of RULES.filter((x) => x.veto)) {
  const a = ruleAgg.get(r.id)!;
  console.log(
    '   ' +
      r.id.padEnd(14) +
      `拦截 ${String(a.samples).padStart(7)} 币   ` +
      `误杀(后涨≥2x) ${pct(a.c2, a.samples).padStart(7)}   ` +
      `中位倍数 ${f2(median(a.mults))}`
  );
}

console.log('');

// ---------------- JSON 报告 ----------------

const report = {
  generatedAt: new Date().toISOString(),
  source: DB_PATH,
  strategyVersion: STRATEGY_VERSION,
  windowMin: WINDOW_MS / 60000,
  dataRange: { from: firstEventTs, to: lastEventTs, hours: (lastEventTs - firstEventTs) / 3600000 },
  funnel,
  entryLag: LAGS_SEC.map((sec, k) => ({
    lagSec: sec,
    samples: lagAgg[k].samples,
    p15: lagAgg[k].samples ? lagAgg[k].c15 / lagAgg[k].samples : null,
    p2: lagAgg[k].samples ? lagAgg[k].c2 / lagAgg[k].samples : null,
    p5: lagAgg[k].samples ? lagAgg[k].c5 / lagAgg[k].samples : null,
    medianMult: median(lagAgg[k].mults),
  })),
  baseline: {
    samples: baseline.samples,
    p15: baseline.samples ? baseline.c15 / baseline.samples : null,
    p2: baseline.samples ? baseline.c2 / baseline.samples : null,
    medianMult: median(baseline.mults),
  },
  rules: RULES.map((r) => {
    const a = ruleAgg.get(r.id)!;
    return {
      id: r.id,
      desc: r.desc,
      veto: !!r.veto,
      samples: a.samples,
      p15: a.samples ? a.c15 / a.samples : null,
      p2: a.samples ? a.c2 / a.samples : null,
      p5: a.samples ? a.c5 / a.samples : null,
      medianMult: median(a.mults),
      meanMult: a.samples ? a.sumMult / a.samples : null,
      lift2x: lift(a, baseline),
    };
  }),
  elapsedMs,
};

if (JSON_OUT) {
  mkdirSync(JSON_OUT.replace(/\/[^/]+$/, '') || '.', { recursive: true });
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  console.log(`JSON 报告 → ${JSON_OUT}`);
}

// ---------------- 回填 outcomes ----------------

if (WRITE_OUTCOMES) {
  const rw = new DatabaseSync(DB_PATH);
  rw.exec('PRAGMA busy_timeout = 5000;');
  rw.exec('PRAGMA journal_mode = WAL;');
  rw.exec(`
    CREATE TABLE IF NOT EXISTS outcomes (
      mint          TEXT PRIMARY KEY,
      price_30s     REAL,
      price_5m      REAL,
      price_1h      REAL,
      price_24h     REAL,
      peak_x        REAL,
      peak_at       INTEGER,
      rugged        INTEGER DEFAULT 0,
      updated_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER
    );
  `);
  const up = rw.prepare(
    `INSERT INTO outcomes (mint, price_30s, price_5m, price_1h, price_24h, peak_x, peak_at, rugged, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(mint) DO UPDATE SET
       price_30s=excluded.price_30s, price_5m=excluded.price_5m, price_1h=excluded.price_1h,
       price_24h=excluded.price_24h, peak_x=excluded.peak_x, peak_at=excluded.peak_at,
       rugged=excluded.rugged, updated_at=excluded.updated_at`
  );
  const now = Date.now();
  rw.exec('BEGIN');
  try {
    for (const o of outcomes) {
      up.run(o.mint, o.price_30s, o.price_5m, o.price_1h, o.price_24h, o.peak_x, o.peak_at, o.rugged, now);
    }
    rw.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES ('analyze', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    ).run(JSON.stringify({ mints: funnel.mints, trades: funnel.trades, peak2Pct: funnel.mints ? funnel.peak2 / funnel.mints : null }), now);
    rw.exec('COMMIT');
  } catch (e) {
    rw.exec('ROLLBACK');
    throw e;
  }
  rw.close();
  console.log(`outcomes 表已回填 ${outcomes.length} 个币`);
}

console.log('');
