/**
 * 回测内核（可复用）：特征 → 评分 → 风控 → 纸面成交 → 归因。
 *
 * 和早期版本相比，这里把「看起来能赚钱」的乐观假设逐条拿掉：
 *   1. 信号 ≠ 立即成交：加入 entryDelayMs，只在延迟后的下一笔真实成交上成交；
 *   2. 离场也要延迟：避免用触发信号的那一笔成交价瞬间跑掉；
 *   3. 死币不再按最后价格无限期可卖：超时无成交按 stuckExitHaircut 打折；
 *   4. 数据结束仍持仓：按 endExitHaircut 打折，而不是假装按最后价平仓；
 *   5. 额外滑点：曲线数学之外再扣 slippageBps（单边），覆盖真实执行摩擦；
 *   6. 随机入场基线：同样的离场规则、同样的资金约束，检验「筛选」是否真的有用。
 *
 * 所有随机性都由 seed 注入，同一输入 + 同一配置 ⇒ 同一结果。
 */

import type { Envelope, Trade } from './types.ts';
import { Portfolio, type ClosedTrade } from './portfolio.ts';
import { FeatureEngine, type Features } from './features.ts';
import { PaperVenue } from './venue/paper.ts';
import { scoreFeatures, STRATEGY_VERSION, TIER_THRESHOLDS, type Tier } from './scorer.ts';
import { scoreFeaturesV2, STRATEGY_VERSION_V2 } from './scorer_v2.ts';
import { preTrade, DEFAULT_LIMITS } from './risk.ts';
import { mulberry32 } from './clock.ts';

export interface BacktestConfig {
  strategy: 'v1' | 'v2' | 'crash';
  initialSol: number;
  sizeSol: number;
  tpPct: number;
  slPct: number;
  maxHoldMs: number;
  maxPositions: number;
  /** 从峰值回撤超过该比例离场；0 = 关闭 */
  trailingStopPct: number;
  /** Dev/creator 卖出时离场 */
  exitOnDevSell: boolean;
  /** crash 策略：从首笔市值回撤到该比例以下才入场 */
  crashDropPct: number;
  crashMinAgeSec: number;
  crashMaxAgeSec: number;
  crashMinTrades: number;
  feeBps: number;
  prioritySol: number;
  /** 曲线之外的单边滑点（bps） */
  slipBps: number;
  /** 单边最大允许冲击（bps）；超过则拒绝入场 */
  maxImpactBps: number;
  /** 按池子 SOL 流动性缩放仓位：0=固定 size，0.01=最多使用 1% 的 vSol */
  sizePctOfLiquidity: number;
  /** 缩放后低于该 size 就放弃，避免碎仓 */
  minSizeSol: number;
  minTier: Tier;
  cooldownMs: number;
  /** 信号产生到成交的延迟（ms） */
  entryDelayMs: number;
  /** 离场触发到成交的延迟（ms） */
  exitDelayMs: number;
  /** 延迟后最多等多久；超过仍无该币成交则放弃入场 */
  maxEntryWaitMs: number;
  /** 离场计划触发后，多久没有该币成交就按打折价强制出清 */
  maxExitStaleMs: number;
  /** 死币强制出清时，按纸面报价保留的比例（0.5 = 只拿回一半） */
  stuckExitHaircut: number;
  /** 回测结束时仍持仓，按纸面报价保留的比例 */
  endExitHaircut: number;
  /** 随机基线模式：每笔可入场事件入场的概率 */
  entryMode: 'strategy' | 'random';
  randomEntryProbability: number;
  seed: number;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  strategy: 'v1',
  initialSol: 1.0,
  sizeSol: 0.1,
  tpPct: 1.0,
  slPct: 0.5,
  maxHoldMs: 30 * 60_000,
  maxPositions: 3,
  trailingStopPct: 0,
  exitOnDevSell: false,
  crashDropPct: 0.5,
  crashMinAgeSec: 300,
  crashMaxAgeSec: 1800,
  crashMinTrades: 3,
  feeBps: 100,
  prioritySol: 0.0005,
  slipBps: 150,
  maxImpactBps: 300,
  sizePctOfLiquidity: 0,
  minSizeSol: 0.002,
  minTier: 'B',
  cooldownMs: 10 * 60_000,
  entryDelayMs: 3000,
  exitDelayMs: 3000,
  maxEntryWaitMs: 30_000,
  maxExitStaleMs: 15 * 60_000,
  stuckExitHaircut: 0.5,
  endExitHaircut: 0.5,
  entryMode: 'strategy',
  randomEntryProbability: 0,
  seed: 20261018,
};

