/**
 * 仓位账本（单币账本，非复式）。
 *
 * 原则：仓位只能由 Fill 驱动，绝不凭空改数量。
 * 未实现盈亏按「最后成交市值」标记 —— meme 币没有可靠中间价。
 */

import type { Fill, Position } from './types.ts';

export interface ClosedTrade {
  mint: string;
  qty: number;
  costSol: number;
  proceedsSol: number;
  pnlSol: number;
  pnlPct: number;
  openedAt: number;
  closedAt: number;
  holdMs: number;
  reason: string;
  evidence: string[];
  /** 该笔往返手续费（SOL），用于成本归因 */
  feesSol: number;
}

export class Portfolio {
  cashSol: number;
  readonly initialSol: number;
  positions = new Map<string, Position>();
  closed: ClosedTrade[] = [];
  realizedSol = 0;
  feesSol = 0;

  constructor(initialSol: number) {
    this.initialSol = initialSol;
    this.cashSol = initialSol;
  }

  open(fill: Fill, intentId: string, mcapSol: number, evidence: string[]): Position {
    if (this.positions.has(fill.mint)) throw new Error(`position exists: ${fill.mint}`);
    const pos: Position = {
      mint: fill.mint,
      qty: fill.tokens,
      // fill.sol 已是「实际支付（含费）」，不再叠加 feeSol，避免重复计费
      costSol: fill.sol,
      entryPrice: fill.price,
      entryMcapSol: mcapSol,
      openedAt: fill.ts,
      intentId,
      evidence,
      peakMcapSol: mcapSol,
      entryFeeSol: fill.feeSol,
    };
    this.positions.set(fill.mint, pos);
    this.cashSol -= pos.costSol;
    this.feesSol += fill.feeSol;
    return pos;
  }

  mark(mint: string, mcapSol: number): void {
    const p = this.positions.get(mint);
    if (p && mcapSol > p.peakMcapSol) p.peakMcapSol = mcapSol;
  }

  /** 平仓，返回该笔净盈亏（SOL） */
  close(fill: Fill, reason: string): ClosedTrade | null {
    const p = this.positions.get(fill.mint);
    if (!p) return null;
    this.positions.delete(fill.mint);

    const proceeds = fill.sol; // 已是净到手
    const pnl = proceeds - p.costSol;
    this.cashSol += proceeds;
    this.realizedSol += pnl;
    this.feesSol += fill.feeSol;

    const t: ClosedTrade = {
      mint: p.mint,
      qty: p.qty,
      costSol: p.costSol,
      proceedsSol: proceeds,
      pnlSol: pnl,
      pnlPct: p.costSol > 0 ? pnl / p.costSol : 0,
      openedAt: p.openedAt,
      closedAt: fill.ts,
      holdMs: fill.ts - p.openedAt,
      reason,
      evidence: p.evidence,
      // 入场费存在 Fill 里但没有逐仓保存；这里以出场费 + 成本差近似不可行。
      // 由调用方在 open 时把 entryFeeSol 记到 position 上更准确，见 position 扩展。
      feesSol: fill.feeSol + (p.entryFeeSol ?? 0),
    };
    this.closed.push(t);
    return t;
  }

  /** 权益 = 现金 + 持仓按最后市值折算的成本占比（保守：用成本，不虚增） */
  equitySol(): number {
    let held = 0;
    for (const [, p] of this.positions) held += p.costSol;
    return this.cashSol + held;
  }

  /** 更激进的权益估算：持仓按 peak 标记（仅用于看最大浮盈） */
  equityAtPeaksSol(): number {
    let held = 0;
    for (const [, p] of this.positions) {
      const mult = p.entryMcapSol > 0 ? p.peakMcapSol / p.entryMcapSol : 1;
      held += p.costSol * Math.max(1, mult);
    }
    return this.cashSol + held;
  }
}
