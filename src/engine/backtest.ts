#!/usr/bin/env node
/**
 * 回测 CLI：真实数据结论必须用 --db；--demo 只做流水线自检。
 *
 * 用法：
 *   node src/engine/backtest.ts --demo --tokens 800
 *   node src/engine/backtest.ts --db data/meme.db --split 0.7
 *
 * 这个文件只负责「参数解析 + 打印 + 落报告」；成交逻辑在 backtestcore.ts，
 * 验证器（validate.ts）复用同一份内核，避免两套代码得出两套结论。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Envelope } from './types.ts';
import { loadFromDb } from './marketfeed.ts';
import {
  DEFAULT_BACKTEST_CONFIG,
  runBacktest,
  type BacktestConfig,
  type BacktestReport,
} from './backtestcore.ts';
import { mulberry32 } from './clock.ts';

const TOTAL_SUPPLY = 1_000_000_000;
const argv = process.argv.slice(2);

const getArg = (k: string, d?: string): string | undefined => {
  const i = argv.indexOf(k);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};

function parseConfig(): BacktestConfig {
  const c = { ...DEFAULT_BACKTEST_CONFIG };
  const num = (k: string, fallback: number): number => {
    const v = Number(getArg(k, String(fallback)));
    return Number.isFinite(v) ? v : fallback;
  };
  const tier = getArg('--min-tier', c.minTier);
  return {
    ...c,
    initialSol: num('--initial', c.initialSol),
    sizeSol: num('--size', c.sizeSol),
    tpPct: num('--tp', c.tpPct),
    slPct: num('--sl', c.slPct),
    maxHoldMs: num('--max-hold-min', c.maxHoldMs / 60_000) * 60_000,
    feeBps: num('--fee-bps', c.feeBps),
    prioritySol: num('--priority', c.prioritySol),
    slipBps: num('--slip-bps', c.slipBps),
    strategy: (() => { const v = getArg('--strategy', c.strategy); return v === 'v2' || v === 'crash' ? v : 'v1'; })(),
    maxPositions: num('--max-positions', c.maxPositions),
    trailingStopPct: num('--trailing-stop', c.trailingStopPct),
    exitOnDevSell: argv.includes('--exit-on-dev-sell'),
    minTier: tier === 'A' || tier === 'B' || tier === 'C' ? tier : c.minTier,
    cooldownMs: num('--cooldown-min', c.cooldownMs / 60_000) * 60_000,
    entryDelayMs: num('--entry-delay-sec', c.entryDelayMs / 1000) * 1000,
    exitDelayMs: num('--exit-delay-sec', c.exitDelayMs / 1000) * 1000,
    maxEntryWaitMs: num('--entry-wait-sec', c.maxEntryWaitMs / 1000) * 1000,
    maxExitStaleMs: num('--stale-min', c.maxExitStaleMs / 60_000) * 60_000,
    stuckExitHaircut: num('--stuck-haircut', c.stuckExitHaircut),
    endExitHaircut: num('--end-haircut', c.endExitHaircut),
  };
}

// ---------------- 合成数据（仅用于流水线自检） ----------------

function demoEnvelopes(tokenCount: number, seed = 2024): Envelope[] {
  const rng = mulberry32(seed);
  const out: Envelope[] = [];
  let seq = 0;
  let t = 1_700_000_000_000;

  for (let i = 0; i < tokenCount; i++) {
    const mint = `DEMO${i.toString().padStart(5, '0')}`;
    const quality = rng();
    let mcap = 28 + rng() * 6;
    t += 500 + Math.floor(rng() * 3000);

    seq++;
    const devBuySol = 0.5 + rng() * 2;
    out.push({
      seq,
      tsWall: t,
      tsMono: t,
      v: 1,
      type: 'TokenCreated',
      payload: {
        mint,
        creator: `DEV${i}`,
        name: `Demo ${i}`,
        symbol: `D${i}`,
        pool: 'pump',
        devBuySol,
        devBuyTokens: (devBuySol / (mcap / TOTAL_SUPPLY)),
        createdAt: t,
        mcapSol: mcap,
        vSol: mcap,
        vTokens: TOTAL_SUPPLY,
        sig: `create-${i}`,
      },
    });

    const n = 40 + Math.floor(rng() * 120);
    for (let j = 0; j < n; j++) {
      t += 1000 + Math.floor(rng() * 29_000);
      const isBuy = rng() < 0.45 + 0.15 * quality;
      const sol = 0.02 + rng() * 1.2;

      if (isBuy) {
        const drift = quality > 0.93 ? 1 + rng() * 0.06 : 1;
        mcap *= 1 + (sol / mcap) * (0.5 + rng() * 0.5) * drift;
      } else {
        mcap *= 1 - (sol / mcap) * (0.5 + rng() * 0.5);
      }
      mcap *= 0.995 + 0.01 * quality;
      mcap = Math.max(4, Math.min(5000, mcap));

      seq++;
      out.push({
        seq,
        tsWall: t,
        tsMono: t,
        v: 1,
        type: 'Trade',
        payload: {
          mint,
          side: isBuy ? 'buy' : 'sell',
          wallet: `W${Math.floor(rng() * 80)}`,
          sol,
          tokens: (sol / (mcap / TOTAL_SUPPLY)) * 0.9,
          vSol: mcap,
          vTokens: TOTAL_SUPPLY,
          mcapSol: mcap,
          sig: `trade-${i}-${j}`,
        },
      });
    }
  }
  return out;
}

// ---------------- 打印 ----------------

function printReport(r: BacktestReport, source: string, synthetic: boolean): void {
  const f = (n: number, d = 4) => n.toFixed(d);
  console.log(`\n═══ 回测报告 ═══  [${source}]`);
  if (synthetic) {
    console.log('⚠️  合成数据流水线自检 —— 这里的收益数字没有参考意义');
    console.log('    真实结论必须用 --db 跑你自己采集的数据');
  }
  console.log(
    `策略版本 ${r.strategyVersion}   最小档位 ${r.config.minTier}` +
      `   延迟 ${r.config.entryDelayMs / 1000}s/${r.config.exitDelayMs / 1000}s` +
      `   滑点 ${r.config.slipBps}bps`
  );
  console.log('');
  console.log(`事件        ${r.events}`);
  console.log(`信号        ${r.signals}   被否决 ${r.vetoed}`);
  console.log(`入场        ${r.entries}   平仓 ${r.closed}   涉及币种 ${r.mintsTraded}`);
  console.log(`取消入场    ${r.canceled}   风控拒绝 ${r.riskRejected}   机会 ${r.opportunities}`);
  console.log('');
  console.log(`胜率        ${(r.winRate * 100).toFixed(1)}%   (${r.wins}/${r.closed})`);
  console.log(`净盈亏      ${f(r.pnlSol)} SOL   (${r.returnPct.toFixed(2)}%)`);
  console.log(`单笔期望    ${f(r.expectancySol)} SOL   收益标准差 ${r.returnStdPct.toFixed(1)}%`);
  console.log(`盈亏比      ${Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞'}`);
  console.log(`平均盈利    ${f(r.avgWinSol)} SOL    平均亏损 ${f(r.avgLossSol)} SOL`);
  console.log(`最大回撤    ${r.maxDrawdownPct.toFixed(2)}%`);
  console.log(`平均持仓    ${r.avgHoldMin.toFixed(1)} 分钟`);
  console.log(`手续费      ${f(r.feesSol)} SOL`);
  console.log(`离场原因    ${JSON.stringify(r.exitReasons)}`);
  console.log(`死币折价    ${r.stuckExits} 笔   数据结束清算 ${r.endExits} 笔`);
  console.log('');
  if (r.rules.length) {
    console.log('规则归因（按贡献排序）:');
    console.log('  ' + '规则'.padEnd(16) + '笔数'.padStart(6) + '胜率'.padStart(8) + '盈亏(SOL)'.padStart(12));
    for (const s of r.rules) {
      console.log(
        '  ' +
          s.id.padEnd(16) +
          String(s.trades).padStart(6) +
          `${((s.wins / Math.max(1, s.trades)) * 100).toFixed(0)}%`.padStart(8) +
          f(s.pnlSol).padStart(12)
      );
    }
    console.log('');
  }
}

// ---------------- 入口 ----------------

function main(): void {
  const useDemo = argv.includes('--demo') || argv.length === 0;
  const dbPath = getArg('--db') ?? 'data/meme.db';
  const tokens = Number(getArg('--tokens', '800'));
  const split = Number(getArg('--split', '0'));
  const cfg = parseConfig();

  const envelopes = useDemo ? demoEnvelopes(tokens) : loadFromDb(dbPath);
  if (envelopes.length === 0) {
    console.error('没有事件。先跑采集器，或用 --demo 自检。');
    process.exit(1);
  }

  const source = useDemo ? `demo x${tokens}` : dbPath;
  mkdirSync('data/reports', { recursive: true });
  const stamp = Date.now();

  if (split > 0 && split < 1) {
    const cutTs = envelopes[0].tsWall + (envelopes[envelopes.length - 1].tsWall - envelopes[0].tsWall) * split;
    const t0 = Date.now();
    const train = runBacktest(envelopes, cfg, { toTs: cutTs });
    const test = runBacktest(envelopes, cfg, { fromTs: cutTs });
    const ms = Date.now() - t0;

    printReport(train.report, `${source} · 训练段（前 ${(split * 100).toFixed(0)}%）`, useDemo);
    printReport(test.report, `${source} · 样本外（后 ${((1 - split) * 100).toFixed(0)}%）`, useDemo);
    console.log(`⏱ 耗时 ${ms}ms`);

    const out = join('data/reports', `backtest-${stamp}.json`);
    writeFileSync(out, JSON.stringify({ synthetic: useDemo, source, split, train: train.report, test: test.report }, null, 2));
    console.log(`报告已写入 ${out}`);
    console.log('\n提示：样本外盈利才值得进入下一步（纸面小额）；样本外亏损说明规则在过拟合，别投钱。');
    return;
  }

  const t0 = Date.now();
  const { report } = runBacktest(envelopes, cfg);
  const ms = Date.now() - t0;

  printReport(report, source, useDemo);
  console.log(`⏱ 耗时 ${ms}ms`);

  const out = join('data/reports', `backtest-${stamp}.json`);
  writeFileSync(out, JSON.stringify({ synthetic: useDemo, source, ...report }, null, 2));
  console.log(`报告已写入 ${out}`);
}

main();