export interface BacktestWindow {
  fromTs?: number;
  toTs?: number;
}

export interface RuleStat {
  id: string;
  trades: number;
  wins: number;
  pnlSol: number;
}

export interface BacktestReport {
  strategyVersion: string;
  config: BacktestConfig;
  events: number;
  signals: number;
  vetoed: number;
  entries: number;
  canceled: number;
  riskRejected: number;
  opportunities: number;
  closed: number;
  wins: number;
  winRate: number;
  pnlSol: number;
  returnPct: number;
  expectancySol: number;
  avgWinSol: number;
  avgLossSol: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgHoldMin: number;
  feesSol: number;
  stuckExits: number;
  endExits: number;
  exitReasons: Record<string, number>;
  rules: RuleStat[];
  mintsTraded: number;
  returnStdPct: number;
  tradeSharpe: number;
}

export interface BacktestResult {
  report: BacktestReport;
  closedTrades: ClosedTrade[];
}

interface PendingEntry {
  mint: string;
  signalTs: number;
  executeAt: number;
  expiresAt: number;
  score: number;
  tier: Tier;
  evidence: string[];
  signalSeq: number;
}

interface ExitPlan {
  reason: string;
  at: number;
}

const TIER_RANK: Record<Tier, number> = { A: 3, B: 2, C: 1 };

function inWindow(ts: number, w: BacktestWindow): boolean {
  if (w.fromTs !== undefined && ts < w.fromTs) return false;
  if (w.toTs !== undefined && ts >= w.toTs) return false;
  return true;
}

/**
 * 跑一次回测。envelopes 必须按 tsWall 升序（loadFromDb 已保证）。
 * 窗口只限制「新开仓」；已有仓位会继续按离场规则管理。
 */
