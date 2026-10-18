/**
 * 运行器状态持久化：重启后必须「接着上次跑」，而不是从头回放。
 *
 * 为什么这不是可选项：
 *   - cursor 从头回放会把历史信号重新触发一遍（重复入场）；
 *   - 冷却时间在内存里，重启即失效（卖完立刻再买回来）；
 *   - 这两个问题在纸面阶段会污染统计，在实盘阶段会重复下单（已有一层 intent 幂等兜底，
 *     但不应该依赖兜底）。
 *
 * 因此：cursor、cooldown 全部落库；signaled 集合由 signals.db 派生（见 SignalStore）。
 */

import { DatabaseSync } from 'node:sqlite';

const DDL = `
CREATE TABLE IF NOT EXISTS runner_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cooldowns (
  mint     TEXT PRIMARY KEY,
  until_ts INTEGER NOT NULL
);
`;

export class RunnerState {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec(DDL);
  }

  getCursor(): number | null {
    const row = this.#db.prepare("SELECT value FROM runner_state WHERE key = 'cursor'").get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    const v = Number(row.value);
    return Number.isFinite(v) ? v : null;
  }

  setCursor(v: number): void {
    this.#db
      .prepare(
        `INSERT INTO runner_state (key, value) VALUES ('cursor', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(String(v));
  }

  setCooldown(mint: string, untilTs: number): void {
    this.#db
      .prepare(
        `INSERT INTO cooldowns (mint, until_ts) VALUES (?, ?)
         ON CONFLICT(mint) DO UPDATE SET until_ts = excluded.until_ts`
      )
      .run(mint, untilTs);
  }

  /** 加载冷却表，并顺手清掉已经过期的行 */
  loadCooldowns(nowTs: number): Map<string, number> {
    const rows = this.#db.prepare('SELECT mint, until_ts FROM cooldowns').all() as Array<{
      mint: string;
      until_ts: number;
    }>;
    const out = new Map<string, number>();
    const del = this.#db.prepare('DELETE FROM cooldowns WHERE mint = ?');
    for (const r of rows) {
      if (r.until_ts <= nowTs) del.run(r.mint);
      else out.set(r.mint, r.until_ts);
    }
    return out;
  }

  close(): void {
    this.#db.close();
  }
}
