/**
 * 回测内核回归测试。
 *
 * 重点不是「能不能赚钱」，而是那些最容易骗自己的地方：
 *   1. 同一输入必须得到同一结果（确定性）
 *   2. 延迟成交：信号后没有后续成交 → 取消，而不是凭空成交
 *   3. 死币：离场触发后长期无成交 → 打折出清，而不是按最后价无限可卖
 *   4. 数据结束：未平仓位必须折价清算
 *   5. 额外滑点必须真实降低收益
 *   6. 随机基线可复现
 */

import type { Envelope } from './types.ts';
import { DEFAULT_BACKTEST_CONFIG, runBacktest, type BacktestConfig } from './backtestcore.ts';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
}

const TOTAL_SUPPLY = 1_000_000_000;

function token(mint: string, ts: number, seq: number): Envelope {
  return {
    seq,
    tsWall: ts,
    tsMono: ts,
    v: 1,
    type: 'TokenCreated',
    payload: {
      mint,
      creator: `DEV-${mint}`,
      name: mint,
      symbol: mint,
      pool: 'pump',
      devBuySol: 0,
      devBuyTokens: 0,
      createdAt: ts,
      mcapSol: 30,
      vSol: 30,
      vTokens: TOTAL_SUPPLY,
      sig: `create-${mint}`,
    },
  };
}

function trade(
  mint: string,
  ts: number,
  seq: number,
  side: 'buy' | 'sell',
  sol: number,
  mcap: number,
  wallet: string,
  vSol: number,
  vTokens: number
): Envelope {
  return {
    seq,
    tsWall: ts,
    tsMono: ts,
    v: 1,
    type: 'Trade',
    payload: {
      mint,
      side,
      wallet,
      sol,
      tokens: (sol / (mcap / TOTAL_SUPPLY)) * 0.98,
      vSol,
      vTokens,
      mcapSol: mcap,
      sig: `t-${mint}-${seq}`,
    },
  };
}

/** 造一个能通过评分、并且在指定时刻暴跌的币 */
function scenario(opts: {
  includeFollowup?: boolean;
  followupAt?: number;
  addOtherEvent?: boolean;
  exitDelayMs?: number;
  maxExitStaleMs?: number;
  endHaircut?: number;
  /** 在数据末尾追加一枚无关币，用来推进全局时钟（测试过期/超时） */
  advanceClockMs?: number;
} = {}): Envelope[] {
  const out: Envelope[] = [];
  const t0 = 1_800_000_000_000;
  const mint = 'MINT-A';
  let seq = 0;
  out.push(token(mint, t0, ++seq));
  let mcap = 30;
  let vSol = 30;
  let vTokens = TOTAL_SUPPLY;
  for (let i = 0; i < 20; i++) {
    const ts = t0 + (i + 1) * 1000;
    mcap *= 1.03;
    vSol += 0.05;
    vTokens -= 150_000;
    out.push(trade(mint, ts, ++seq, 'buy', 0.05, mcap, `W${i}`, vSol, vTokens));
  }
  if (opts.includeFollowup !== false) {
    // 触发止损：价格跌到入场市值的约 25%，确保 early 入场也能触发
    const at = t0 + (opts.followupAt ?? 25_000);
    mcap *= 0.2;
    vSol *= 0.45;
    out.push(trade(mint, at, ++seq, 'sell', 0.2, mcap, 'WHALE', vSol, vTokens));
    if (opts.addOtherEvent) {
      // 另一枚币的成交推进全局时钟，让「死币」超时规则有机会执行
      out.push(token('MINT-B', at + 1000, ++seq));
      out.push(trade('MINT-B', at + 1000 + (opts.maxExitStaleMs ?? 60_000) + 1000, ++seq, 'buy', 0.05, 30, 'WX', 30, TOTAL_SUPPLY));
    }
  }
  if (opts.advanceClockMs) {
    const at = t0 + opts.advanceClockMs;
    out.push(token('MINT-C', at, ++seq));
    out.push(trade('MINT-C', at, ++seq, 'buy', 0.05, 30, 'WY', 30, TOTAL_SUPPLY));
  }
  return out;
}

const base: BacktestConfig = {
  ...DEFAULT_BACKTEST_CONFIG,
  entryDelayMs: 3000,
  exitDelayMs: 0,
  maxEntryWaitMs: 30_000,
  maxExitStaleMs: 60_000,
  slipBps: 150,
  seed: 42,
};

console.log('回测内核：');

