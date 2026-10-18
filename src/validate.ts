#!/usr/bin/env node
/**
 * 策略严苛验证器（不是「再跑一次回测」）。
 *
 * 它回答四个问题，任何一个答案是「否」就不允许上实盘：
 *   1. 数据够不够？（时长、成交、币种、覆盖率、完整性）
 *   2. 样本外能不能赚？（时间切分的 walk-forward，而不是同一段数据反复调参）
 *   3. 成本/延迟抬高后还能不能赚？（手续费、滑点、3s/10s/30s 延迟、死币折价）
 *   4. 这个结果是不是运气/过拟合？（按币种 cluster bootstrap、随机入场基线、
 *      参数平原、规则多重检验 FDR）
 *
 * 用法：
 *   node src/validate.ts --db data/meme.db
 *   node src/validate.ts --db data/meme.db --folds 5 --quick
 *   node src/validate.ts --db data/meme.db --out data/reports/validation-latest.json
 *
 * 输出：
 *   data/reports/validation-<timestamp>.json
 *   data/reports/validation-latest.json   （前端 /v1/validation/latest 读取）
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Envelope } from './engine/types.ts';
import { loadFromDb } from './engine/marketfeed.ts';
import {
  DEFAULT_BACKTEST_CONFIG,
  runBacktest,
  summarize,
  type BacktestConfig,
  type BacktestReport,
  type BacktestWindow,
} from './engine/backtestcore.ts';
import { FeatureEngine } from './engine/features.ts';
import { RULES, scoreFeatures, STRATEGY_VERSION, TIER_THRESHOLDS } from './engine/scorer.ts';
import { buildFwdWindowMax, median } from './engine/forwardmath.ts';
import {
  percentile,
  twoSidedBinomialP,
  bhQValues,
  clusterBootstrap,
  type BootstrapResult,
} from './engine/stats.ts';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(k);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const flag = (k: string): boolean => argv.includes(k);

const DB_PATH = arg('--db', 'data/meme.db');
const OUT_DIR = arg('--out-dir', 'data/reports');
const LATEST_OUT = arg('--out', join(OUT_DIR, 'validation-latest.json'));
const FOLDS = Math.max(2, Math.min(8, Number(arg('--folds', '4'))));
const MIN_HOURS = Number(arg('--min-hours', '24'));
const LIVE_MIN_HOURS = Number(arg('--live-min-hours', '168'));
const MIN_CLOSED = Number(arg('--min-closed', '30'));
const LIVE_MIN_CLOSED = Number(arg('--live-min-closed', '100'));
const MIN_SIGNALS = Number(arg('--min-signals', '30'));
const MIN_TRADES = Number(arg('--min-trades', '5000'));
const MIN_MINTS = Number(arg('--min-mints', '30'));
const QUICK = flag('--quick');
const JSON_OUT = arg('--json', '');

const NOW = Date.now();

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

const round = (n: number, d = 6): number => {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

const pct = (n: number): number => round(n * 100, 3);

function mergeExitReasons(target: Record<string, number>, src: Record<string, number>): void {
  for (const [k, v] of Object.entries(src)) target[k] = (target[k] ?? 0) + v;
}

// ---------------------------------------------------------------------------
// 1. 数据审计（直接读 SQLite，不经过回测）
// ---------------------------------------------------------------------------

interface DataAudit {
  db: string;
  trades: number;
  tokens: number;
  mintsWithTrades: number;
  tokenCoveragePct: number;
  migrations: number;
  firstTradeAt: number | null;
  lastTradeAt: number | null;
  durationHours: number;
  /** 真正有成交的分钟数（不是首尾时间差） */
  activeMinutes: number;
  activeHours: number;
  coveragePct: number;
  maxGapMinutes: number;
  dataAgeHours: number;
  duplicateTradeKeys: number;
  badSideRows: number;
  badMcapRows: number;
  badSolRows: number;
  futureRows: number;
  nullWalletRows: number;
  creatorCoveragePct: number;
  tradesPerMint: { p50: number; p90: number; p99: number; max: number };
  hourlyBuckets: number;
  emptyHourBuckets: number;
  worstJumpRatio: number;
  jumpOutliers: number;
  notes: string[];
}