export function runBacktest(
  envelopes: Envelope[],
  cfg: BacktestConfig,
  window: BacktestWindow = {}
): BacktestResult {
  const venue = new PaperVenue({
    feeBps: cfg.feeBps,
    prioritySol: cfg.prioritySol,
    slippageBps: cfg.slipBps,
  });
  const portfolio = new Portfolio(cfg.initialSol);
  const features = new FeatureEngine();
  const cooldown = new Map<string, number>();
  const lastMcap = new Map<string, number>();
  const lastTradeAt = new Map<string, number>();
  const signaled = new Set<string>();
  const pendingEntries = new Map<string, PendingEntry>();
  const exitPlans = new Map<string, ExitPlan>();
  const rng = mulberry32(cfg.seed);
  // 「当日亏损」必须按 UTC 日切分；否则回测跨天时第一次亏损会永久熔断
  let dayKey = -1;
  let dayStartRealized = 0;

  let signals = 0;
  let vetoed = 0;
  let entries = 0;
  let canceled = 0;
  let riskRejected = 0;
  let opportunities = 0;
  let stuckExits = 0;
  let endExits = 0;
  const exitReasons: Record<string, number> = {};

  const limits = {
    ...DEFAULT_LIMITS,
    maxPositions: cfg.maxPositions,
    // 仓位大于默认单笔上限时才放宽，否则保持与实盘一致的风控
    maxSolPerTrade: Math.max(cfg.sizeSol, DEFAULT_LIMITS.maxSolPerTrade),
  };

  const closePosition = (mint: string, reason: string, ts: number, haircut = 1): void => {
    const pos = portfolio.positions.get(mint);
    if (!pos) {
      exitPlans.delete(mint);
      return;
    }
    const q = venue.quoteSell(mint, pos.qty);
    const proceeds = q ? Math.max(0, q.solIn * haircut) : 0;
    const fill = {
      mint,
      side: 'sell' as const,
      sol: proceeds,
      tokens: pos.qty,
      price: pos.qty > 0 ? proceeds / pos.qty : 0,
      feeSol: q?.feeSol ?? 0,
      ts,
    };
    portfolio.close(fill, reason);
    exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
    exitPlans.delete(mint);
    cooldown.set(mint, ts);
    if (reason === 'stuck_exit') stuckExits++;
    if (reason === 'end_of_data') endExits++;
  };

  const executeEntry = (pe: PendingEntry, ts: number, mcapSol: number): void => {
    pendingEntries.delete(pe.mint);
    if (portfolio.positions.has(pe.mint)) return;
    const cool = cooldown.get(pe.mint);
    if (cool !== undefined && ts < cool) return;

    let size = cfg.sizeSol;
    const reserves = venue.reserves(pe.mint);
    if (cfg.sizePctOfLiquidity > 0) {
      if (!reserves || !(reserves.vSol > 0)) {
        riskRejected++;
        return;
      }
      size = Math.min(size, reserves.vSol * cfg.sizePctOfLiquidity);
    }
    if (!(size >= cfg.minSizeSol)) {
      riskRejected++;
      return;
    }
    const buyQuote = venue.quoteBuy(pe.mint, size);
    if (!buyQuote || buyQuote.impactBps > cfg.maxImpactBps) {
      riskRejected++;
      return;
    }

    const risk = preTrade(
      { mint: pe.mint, sol: size },
      limits,
      {
        openPositions: portfolio.positions.size,
        mintExposureSol: 0,
        equitySol: portfolio.equitySol(),
        cashSol: portfolio.cashSol,
        dayPnlSol: portfolio.realizedSol - dayStartRealized,
        staleMs: 0,
        halted: false,
      }
    );
    if (!risk.ok) {
      riskRejected++;
      return;
    }

    const fill = venue.buy(pe.mint, size, ts);
    if (!fill) {
      riskRejected++;
      return;
    }
    portfolio.open(fill, `${pe.mint}:buy:${pe.signalSeq}`, mcapSol, pe.evidence);
    entries++;
  };

  for (const evt of envelopes) {
    const ts = evt.tsWall;
    const dk = Math.floor(ts / 86_400_000);
    if (dk !== dayKey) {
      dayKey = dk;
      dayStartRealized = portfolio.realizedSol;
    }

    if (evt.type === 'TokenCreated') {
      features.onEvent(evt);
      const p = evt.payload;
      if (p.vSol > 0 && p.vTokens > 0) venue.seed(p.mint, p.vSol, p.vTokens);
      continue;
    }
    if (evt.type !== 'Trade') {
      features.onEvent(evt);
      continue;
    }

    const tr: Trade = evt.payload;
    venue.onTrade(tr);
    features.onEvent(evt);
    portfolio.mark(tr.mint, tr.mcapSol);
    lastMcap.set(tr.mint, tr.mcapSol);
    lastTradeAt.set(tr.mint, ts);

    // ---- 0. 过期未成交的入场计划 ----
    for (const [mint, pe] of pendingEntries) {
      if (ts > pe.expiresAt) {
        pendingEntries.delete(mint);
        canceled++;
      }
    }

    // ---- 1. 延迟后的入场：只在该币下一笔真实成交上执行 ----
    const pe = pendingEntries.get(tr.mint);
    if (pe && ts >= pe.executeAt) executeEntry(pe, ts, tr.mcapSol);

    // ---- 2. 为所有持仓检查离场触发条件 ----
    for (const [mint, pos] of portfolio.positions) {
      if (exitPlans.has(mint)) continue;
      const cur = lastMcap.get(mint) ?? pos.entryMcapSol;
      const mult = pos.entryMcapSol > 0 ? cur / pos.entryMcapSol : 1;
      let reason = '';
      const peakMult = pos.entryMcapSol > 0 ? pos.peakMcapSol / pos.entryMcapSol : 1;
      if (mult >= 1 + cfg.tpPct) reason = 'take_profit';
      else if (mult <= 1 - cfg.slPct) reason = 'stop_loss';
      else if (
        cfg.trailingStopPct > 0 &&
        peakMult >= 1.15 &&
        cur <= pos.peakMcapSol * (1 - cfg.trailingStopPct)
      ) reason = 'trailing_stop';
      else if (
        cfg.exitOnDevSell &&
        tr.side === 'sell' &&
        tr.wallet &&
        tr.wallet === features.get(mint)?.creator
      ) reason = 'dev_sell';
      else if (ts - pos.openedAt >= cfg.maxHoldMs) reason = 'timeout';
      if (reason) exitPlans.set(mint, { reason, at: ts + cfg.exitDelayMs });
    }

    // ---- 3. 延迟后的离场：只在触发后该币的真实成交上执行 ----
    const plan = exitPlans.get(tr.mint);
    if (plan && ts >= plan.at) closePosition(tr.mint, plan.reason, ts);

    // ---- 4. 死币：离场触发后长期无成交，按打折价出清，不再假装按最后价成交 ----
    for (const [mint, p] of exitPlans) {
      if (ts < p.at) continue;
      const lastAt = lastTradeAt.get(mint) ?? 0;
      if (ts - lastAt > cfg.maxExitStaleMs) closePosition(mint, 'stuck_exit', ts, cfg.stuckExitHaircut);
    }

    // ---- 5. 入场：只在窗口内；信号/随机基线都走同一套延迟与风控 ----
    if (!inWindow(ts, window)) continue;
    if (portfolio.positions.has(tr.mint)) continue;
    if (pendingEntries.has(tr.mint)) continue;
    const cool = cooldown.get(tr.mint);
    if (cool !== undefined && ts < cool) continue;

    opportunities++;

    let evidence: string[] = [];
    let score = 0;
    let tier: Tier | null = null;

    if (cfg.entryMode === 'random') {
      if (rng() >= cfg.randomEntryProbability) continue;
      evidence = ['random_baseline'];
      tier = 'B';
    } else {
      const f: Features | null = features.get(tr.mint);
      if (!f) continue;
      let s;
      if (cfg.strategy === 'v2') s = scoreFeaturesV2(f);
      else if (cfg.strategy === 'crash') {
        const crashOk =
          f.ageSec >= cfg.crashMinAgeSec &&
          f.ageSec <= cfg.crashMaxAgeSec &&
          f.growthX <= cfg.crashDropPct &&
          f.trades5m >= cfg.crashMinTrades;
        s = crashOk
          ? { score: 50, tier: 'B' as const, evidence: ['crash_reversion'], vetoed: [] }
          : { score: 0, tier: null, evidence: [], vetoed: ['crash_filter'] };
      } else s = scoreFeatures(f);
      if (s.vetoed.length > 0) {
        vetoed++;
        continue;
      }
      tier = s.tier;
      if (!tier || TIER_RANK[tier] < TIER_RANK[cfg.minTier]) continue;
      score = s.score;
      evidence = s.evidence;
      if (!signaled.has(tr.mint)) {
        signaled.add(tr.mint);
        signals++;
      }
    }

    const pe2: PendingEntry = {
      mint: tr.mint,
      signalTs: ts,
      executeAt: ts + cfg.entryDelayMs,
      expiresAt: ts + cfg.entryDelayMs + cfg.maxEntryWaitMs,
      score,
      tier,
      evidence,
      signalSeq: evt.seq,
    };
    pendingEntries.set(tr.mint, pe2);
    // 零延迟：仍然在当前事件收盘价上成交（老行为），但走同一套风控/成交函数
    if (pe2.executeAt <= ts) executeEntry(pe2, ts, tr.mcapSol);
  }

  // ---- 6. 数据结束：未平仓位按折价清算，单独计数 ----
  const endTs = envelopes.length ? envelopes[envelopes.length - 1].tsWall : 0;
  for (const mint of [...portfolio.positions.keys()]) {
    closePosition(mint, 'end_of_data', endTs, cfg.endExitHaircut);
  }

  const report = summarize(
    portfolio.closed,
    cfg,
    {
      events: envelopes.length,
      signals,
      vetoed,
      entries,
      canceled,
      riskRejected,
      opportunities,
      stuckExits,
      endExits,
      exitReasons,
    }
  );

  return { report, closedTrades: portfolio.closed };
}

