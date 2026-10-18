/**
 * 回放引擎：实盘和回测共用同一份策略代码。
 *
 * 不变量 I2：同一 log + 同一 strategy version + 同一 seed ⇒ 同一决策序列。
 * 决策摘要（digest）用于 golden replay 测试。
 */

import { createHash } from 'node:crypto';
import type { OrderIntent, Strategy, StrategyCtx } from './types.ts';
import type { EventLog } from './log.ts';
import { ReplayClock, mulberry32 } from './clock.ts';

export interface ReplayResult {
  events: number;
  intents: OrderIntent[];
  durationMs: number;
}

export function replay(log: EventLog, strategy: Strategy, seed = 1): ReplayResult {
  const clock = new ReplayClock();
  const rng = mulberry32(seed);
  const intents: OrderIntent[] = [];
  const ctx: StrategyCtx = {
    clock,
    rng,
    emit: (i) => intents.push(i),
  };

  const t0 = process.hrtime.bigint();
  const events = log.replay();
  for (const e of events) {
    clock.set(e.tsWall);
    strategy.onEvent(e, ctx);
  }
  const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;

  return { events: events.length, intents, durationMs };
}

/** 决策摘要：只对「决策」做哈希，绝不包含 tsMono（那是机器噪声） */
export function decisionDigest(intents: OrderIntent[]): string {
  const h = createHash('sha256');
  for (const i of intents) {
    h.update(
      [i.id, i.mint, i.side, i.sol.toFixed(8), i.maxSlipBps, i.reason, i.ttlMs].join('|') + '\n'
    );
  }
  return h.digest('hex');
}