function auditData(dbPath: string): DataAudit {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000;');
  const notes: string[] = [];
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;

  const counts = one<{
    n: number;
    mints: number;
    minTs: number | null;
    maxTs: number | null;
    badSide: number;
    badMcap: number;
    badSol: number;
    future: number;
    nullWallet: number;
    dup: number;
  }>(`
    SELECT COUNT(*) n,
           COUNT(DISTINCT mint) mints,
           MIN(ts) minTs,
           MAX(ts) maxTs,
           SUM(CASE WHEN side NOT IN ('buy','sell') OR side IS NULL THEN 1 ELSE 0 END) badSide,
           SUM(CASE WHEN market_cap_sol IS NULL OR market_cap_sol <= 0 THEN 1 ELSE 0 END) badMcap,
           SUM(CASE WHEN sol_amount IS NULL OR sol_amount <= 0 THEN 1 ELSE 0 END) badSol,
           SUM(CASE WHEN ts > ${NOW + 5 * 60_000} THEN 1 ELSE 0 END) future,
           SUM(CASE WHEN wallet IS NULL OR wallet = '' THEN 1 ELSE 0 END) nullWallet,
           COUNT(*) - COUNT(DISTINCT signature || '|' || mint) dup
    FROM trades`);

  const tokens = one<{ n: number }>('SELECT COUNT(*) n FROM tokens');
  const creators = one<{ n: number; c: number }>(
    'SELECT COUNT(*) n, SUM(CASE WHEN creator IS NOT NULL AND creator <> \'\' THEN 1 ELSE 0 END) c FROM tokens'
  );
  const migrations = one<{ n: number }>('SELECT COUNT(*) n FROM migrations');

  const perMint = db
    .prepare('SELECT COUNT(*) c FROM trades GROUP BY mint')
    .all()
    .map((r) => Number((r as { c: number }).c));
  perMint.sort((a, b) => a - b);

  const hourly = db
    .prepare(`SELECT (ts / 3600000) AS h, COUNT(*) c FROM trades GROUP BY h ORDER BY h`)
    .all()
    .map((r) => ({ h: Number((r as { h: number }).h), c: Number((r as { c: number }).c) }));
  let emptyHourBuckets = 0;
  if (hourly.length > 1) {
    const from = hourly[0].h;
    const to = hourly[hourly.length - 1].h;
    const seen = new Set(hourly.map((x) => x.h));
    for (let h = from; h <= to; h++) if (!seen.has(h)) emptyHourBuckets++;
  }

  // 价格跳变：同一 mint 相邻成交的 mcap 比值。>10x 或 <0.1x 视为可疑。
  let jumpOutliers = 0;
  let worstJumpRatio = 1;
  const rows = db
    .prepare('SELECT mint, ts, market_cap_sol FROM trades ORDER BY mint ASC, ts ASC')
    .iterate() as IterableIterator<{ mint: string; ts: number; market_cap_sol: number | null }>;
  let curMint = '';
  let prev = 0;
  for (const r of rows) {
    const mcap = Number(r.market_cap_sol ?? 0);
    if (r.mint === curMint && prev > 0 && mcap > 0) {
      const ratio = mcap / prev;
      if (ratio > worstJumpRatio) worstJumpRatio = ratio;
      if (ratio > 10 || ratio < 0.1) jumpOutliers++;
    }
    curMint = r.mint;
    prev = mcap;
  }

  // 活跃度：首尾跨度会把采集中断也算成「有数据」，必须单独统计真正有成交的分钟
  const activeMinuteSet = new Set<number>();
  let maxGapMs = 0;
  let prevTs = -1;
  const tsRows = db
    .prepare('SELECT ts FROM trades WHERE market_cap_sol IS NOT NULL AND side IN (\'buy\',\'sell\') ORDER BY ts ASC')
    .iterate() as IterableIterator<{ ts: number }>;
  for (const r of tsRows) {
    const ts = Number(r.ts);
    activeMinuteSet.add(Math.floor(ts / 60_000));
    if (prevTs >= 0 && ts - prevTs > maxGapMs) maxGapMs = ts - prevTs;
    prevTs = ts;
  }
  db.close();

  const durationHours =
    counts.minTs != null && counts.maxTs != null ? (counts.maxTs - counts.minTs) / 3_600_000 : 0;
  const activeMinutes = activeMinuteSet.size;
  const coveragePct =
    counts.minTs != null && counts.maxTs != null && counts.maxTs > counts.minTs
      ? pct(activeMinutes / ((counts.maxTs - counts.minTs) / 60_000))
      : 0;
  const dataAgeHours = counts.maxTs != null ? (NOW - counts.maxTs) / 3_600_000 : Infinity;

  if (counts.dup > 0) notes.push(`重复成交键 ${counts.dup} 条（主键应已阻止，需检查写入路径）`);
  if (counts.badMcap > 0) notes.push(`市值为空/非正的成交 ${counts.badMcap} 条，回测已过滤`);
  if (counts.badSide > 0) notes.push(`side 非 buy/sell 的成交 ${counts.badSide} 条，回测已过滤`);
  if (counts.nullWallet > 0) notes.push(`钱包为空 ${counts.nullWallet} 条，钱包画像会低估`);
  if (counts.future > 0) notes.push(`未来时间戳 ${counts.future} 条，可能污染特征`);
  if (emptyHourBuckets > 0) notes.push(`有 ${emptyHourBuckets} 个整点小时无成交，采集可能断过`);
  if (maxGapMs > 10 * 60_000) notes.push(`最长采集中断 ${(maxGapMs / 60_000).toFixed(1)} 分钟，跨度时长会严重高估有效样本`);
  if (coveragePct < 50) notes.push(`有效覆盖率仅 ${coveragePct}%（有成交分钟 / 首尾跨度），不能把跨度当作样本时长`);
  if (jumpOutliers > 0) notes.push(`相邻成交市值跳变 >10x 或 <0.1x 共 ${jumpOutliers} 次，需检查解析/脏数据`);
  if (tokens.n > 0 && (counts.mints / tokens.n) < 0.5) notes.push('不足一半的创建币有成交记录（采集订阅有上限，属已知偏差）');

  return {
    db: dbPath,
    trades: counts.n,
    tokens: tokens.n,
    mintsWithTrades: counts.mints,
    tokenCoveragePct: tokens.n > 0 ? pct(counts.mints / tokens.n) : 0,
    migrations: migrations.n,
    firstTradeAt: counts.minTs,
    lastTradeAt: counts.maxTs,
    durationHours: round(durationHours, 2),
    activeMinutes,
    activeHours: round(activeMinutes / 60, 2),
    coveragePct,
    maxGapMinutes: round(maxGapMs / 60_000, 1),
    dataAgeHours: round(dataAgeHours, 2),
    duplicateTradeKeys: counts.dup,
    badSideRows: counts.badSide,
    badMcapRows: counts.badMcap,
    badSolRows: counts.badSol,
    futureRows: counts.future,
    nullWalletRows: counts.nullWallet,
    creatorCoveragePct: creators.n > 0 ? pct((creators.c ?? 0) / creators.n) : 0,
    tradesPerMint: {
      p50: perMint.length ? percentile(perMint, 0.5) : 0,
      p90: perMint.length ? percentile(perMint, 0.9) : 0,
      p99: perMint.length ? percentile(perMint, 0.99) : 0,
      max: perMint.length ? perMint[perMint.length - 1] : 0,
    },
    hourlyBuckets: hourly.length,
    emptyHourBuckets,
    worstJumpRatio: round(worstJumpRatio, 2),
    jumpOutliers,
    notes,
  };
}

