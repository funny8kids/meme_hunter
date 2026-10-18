/**
 * 执行器：把「风控 → 落库 → 签名 → 发送 → 确认」串成一条不可跳步的流水线。
 *
 * 不变量 I3 的落地顺序：
 *   create(INTENT) → prepare → transition(SIGNED, tx) → send → transition(SUBMITTED, sig) → CONFIRMED
 * 任何一步抛错都要落到 FAILED，绝不静默吞掉。
 */

import { OrderStore } from './orders.ts';
import type { Portfolio } from './portfolio.ts';
import { preTrade, type RiskContext, type RiskLimits } from './risk.ts';
import type { OrderIntent } from './types.ts';

export interface ExecVenue {
  prepare(action: 'buy' | 'sell', mint: string, amount: number): Promise<Uint8Array>;
  send(bytes: Uint8Array): Promise<{ sig: string; dryRun: boolean }>;
  confirm(sig: string, timeoutMs?: number): Promise<boolean>;
  /** live venue 必须实现：用链上 tx meta 解析实际成交，禁止用 expected 记账 */
  resolveFill?(sig: string, mint: string, side: 'buy' | 'sell'): Promise<{ tokens: number; sol: number; price: number; feeSol?: number } | null>;
}

export interface ExecDeps {
  store: OrderStore;
  portfolio: Portfolio;
  venue: ExecVenue;
  limits: RiskLimits;
  notify?: (text: string) => Promise<void>;
}

export interface ExecResult {
  ok: boolean;
  state: string;
  sig?: string;
  reason?: string;
}

export interface ExpectedFill {
  tokens: number;
  price: number;
  mcapSol: number;
  evidence: string[];
  /** 成交时间（事件时间，重放/纸面场景必须注入；实盘缺省为墙钟） */
  ts?: number;
}

export class Executor {
  #deps: ExecDeps;

  constructor(deps: ExecDeps) {
    this.#deps = deps;
  }

  async buy(intent: OrderIntent, ctx: RiskContext, expected: ExpectedFill): Promise<ExecResult> {
    const { store, portfolio, venue, limits, notify } = this.#deps;

    const risk = preTrade(intent, limits, ctx);
    if (!risk.ok) {
      return { ok: false, state: 'REJECTED', reason: risk.reason };
    }

    // 幂等：同一个 intent id 不允许执行两次（重放/重启/重试都要挡住）
    const existing = store.get(intent.id);
    if (existing) {
      return {
        ok: existing.state === 'CONFIRMED',
        state: existing.state,
        sig: existing.sig ?? undefined,
        reason: 'duplicate_intent',
      };
    }

    store.create(intent);
    let sig: string | undefined;

    try {
      const bytes = await venue.prepare('buy', intent.mint, intent.sol);
      // 先落库签名，再发链 —— 顺序不能反
      store.transition(intent.id, 'SIGNED', { tx: Buffer.from(bytes).toString('base64') });

      const sent = await venue.send(bytes);
      sig = sent.sig;
      store.transition(intent.id, 'SUBMITTED', { sig });

      const ok = await venue.confirm(sig);
      if (!ok) {
        store.transition(intent.id, 'UNKNOWN', { reason: 'confirm_timeout' });
        await notify?.(`⚠️ 订单未确认 ${intent.mint} ${sig}`);
        return { ok: false, state: 'UNKNOWN', sig, reason: 'confirm_timeout' };
      }

      store.transition(intent.id, 'CONFIRMED', { sig });
      let actual: { tokens: number; sol: number; price: number; feeSol?: number } | null = null;
      if (venue.resolveFill) {
        try {
          actual = await venue.resolveFill(sig, intent.mint, 'buy');
        } catch {
          actual = null;
        }
        if (!actual) {
          return { ok: false, state: 'CONFIRMED', sig, reason: 'fill_unresolved' };
        }
      }
      portfolio.open(
        {
          mint: intent.mint,
          side: 'buy',
          sol: actual?.sol ?? intent.sol,
          tokens: actual?.tokens ?? expected.tokens,
          price: actual?.price ?? expected.price,
          feeSol: actual?.feeSol ?? 0,
          ts: expected.ts ?? Date.now(),
        },
        intent.id,
        expected.mcapSol,
        expected.evidence
      );
      await notify?.(`🟢 买入 ${intent.mint} ${intent.sol} SOL\n${sig}`);
      return { ok: true, state: 'CONFIRMED', sig };
    } catch (e) {
      const reason = String((e as Error)?.message ?? e);
      const cur = store.get(intent.id);
      if (cur && cur.state !== 'CONFIRMED' && cur.state !== 'FAILED') {
        try {
          store.transition(intent.id, 'FAILED', { reason });
        } catch {
          /* 非法迁移：保持原状态，交给对账 */
        }
      }
      await notify?.(`🔴 买入失败 ${intent.mint}: ${reason}`);
      return { ok: false, state: 'FAILED', sig, reason };
    }
  }

  async sell(mint: string, tokens: number, price: number, reason: string, now: number = Date.now()): Promise<ExecResult> {
    const { store, portfolio, venue, notify } = this.#deps;
    const pos = portfolio.positions.get(mint);
    if (!pos) return { ok: false, state: 'NO_POSITION', reason: 'no_position' };

    const id = `${mint}:sell:${now}`;
    store.create({ id, mint, side: 'sell', sol: 0, maxSlipBps: 2000, reason, ttlMs: 10_000 });
    let sig: string | undefined;

    try {
      const bytes = await venue.prepare('sell', mint, tokens);
      store.transition(id, 'SIGNED', { tx: Buffer.from(bytes).toString('base64') });

      const sent = await venue.send(bytes);
      sig = sent.sig;
      store.transition(id, 'SUBMITTED', { sig });

      const ok = await venue.confirm(sig);
      if (!ok) {
        store.transition(id, 'UNKNOWN', { reason: 'confirm_timeout' });
        return { ok: false, state: 'UNKNOWN', sig, reason: 'confirm_timeout' };
      }

      store.transition(id, 'CONFIRMED', { sig });
      let actual: { tokens: number; sol: number; price: number; feeSol?: number } | null = null;
      if (venue.resolveFill) {
        try {
          actual = await venue.resolveFill(sig, mint, 'sell');
        } catch {
          actual = null;
        }
        if (!actual) {
          return { ok: false, state: 'CONFIRMED', sig, reason: 'fill_unresolved' };
        }
      }
      portfolio.close(
        {
          mint,
          side: 'sell',
          sol: actual?.sol ?? tokens * price,
          tokens: actual?.tokens ?? tokens,
          price: actual?.price ?? price,
          feeSol: actual?.feeSol ?? 0,
          ts: now,
        },
        reason
      );
      await notify?.(`🔵 卖出 ${mint} (${reason})\n${sig}`);
      return { ok: true, state: 'CONFIRMED', sig };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const cur = store.get(id);
      if (cur && cur.state !== 'CONFIRMED' && cur.state !== 'FAILED') {
        try {
          store.transition(id, 'FAILED', { reason: msg });
        } catch {
          /* 交给对账 */
        }
      }
      await notify?.(`🔴 卖出失败 ${mint}: ${msg}`);
      return { ok: false, state: 'FAILED', sig, reason: msg };
    }
  }
}
