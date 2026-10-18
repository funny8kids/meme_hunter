/**
 * S1 验收测试：确定性回放。
 *
 * 断言：
 *   1. 同一日志重放两次 → 决策摘要完全相同
 *   2. 同源事件写入另一个库 → 决策摘要相同（事件流是唯一真相）
 *   3. 换随机种子 → 摘要不同（证明 RNG 真的被注入且被使用）
 *   4. 重放期间 seq 严格单调
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from './log.ts';
import { replay, decisionDigest } from './engine.ts';
import { mulberry32 } from './clock.ts';
import type { Envelope, OrderIntent, Strategy, StrategyCtx } from './types.ts';

// ---------- 合成事件流（可复现） ----------

interface GenOpts {
  tokens: number;
  seed: number;
}

function generate(log: EventLog, opts: GenOpts): void {
  const rng = mulberry32(opts.seed);
  let t = 1_700_000_000_000;

  for (let i = 0; i < opts.tokens; i++) {
    const mint = `MINT${i.toString().padStart(4, '0')}`;
    t += 1000 + Math.floor(rng() * 4000);

    log.append(
      'TokenCreated',
      {
        mint,
        creator: `DEV${i}`,
        name: `Token ${i}`,
        symbol: `T${i}`,
        pool: 'pump',
        devBuySol: 0.1 + rng() * 2.9,
        mcapSol: 28 + rng() * 8,
        vSol: 30 + rng() * 8,
        vTokens: 1_073_000_000,
        sig: `create-${i}`,
      },
      t
    );

    const n = 6 + Math.floor(rng() * 9);
    let mcap = 28 + rng() * 8;
    for (let j = 0; j < n; j++) {
      t += 200 + Math.floor(rng() * 3000);
      const isBuy = rng() < 0.65;
      const sol = 0.01 + rng() * 2.0;
      mcap = Math.max(20, mcap + (isBuy ? sol * 1.4 : -sol * 1.1));
      log.append(
        'Trade',
        {
          mint,
          side: isBuy ? 'buy' : 'sell',
          wallet: `W${Math.floor(rng() * 50)}`,
          sol,
          tokens: sol * 1_000_000,
          vSol: 30 + mcap * 0.1,
          vTokens: 900_000_000,
          mcapSol: mcap,
          sig: `trade-${i}-${j}`,
        },
        t
      );
    }
  }
}

// ---------- 被测策略：动量 + 随机仓位抖动 ----------

function makeStrategy(): Strategy {
  const state = new Map<string, { buys: number; vol: number; emitted: boolean }>();

  return {
    id: 'momentum-v0',
    version: '0.0.1',
    onEvent(evt: Envelope, ctx: StrategyCtx): void {
      if (evt.type !== 'Trade') return;
      const tr = evt.payload;

      let s = state.get(tr.mint);
      if (!s) {
        s = { buys: 0, vol: 0, emitted: false };
        state.set(tr.mint, s);
      }
      if (tr.side === 'buy') {
        s.buys++;
        s.vol += tr.sol;
      }

      if (!s.emitted && s.buys >= 3 && tr.mcapSol < 60) {
        s.emitted = true;
        // 用注入的 rng 做仓位抖动：种子不同 → 结果必须不同
        const sizeSol = 0.05 * (0.9 + 0.2 * ctx.rng());
        ctx.emit({
          id: `${tr.mint}:buy:${evt.seq}`,
          mint: tr.mint,
          side: 'buy',
          sol: Number(sizeSol.toFixed(6)),
          maxSlipBps: 1200,
          reason: `buys=${s.buys},vol=${s.vol.toFixed(2)},mcap=${tr.mcapSol.toFixed(1)}`,
          ttlMs: 5000,
        });
      }
    },
  };
}

// ---------- 断言 ----------

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ---------- 运行 ----------

const dir = mkdtempSync(join(tmpdir(), 'mh-engine-'));
const pathA = join(dir, 'a.db');
const pathB = join(dir, 'b.db');

const logA = new EventLog(pathA);
generate(logA, { tokens: 120, seed: 42 });
const totalEvents = logA.lastSeq;

const logB = new EventLog(pathB);
const source = logA.replay();
for (const e of source) logB.append(e.type, e.payload as never, e.tsWall, e.tsMono);

// 重放两次
const r1 = replay(logA, makeStrategy(), 7);
const r2 = replay(logA, makeStrategy(), 7);
// 不同库、同事件流
const r3 = replay(logB, makeStrategy(), 7);
// 不同种子
const r4 = replay(logA, makeStrategy(), 8);

const d1 = decisionDigest(r1.intents);
const d2 = decisionDigest(r2.intents);
const d3 = decisionDigest(r3.intents);
const d4 = decisionDigest(r4.intents);

console.log(`\n事件数=${totalEvents}  决策数=${r1.intents.length}  耗时=${r1.durationMs.toFixed(1)}ms`);
console.log(`digest(run1)=${d1.slice(0, 16)}…`);
console.log(`digest(run2)=${d2.slice(0, 16)}…`);
console.log(`digest(repo)=${d3.slice(0, 16)}…`);
console.log(`digest(seed8)=${d4.slice(0, 16)}…\n`);

console.log('S1 确定性回放：');
check('同一日志重放两次结果一致', d1 === d2 && r1.intents.length === r2.intents.length);
check('同源事件写入新库结果一致', d1 === d3);
check('换种子结果不同（RNG 已注入）', d1 !== d4);
check('确实产生了决策', r1.intents.length > 0, `${r1.intents.length} 条`);

// seq 单调
const seqs = source.map((e) => e.seq);
const monotonic = seqs.every((v, i) => i === 0 || v === seqs[i - 1] + 1);
check('seq 严格单调', monotonic);

logA.close();
logB.close();

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