// ---------------------------------------------------------------------------
// 2. Walk-forward / 成本 / 延迟 / 随机基线
// ---------------------------------------------------------------------------

interface FoldResult {
  index: number;
  fromTs: number;
  toTs: number;
  report: BacktestReport;
}

interface ClosedTradeLite {
  mint: string;
  pnlSol: number;
  costSol: number;
}

/**
 * 按「成交事件数」切折，而不是按首尾时间跨度。
 * 采集中断会让时间切分产生空折（0 笔），看起来像策略没信号，实际是没数据。
 * 每折保证约 N/(folds+1) 笔成交；前 1/(folds+1) 作为特征热身。
 */
function foldWindowsByEvents(envelopes: Envelope[], folds: number): Array<{ fromTs: number; toTs: number }> {
  const tradeTs: number[] = [];
  for (const e of envelopes) if (e.type === 'Trade') tradeTs.push(e.tsWall);
  if (tradeTs.length < 20 || folds < 2) return [];
  const seg = tradeTs.length / (folds + 1);
  const out: Array<{ fromTs: number; toTs: number }> = [];
  for (let i = 1; i <= folds; i++) {
    const fromIdx = Math.floor(seg * i);
    const toIdx = Math.floor(seg * (i + 1));
    if (fromIdx >= tradeTs.length) break;
    const fromTs = tradeTs[fromIdx];
    const toTs = toIdx < tradeTs.length ? tradeTs[toIdx] : Infinity;
    if (Number.isFinite(toTs) && toTs <= fromTs) continue;
    out.push({ fromTs, toTs });
  }
  return out;
}

function runFolds(
  envelopes: Envelope[],
  cfg: BacktestConfig,
  windows: Array<{ fromTs: number; toTs: number }>
): { folds: FoldResult[]; aggregate: BacktestReport; trades: ClosedTradeLite[] } {
  const folds: FoldResult[] = [];
  const allTrades: ClosedTradeLite[] = [];
  let signals = 0;
  let vetoed = 0;
  let entries = 0;
  let canceled = 0;
  let riskRejected = 0;
  let opportunities = 0;
  let stuckExits = 0;
  let endExits = 0;
  const exitReasons: Record<string, number> = {};

  for (let i = 0; i < windows.length; i++) {
    const w: BacktestWindow = windows[i];
    const { report, closedTrades } = runBacktest(envelopes, cfg, w);
    folds.push({ index: i + 1, fromTs: w.fromTs!, toTs: w.toTs!, report });
    allTrades.push(...closedTrades);
    signals += report.signals;
    vetoed += report.vetoed;
    entries += report.entries;
    canceled += report.canceled;
    riskRejected += report.riskRejected;
    opportunities += report.opportunities;
    stuckExits += report.stuckExits;
    endExits += report.endExits;
    mergeExitReasons(exitReasons, report.exitReasons);
  }

  const aggregate = summarize(allTrades, cfg, {
    events: envelopes.length,
    signals,
    vetoed,
    entries,
    canceled,
    riskRejected,
    opportunities,
    stuckExits,
    endExits,
    exitReasons,
  });
  return { folds, aggregate, trades: allTrades };
}

interface Scenario {
  id: string;
  label: string;
  config: BacktestConfig;
  aggregate: BacktestReport;
  folds: FoldResult[];
  trades: ClosedTradeLite[];
}

function runScenario(
  envelopes: Envelope[],
  base: BacktestConfig,
  windows: Array<{ fromTs: number; toTs: number }>,
  id: string,
  label: string,
  patch: Partial<BacktestConfig>
): Scenario {
  const config = { ...base, ...patch };
  const { folds, aggregate, trades } = runFolds(envelopes, config, windows);
  return { id, label, config, aggregate, folds, trades };
}

// ---------------------------------------------------------------------------
// 3. 统计：cluster bootstrap + 随机入场基线
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 4. 规则质量 + FDR（每币首次命中后的前向 1h 峰值）
// ---------------------------------------------------------------------------

interface RuleQuality {
  id: string;
  desc: string;
  veto: boolean;
  samples: number;
  p15: number | null;
  p2: number | null;
  p5: number | null;
  medianMult: number | null;
  meanMult: number | null;
  lift2x: number | null;
  pValue: number | null;
  qValue: number | null;
  falseKillPct: number | null;
}

interface RuleQualityReport {
  windowMin: number;
  baseline: {
    samples: number;
    p15: number | null;
    p2: number | null;
    p5: number | null;
    medianMult: number | null;
    meanMult: number | null;
  };
  rules: RuleQuality[];
  notes: string[];
}

