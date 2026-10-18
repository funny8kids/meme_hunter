#!/usr/bin/env node
/**
 * crash 候选的 walk-forward 验证。
 *
 * 和 validate.ts 的区别：
 *   - 只验证 crash 风险版（流动性缩放 + 冲击上限 + 20 笔以内并发）；
 *   - 每折只允许在测试窗口内开新仓，折末按数据结束折价清算；
 *   - 同时跑成本压力、10s 延迟、随机基线、参数敏感性；
 *   - 报告明确写「样本不足」，不把全样本拟合当结论。
 *
 * 用法：
 *   node src/validate-crash.ts --db data/meme.db
 *   node src/validate-crash.ts --folds 4 --quick
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFromDb } from './engine/marketfeed.ts';
import {
  DEFAULT_BACKTEST_CONFIG,
  runBacktest,
  summarize,
  type BacktestConfig,
  type BacktestReport,
} from './engine/backtestcore.ts';
import { clusterBootstrap } from './engine/stats.ts';
import type { ClosedTrade } from './engine/portfolio.ts';
import type { Envelope } from './engine/types.ts';

const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(k);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const flag = (k: string): boolean => argv.includes(k);
const DB = arg('--db', 'data/meme.db');
const FOLDS = Math.max(2, Math.min(8, Number(arg('--folds', '4'))));
const QUICK = flag('--quick');
const OUT = arg('--out', 'data/reports/crash-validation-latest.json');

const events = loadFromDb(DB);
if (!events.length) {
  console.error('no events');
  process.exit(1);
}

const base: BacktestConfig = {
  ...DEFAULT_BACKTEST_CONFIG,
  strategy: 'crash',
  initialSol: 10,
  sizeSol: 0.02,
  maxPositions: 10,
  cooldownMs: 0,
  crashDropPct: 0.5,
  crashMinAgeSec: 300,
  crashMaxAgeSec: 1800,
  crashMinTrades: 3,
  tpPct: 1,
  slPct: 0.5,
  maxHoldMs: 30 * 60_000,
  feeBps: 100,
  prioritySol: 0.0005,
  slipBps: 150,
  maxImpactBps: 200,
  sizePctOfLiquidity: 0.01,
  minSizeSol: 0.002,
  entryDelayMs: 3000,
  exitDelayMs: 3000,
  maxEntryWaitMs: 30_000,
  maxExitStaleMs: 15 * 60_000,
  stuckExitHaircut: 0.5,
  endExitHaircut: 0.5,
  entryMode: 'strategy',
  randomEntryProbability: 0,
  seed: 20261018,
};

interface Fold {
  index: number;
  fromTs: number;
  toTs: number;
  report: BacktestReport;
}

function foldWindows(envelopes: Envelope[], folds: number): Array<{ fromTs: number; toTs: number }> {
  const ts: number[] = [];
  for (const e of envelopes) if (e.type === 'Trade') ts.push(e.tsWall);
  if (ts.length < 20) return [];
  const seg = ts.length / (folds + 1);
  const out: Array<{ fromTs: number; toTs: number }> = [];
  for (let i = 1; i <= folds; i++) {
    const a = Math.floor(seg * i);
    const b = Math.floor(seg * (i + 1));
    if (a >= ts.length) break;
    out.push({ fromTs: ts[a], toTs: b < ts.length ? ts[b] : Infinity });
  }
  return out;
}

function mergeCounts(target: Record<string, number>, src: Record<string, number>): void {
  for (const [k, v] of Object.entries(src)) target[k] = (target[k] ?? 0) + v;
}

function runFolds(
  envelopes: Envelope[],
  cfg: BacktestConfig,
  windows: Array<{ fromTs: number; toTs: number }>
): { folds: Fold[]; report: BacktestReport; trades: ClosedTrade[] } {
  const folds: Fold[] = [];
  const trades: ClosedTrade[] = [];
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
    const w = windows[i];
    // 关键：只把数据截到折末，避免折后价格回填折内仓位
    const slice = Number.isFinite(w.toTs) ? envelopes.filter((e) => e.tsWall <= w.toTs) : envelopes;
    const { report, closedTrades } = runBacktest(slice, cfg, { fromTs: w.fromTs, toTs: Infinity });
    folds.push({ index: i + 1, fromTs: w.fromTs, toTs: w.toTs, report });
    trades.push(...closedTrades);
    signals += report.signals;
    vetoed += report.vetoed;
    entries += report.entries;
    canceled += report.canceled;
    riskRejected += report.riskRejected;
    opportunities += report.opportunities;
    stuckExits += report.stuckExits;
    endExits += report.endExits;
    mergeCounts(exitReasons, report.exitReasons);
  }

  const report = summarize(trades, cfg, {
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
  return { folds, report, trades };
}

function activeHours(envelopes: Envelope[]): number {
  const mins = new Set<number>();
  for (const e of envelopes) if (e.type === 'Trade') mins.add(Math.floor(e.tsWall / 60_000));
  return mins.size / 60;
}

const windows = foldWindows(events, FOLDS);
if (!windows.length) {
  console.error('not enough trade events for folds');
  process.exit(1);
}

const baseRun = runFolds(events, base, windows);
const costRun = runFolds(events, { ...base, feeBps: 200, slipBps: 400, prioritySol: 0.002, maxImpactBps: 1000 }, windows);
const latencyRun = runFolds(events, { ...base, entryDelayMs: 10_000, exitDelayMs: 10_000 }, windows);

const entryRate = baseRun.report.opportunities > 0 ? baseRun.report.entries / baseRun.report.opportunities : 0;
const randomRun = runFolds(
  events,
  { ...base, entryMode: 'random', randomEntryProbability: Math.max(0.01, Math.min(0.5, entryRate)) },
  windows
);

const sensitivity: Array<{ id: string; patch: Partial<BacktestConfig>; expectancySol: number; closed: number; pf: number; maxDd: number }> = [];
if (!QUICK) {
  const variants: Array<{ id: string; patch: Partial<BacktestConfig> }> = [
    { id: 'drop_40', patch: { crashDropPct: 0.4 } },
    { id: 'drop_60', patch: { crashDropPct: 0.6 } },
    { id: 'hold_15m', patch: { maxHoldMs: 15 * 60_000 } },
    { id: 'hold_60m', patch: { maxHoldMs: 60 * 60_000 } },
    { id: 'impact_100', patch: { maxImpactBps: 100, slipBps: 0 } },
    { id: 'size_005', patch: { sizeSol: 0.05 } },
    { id: 'size_010', patch: { sizeSol: 0.1 } },
    { id: 'impact_400', patch: { maxImpactBps: 400 } },
  ];
  for (const v of variants) {
    const r = runFolds(events, { ...base, ...v.patch }, windows);
    sensitivity.push({
      id: v.id,
      patch: v.patch,
      expectancySol: r.report.expectancySol,
      closed: r.report.closed,
      pf: r.report.profitFactor,
      maxDd: r.report.maxDrawdownPct,
    });
  }
}

const bootstrap = clusterBootstrap(
  baseRun.trades.map((t) => ({ mint: t.mint, pnlSol: t.pnlSol, costSol: t.costSol })),
  2000,
  20261018
);

const hours = activeHours(events);
const minClosed = 30;
const minHours = 24;
const gates = {
  dataHours: hours >= minHours,
  closed: baseRun.report.closed >= minClosed,
  ciLower: bootstrap.expectancySol.ci95[0] > 0,
  profitFactor: baseRun.report.profitFactor >= 1.2,
  maxDrawdown: baseRun.report.maxDrawdownPct <= 25,
  costStress: costRun.report.expectancySol > 0,
  latencyStress: latencyRun.report.expectancySol > 0,
  beatsRandom: baseRun.report.expectancySol > randomRun.report.expectancySol,
};
const passed = Object.values(gates).every(Boolean);
const insufficient = !gates.dataHours || !gates.closed;
const verdict = passed ? 'GO_LIVE' : insufficient ? 'INSUFFICIENT_DATA' : 'NO_GO';

const report = {
  generatedAt: new Date().toISOString(),
  candidate: 'crash_risk',
  source: DB,
  config: base,
  data: {
    events: events.length,
    activeHours: Number(hours.toFixed(2)),
    folds: windows.length,
    windows: windows.map((w, i) => ({ fold: i + 1, fromTs: w.fromTs, toTs: Number.isFinite(w.toTs) ? w.toTs : null })),
  },
  base: baseRun.report,
  folds: baseRun.folds.map((f) => ({
    index: f.index,
    fromTs: f.fromTs,
    toTs: Number.isFinite(f.toTs) ? f.toTs : null,
    closed: f.report.closed,
    winRate: f.report.winRate,
    expectancySol: f.report.expectancySol,
    pnlSol: f.report.pnlSol,
    profitFactor: f.report.profitFactor,
    maxDrawdownPct: f.report.maxDrawdownPct,
  })),
  costStress: costRun.report,
  latencyStress: latencyRun.report,
  randomBaseline: randomRun.report,
  bootstrap,
  sensitivity,
  gates,
  verdict,
  notes: [
    '每折只允许在测试窗口内开新仓；折末按 endExitHaircut 折价清算。',
    'full-sample 结果不作为结论；本报告看 walk-forward、成本和延迟压力。',
    insufficient ? '样本不足，禁止实盘；继续采集。' : '样本门槛通过，但还需要 forward shadow 复核。',
  ],
};

mkdirSync(join('data', 'reports'), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));
writeFileSync('data/reports/crash-validation-latest.json', JSON.stringify(report, null, 2));

console.log('crash_risk walk-forward');
console.log(`  数据 ${hours.toFixed(2)}h · ${windows.length} 折`);
console.log(`  平仓 ${baseRun.report.closed} · 胜率 ${(baseRun.report.winRate * 100).toFixed(1)}% · 期望 ${baseRun.report.expectancySol.toFixed(4)} · PF ${baseRun.report.profitFactor.toFixed(2)} · 回撤 ${baseRun.report.maxDrawdownPct.toFixed(1)}%`);
console.log(`  bootstrap 期望 95% CI [${bootstrap.expectancySol.ci95[0].toFixed(4)}, ${bootstrap.expectancySol.ci95[1].toFixed(4)}]`);
console.log(`  成本压力 ${costRun.report.expectancySol.toFixed(4)} · 延迟压力 ${latencyRun.report.expectancySol.toFixed(4)} · 随机 ${randomRun.report.expectancySol.toFixed(4)}`);
console.log(`  结论：${verdict}`);
console.log(`  报告：${OUT}`);
