/**
 * 追加式事件日志（唯一真相）。
 *
 * 不变量 I1：只有 append() 能改变状态，seq 严格单调。
 * 不变量 I2：replay() 必须永远返回相同序列，供回测/复盘使用。
 */

import { DatabaseSync } from 'node:sqlite';
import type { Envelope, EventPayloadMap, EventType } from './types.ts';

const DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq      INTEGER PRIMARY KEY,
  ts_wall  INTEGER NOT NULL,
  ts_mono  INTEGER NOT NULL,
  v        INTEGER NOT NULL,
  type     TEXT    NOT NULL,
  payload  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
`;

/** schema 升级：只增不改。key = 旧版本号，返回新版本 payload */
const UPCASTERS: Record<number, (t: string, p: unknown) => unknown> = {};

export class EventLog {
  #db: DatabaseSync;
  #seq = 0;
  #subs: Array<(e: Envelope) => void> = [];
  #ins;
  #closed = false;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec('PRAGMA synchronous = NORMAL;');
    this.#db.exec(DDL);

    const row = this.#db.prepare('SELECT MAX(seq) AS m FROM events').get() as { m: number | null };
    this.#seq = row?.m ?? 0;

    this.#ins = this.#db.prepare(
      'INSERT INTO events (seq, ts_wall, ts_mono, v, type, payload) VALUES (?,?,?,?,?,?)'
    );
  }

  get lastSeq(): number {
    return this.#seq;
  }

  append<K extends EventType>(
    type: K,
    payload: EventPayloadMap[K],
    tsWall: number,
    tsMono = tsWall
  ): Envelope {
    if (this.#closed) throw new Error('EventLog closed');
    const seq = ++this.#seq;
    const v = 1;
    this.#ins.run(seq, tsWall, tsMono, v, type, JSON.stringify(payload));
    const evt = { seq, tsWall, tsMono, v, type, payload } as Envelope;
    for (const fn of this.#subs) fn(evt);
    return evt;
  }

  subscribe(fn: (e: Envelope) => void): () => void {
    this.#subs.push(fn);
    return () => {
      this.#subs = this.#subs.filter((f) => f !== fn);
    };
  }

  /** 全量回放（按 seq 升序）。大数据量时改成分页迭代。 */
  replay(): Envelope[] {
    const rows = this.#db
      .prepare('SELECT seq, ts_wall, ts_mono, v, type, payload FROM events ORDER BY seq ASC')
      .all() as Array<{
      seq: number;
      ts_wall: number;
      ts_mono: number;
      v: number;
      type: string;
      payload: string;
    }>;

    return rows.map((r) => {
      let payload: unknown = JSON.parse(r.payload);
      let v = r.v;
      while (UPCASTERS[v]) {
        payload = UPCASTERS[v](r.type, payload);
        v++;
      }
      return {
        seq: r.seq,
        tsWall: r.ts_wall,
        tsMono: r.ts_mono,
        v,
        type: r.type,
        payload,
      } as Envelope;
    });
  }

  close(): void {
    this.#closed = true;
    this.#db.close();
  }
}