function analyzeRuleQuality(envelopes: Envelope[], windowMs: number): RuleQualityReport {
  const FWD = Math.max(5 * 60_000, windowMs);
  const byMint = new Map<string, Envelope[]>();
  for (const e of envelopes) {
    if (e.type !== 'Trade' && e.type !== 'TokenCreated') continue;
    const mint = e.payload.mint;
    const arr = byMint.get(mint) ?? [];
    arr.push(e);
    byMint.set(mint, arr);
  }

  const baseMults: number[] = [];
  const ruleMults = new Map<string, number[]>();
  for (const r of RULES) ruleMults.set(r.id, []);

  for (const [mint, evts] of byMint) {
    const trades = evts.filter((e) => e.type === 'Trade');
    if (trades.length < 2) continue;
    const ts = new Float64Array(trades.length);
    const mcap = new Float64Array(trades.length);
    for (let i = 0; i < trades.length; i++) {
      ts[i] = trades[i].tsWall;
      mcap[i] = Number((trades[i].payload as { mcapSol: number }).mcapSol ?? 0);
    }
    const fwd = buildFwdWindowMax(ts, mcap, FWD);
    const features = new FeatureEngine();
    for (const e of evts) {
      if (e.type === 'TokenCreated') features.onEvent(e);
    }
    const fired = new Set<string>();
    for (let i = 0; i < trades.length; i++) {
      const e = trades[i];
      features.onEvent(e);
      if (mcap[i] <= 0 || !Number.isFinite(fwd[i])) continue;
      const mult = fwd[i] / mcap[i];
      baseMults.push(mult);
      const f = features.get(mint);
      if (!f) continue;
      const s = scoreFeatures(f);
      const hits = [...s.evidence, ...s.vetoed];
      for (const id of hits) {
        if (fired.has(id)) continue;
        fired.add(id);
        ruleMults.get(id)!.push(mult);
      }
    }
  }

  const base = {
    samples: baseMults.length,
    p15: baseMults.length ? baseMults.filter((x) => x >= 1.5).length / baseMults.length : null,
    p2: baseMults.length ? baseMults.filter((x) => x >= 2).length / baseMults.length : null,
    p5: baseMults.length ? baseMults.filter((x) => x >= 5).length / baseMults.length : null,
    medianMult: baseMults.length ? median(baseMults) : null,
    meanMult: baseMults.length ? baseMults.reduce((a, b) => a + b, 0) / baseMults.length : null,
  };

  const raw = RULES.map((r) => {
    const m = ruleMults.get(r.id)!;
    const p2 = m.length ? m.filter((x) => x >= 2).length / m.length : null;
    return { r, m, p2 };
  });
  const pValues = raw.filter((x) => !x.r.veto && x.p2 != null && base.p2 != null)
    .map((x) => twoSidedBinomialP(Math.round((x.p2 ?? 0) * x.m.length), x.m.length, base.p2 ?? 0));
  const qValues = bhQValues(pValues);
  let qIdx = 0;

  const rules: RuleQuality[] = raw.map(({ r, m, p2 }) => {
    const isTested = !r.veto && p2 != null && base.p2 != null;
    const pValue = isTested
      ? twoSidedBinomialP(Math.round((p2 ?? 0) * m.length), m.length, base.p2 ?? 0)
      : null;
    const qValue = isTested ? qValues[qIdx++] ?? null : null;
    return {
      id: r.id,
      desc: r.desc,
      veto: !!r.veto,
      samples: m.length,
      p15: m.length ? m.filter((x) => x >= 1.5).length / m.length : null,
      p2,
      p5: m.length ? m.filter((x) => x >= 5).length / m.length : null,
      medianMult: m.length ? median(m) : null,
      meanMult: m.length ? m.reduce((a, b) => a + b, 0) / m.length : null,
      lift2x: p2 != null && base.p2 != null && base.p2 > 0 ? p2 / base.p2 : null,
      pValue,
      qValue,
      falseKillPct: r.veto && m.length ? m.filter((x) => x >= 2).length / m.length : null,
    };
  });

  const notes = [
    '规则统计使用「每币首次命中」，避免同一枚币刷屏；基准是同一时刻所有币的池化前向峰值。',
    'p/q 值基于正态近似 + BH FDR；样本高度相关，仅用于排序，不应当作独立实验的精确显著性。',
    '前向峰值 ≠ 可实现收益；真实收益看回测/验证器的成本与延迟压力测试。',
  ];

  return {
    windowMin: FWD / 60_000,
    baseline: base,
    rules,
    notes,
  };
}

// ---------------------------------------------------------------------------
// 5. 参数敏感性（只在全样本上做稳健性检查，不拿最优参数当结论）
// ---------------------------------------------------------------------------

interface SensitivityCell {
  tpPct: number;
  slPct: number;
  maxHoldMin: number;
  minTier: string;
  closed: number;
  pnlSol: number;
  expectancySol: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
}

