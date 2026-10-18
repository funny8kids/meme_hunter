/**
 * 验证统计：不依赖外部库，全部可复现。
 *
 * 这里只放纯函数：
 *   - percentile / normalCdf / 二项检验 p 值
 *   - Benjamini-Hochberg FDR
 *   - 按币种 cluster bootstrap（meme 交易里同一币的多笔结果高度相关，
 *     按「笔」重采样会严重低估置信区间）
 */

import { mulberry32 } from './clock.ts';

export interface BootstrapTrade {
  mint: string;
  pnlSol: number;
  costSol: number;
}

export interface BootstrapResult {
  iterations: number;
  mints: number;
  trades: number;
  meanPnlSol: { point: number; ci95: [number, number] };
  winRate: { point: number; ci95: [number, number] };
  profitFactor: { point: number; ci95: [number, number] };
  expectancySol: { point: number; ci95: [number, number] };
}

export function percentile(a: number[], p: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** 标准正态 CDF（Abramowitz-Stegun 7.1.26 的 erf 近似） */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** 两正态近似二项检验：观测成功率 success/n 是否偏离 p0 */
export function twoSidedBinomialP(success: number, n: number, p0: number): number {
  if (n <= 0) return 1;
  const se = Math.sqrt(Math.max(1e-12, (p0 * (1 - p0)) / n));
  const z = (success / n - p0) / se;
  return Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
}

/** Benjamini-Hochberg FDR：返回与输入同序的 q 值 */
export function bhQValues(pValues: number[]): number[] {
  const m = pValues.length;
  if (!m) return [];
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const q = new Array<number>(m).fill(1);
  let prev = 1;
  for (let k = m - 1; k >= 0; k--) {
    const { p, i } = order[k];
    const val = Math.min(prev, (p * m) / (k + 1));
    q[i] = Math.min(1, val);
    prev = q[i];
  }
  return q;
}

function round(n: number, d = 6): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/**
 * 按币种 cluster bootstrap。
 * 同一枚币的多笔平仓不是独立样本；重采样「币」而不是「笔」。
 */
export function clusterBootstrap(
  trades: BootstrapTrade[],
  iterations: number,
  seed: number
): BootstrapResult {
  if (trades.length === 0) {
    return {
      iterations: 0,
      mints: 0,
      trades: 0,
      meanPnlSol: { point: 0, ci95: [0, 0] },
      winRate: { point: 0, ci95: [0, 0] },
      profitFactor: { point: 0, ci95: [0, 0] },
      expectancySol: { point: 0, ci95: [0, 0] },
    };
  }

  const byMint = new Map<string, number[]>();
  for (const t of trades) {
    const arr = byMint.get(t.mint) ?? [];
    arr.push(t.pnlSol);
    byMint.set(t.mint, arr);
  }
  const clusters = [...byMint.values()];
  const rng = mulberry32(seed);
  const pnls: number[] = [];
  const wins: number[] = [];
  const pfs: number[] = [];
  const exp: number[] = [];

  const pointPnl = trades.reduce((a, t) => a + t.pnlSol, 0);
  const pointWins = trades.filter((t) => t.pnlSol > 0).length;
  const grossWin = trades.filter((t) => t.pnlSol > 0).reduce((a, t) => a + t.pnlSol, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnlSol <= 0).reduce((a, t) => a + t.pnlSol, 0));
  const pointPf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  for (let it = 0; it < iterations; it++) {
    let pnl = 0;
    let n = 0;
    let w = 0;
    let gw = 0;
    let gl = 0;
    for (let c = 0; c < clusters.length; c++) {
      const pick = Math.floor(rng() * clusters.length);
      for (const p of clusters[pick]) {
        pnl += p;
        n++;
        if (p > 0) {
          w++;
          gw += p;
        } else {
          gl += -p;
        }
      }
    }
    pnls.push(pnl);
    wins.push(n > 0 ? w / n : 0);
    pfs.push(gl > 0 ? gw / gl : gw > 0 ? 999 : 0);
    exp.push(n > 0 ? pnl / n : 0);
  }

  return {
    iterations,
    mints: clusters.length,
    trades: trades.length,
    meanPnlSol: {
      point: round(pointPnl),
      ci95: [round(percentile(pnls, 0.025)), round(percentile(pnls, 0.975))],
    },
    winRate: {
      point: round(trades.length ? pointWins / trades.length : 0),
      ci95: [round(percentile(wins, 0.025)), round(percentile(wins, 0.975))],
    },
    profitFactor: {
      point: round(pointPf, 4),
      ci95: [round(percentile(pfs, 0.025), 4), round(percentile(pfs, 0.975), 4)],
    },
    expectancySol: {
      point: round(trades.length ? pointPnl / trades.length : 0),
      ci95: [round(percentile(exp, 0.025)), round(percentile(exp, 0.975))],
    },
  };
}
