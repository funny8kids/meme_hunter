/**
 * 风控：前置检查 + 文件熔断。
 *
 * 不变量 I5：未过检查的 intent 进不了执行平面；停机开关是文件，不是内存变量。
 * 文件开关的好处：外部 `touch data/HALT` 立刻生效，进程重启也仍然生效。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RiskLimits {
  maxPositions: number;
  maxSolPerTrade: number;
  /** 单币敞口占总权益上限 */
  maxMintExposurePct: number;
  /** 当日亏损占总权益上限 */
  dailyLossPct: number;
  /** 价格陈旧上限（ms） */
  maxStaleMs: number;
  /** 最小现金储备（SOL） */
  minCashSol: number;
}

export const DEFAULT_LIMITS: RiskLimits = {
  maxPositions: 3,
  maxSolPerTrade: 0.15,
  maxMintExposurePct: 0.25,
  dailyLossPct: 0.15,
  maxStaleMs: 8000,
  minCashSol: 0,
};

export interface RiskContext {
  openPositions: number;
  mintExposureSol: number;
  equitySol: number;
  cashSol: number;
  dayPnlSol: number;
  staleMs: number;
  halted: boolean;
}

export interface RiskDecision {
  ok: boolean;
  reason?: string;
}

export function preTrade(
  intent: { mint: string; sol: number },
  limits: RiskLimits,
  ctx: RiskContext
): RiskDecision {
  if (ctx.halted) return { ok: false, reason: 'halted' };
  if (intent.sol <= 0) return { ok: false, reason: 'bad_size' };
  if (intent.sol > limits.maxSolPerTrade) return { ok: false, reason: 'size_over_limit' };
  if (ctx.cashSol < intent.sol + limits.minCashSol) return { ok: false, reason: 'insufficient_cash' };
  if (ctx.openPositions >= limits.maxPositions) return { ok: false, reason: 'max_positions' };
  if (ctx.staleMs > limits.maxStaleMs) return { ok: false, reason: 'stale_price' };

  if (ctx.equitySol > 0) {
    if (ctx.dayPnlSol / ctx.equitySol <= -limits.dailyLossPct) {
      return { ok: false, reason: 'daily_loss_limit' };
    }
    const exposure = (ctx.mintExposureSol + intent.sol) / ctx.equitySol;
    if (exposure > limits.maxMintExposurePct) {
      return { ok: false, reason: 'mint_exposure' };
    }
  }
  return { ok: true };
}

/** 文件熔断开关 */
export class HaltSwitch {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  isHalted(): boolean {
    return existsSync(this.path);
  }
  reason(): string | null {
    if (!existsSync(this.path)) return null;
    try {
      return readFileSync(this.path, 'utf8').trim() || 'manual';
    } catch {
      return 'manual';
    }
  }
  halt(reason: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${reason}\n${new Date().toISOString()}\n`);
  }
  clear(): void {
    if (existsSync(this.path)) rmSync(this.path);
  }
}
