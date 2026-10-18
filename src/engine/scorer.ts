/**
 * 规则评分：可解释、可归因、可版本化。
 *
 * 不用 ML 的理由：新系统没有足够标签，且无法解释「为什么买」。
 * 每条规则命中都记录进 evidence，回测时按规则统计期望值。
 */

import { createHash } from 'node:crypto';
import type { Features } from './features.ts';

export interface Rule {
  id: string;
  desc: string;
  weight: number;
  veto?: boolean;
  test(f: Features): boolean;
}

export const RULES: Rule[] = [
  // ---- 一票否决 ----
  { id: 'v_stale', desc: '最近 8 秒内有成交', weight: 0, veto: true, test: (f) => f.staleMs <= 8000 },
  { id: 'v_dev', desc: 'Dev 持仓 < 15%', weight: 0, veto: true, test: (f) => f.devHeldPct < 0.15 },
  { id: 'v_alive', desc: '5 分钟内有 ≥3 笔成交', weight: 0, veto: true, test: (f) => f.trades5m >= 3 },

  // ---- 打分项（合计 100）----
  { id: 'demand', desc: '5m 独立买家 ≥ 6', weight: 20, test: (f) => f.uniqueBuyers5m >= 6 },
  { id: 'momentum', desc: '5m 买卖比 ≥ 1.5', weight: 20, test: (f) => f.ratio5m >= 1.5 },
  { id: 'accel', desc: '成交量加速 ≥ 1.3', weight: 15, test: (f) => f.volAccel >= 1.3 },
  { id: 'velocity', desc: '5m 成交笔数 ≥ 15', weight: 15, test: (f) => f.trades5m >= 15 },
  { id: 'early', desc: '年龄 ≤ 30min 且市值 ≤ 150 SOL', weight: 15, test: (f) => f.ageSec <= 1800 && f.mcapSol <= 150 },
  { id: 'concentration', desc: '最大买家占比 ≤ 45%', weight: 15, test: (f) => f.topBuyerShare <= 0.45 },
];

const TOTAL_WEIGHT = RULES.filter((r) => !r.veto).reduce((a, r) => a + r.weight, 0);

/** 阈值：低于 C 不产生信号 */
export const TIER_THRESHOLDS = { A: 75, B: 55, C: 40 } as const;
export type Tier = 'A' | 'B' | 'C';

/** 策略版本 = 规则集指纹。参数一改，版本就变，历史归因不会串味。 */
export const STRATEGY_VERSION = createHash('sha256')
  .update(RULES.map((r) => `${r.id}:${r.weight}:${r.veto ? 1 : 0}`).join('|'))
  .digest('hex')
  .slice(0, 12);

export interface ScoreResult {
  score: number;
  tier: Tier | null;
  evidence: string[];
  vetoed: string[];
}

export function scoreFeatures(f: Features): ScoreResult {
  const evidence: string[] = [];
  const vetoed: string[] = [];
  let passed = 0;

  for (const r of RULES) {
    const ok = r.test(f);
    if (!ok) {
      if (r.veto) vetoed.push(r.id);
      continue;
    }
    if (r.veto) continue;
    evidence.push(r.id);
    passed += r.weight;
  }

  const score = Math.round((passed / TOTAL_WEIGHT) * 100);
  let tier: Tier | null = null;
  if (vetoed.length === 0) {
    if (score >= TIER_THRESHOLDS.A) tier = 'A';
    else if (score >= TIER_THRESHOLDS.B) tier = 'B';
    else if (score >= TIER_THRESHOLDS.C) tier = 'C';
  }

  return { score, tier, evidence, vetoed };
}
