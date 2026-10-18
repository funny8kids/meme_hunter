/**
 * 策略 v2：先把“评分规则”拿掉，只留下可解释的 veto + 结构过滤。
 *
 * 依据：v1 的 6 条评分规则在 1.3h 样本上 lift 全部 < 1；
 * 继续给它们加权只会放大反向选择。v2 先回答一个更小的问题：
 *   “只靠 veto（活跃度/Dev/集中度/前 10 秒 bundle/市值区间）能不能接近正期望？”
 *
 * v2 的 veto 全部来自本地历史成交，回测/实盘一致，不引入第三方当前快照的前视偏差。
 */

import { createHash } from 'node:crypto';
import type { Features } from './features.ts';

export interface RuleV2 {
  id: string;
  desc: string;
  veto: boolean;
  test(f: Features): boolean;
}

export const RULES_V2: RuleV2[] = [
  { id: 'v_alive', desc: '5m 成交 ≥3', veto: true, test: (f) => f.trades5m >= 3 },
  { id: 'v_dev', desc: 'Dev 持仓 <15%', veto: true, test: (f) => f.devHeldPct < 0.15 },
  {
    id: 'v_bundle',
    desc: '前 10 秒买家 ≥3 且前 3 占比 ≤90%',
    veto: true,
    test: (f) => f.first10sWallets < 3 || f.first10sTop3Share <= 0.9,
  },
  {
    id: 'v_concentration',
    desc: '5m 最大买家占比 ≤65%',
    veto: true,
    test: (f) => f.topBuyerShare <= 0.65,
  },
  {
    id: 'v_mcap',
    desc: '市值 15–500 SOL',
    veto: true,
    test: (f) => f.mcapSol >= 15 && f.mcapSol <= 500,
  },
];

export const STRATEGY_VERSION_V2 = createHash('sha256')
  .update(RULES_V2.map((r) => `${r.id}:${r.veto ? 1 : 0}`).join('|'))
  .digest('hex')
  .slice(0, 12);

export interface ScoreV2 {
  score: number;
  tier: 'A' | 'B' | 'C' | null;
  evidence: string[];
  vetoed: string[];
}

export function scoreFeaturesV2(f: Features): ScoreV2 {
  const vetoed: string[] = [];
  for (const r of RULES_V2) {
    if (r.veto && !r.test(f)) vetoed.push(r.id);
  }
  if (vetoed.length) return { score: 0, tier: null, evidence: [], vetoed };
  // 通过 veto 即 B；没有正向评分，避免用未验证的指标继续选择。
  return { score: 50, tier: 'B', evidence: ['veto_pass'], vetoed: [] };
}
