/**
 * 仓位持久化：重启后必须能恢复账本，否则对账无从谈起。
 */

import { DatabaseSync } from 'node:sqlite';
import type { Position } from './types.ts';

const DDL = `
CREATE TABLE IF NOT EXISTS positions (
  mint          TEXT PRIMARY KEY,
  qty           REAL NOT NULL,
  cost_sol      REAL NOT NULL,
  entry_price   REAL NOT NULL,
  entry_mcap    REAL NOT NULL,
  opened_at     INTEGER NOT NULL,
  intent_id     TEXT NOT NULL,
  evidence      TEXT NOT NULL,
  peak_mcap     REAL NOT NULL
);
`;

export class PositionStore {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec(DDL);
  }

  load(): Map<string, Position> {
    const rows = this.#db.prepare('SELECT * FROM positions').all() as Array<Record<string, unknown>>;
    const out = new Map<string, Position>();
    for (const r of rows) {
      out.set(String(r.mint), {
        mint: String(r.mint),
        qty: Number(r.qty),
        costSol: Number(r.cost_sol),
        entryPrice: Number(r.entry_price),
        entryMcapSol: Number(r.entry_mcap),
        openedAt: Number(r.opened_at),
        intentId: String(r.intent_id),
        evidence: JSON.parse(String(r.evidence)) as string[],
        peakMcapSol: Number(r.peak_mcap),
      });
    }
    return out;
  }

  upsert(p: Position): void {
    this.#db
      .prepare(
        `INSERT INTO positions (mint, qty, cost_sol, entry_price, entry_mcap, opened_at, intent_id, evidence, peak_mcap)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(mint) DO UPDATE SET
           qty=excluded.qty, cost_sol=excluded.cost_sol, entry_price=excluded.entry_price,
           entry_mcap=excluded.entry_mcap, opened_at=excluded.opened_at,
           intent_id=excluded.intent_id, evidence=excluded.evidence, peak_mcap=excluded.peak_mcap`
      )
      .run(
        p.mint,
        p.qty,
        p.costSol,
        p.entryPrice,
        p.entryMcapSol,
        p.openedAt,
        p.intentId,
        JSON.stringify(p.evidence),
        p.peakMcapSol
      );
  }

  remove(mint: string): void {
    this.#db.prepare('DELETE FROM positions WHERE mint = ?').run(mint);
  }

  size(): number {
    return (this.#db.prepare('SELECT COUNT(*) c FROM positions').get() as { c: number }).c;
  }

  close(): void {
    this.#db.close();
  }
}

// ---------------------------------------------------------------------------
// 信号落库：没有落库的信号等于没发生过，无法归因、无法复盘。
// ---------------------------------------------------------------------------

const SIGNAL_DDL = `
CREATE TABLE IF NOT EXISTS signals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  mint             TEXT NOT NULL,
  ts               INTEGER NOT NULL,
  score            REAL NOT NULL,
  tier             TEXT NOT NULL,
  evidence         TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  acted            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_signals_mint ON signals(mint);
CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
`;

export interface SignalRow {
  mint: string;
  ts: number;
  score: number;
  tier: string;
  evidence: string[];
  strategyVersion: string;
  acted: boolean;
}

export class SignalStore {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec(SIGNAL_DDL);
  }

  /** 返回插入的行 id（用于回填 acted） */
  save(s: SignalRow): number {
    const res = this.#db
      .prepare(
        `INSERT INTO signals (mint, ts, score, tier, evidence, strategy_version, acted)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(s.mint, s.ts, s.score, s.tier, JSON.stringify(s.evidence), s.strategyVersion, s.acted ? 1 : 0);
    return Number(res.lastInsertRowid);
  }

  markActed(id: number): void {
    this.#db.prepare('UPDATE signals SET acted = 1 WHERE id = ?').run(id);
  }

  /** 重启后恢复「已发过信号」集合：防止同一个币重放时再次触发 */
  signaledMints(strategyVersion: string): Set<string> {
    const rows = this.#db
      .prepare('SELECT DISTINCT mint FROM signals WHERE strategy_version = ?')
      .all(strategyVersion) as Array<{ mint: string }>;
    return new Set(rows.map((r) => r.mint));
  }

  /** 归因查询：哪条规则在实盘里真的赚钱 */
  attribution(): Array<{ rule: string; signals: number; acted: number }> {
    const rows = this.#db.prepare('SELECT evidence, acted FROM signals').all() as Array<{
      evidence: string;
      acted: number;
    }>;
    const m = new Map<string, { signals: number; acted: number }>();
    for (const r of rows) {
      for (const rule of JSON.parse(r.evidence) as string[]) {
        const cur = m.get(rule) ?? { signals: 0, acted: 0 };
        cur.signals++;
        cur.acted += r.acted ? 1 : 0;
        m.set(rule, cur);
      }
    }
    return [...m.entries()].map(([rule, v]) => ({ rule, ...v }));
  }

  close(): void {
    this.#db.close();
  }
}
