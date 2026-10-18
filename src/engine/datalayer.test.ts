/**
 * 数据层测试：断点续跑不丢数据的前提。
 *
 *   1. marketfeed：同一签名、不同 mint 的成交不能被误删（此前的 bug）
 *   2. marketfeed：initial_buy 必须带进 TokenCreated（dev 跟踪的数据来源）
 *   3. RunnerState：cursor 持久化 + 过期冷却清理
 *   4. SignalStore：重启后 signaled 集合可恢复，acted 可回填
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadFromDb } from './marketfeed.ts';
import { RunnerState } from './runnerstate.ts';
import { SignalStore } from './positionstore.ts';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'mh-data-'));

// ---------- 构造一个最小数据库 ----------

const dbPath = join(dir, 'feed.db');
{
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE tokens (
      mint TEXT PRIMARY KEY, created_at INTEGER, creator TEXT, name TEXT, symbol TEXT,
      uri TEXT, pool TEXT, initial_buy REAL, sol_amount REAL, bonding_curve TEXT,
      market_cap_sol REAL, v_sol REAL, v_tokens REAL, is_mayhem INTEGER
    );
    CREATE TABLE trades (
      signature TEXT NOT NULL, mint TEXT NOT NULL, ts INTEGER NOT NULL, side TEXT,
      wallet TEXT, sol_amount REAL, token_amount REAL, market_cap_sol REAL,
      v_sol REAL, v_tokens REAL, PRIMARY KEY (signature, mint)
    );
    CREATE TABLE migrations (mint TEXT PRIMARY KEY, ts INTEGER, pool TEXT);
  `);
  db.prepare(
    `INSERT INTO tokens (mint, created_at, creator, name, symbol, pool, initial_buy, sol_amount, market_cap_sol, v_sol, v_tokens)
     VALUES ('MINT_A', 1000, 'DEV_A', 'A', 'A', 'pump', 25000000, 1.0, 30, 31, 1000000000)`
  ).run();

  const insTrade = db.prepare(
    `INSERT INTO trades (signature, mint, ts, side, wallet, sol_amount, token_amount, market_cap_sol, v_sol, v_tokens)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  // 同一签名例外：SIG_MULTI 同时包含 MINT_A 与 MINT_B 的成交（多 mint 交易）
  insTrade.run('SIG_MULTI', 'MINT_A', 2000, 'buy', 'W1', 0.5, 1000, 30, 31, 1000000000);
  insTrade.run('SIG_MULTI', 'MINT_B', 2001, 'buy', 'W2', 0.5, 1000, 28, 29, 1000000000);
  // 同一签名 + 同一 mint 的重复行（PK 保证不会出现，但 feed 也必须幂等）
  insTrade.run('SIG_A2', 'MINT_A', 3000, 'sell', 'W1', 0.4, 900, 29, 30, 1000000000);
  db.close();
}

console.log('数据层（marketfeed）：');

// ---------- 1. 同签名多 mint 不丢 ----------
{
  const env = loadFromDb(dbPath);
  const trades = env.filter((e) => e.type === 'Trade');
  const mints = new Set(trades.map((e) => (e.payload as { mint: string }).mint));
  check('同签名不同 mint 都保留', mints.has('MINT_A') && mints.has('MINT_B'), `事件 ${trades.length} 条`);
  check('MINT_B 从首笔成交兜底建币', env.some((e) => e.type === 'TokenCreated' && (e.payload as { mint: string }).mint === 'MINT_B'));
}

// ---------- 2. initial_buy 进入 TokenCreated ----------
{
  const env = loadFromDb(dbPath);
  const c = env.find((e) => e.type === 'TokenCreated' && (e.payload as { mint: string }).mint === 'MINT_A');
  const p = c?.payload as { devBuyTokens?: number } | undefined;
  check('devBuyTokens = tokens.initial_buy', p?.devBuyTokens === 25_000_000, `得到 ${p?.devBuyTokens}`);
}

console.log('数据层（RunnerState）：');

// ---------- 3. cursor 持久化 ----------
{
  const path = join(dir, 'runner.db');
  const s1 = new RunnerState(path);
  check('首次启动无 cursor', s1.getCursor() === null);
  s1.setCursor(1234);
  s1.close();

  const s2 = new RunnerState(path);
  check('重启后 cursor 恢复', s2.getCursor() === 1234);

  // 冷却：过期的被清理，未过期的保留
  s2.setCooldown('M1', 500);
  s2.setCooldown('M2', 5000);
  const cd = s2.loadCooldowns(1000);
  check('过期冷却被清理', !cd.has('M1'));
  check('未过期冷却保留', cd.get('M2') === 5000);
  s2.close();
}

console.log('数据层（SignalStore）：');

// ---------- 4. signals 恢复 + acted 回填 ----------
{
  const path = join(dir, 'signals.db');
  const s1 = new SignalStore(path);
  const id = s1.save({
    mint: 'MINT_A',
    ts: 1,
    score: 60,
    tier: 'B',
    evidence: ['demand'],
    strategyVersion: 'v1',
    acted: false,
  });
  s1.save({ mint: 'MINT_B', ts: 2, score: 80, tier: 'A', evidence: ['early'], strategyVersion: 'v1', acted: false });
  s1.save({ mint: 'MINT_C', ts: 3, score: 90, tier: 'A', evidence: ['early'], strategyVersion: 'v2', acted: false });
  s1.markActed(id);
  s1.close();

  const s2 = new SignalStore(path);
  const set = s2.signaledMints('v1');
  check('重启后 signaled 恢复（仅当前版本）', set.has('MINT_A') && set.has('MINT_B') && !set.has('MINT_C'), `集合大小 ${set.size}`);
  const attr = s2.attribution();
  const demand = attr.find((a) => a.rule === 'demand');
  check('acted 回填成功', demand?.acted === 1, JSON.stringify(demand));
  s2.close();
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
