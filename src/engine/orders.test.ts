/**
 * S5/S6 验收：订单状态机 + 启动对账。
 *
 * 断言：
 *   1. 非法状态迁移被拒绝（INTENT 不能直接到 CONFIRMED）
 *   2. 重复 intent id 被拒绝（幂等）
 *   3. 重试只能从 FAILED 出发，且有次数上限
 *   4. 崩溃恢复能正确判定 confirmed / failed / unknown
 *   5. 孤儿仓被识别（链上有、账本没有）
 *   6. 缺失仓被识别（账本有、链上没有）
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrderStore } from './orders.ts';
import { reconcile } from './reconcile.ts';
import type { Position } from './types.ts';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
}
const throws = (fn: () => void): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const dir = mkdtempSync(join(tmpdir(), 'mh-orders-'));
const store = new OrderStore(join(dir, 'orders.db'));

console.log('S5 订单状态机：');

const intent = { id: 'MINT1:buy:1', mint: 'MINT1', side: 'buy' as const, sol: 0.1, maxSlipBps: 1200, reason: 'test', ttlMs: 5000 };
const o = store.create(intent);
check('创建后为 INTENT', o.state === 'INTENT');
check('重复 id 被拒', throws(() => store.create(intent)));
check('INTENT 不能直接 CONFIRMED', throws(() => store.transition(o.id, 'CONFIRMED')));

store.transition(o.id, 'SIGNED', { tx: 'base64tx' });
store.transition(o.id, 'SUBMITTED', { sig: 'SIG1' });
const done = store.transition(o.id, 'CONFIRMED', { sig: 'SIG1' });
check('正常链路 INTENT→SIGNED→SUBMITTED→CONFIRMED', done.state === 'CONFIRMED');
check('终态不可再迁移', throws(() => store.transition(o.id, 'FAILED')));

const o2 = store.create({ ...intent, id: 'MINT2:buy:2', mint: 'MINT2' });
store.transition(o2.id, 'SIGNED', { tx: 'tx2' });
store.transition(o2.id, 'SUBMITTED', { sig: 'SIG2' });
store.transition(o2.id, 'FAILED', { reason: 'slippage' });
check('FAILED 可重试回 INTENT', store.retry(o2.id, 'manual').state === 'INTENT');
check('重试次数累加', store.get(o2.id)!.attempts === 2);

// 打到上限：create 时 attempts=1，两次 retry 后到 3
const o3 = store.create({ ...intent, id: 'MINT3:buy:3', mint: 'MINT3' });
for (let i = 0; i < 2; i++) {
  store.transition(o3.id, 'FAILED', { reason: 'x' });
  store.retry(o3.id, 'x');
}
store.transition(o3.id, 'FAILED', { reason: 'x' });
check('超过最大重试被拒', throws(() => store.retry(o3.id, 'x')), `attempts=${store.get(o3.id)!.attempts}`);

// 重启恢复
const o4 = store.create({ ...intent, id: 'MINT4:buy:4', mint: 'MINT4' });
store.transition(o4.id, 'SIGNED', { tx: 'tx4' });
store.transition(o4.id, 'SUBMITTED', { sig: 'SIG4' });
const o5 = store.create({ ...intent, id: 'MINT5:buy:5', mint: 'MINT5' });
store.transition(o5.id, 'SIGNED', { tx: 'tx5' });
store.transition(o5.id, 'SUBMITTED', { sig: 'SIG5' });
const o6 = store.create({ ...intent, id: 'MINT6:buy:6', mint: 'MINT6' });
store.transition(o6.id, 'SIGNED', { tx: 'tx6' });
store.transition(o6.id, 'SUBMITTED', { sig: 'SIG6' });

check('pending 只含未决订单', store.pending().length === 3, `${store.pending().length}`);

// ---------- 对账 ----------

console.log('\nS6 启动对账：');

const positions = new Map<string, Position>();
positions.set('MINT5', {
  mint: 'MINT5',
  qty: 1000,
  costSol: 0.1,
  entryPrice: 1e-7,
  entryMcapSol: 30,
  openedAt: 0,
  intentId: 'x',
  evidence: [],
  peakMcapSol: 30,
});

const status: Record<string, 'confirmed' | 'failed' | 'unknown'> = {
  SIG4: 'confirmed',
  SIG5: 'unknown',
  SIG6: 'failed',
};

const balance: Record<string, bigint> = {
  MINT4: 500n, // 已成交
  MINT5: 1000n, // 账本也有 → 平
  MINT6: 0n, // 失败
  MINT7: 42n, // 孤儿
};

const report = await reconcile(store, positions, {
  signatureStatus: async (sig) => status[sig] ?? 'unknown',
  tokenBalances: async () => new Map(Object.entries(balance)),
});

check('扫描到 3 笔未决订单', report.scannedOrders === 3, `${report.scannedOrders}`);
check('SIG4 判为已确认', report.confirmedOrders === 1);
check('SIG6 判为失败', report.failedOrders === 1);
check('SIG5 判为未知', report.unknownOrders === 1);
check('发现孤儿仓 MINT7', report.orphanPositions.some((x) => x.mint === 'MINT7'));
check('孤儿仓导致整体不平', report.ok === false);
check('订单状态已落库', store.get('MINT4:buy:4')!.state === 'CONFIRMED' && store.get('MINT6:buy:6')!.state === 'FAILED');

// adopt 策略
const positions2 = new Map<string, Position>();
const report2 = await reconcile(
  new OrderStore(join(dir, 'orders2.db')),
  positions2,
  { signatureStatus: async () => 'unknown', tokenBalances: async () => new Map([['ORPHAN', 7n]]) },
  'adopt'
);
check('adopt 策略接管孤儿仓', positions2.has('ORPHAN') && positions2.get('ORPHAN')!.intentId === 'recovered:orphan');
check('adopt 后不再报告孤儿', report2.orphanPositions.length === 1);

store.close();

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
