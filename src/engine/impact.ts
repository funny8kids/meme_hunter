/**
 * 流动性 / 冲击 / 成本估算。
 *
 * 用途：
 *   - 回测：拒绝高冲击成交，按流动性缩放仓位；
 *   - forward shadow：不是固定 0.02 SOL，而是按池子深度决定 size；
 *   - 任何策略：先问「卖得掉吗」，再问「能赚吗」。
 *
 * 模型是保守的恒定乘积近似：
 *   buy impact  = size / (liquidity + size)
 *   sell impact = size / max(liquidity - size, eps)
 *
 * 它不是精确的链上报价，但足以拦住「小池子 + 大仓位」这种归零方式。
 */

export interface ImpactInput {
  /** 本次交易的 SOL 名义价值 */
  sizeSol: number;
  /** 池子 SOL 侧流动性（vSol） */
  liquiditySol: number;
  feeBps?: number;
  /** 每笔固定优先费（SOL） */
  prioritySol?: number;
  /** 额外单边滑点（bps） */
  extraSlipBps?: number;
  /** 最大允许单边冲击（0.01 = 1%） */
  maxImpactPct?: number;
}

export interface ImpactQuote {
  sizeSol: number;
  side: 'buy' | 'sell';
  impactPct: number;
  /** 费用 + 优先费 + 冲击 + 额外滑点，折算成 SOL */
  costSol: number;
  costPct: number;
  executable: boolean;
  reason?: string;
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function buyImpactPct(sizeSol: number, liquiditySol: number): number {
  if (!(sizeSol > 0) || !(liquiditySol > 0)) return 1;
  return clamp01(sizeSol / (liquiditySol + sizeSol));
}

export function sellImpactPct(sizeSol: number, liquiditySol: number): number {
  if (!(sizeSol > 0) || !(liquiditySol > 0)) return 1;
  if (sizeSol >= liquiditySol) return 1;
  return clamp01(sizeSol / (liquiditySol - sizeSol));
}

/** 给定最大冲击，最多能买/卖多少 SOL 名义价值 */
export function maxSizeForImpact(liquiditySol: number, maxImpactPct: number): number {
  if (!(liquiditySol > 0)) return 0;
  const p = Math.max(0.0001, Math.min(0.95, maxImpactPct));
  return (liquiditySol * p) / (1 - p);
}

/** 把固定 size 缩到池子允许的 size；返回 0 表示无法交易 */
export function sizeForLiquidity(capSol: number, liquiditySol: number, maxImpactPct: number): number {
  if (!(capSol > 0)) return 0;
  return Math.min(capSol, maxSizeForImpact(liquiditySol, maxImpactPct));
}

export function quoteImpact(
  side: 'buy' | 'sell',
  input: ImpactInput
): ImpactQuote {
  const size = Number(input.sizeSol);
  const liq = Number(input.liquiditySol);
  const feeBps = input.feeBps ?? 100;
  const priority = input.prioritySol ?? 0.0005;
  const slipBps = input.extraSlipBps ?? 0;
  const maxImpact = input.maxImpactPct ?? 0.02;

  if (!(size > 0) || !(liq > 0)) {
    return { sizeSol: size, side, impactPct: 1, costSol: size, costPct: 1, executable: false, reason: 'bad_liquidity' };
  }

  const impact = side === 'buy' ? buyImpactPct(size, liq) : sellImpactPct(size, liq);
  const fee = size * (feeBps / 10_000);
  const slip = size * (slipBps / 10_000);
  const impactCost = size * impact;
  const cost = fee + priority + slip + impactCost;
  const executable = impact <= maxImpact && (side === 'buy' || size < liq);
  return {
    sizeSol: size,
    side,
    impactPct: impact,
    costSol: cost,
    costPct: size > 0 ? cost / size : 1,
    executable,
    reason: executable ? undefined : impact > maxImpact ? 'impact_over_limit' : 'liquidity_too_low',
  };
}

/**
 * 往返成本估算：用于「这笔交易至少需要涨多少才不亏」。
 * 买入和卖出都按同一个 SOL 名义价值做保守估算。
 */
export function roundTripCost(input: ImpactInput): ImpactQuote {
  const size = Number(input.sizeSol);
  const liq = Number(input.liquiditySol);
  if (!(size > 0) || !(liq > 0)) {
    return { sizeSol: size, side: 'buy', impactPct: 1, costSol: size, costPct: 1, executable: false, reason: 'bad_liquidity' };
  }
  const buy = quoteImpact('buy', input);
  const sell = quoteImpact('sell', input);
  const cost = buy.costSol + sell.costSol;
  return {
    sizeSol: size,
    side: 'buy',
    impactPct: buy.impactPct + sell.impactPct,
    costSol: cost,
    costPct: cost / size,
    executable: buy.executable && sell.executable,
    reason: !buy.executable ? buy.reason : !sell.executable ? sell.reason : undefined,
  };
}

/**
 * 给定“最大可接受往返成本”，反推最小经济仓位。
 * 固定优先费对小仓位是致命拖累：0.001 SOL 往返 / 0.02 SOL = 5%。
 */
export function minSizeForCost(opts: {
  feeBps?: number;
  extraSlipBps?: number;
  prioritySol?: number;
  maxCostPct: number;
}): number {
  const feeBps = opts.feeBps ?? 100;
  const slipBps = opts.extraSlipBps ?? 0;
  const priority = opts.prioritySol ?? 0.0005;
  const variablePct = ((feeBps + slipBps) * 2) / 10_000;
  const budget = opts.maxCostPct - variablePct;
  if (!(budget > 0)) return Infinity;
  return (priority * 2) / budget;
}

/** 账户级风险：按单笔风险预算计算 size，并受流动性上限约束 */
export function riskBudgetSize(opts: {
  equitySol: number;
  riskPct: number;
  stopLossPct: number;
  liquiditySol: number;
  maxImpactPct: number;
  capSol: number;
}): number {
  const equity = Math.max(0, opts.equitySol);
  const risk = Math.max(0, opts.riskPct);
  const stop = Math.max(0.001, opts.stopLossPct);
  const budget = (equity * risk) / stop;
  return Math.min(Math.max(0, opts.capSol), budget, maxSizeForImpact(opts.liquiditySol, opts.maxImpactPct));
}
