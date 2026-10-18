#!/usr/bin/env node
/**
 * 策略实验矩阵：同一份数据、同一套成交/成本模型，比较候选策略。
 *
 * 这不是“调参到赚钱”，而是把候选假设放在同一张桌子上：
 *   v1      现有评分规则
 *   v2      veto-only（去掉反向评分规则）
 *   crash   暴跌后的均值回归/彩票篮子
 *   capital 不同仓位上限
 *   exit    trailing / dev-sell / 短持仓
 *
 * 输出 data/reports/experiments-latest.json，控制台可一键运行。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFromDb } from './engine/marketfeed.ts';
import { DEFAULT_BACKTEST_CONFIG, runBacktest, type BacktestConfig } from './engine/backtestcore.ts';

const DB = (() => {
  const i = process.argv.indexOf('--db');
  return i >= 0 ? process.argv[i + 1] ?? 'data/meme.db' : 'data/meme.db';
})();

const events = loadFromDb(DB);
if (!events.length) {
  console.error('no events');
  process.exit(1);
}

const base: BacktestConfig = {
  ...DEFAULT_BACKTEST_CONFIG,
  initialSol: 10,
  sizeSol: 0.1,
  entryDelayMs: 3000,
  exitDelayMs: 3000,
  slipBps: 150,
  cooldownMs: 10 * 60_000,
  maxPositions: 3,
};

interface Case {
  id: string;
  label: string;
  cfg: BacktestConfig;
}

const cases: Case[] = [
  { id: 'v1_base', label: 'v1 当前规则 / 3仓 / 30m', cfg: { ...base } },
  { id: 'v1_m5', label: 'v1 / 5仓', cfg: { ...base, maxPositions: 5 } },
  { id: 'v1_m10', label: 'v1 / 10仓', cfg: { ...base, maxPositions: 10 } },
  {
    id: 'v1_short',
    label: 'v1 / 3仓 / TP20% SL30% 3m',
    cfg: { ...base, tpPct: 0.2, slPct: 0.3, maxHoldMs: 3 * 60_000, maxPositions: 8 },
  },
  { id: 'v2_m5', label: 'v2 veto-only / 5仓', cfg: { ...base, strategy: 'v2', maxPositions: 5 } },
  { id: 'v2_m10', label: 'v2 veto-only / 10仓', cfg: { ...base, strategy: 'v2', maxPositions: 10 } },
  {
    id: 'v2_trail',
    label: 'v2 / 10仓 / trailing 25%',
    cfg: { ...base, strategy: 'v2', maxPositions: 10, trailingStopPct: 0.25 },
  },
  {
    id: 'v2_dev',
    label: 'v2 / 10仓 / dev-sell exit',
    cfg: { ...base, strategy: 'v2', maxPositions: 10, exitOnDevSell: true },
  },
  {
    id: 'crash_30m',
    label: 'crash -50% / 30m / TP100% SL50%',
    cfg: {
      ...base,
      strategy: 'crash',
      initialSol: 10,
      sizeSol: 0.01,
      maxPositions: 200,
      cooldownMs: 0,
      crashDropPct: 0.5,
      maxHoldMs: 30 * 60_000,
      tpPct: 1,
      slPct: 0.5,
    },
  },
  {
    id: 'crash_60m',
    label: 'crash -50% / 60m / TP100% SL50%',
    cfg: {
      ...base,
      strategy: 'crash',
      initialSol: 10,
      sizeSol: 0.01,
      maxPositions: 200,
      cooldownMs: 0,
      crashDropPct: 0.5,
      maxHoldMs: 60 * 60_000,
      tpPct: 1,
      slPct: 0.5,
    },
  },
  {
    id: 'crash_risk',
    label: 'crash / 10仓 / 1% 流动性缩放 / 2% 冲击上限',
    cfg: {
      ...base,
      strategy: 'crash',
      initialSol: 10,
      sizeSol: 0.02,
      maxPositions: 10,
      cooldownMs: 0,
      crashDropPct: 0.5,
      maxHoldMs: 30 * 60_000,
      tpPct: 1,
      slPct: 0.5,
      sizePctOfLiquidity: 0.01,
      maxImpactBps: 200,
      minSizeSol: 0.002,
    },
  },
  {
    id: 'crash_trail',
    label: 'crash / 10仓 / trailing 25%',
    cfg: {
      ...base,
      strategy: 'crash',
      initialSol: 10,
      sizeSol: 0.02,
      maxPositions: 10,
      cooldownMs: 0,
      crashDropPct: 0.5,
      maxHoldMs: 30 * 60_000,
      tpPct: 1,
      slPct: 0.5,
      trailingStopPct: 0.25,
    },
  },
];

const results = cases.map((c) => {
  const { report } = runBacktest(events, c.cfg);
  return {
    id: c.id,
    label: c.label,
    strategy: c.cfg.strategy,
    config: c.cfg,
    closed: report.closed,
    entries: report.entries,
    signals: report.signals,
    wins: report.wins,
    winRate: report.winRate,
    pnlSol: report.pnlSol,
    returnPct: report.returnPct,
    expectancySol: report.expectancySol,
    profitFactor: report.profitFactor,
    maxDrawdownPct: report.maxDrawdownPct,
    avgHoldMin: report.avgHoldMin,
    exitReasons: report.exitReasons,
    stuckExits: report.stuckExits,
    endExits: report.endExits,
  };
});

results.sort((a, b) => b.expectancySol - a.expectancySol);
const profitable = results.filter((r) => r.expectancySol > 0);
const report = {
  generatedAt: new Date().toISOString(),
  source: DB,
  events: events.length,
  note:
    '全样本研究，不是样本外结论；用于比较候选策略。真正的实盘判断必须看 validate.ts 的 walk-forward/成本压力。',
  results,
  profitableCount: profitable.length,
  verdict: profitable.length > 0 ? 'CANDIDATES_POSITIVE' : 'NO_POSITIVE_ON_FULL_SAMPLE',
};

mkdirSync('data/reports', { recursive: true });
writeFileSync('data/reports/experiments-latest.json', JSON.stringify(report, null, 2));

console.log('策略实验（全样本）');
for (const r of results) {
  console.log(
    `${r.id.padEnd(10)} 平仓 ${String(r.closed).padStart(4)}  胜率 ${(r.winRate * 100).toFixed(1).padStart(5)}%  ` +
      `期望 ${r.expectancySol.toFixed(4).padStart(8)}  PF ${r.profitFactor.toFixed(2)}  回撤 ${r.maxDrawdownPct.toFixed(1)}%`
  );
}
console.log(`\n正期望候选 ${profitable.length}/${results.length} → ${report.verdict}`);
console.log('报告 data/reports/experiments-latest.json');