// ---- 1. 确定性 ----
{
  const a = runBacktest(scenario(), base);
  const b = runBacktest(scenario(), base);
  check('同输入同配置结果一致', a.report.pnlSol === b.report.pnlSol && a.report.closed === b.report.closed);
  check('确实产生了入场', a.report.entries > 0, `entries=${a.report.entries}`);
}

// ---- 2. 延迟后无成交 → 取消 ----
{
  const rows = scenario({ includeFollowup: false, advanceClockMs: 120_000 });
  const r = runBacktest(rows, { ...base, entryDelayMs: 60_000, maxEntryWaitMs: 1000 });
  check('延迟后无成交不凭空入场', r.report.entries === 0 && r.report.closed === 0, `entries=${r.report.entries}`);
  check('未成交计划被计数为取消', r.report.canceled > 0, `canceled=${r.report.canceled}`);
}

// ---- 3. 零延迟正常成交 ----
{
  const r = runBacktest(scenario(), { ...base, entryDelayMs: 0, exitDelayMs: 0 });
  check('零延迟可以成交', r.report.entries > 0, `entries=${r.report.entries}`);
  check('止损/离场有记录', Object.keys(r.report.exitReasons).length > 0, JSON.stringify(r.report.exitReasons));
}

// ---- 4. 死币折价 ----
{
  const r = runBacktest(scenario({ exitDelayMs: 3000, maxExitStaleMs: 5000, addOtherEvent: true, advanceClockMs: 120_000 }), {
    ...base,
    exitDelayMs: 3000,
    maxExitStaleMs: 5000,
  });
  check('长期无成交触发 stuck_exit', (r.report.exitReasons['stuck_exit'] ?? 0) > 0, JSON.stringify(r.report.exitReasons));
  check('stuck_exit 被计数', r.report.stuckExits > 0, `stuckExits=${r.report.stuckExits}`);
}

// ---- 5. 数据结束折价 ----
{
  const r = runBacktest(scenario({ includeFollowup: false }), {
    ...base,
    exitDelayMs: 0,
    endExitHaircut: 0.5,
  });
  check('数据结束未平仓被清算', r.report.endExits > 0, `endExits=${r.report.endExits}`);
}

// ---- 6. 额外滑点降低收益 ----
{
  const zero = runBacktest(scenario(), { ...base, exitDelayMs: 0, slipBps: 0 });
  const high = runBacktest(scenario(), { ...base, exitDelayMs: 0, slipBps: 500, maxImpactBps: 1000 });
  check('滑点越高盈亏越低', high.report.pnlSol < zero.report.pnlSol, `${zero.report.pnlSol.toFixed(4)} → ${high.report.pnlSol.toFixed(4)}`);
}

// ---- 9. 冲击上限与流动性缩放 ----
{
  const rejected = runBacktest(scenario(), { ...base, entryDelayMs: 0, exitDelayMs: 0, maxImpactBps: 100 });
  check('冲击超限时拒绝入场', rejected.report.entries === 0 && rejected.report.riskRejected > 0, `entries=${rejected.report.entries}`);

  const scaled = runBacktest(scenario(), {
    ...base,
    entryDelayMs: 0,
    exitDelayMs: 0,
    sizeSol: 5,
    sizePctOfLiquidity: 0.001,
    minSizeSol: 0.0001,
    maxImpactBps: 1000,
  });
  check('按流动性缩放后产生入场', scaled.report.entries > 0, `entries=${scaled.report.entries}`);
  check('实际成本被缩到小仓位', scaled.closedTrades.every((t) => t.costSol <= 0.05), JSON.stringify(scaled.closedTrades.map((t) => t.costSol)));
}

// ---- 7. 随机基线可复现 ----
{
  const cfg: BacktestConfig = { ...base, entryDelayMs: 0, exitDelayMs: 0, entryMode: 'random', randomEntryProbability: 0.3 };
  const a = runBacktest(scenario(), cfg);
  const b = runBacktest(scenario(), cfg);
  check('随机基线同种子结果一致', a.report.pnlSol === b.report.pnlSol && a.report.entries === b.report.entries);
  check('随机基线会产生入场', a.report.entries > 0, `entries=${a.report.entries}`);
}

// ---- 8. 手续费归因 ----
{
  const r = runBacktest(scenario(), { ...base, exitDelayMs: 0 });
  check('手续费为正且被记录', r.report.feesSol > 0, `fees=${r.report.feesSol.toFixed(6)}`);
  check('每个平仓都有往返手续费', r.closedTrades.every((t) => t.feesSol >= 0));
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
