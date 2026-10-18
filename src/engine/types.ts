/**
 * 唯一类型来源。所有模块只能从这里 import 类型。
 * 约束：事件 schema 只增不改（新增字段必须可选 + 提升 v）。
 */

export type Side = 'buy' | 'sell';

export interface TokenCreated {
  mint: string;
  creator: string;
  name: string;
  symbol: string;
  pool: string;
  devBuySol: number;
  /** 创建者首买得到的代币数量（v>1 新增，可选：老事件可能缺失） */
  devBuyTokens?: number;
  /**
   * 链上/采集器记录的创建时间（可选，v1 事件可能缺失）。
   * 特征引擎用它计算真实 ageSec；缺失时退回事件时间，避免用「首笔成交」冒充创建时间。
   */
  createdAt?: number;
  mcapSol: number;
  vSol: number;
  vTokens: number;
  sig: string;
}

export interface Trade {
  mint: string;
  side: Side;
  wallet: string;
  sol: number;
  tokens: number;
  vSol: number;
  vTokens: number;
  mcapSol: number;
  sig: string;
}

export interface Migrated {
  mint: string;
  pool: string;
}

export interface FeatureTick {
  mint: string;
  version: string;
  values: Record<string, number>;
}

export interface Signal {
  mint: string;
  score: number;
  tier: 'A' | 'B' | 'C';
  evidence: string[];
  strategyVersion: string;
}

export interface OrderIntent {
  id: string;
  mint: string;
  side: Side;
  sol: number;
  maxSlipBps: number;
  reason: string;
  ttlMs: number;
}

export interface EventPayloadMap {
  TokenCreated: TokenCreated;
  Trade: Trade;
  Migrated: Migrated;
  FeatureTick: FeatureTick;
  Signal: Signal;
  OrderIntent: OrderIntent;
}

export type EventType = keyof EventPayloadMap;

/** 判别联合：按 type 收窄 payload */
export type Envelope = {
  [K in EventType]: {
    seq: number;
    tsWall: number;
    tsMono: number;
    v: number;
    type: K;
    payload: EventPayloadMap[K];
  };
}[EventType];

export interface Clock {
  /** 事件时间（链上/消息时间） */
  now(): number;
  /** 单调时钟，只用于延迟度量，禁止进入决策 */
  mono(): number;
}

/** 策略上下文：策略只能通过它产生副作用 */
export interface StrategyCtx {
  clock: Clock;
  rng: () => number;
  emit(intent: OrderIntent): void;
}

export interface Strategy {
  id: string;
  version: string;
  onEvent(evt: Envelope, ctx: StrategyCtx): void;
}

export interface Quote {
  mint: string;
  side: Side;
  solIn: number;
  tokensOut: number;
  price: number;
  feeSol: number;
  impactBps: number;
}

export interface Fill {
  mint: string;
  side: Side;
  sol: number;
  tokens: number;
  price: number;
  feeSol: number;
  ts: number;
}

export interface Position {
  mint: string;
  qty: number;
  costSol: number;
  entryPrice: number;
  entryMcapSol: number;
  openedAt: number;
  intentId: string;
  evidence: string[];
  peakMcapSol: number;
  /** 入场手续费（SOL）；老仓位可能缺失 */
  entryFeeSol?: number;
}
