/**
 * 流动性 / 冲击 / 仓位缩放测试。
 *
 * 目标不是要求模型精确，而是确保：
 *   1. 小池子大仓位会被拒绝；
 *   2. 仓位按流动性缩放；
 *   3. 往返成本随 size 和滑点上升；
 *   4. 风险预算不会超过冲击上限。
 */

import { buyImpactPct, sellImpactPct, maxSizeForImpact, sizeForLiquidity, quoteImpact, roundTripCost, riskBudgetSize, minSizeForCost } from './impact.ts';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
}

console.log('流动性冲击：');
check('买入冲击随 size 上升', buyImpactPct(1, 100) < buyImpactPct(10, 100));
check('卖出冲击高于买入冲击', sellImpactPct(10, 100) > buyImpactPct(10, 100));
check('size 接近流动性时卖出不可执行', !quoteImpact('sell', { sizeSol: 100, liquiditySol: 100, maxImpactPct: 0.1 }).executable);
check('超过冲击上限不可执行', !quoteImpact('buy', { sizeSol: 20, liquiditySol: 100, maxImpactPct: 0.01 }).executable);
check('小单可执行', quoteImpact('buy', { sizeSol: 1, liquiditySol: 100, maxImpactPct: 0.05 }).executable);
check('maxSizeForImpact 单调', maxSizeForImpact(100, 0.01) < maxSizeForImpact(100, 0.02));
check('sizeForLiquidity 不超过 cap', sizeForLiquidity(1, 100, 0.01) <= 1 + 1e-12);
check('小池子按冲击缩放', sizeForLiquidity(0.02, 1, 0.015) < 0.02);
check('零流动性返回 0', sizeForLiquidity(1, 0, 0.01) === 0);
check('往返成本高于单边', roundTripCost({ sizeSol: 1, liquiditySol: 100, maxImpactPct: 0.05 }).costSol > quoteImpact('buy', { sizeSol: 1, liquiditySol: 100 }).costSol);
check('风险预算不超过流动性上限', riskBudgetSize({ equitySol: 10, riskPct: 0.01, stopLossPct: 0.5, liquiditySol: 2, maxImpactPct: 0.01, capSol: 1 }) <= maxSizeForImpact(2, 0.01) + 1e-12);
check('风险预算不超过 cap', riskBudgetSize({ equitySol: 10, riskPct: 0.01, stopLossPct: 0.5, liquiditySol: 100, maxImpactPct: 0.05, capSol: 0.1 }) <= 0.1 + 1e-12);
check('固定优先费要求最小经济仓位', minSizeForCost({ prioritySol: 0.001, feeBps: 100, extraSlipBps: 150, maxCostPct: 0.08 }) > 0.02);
check('成本预算太小时无可行仓位', minSizeForCost({ prioritySol: 0.001, feeBps: 200, extraSlipBps: 400, maxCostPct: 0.05 }) === Infinity);

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