function sensitivityGrid(envelopes: Envelope[], base: BacktestConfig): SensitivityCell[] {
  const tps = QUICK ? [1.0] : [1.0, 1.5];
  const sls = QUICK ? [0.5] : [0.35, 0.5, 0.65];
  const holds = QUICK ? [30] : [15, 30, 45];
  const tiers: Array<BacktestConfig['minTier']> = ['B'];
  const out: SensitivityCell[] = [];
  for (const tp of tps) {
    for (const sl of sls) {
      for (const hold of holds) {
        for (const tier of tiers) {
          const cfg: BacktestConfig = {
            ...base,
            tpPct: tp,
            slPct: sl,
            maxHoldMs: hold * 60_000,
            minTier: tier,
          };
          const { report } = runBacktest(envelopes, cfg);
          out.push({
            tpPct: tp,
            slPct: sl,
            maxHoldMin: hold,
            minTier: tier,
            closed: report.closed,
            pnlSol: round(report.pnlSol, 6),
            expectancySol: round(report.expectancySol, 6),
            winRate: round(report.winRate, 6),
            profitFactor: round(report.profitFactor, 4),
            maxDrawdownPct: round(report.maxDrawdownPct, 2),
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 6. 判定
// ---------------------------------------------------------------------------

interface Gate {
  id: string;
  label: string;
  pass: boolean;
  value: string;
  threshold: string;
  detail?: string;
}

type Verdict = 'INSUFFICIENT_DATA' | 'NO_GO' | 'PAPER_ONLY' | 'GO_LIVE';

interface ValidationReport {
  generatedAt: string;
  source: string;
  strategyVersion: string;
  tierThresholds: typeof TIER_THRESHOLDS;
  verdict: Verdict;
  verdictLabel: string;
  reasons: string[];
  gates: Gate[];
  dataAudit: DataAudit;
  config: BacktestConfig;
  walkForward: {
    folds: Array<{
      index: number;
      fromTs: number;
      toTs: number;
      closed: number;
      pnlSol: number;
      expectancySol: number;
      winRate: number;
      profitFactor: number;
      maxDrawdownPct: number;
      stuckExits: number;
      endExits: number;
    }>;
    aggregate: BacktestReport;
    positiveFolds: number;
    foldCount: number;
  };
  costs: Scenario[];
  latency: Scenario[];
  randomBaseline: {
    probability: number;
    aggregate: BacktestReport;
    edgeVsRandomSol: number;
    note: string;
  };
  statistics: {
    bootstrap: BootstrapResult;
    ruleQuality: RuleQualityReport;
  };
  sensitivity: {
    cells: SensitivityCell[];
    best: SensitivityCell | null;
    medianExpectancySol: number;
    profitablePct: number;
    bestVsMedian: number | null;
  };
  recommendations: string[];
  limitations: string[];
  elapsedMs: number;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  INSUFFICIENT_DATA: '样本不足，不能下结论',
  NO_GO: '不通过：禁止投入真钱',
  PAPER_ONLY: '仅纸面：可继续观察，禁止实盘',
  GO_LIVE: '通过：可进入极小资金实盘',
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main(): void {
  const t0 = Date.now();
  if (!DB_PATH) {
    console.error('缺少 --db');
    process.exit(1);
  }

  console.log(`\n═══ 策略严苛验证 ═══  [${DB_PATH}]  策略 ${STRATEGY_VERSION}`);

  // 1) 数据审计
  const dataAudit = auditData(DB_PATH);
  console.log(`\n① 数据审计`);
  console.log(
    `   成交 ${dataAudit.trades} 笔 / ${dataAudit.mintsWithTrades} 币 / 创建 ${dataAudit.tokens} 个` +
      ` / 跨度 ${dataAudit.durationHours}h / 有效 ${dataAudit.activeHours}h（覆盖 ${dataAudit.coveragePct}%）` +
      ` / 数据年龄 ${dataAudit.dataAgeHours}h`
  );
  console.log(
    `   每币成交 p50=${dataAudit.tradesPerMint.p50} p90=${dataAudit.tradesPerMint.p90}` +
      ` 最大=${dataAudit.tradesPerMint.max}   空小时=${dataAudit.emptyHourBuckets}` +
      `   最长中断=${dataAudit.maxGapMinutes}min   币覆盖率=${dataAudit.tokenCoveragePct}%`
  );
  if (dataAudit.notes.length) for (const n of dataAudit.notes) console.log(`   · ${n}`);

  // 2) 事件流
  const envelopes = loadFromDb(DB_PATH);
  if (envelopes.length === 0) {
    console.error('没有可用事件，终止。');
    process.exit(1);
  }
  const windows = foldWindowsByEvents(envelopes, FOLDS);

  // 3) 基准 walk-forward
  const baseCfg: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    // 验证默认比演示更保守：3s 延迟 + 150bps 额外滑点
    entryDelayMs: 3000,
    exitDelayMs: 3000,
    slipBps: 150,
    seed: 20261018,
  };
  const base = runScenario(envelopes, baseCfg, windows, 'base', '基准（3s 延迟 / 150bps 滑点）', {});

  console.log(`\n② Walk-forward 样本外（${FOLDS} 折，仅窗口内开仓）`);
  for (const f of base.folds) {
    console.log(
      `   折 ${f.index}: 平仓 ${f.report.closed}  盈亏 ${f.report.pnlSol.toFixed(4)} SOL` +
        `  胜率 ${(f.report.winRate * 100).toFixed(1)}%  回撤 ${f.report.maxDrawdownPct.toFixed(1)}%`
    );
  }
  console.log(
    `   汇总: 平仓 ${base.aggregate.closed}  盈亏 ${base.aggregate.pnlSol.toFixed(4)} SOL` +
      `  期望 ${base.aggregate.expectancySol.toFixed(4)} SOL/笔  胜率 ${(base.aggregate.winRate * 100).toFixed(1)}%` +
      `  PF ${Number.isFinite(base.aggregate.profitFactor) ? base.aggregate.profitFactor.toFixed(2) : '∞'}`
  );

  // 4) 成本 / 延迟压力
  const costScenarios: Scenario[] = [
    base,
    runScenario(envelopes, baseCfg, windows, 'stress', '压力（10s 延迟 / 2x 费 / 400bps 滑点）', {
      feeBps: 200,
      slipBps: 400,
      entryDelayMs: 10_000,
      exitDelayMs: 10_000,
    }),
    runScenario(envelopes, baseCfg, windows, 'extreme', '极端（30s 延迟 / 3x 费 / 800bps 滑点）', {
      feeBps: 300,
      slipBps: 800,
      entryDelayMs: 30_000,
      exitDelayMs: 30_000,
    }),
  ];
  console.log(`\n③ 成本 / 延迟压力`);
  for (const s of costScenarios) {
    console.log(
      `   ${s.label}: 平仓 ${s.aggregate.closed}  盈亏 ${s.aggregate.pnlSol.toFixed(4)} SOL` +
        `  期望 ${s.aggregate.expectancySol.toFixed(4)} SOL/笔`
    );
  }

  const latencyScenarios: Scenario[] = [
    runScenario(envelopes, baseCfg, windows, 'lat0', '0s 延迟', { entryDelayMs: 0, exitDelayMs: 0 }),
    base,
    runScenario(envelopes, baseCfg, windows, 'lat10', '10s 延迟', { entryDelayMs: 10_000, exitDelayMs: 10_000 }),
    runScenario(envelopes, baseCfg, windows, 'lat30', '30s 延迟', { entryDelayMs: 30_000, exitDelayMs: 30_000 }),
  ];
  console.log(`\n④ 延迟敏感性`);
  for (const s of latencyScenarios) {
    console.log(
      `   ${s.label}: 平仓 ${s.aggregate.closed}  期望 ${s.aggregate.expectancySol.toFixed(4)} SOL/笔` +
        `  盈亏 ${s.aggregate.pnlSol.toFixed(4)} SOL`
    );
  }

  // 5) 随机入场基线
  const p =
    base.aggregate.opportunities > 0
      ? Math.max(1e-6, Math.min(0.5, base.aggregate.entries / base.aggregate.opportunities))
      : 0;
  const random = runScenario(envelopes, baseCfg, windows, 'random', '随机入场基线', {
    entryMode: 'random',
    randomEntryProbability: p,
    seed: 20261019,
  });
  console.log(`\n⑤ 随机入场基线（p=${p.toExponential(2)}）`);
  console.log(
    `   策略期望 ${base.aggregate.expectancySol.toFixed(4)} SOL/笔` +
      `   随机期望 ${random.aggregate.expectancySol.toFixed(4)} SOL/笔` +
      `   优势 ${(base.aggregate.expectancySol - random.aggregate.expectancySol).toFixed(4)} SOL/笔`
  );

  // 6) 统计
  const bootstrap = clusterBootstrap(
    base.trades,
    2000,
    20261020
  );
  console.log(`\n⑥ Cluster bootstrap（按币种重采样 2000 次）`);
  console.log(
    `   单笔期望 95% CI [${bootstrap.expectancySol.ci95[0].toFixed(4)}, ${bootstrap.expectancySol.ci95[1].toFixed(4)}] SOL` +
      `   总盈亏 95% CI [${bootstrap.meanPnlSol.ci95[0].toFixed(4)}, ${bootstrap.meanPnlSol.ci95[1].toFixed(4)}] SOL`
  );
  console.log(
    `   胜率 95% CI [${(bootstrap.winRate.ci95[0] * 100).toFixed(1)}%, ${(bootstrap.winRate.ci95[1] * 100).toFixed(1)}%]`
  );

  const ruleQuality = analyzeRuleQuality(envelopes, 60 * 60_000);
  console.log(`\n⑦ 规则质量 + FDR（基准 ≥2x ${((ruleQuality.baseline.p2 ?? 0) * 100).toFixed(2)}%）`);
  for (const r of ruleQuality.rules.filter((x) => !x.veto)) {
    console.log(
      `   ${r.id.padEnd(14)} n=${String(r.samples).padStart(5)}` +
        `  ≥2x=${r.p2 == null ? '—' : (r.p2 * 100).toFixed(1) + '%'}` +
        `  lift=${r.lift2x == null ? '—' : r.lift2x.toFixed(2) + 'x'}` +
        `  q=${r.qValue == null ? '—' : r.qValue.toFixed(3)}`
    );
  }

  // 7) 参数敏感性
  const cells = sensitivityGrid(envelopes, baseCfg);
  const expCells = cells.map((c) => c.expectancySol).filter((x) => Number.isFinite(x));
  const profitable = cells.filter((c) => c.expectancySol > 0).length;
  const sorted = [...cells].sort((a, b) => b.expectancySol - a.expectancySol);
  const best = sorted[0] ?? null;
  const med = expCells.length ? median(expCells) : 0;
  const profitablePct = cells.length ? profitable / cells.length : 0;
  console.log(`\n⑧ 参数敏感性（${cells.length} 组，全样本稳健性检查）`);
  console.log(
    `   正期望组合 ${profitable}/${cells.length} = ${(profitablePct * 100).toFixed(0)}%` +
      `   中位期望 ${med.toFixed(4)} SOL/笔   最佳 ${best ? best.expectancySol.toFixed(4) : '—'}`
  );

  // 8) 判定
  const positiveFolds = base.folds.filter((f) => f.report.pnlSol > 0).length;
  const foldCount = base.folds.length;
  const lowerCi = bootstrap.expectancySol.ci95[0];
  const sufficient =
    dataAudit.activeHours >= MIN_HOURS &&
    dataAudit.trades >= MIN_TRADES &&
    dataAudit.mintsWithTrades >= MIN_MINTS &&
    base.aggregate.closed >= MIN_CLOSED &&
    base.aggregate.signals >= MIN_SIGNALS;
  const liveSample =
    dataAudit.activeHours >= LIVE_MIN_HOURS && base.aggregate.closed >= LIVE_MIN_CLOSED;

  const significantRules = ruleQuality.rules.filter(
    (r) => !r.veto && r.qValue != null && r.qValue < 0.1 && (r.lift2x ?? 0) > 1.2
  ).length;

  const harmfulRules = ruleQuality.rules.filter(
    (r) => !r.veto && r.qValue != null && r.qValue < 0.1 && (r.lift2x ?? 1) < 0.9
  );
  const neutralRules = ruleQuality.rules.filter(
    (r) => !r.veto && (r.qValue == null || r.qValue >= 0.1 || ((r.lift2x ?? 1) >= 0.9 && (r.lift2x ?? 1) <= 1.2))
  );
  const falseKillVetoes = ruleQuality.rules.filter(
    (r) => r.veto && (r.falseKillPct ?? 0) > 0.2
  );
  const recommendations: string[] = [];
  if (harmfulRules.length) {
    recommendations.push(
      `显著反向的评分规则：${harmfulRules.map((r) => `${r.id}(lift ${(r.lift2x ?? 0).toFixed(2)}x, q=${(r.qValue ?? 1).toFixed(3)})`).join('、')}。` +
        '先删除或重做这些规则，不要在原权重上继续调参。'
    );
  }
  if (neutralRules.length) {
    recommendations.push(
      `没有证据支持为正的规则：${neutralRules.map((r) => r.id).join('、')}；保留观察可以，但不能把它们的权重当成 edge。`
    );
  }
  if (significantRules === 0) {
    recommendations.push('没有任何规则通过 BH-FDR：当前评分体系没有可证明的筛选 edge，先不要改 TP/SL 或加杠杆。');
  }
  if (falseKillVetoes.length) {
    recommendations.push(
      `误杀率偏高的 veto：${falseKillVetoes.map((r) => `${r.id}(${((r.falseKillPct ?? 0) * 100).toFixed(1)}%)`).join('、')}；` +
        '需要确认这是风险控制还是过度过滤。'
    );
  }
  recommendations.push('只有在有效数据 ≥7 天、样本外通过后，才考虑改规则/参数；在 0.5 小时数据上调参属于过拟合。');

  const gates: Gate[] = [
    {
      id: 'sample',
      label: '样本量',
      pass: sufficient,
      value: `${dataAudit.activeHours}h 有效 / ${base.aggregate.closed} 平仓 / ${base.aggregate.signals} 信号`,
      threshold: `≥${MIN_HOURS}h 有效 / ≥${MIN_CLOSED} 平仓 / ≥${MIN_SIGNALS} 信号`,
      detail: '样本不足时任何胜率/收益都可能是噪声，必须明确写「不能下结论」。',
    },
    {
      id: 'live_sample',
      label: '实盘样本',
      pass: liveSample,
      value: `${dataAudit.activeHours}h 有效 / ${base.aggregate.closed} 平仓`,
      threshold: `≥${LIVE_MIN_HOURS}h 有效 / ≥${LIVE_MIN_CLOSED} 平仓`,
      detail: '实盘门槛：至少 7 天真实数据、100 笔平仓。',
    },
    {
      id: 'expectancy',
      label: '样本外期望（CI 下界）',
      pass: lowerCi > 0,
      value: `${bootstrap.expectancySol.ci95[0].toFixed(4)} SOL/笔`,
      threshold: '> 0',
      detail: '不是看均值，而是看按币种 cluster bootstrap 后的 95% 置信下界。',
    },
    {
      id: 'profit_factor',
      label: '盈亏比',
      pass: base.aggregate.profitFactor >= 1.2,
      value: Number.isFinite(base.aggregate.profitFactor) ? base.aggregate.profitFactor.toFixed(2) : '∞',
      threshold: '≥ 1.20',
      detail: '低于 1.2 时，手续费/滑点的一次波动就能吃掉全部利润。',
    },
    {
      id: 'drawdown',
      label: '最大回撤',
      pass: base.aggregate.maxDrawdownPct <= 25,
      value: `${base.aggregate.maxDrawdownPct.toFixed(1)}%`,
      threshold: '≤ 25%',
      detail: '回测回撤通常小于实盘，超过 25% 说明仓位/止损不可接受。',
    },
    {
      id: 'fold_stability',
      label: '样本外折稳定性',
      pass: foldCount > 0 && positiveFolds / foldCount >= 0.5,
      value: `${positiveFolds}/${foldCount} 折盈利`,
      threshold: '≥ 50%',
      detail: '只在某一折赚钱，通常是市场状态或过拟合。',
    },
    {
      id: 'cost_stress',
      label: '成本压力',
      pass: costScenarios[1].aggregate.expectancySol > 0,
      value: `${costScenarios[1].aggregate.expectancySol.toFixed(4)} SOL/笔`,
      threshold: '2x 费 + 400bps 滑点 + 10s 延迟下 > 0',
      detail: '真实摩擦比曲线公式高；压力场景亏损就不配上实盘。',
    },
    {
      id: 'latency',
      label: '延迟压力',
      pass: (latencyScenarios[2]?.aggregate.expectancySol ?? -1) > 0,
      value: `${(latencyScenarios[2]?.aggregate.expectancySol ?? 0).toFixed(4)} SOL/笔`,
      threshold: '10s 延迟下 > 0',
      detail: '我们不是 colocation 节点，10s 延迟是现实上限。',
    },
    {
      id: 'random_baseline',
      label: '随机入场基线',
      pass: base.aggregate.expectancySol > random.aggregate.expectancySol,
      value: `策略 ${base.aggregate.expectancySol.toFixed(4)} vs 随机 ${random.aggregate.expectancySol.toFixed(4)}`,
      threshold: '策略 > 随机',
      detail: '如果随机撒钱一样赚，说明收益来自市场 beta，不是筛选 edge。',
    },
    {
      id: 'parameter_plateau',
      label: '参数平原',
      pass: profitablePct >= 0.5 && med > 0,
      value: `${(profitablePct * 100).toFixed(0)}% 组合正期望，中位 ${med.toFixed(4)}`,
      threshold: '≥50% 组合正期望且中位 > 0',
      detail: '只在某一个 TP/SL 组合上赚钱 = 曲线拟合。',
    },
    {
      id: 'rule_significance',
      label: '规则多重检验',
      pass: significantRules > 0,
      value: `${significantRules} 条规则 q<0.1 且 lift>1.2`,
      threshold: '≥ 1 条',
      detail: '6 条打分规则同时测试，必须做 BH FDR；没有显著规则说明评分只是噪声。',
    },
  ];

  const failed = gates.filter((g) => !g.pass);
  let verdict: Verdict;
  if (!sufficient) verdict = 'INSUFFICIENT_DATA';
  else if (failed.some((g) => g.id !== 'live_sample' && g.id !== 'rule_significance')) verdict = 'NO_GO';
  else if (!liveSample) verdict = 'PAPER_ONLY';
  else if (failed.length > 0) verdict = 'NO_GO';
  else verdict = 'GO_LIVE';

  const reasons: string[] = [];
  if (!sufficient) {
    reasons.push(
      `样本不足：${dataAudit.activeHours}h 有效 / ${base.aggregate.closed} 平仓 / ${base.aggregate.signals} 信号；` +
        `至少需要 ${MIN_HOURS}h 有效、${MIN_CLOSED} 平仓、${MIN_SIGNALS} 信号。`
    );
    reasons.push('当前数据只能用于检查流水线，不能用来判断策略是否有效。');
  }
  for (const g of failed) {
    if (g.id === 'live_sample' && verdict === 'PAPER_ONLY') {
      reasons.push(`${g.label}未达实盘门槛：${g.value}（需要 ${g.threshold}）。`);
    } else if (!(g.id === 'sample' && !sufficient)) {
      reasons.push(`${g.label}未通过：${g.value}（阈值 ${g.threshold}）。`);
    }
  }
  if (verdict === 'INSUFFICIENT_DATA') {
    reasons.push('结论：不能下「有效」或「无效」的结论；继续采集，禁止投钱。');
  } else if (verdict === 'NO_GO') {
    reasons.push('结论：当前策略不满足实盘门槛，禁止投入真钱。');
  } else if (verdict === 'PAPER_ONLY') {
    reasons.push('结论：可以继续纸面跟踪，但样本/门槛未满足实盘要求。');
  } else {
    reasons.push('结论：所有硬门槛通过，但仍应先以小资金实盘、并保持 HALT 开关。');
  }

  const limitations = [
    '回测使用 pump.fun 恒定乘积曲线 + 额外滑点；未建模 MEV 三明治、区块竞争、RPC 失败和交易失败重试。',
    '成交只来自本地采集器覆盖的 mint；没有成交记录的币不在样本内，存在覆盖偏差。',
    'walk-forward 各折是独立资金账户，未模拟跨折资金曲线；折与折之间可能有时间重叠的持仓。',
    '规则显著性使用前向峰值（非可实现收益），且规则之间高度相关；q 值只用于排序和预警。',
    '参数敏感性在全样本上做，仅用于判断「是否只在一个参数点赚钱」，不能替代样本外验证。',
    '当前数据时长和样本量可能不足以覆盖不同市场状态（冷清/狂热/迁移潮）。',
  ];

  const report: ValidationReport = {
    generatedAt: new Date(NOW).toISOString(),
    source: DB_PATH,
    strategyVersion: STRATEGY_VERSION,
    tierThresholds: TIER_THRESHOLDS,
    verdict,
    verdictLabel: VERDICT_LABEL[verdict],
    reasons,
    gates,
    dataAudit,
    config: baseCfg,
    walkForward: {
      folds: base.folds.map((f) => ({
        index: f.index,
        fromTs: f.fromTs,
        toTs: f.toTs,
        closed: f.report.closed,
        pnlSol: round(f.report.pnlSol, 6),
        expectancySol: round(f.report.expectancySol, 6),
        winRate: round(f.report.winRate, 6),
        profitFactor: round(f.report.profitFactor, 4),
        maxDrawdownPct: round(f.report.maxDrawdownPct, 2),
        stuckExits: f.report.stuckExits,
        endExits: f.report.endExits,
      })),
      aggregate: base.aggregate,
      positiveFolds,
      foldCount,
    },
    costs: costScenarios.map((s) => ({
      ...s,
      aggregate: { ...s.aggregate, config: s.config },
      folds: s.folds.map((f) => ({
        ...f,
        report: {
          ...f.report,
          // 折叠明细只保留紧凑字段，避免 JSON 膨胀
          rules: [],
        },
      })),
    })),
    latency: latencyScenarios.map((s) => ({
      ...s,
      aggregate: { ...s.aggregate, config: s.config },
      folds: s.folds.map((f) => ({ ...f, report: { ...f.report, rules: [] } })),
    })),
    randomBaseline: {
      probability: p,
      aggregate: random.aggregate,
      edgeVsRandomSol: round(base.aggregate.expectancySol - random.aggregate.expectancySol, 6),
      note: '随机基线使用同样的离场规则、资金约束、延迟和成本；只把「选币/择时」替换成随机。',
    },
    statistics: { bootstrap, ruleQuality },
    sensitivity: {
      cells,
      best,
      medianExpectancySol: round(med, 6),
      profitablePct: round(profitablePct, 4),
      bestVsMedian: best ? round(best.expectancySol - med, 6) : null,
    },
    recommendations,
    limitations,
    elapsedMs: Date.now() - t0,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date(NOW).toISOString().replace(/[:.]/g, '-');
  const file = join(OUT_DIR, `validation-${stamp}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  mkdirSync(dirname(LATEST_OUT), { recursive: true });
  writeFileSync(LATEST_OUT, JSON.stringify(report, null, 2));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));

  console.log(`\n═══ 结论：${verdict} · ${VERDICT_LABEL[verdict]} ═══`);
  for (const r of reasons) console.log(`  · ${r}`);
  if (recommendations.length) {
    console.log('\n规则 / 下一步建议：');
    for (const r of recommendations) console.log(`  → ${r}`);
  }
  console.log(`\n报告：${file}`);
  console.log(`最新：${LATEST_OUT}`);
  console.log(`耗时：${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

main();
