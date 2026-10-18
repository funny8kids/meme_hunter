/**
 * 纸面交易所：用**真实曲线数学**模拟成交，而不是拍一个固定滑点。
 *
 * 恒定乘积 x·y=k：
 *   买入 Δ：tokensOut = vTokens·Δ / (vSol + Δ)
 *   卖出 Δ：solOut    = vSol·Δ / (vTokens + Δ)
 *
 * 这是 pump.fun 曲线本身的公式，所以纸面成交价与链上一致（差异只剩优先费和真实滑点）。
 */

import type { Fill, Quote, Trade } from '../types.ts';

export interface PaperOpts {
  /** 平台手续费，pump 约 100 bps */
  feeBps?: number;
  /** 每笔固定优先费（SOL） */
  prioritySol?: number;
  /**
   * 额外滑点（bps，单边）：曲线公式之外的保守折扣，用于覆盖延迟、
   * 聚合路由失败、区块竞争等无法从历史成交还原的成本。
   */
  slippageBps?: number;
}

interface Reserves {
  vSol: number;
  vTokens: number;
}

export class PaperVenue {
  readonly feeBps: number;
  readonly prioritySol: number;
  readonly slippageBps: number;
  #reserves = new Map<string, Reserves>();
  /** 因流动性不足被拒绝的次数 */
  rejected = 0;

  constructor(opts: PaperOpts = {}) {
    this.feeBps = opts.feeBps ?? 100;
    this.prioritySol = opts.prioritySol ?? 0.0005;
    this.slippageBps = opts.slippageBps ?? 0;
  }

  onTrade(t: Trade): void {
    if (t.vSol > 0 && t.vTokens > 0) {
      this.#reserves.set(t.mint, { vSol: t.vSol, vTokens: t.vTokens });
    }
  }

  seed(mint: string, vSol: number, vTokens: number): void {
    this.#reserves.set(mint, { vSol, vTokens });
  }

  reserves(mint: string): Reserves | null {
    return this.#reserves.get(mint) ?? null;
  }

  /** 当前隐含市值（SOL）：price × 10 亿 */
  mcapSol(mint: string): number {
    const r = this.#reserves.get(mint);
    if (!r || r.vTokens <= 0) return 0;
    return (r.vSol / r.vTokens) * 1_000_000_000;
  }

  quoteBuy(mint: string, sol: number): Quote | null {
    const r = this.#reserves.get(mint);
    if (!r || sol <= 0) return null;
    const fee = sol * (this.feeBps / 10_000);
    const eff = sol - fee;
    const rawTokensOut = (r.vTokens * eff) / (r.vSol + eff);
    const tokensOut = rawTokensOut * (1 - this.slippageBps / 10_000);
    if (!(tokensOut > 0)) return null;
    return {
      mint,
      side: 'buy',
      solIn: sol,
      tokensOut,
      price: sol / tokensOut,
      feeSol: fee + this.prioritySol,
      impactBps: Math.round((eff / r.vSol) * 10_000) + this.slippageBps,
    };
  }

  quoteSell(mint: string, tokens: number): Quote | null {
    const r = this.#reserves.get(mint);
    if (!r || tokens <= 0) return null;
    const gross = (r.vSol * tokens) / (r.vTokens + tokens);
    const fee = gross * (this.feeBps / 10_000);
    const afterCosts = Math.max(0, gross - fee - this.prioritySol);
    const net = afterCosts * (1 - this.slippageBps / 10_000);
    return {
      mint,
      side: 'sell',
      solIn: net,
      tokensOut: tokens,
      price: tokens > 0 ? net / tokens : 0,
      feeSol: fee + this.prioritySol,
      impactBps: Math.round((tokens / r.vTokens) * 10_000) + this.slippageBps,
    };
  }

  buy(mint: string, sol: number, ts: number): Fill | null {
    const q = this.quoteBuy(mint, sol);
    if (!q) {
      this.rejected++;
      return null;
    }
    const r = this.#reserves.get(mint)!;
    const fee = sol * (this.feeBps / 10_000);
    const eff = sol - fee;
    // 池子按曲线真实输出扣减；滑点折扣是交易者的损失，不应让池子凭空多留代币
    const curveTokensOut = (r.vTokens * eff) / (r.vSol + eff);
    this.#reserves.set(mint, {
      vSol: r.vSol + eff,
      vTokens: r.vTokens - curveTokensOut,
    });
    return {
      mint,
      side: 'buy',
      sol, // 实际支付（含费）
      tokens: q.tokensOut,
      price: q.price,
      feeSol: q.feeSol,
      ts,
    };
  }

  sell(mint: string, tokens: number, ts: number): Fill | null {
    const q = this.quoteSell(mint, tokens);
    if (!q) {
      this.rejected++;
      return null;
    }
    const r = this.#reserves.get(mint)!;
    const gross = (r.vSol * tokens) / (r.vTokens + tokens);
    this.#reserves.set(mint, {
      vSol: Math.max(0, r.vSol - gross),
      vTokens: r.vTokens + tokens,
    });
    return {
      mint,
      side: 'sell',
      sol: q.solIn, // 实际到手（已扣费）
      tokens,
      price: q.price,
      feeSol: q.feeSol,
      ts,
    };
  }
}
