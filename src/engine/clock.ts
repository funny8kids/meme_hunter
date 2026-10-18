/** 时钟与随机数：全部可注入，策略里禁止裸用 Date.now / Math.random */

import type { Clock } from './types.ts';

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  mono(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  }
}

/** 回放时钟：时间由事件推进，保证重放确定 */
export class ReplayClock implements Clock {
  private t = 0;
  set(t: number): void {
    this.t = t;
  }
  now(): number {
    return this.t;
  }
  mono(): number {
    return this.t;
  }
}

/**
 * mulberry32：32 位可复现 PRNG。
 * 只要种子相同，序列完全相同 —— 这是回放一致性的前提。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