interface ExtraStats {
  events: number;
  signals: number;
  vetoed: number;
  entries: number;
  canceled: number;
  riskRejected: number;
  opportunities: number;
  stuckExits: number;
  endExits: number;
  exitReasons: Record<string, number>;
}

/** 把逐笔成交汇总成报告；验证器也会用它聚合多个样本外折 */
export function summarize(
  closed: ClosedTrade[],
  cfg: BacktestConfig,
  extra: ExtraStats
): BacktestReport {
  const wins = closed.filter((t) => t.pnlSol > 0);
  const losses = closed.filter((t) => t.pnlSol <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnlSol, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlSol, 0));
  const pnlSol = closed.reduce((a, t) => a + t.pnlSol, 0);

  let equity = cfg.initialSol;
  let peak = equity;
  let maxDd = 0;
  for (const t of [...closed].sort((a, b) => a.closedAt - b.closedAt)) {
    equity += t.pnlSol;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }

  const ruleMap = new Map<string, RuleStat>();
  for (const t of closed) {
    for (const r of t.evidence) {
      const s = ruleMap.get(r) ?? { id: r, trades: 0, wins: 0, pnlSol: 0 };
      s.trades++;
      if (t.pnlSol > 0) s.wins++;
      s.pnlSol += t.pnlSol;
      ruleMap.set(r, s);
    }
  }

  const returns = closed.map((t) => (t.costSol > 0 ? t.pnlSol / t.costSol : 0));
  const meanRet = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((a, b) => a + (b - meanRet) ** 2, 0) / (returns.length - 1)
    : 0;
  const std = Math.sqrt(variance);

  return {
    strategyVersion:
      cfg.strategy === 'v2' ? STRATEGY_VERSION_V2 : cfg.strategy === 'crash' ? 'crash-v1' : STRATEGY_VERSION,
    config: cfg,
    events: extra.events,
    signals: extra.signals,
    vetoed: extra.vetoed,
    entries: extra.entries,
    canceled: extra.canceled,
    riskRejected: extra.riskRejected,
    opportunities: extra.opportunities,
    closed: closed.length,
    wins: wins.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    pnlSol,
    returnPct: (pnlSol / cfg.initialSol) * 100,
    expectancySol: closed.length ? pnlSol / closed.length : 0,
    avgWinSol: wins.length ? grossProfit / wins.length : 0,
    avgLossSol: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxDrawdownPct: maxDd * 100,
    avgHoldMin: closed.length ? closed.reduce((a, t) => a + t.holdMs, 0) / closed.length / 60_000 : 0,
    feesSol: closed.reduce((a, t) => a + t.feesSol, 0),
    stuckExits: extra.stuckExits,
    endExits: extra.endExits,
    exitReasons: extra.exitReasons,
    rules: [...ruleMap.values()].sort((a, b) => b.pnlSol - a.pnlSol),
    mintsTraded: new Set(closed.map((t) => t.mint)).size,
    returnStdPct: std * 100,
    tradeSharpe: std > 0 ? (meanRet / std) * Math.sqrt(returns.length) : 0,
  };
}

export const TIER_THRESHOLDS_EXPORT = TIER_THRESHOLDS;
