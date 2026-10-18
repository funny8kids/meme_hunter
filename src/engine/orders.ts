/**
 * 订单状态机（不变量 I3：效果至多一次）。
 *
 * 关键顺序：**先落库签名，再发链**。反过来的话，进程在发送后崩溃，
 * 重启时数据库里没有这笔单，链上却已经成交 —— 就是双花。
 *
 * 状态迁移是白名单，非法迁移直接抛错，不允许"顺手"改状态。
 */

import { DatabaseSync } from 'node:sqlite';
import type { OrderIntent } from './types.ts';

export type OrderState = 'INTENT' | 'SIGNED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN';

export interface OrderRecord {
  id: string;
  mint: string;
  side: string;
  sol: number;
  state: OrderState;
  sig: string | null;
  tx: string | null;
  reason: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

const DDL = `
CREATE TABLE IF NOT EXISTS orders (
  id         TEXT PRIMARY KEY,
  mint       TEXT NOT NULL,
  side       TEXT NOT NULL,
  sol        REAL NOT NULL,
  state      TEXT NOT NULL,
  sig        TEXT,
  tx         TEXT,
  reason     TEXT,
  attempts   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(state);
CREATE INDEX IF NOT EXISTS idx_orders_mint ON orders(mint);
`;

/** 允许的迁移：任何不在表里的迁移都是 bug */
const ALLOWED: Record<OrderState, OrderState[]> = {
  INTENT: ['SIGNED', 'FAILED'],
  SIGNED: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['CONFIRMED', 'FAILED', 'UNKNOWN'],
  UNKNOWN: ['CONFIRMED', 'FAILED'],
  CONFIRMED: [],
  FAILED: [],
};

const MAX_ATTEMPTS = 3;

export class OrderStore {
  #db: DatabaseSync;
  #now: () => number;

  constructor(path: string, now: () => number = () => Date.now()) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec(DDL);
    this.#now = now;
  }

  create(intent: OrderIntent): OrderRecord {
    if (this.get(intent.id)) throw new Error(`order exists: ${intent.id}`);
    const t = this.#now();
    this.#db
      .prepare(
        `INSERT INTO orders (id, mint, side, sol, state, created_at, updated_at)
         VALUES (?,?,?,?, 'INTENT', ?, ?)`
      )
      .run(intent.id, intent.mint, intent.side, intent.sol, t, t);
    return this.get(intent.id)!;
  }

  get(id: string): OrderRecord | null {
    const r = this.#db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapRow(r) : null;
  }

  /** 白名单迁移；非法迁移抛错 */
  transition(id: string, to: OrderState, patch: { sig?: string; tx?: string; reason?: string } = {}): OrderRecord {
    const cur = this.get(id);
    if (!cur) throw new Error(`order not found: ${id}`);
    if (!ALLOWED[cur.state].includes(to)) {
      throw new Error(`illegal transition ${cur.state} -> ${to} (order ${id})`);
    }
    this.#db
      .prepare(
        `UPDATE orders SET state = ?, sig = COALESCE(?, sig), tx = COALESCE(?, tx),
                           reason = COALESCE(?, reason), updated_at = ?
         WHERE id = ?`
      )
      .run(to, patch.sig ?? null, patch.tx ?? null, patch.reason ?? null, this.#now(), id);
    return this.get(id)!;
  }

  /** 记录一次重试：只有 FAILED 才能重新进入 INTENT */
  retry(id: string, reason: string): OrderRecord {
    const cur = this.get(id);
    if (!cur) throw new Error(`order not found: ${id}`);
    if (cur.state !== 'FAILED') throw new Error(`retry requires FAILED, got ${cur.state}`);
    if (cur.attempts >= MAX_ATTEMPTS) throw new Error(`max attempts reached: ${id}`);
    this.#db
      .prepare(
        `UPDATE orders SET state = 'INTENT', attempts = attempts + 1, reason = ?,
                           sig = NULL, tx = NULL, updated_at = ? WHERE id = ?`
      )
      .run(reason, this.#now(), id);
    return this.get(id)!;
  }

  /** 崩溃恢复：所有「已签名但结果未知」的单 */
  pending(): OrderRecord[] {
    return (
      this.#db
        .prepare("SELECT * FROM orders WHERE state IN ('SIGNED','SUBMITTED','UNKNOWN') ORDER BY created_at ASC")
        .all() as Record<string, unknown>[]
    ).map(mapRow);
  }

  counts(): Record<string, number> {
    const rows = this.#db.prepare('SELECT state, COUNT(*) c FROM orders GROUP BY state').all() as Array<{
      state: string;
      c: number;
    }>;
    return Object.fromEntries(rows.map((r) => [r.state, r.c]));
  }

  close(): void {
    this.#db.close();
  }
}

function mapRow(r: Record<string, unknown>): OrderRecord {
  return {
    id: String(r.id),
    mint: String(r.mint),
    side: String(r.side),
    sol: Number(r.sol),
    state: String(r.state) as OrderState,
    sig: r.sig === null ? null : String(r.sig),
    tx: r.tx === null ? null : String(r.tx),
    reason: r.reason === null ? null : String(r.reason),
    attempts: Number(r.attempts),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
