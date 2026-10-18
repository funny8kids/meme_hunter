/**
 * 验证统计测试：这些数字直接进入「能不能投钱」的判定，不能靠感觉。
 */

import {
  percentile,
  normalCdf,
  twoSidedBinomialP,
  bhQValues,
  clusterBootstrap,
} from './stats.ts';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
}

console.log('验证统计：');

// ---- percentile ----
{
  check('中位数（奇数）', percentile([3, 1, 2], 0.5) === 2);
  check('中位数（偶数）', percentile([4, 1, 3, 2], 0.5) === 2.5);
  check('空数组为 NaN', Number.isNaN(percentile([], 0.5)));
  check('0/100 分位', percentile([1, 2, 3], 0) === 1 && percentile([1, 2, 3], 1) === 3);
}

// ---- 正态 CDF ----
{
  check('Φ(0)=0.5', Math.abs(normalCdf(0) - 0.5) < 1e-6);
  check('Φ(1.96)≈0.975', Math.abs(normalCdf(1.96) - 0.975) < 0.001);
  check('对称性', Math.abs(normalCdf(-1.2) + normalCdf(1.2) - 1) < 1e-9);
}

// ---- 二项检验 ----
{
  const p = twoSidedBinomialP(50, 100, 0.5);
  check('50/100 不显著', p > 0.9, p.toFixed(3));
  const p2 = twoSidedBinomialP(70, 100, 0.5);
  check('70/100 显著', p2 < 0.001, p2.toExponential(2));
}

// ---- BH FDR ----
{
  const q = bhQValues([0.001, 0.01, 0.04, 0.5]);
  check('BH 输出同长度', q.length === 4);
  check('BH q 值单调', q.every((v, i) => i === 0 || v >= q[i - 1] - 1e-12), q.map((x) => x.toFixed(3)).join(','));
  check('BH 不小于原始 p', q.every((v, i) => v >= [0.001, 0.01, 0.04, 0.5][i] - 1e-12));
  check('空输入', bhQValues([]).length === 0);
}

// ---- cluster bootstrap ----
{
  const trades = [
    { mint: 'A', pnlSol: 0.2, costSol: 0.1 },
    { mint: 'A', pnlSol: -0.1, costSol: 0.1 },
    { mint: 'B', pnlSol: 0.3, costSol: 0.1 },
    { mint: 'C', pnlSol: -0.2, costSol: 0.1 },
  ];
  const r1 = clusterBootstrap(trades, 500, 123);
  const r2 = clusterBootstrap(trades, 500, 123);
  check('bootstrap 可复现', JSON.stringify(r1) === JSON.stringify(r2));
  check('按币种聚类数正确', r1.mints === 3);
  check('置信区间有序', r1.expectancySol.ci95[0] <= r1.expectancySol.ci95[1]);
  check('胜率在 [0,1]', r1.winRate.ci95[0] >= 0 && r1.winRate.ci95[1] <= 1);
  const empty = clusterBootstrap([], 100, 1);
  check('空样本返回 0', empty.trades === 0 && empty.expectancySol.point === 0);
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
