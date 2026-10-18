/**
 * S5 验收：钱包装载 + 执行流水线顺序。
 *
 * 关键断言：
 *   1. base58 / JSON 两种私钥格式都能加载
 *   2. 发送时订单必须已经是 SIGNED 且 tx 已落库（先落库再发 不变量）
 *   3. 风控拒绝时不会创建订单
 *   4. 卖出能平掉仓位
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { loadWallet, bs58decode } from './wallet.ts';
import { OrderStore } from './orders.ts';
import { Portfolio } from './portfolio.ts';
import { Executor } from './executor.ts';
import { DEFAULT_LIMITS } from './risk.ts';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = '1' + s;
    else break;
  }
  return s;
}

console.log('S5 钱包：');
const kp = Keypair.generate();
const jsonForm = JSON.stringify([...kp.secretKey]);
const b58Form = bs58encode(kp.secretKey);

const w1 = loadWallet(jsonForm);
const w2 = loadWallet(b58Form);
check('JSON 数组格式可加载', w1.address === kp.publicKey.toBase58());
check('base58 格式可加载', w2.address === kp.publicKey.toBase58());
check('base58 往返一致', Buffer.compare(Buffer.from(bs58decode(b58Form)), Buffer.from(kp.secretKey)) === 0);
check('缺失私钥时抛错', (() => { try { loadWallet(undefined as never); return false; } catch { return true; } })());
check('长度异常时抛错', (() => { try { loadWallet('abc'); return false; } catch { return true; } })());

// ---------- 执行流水线 ----------

console.log('\nS5 执行流水线：');
const dir = mkdtempSync(join(tmpdir(), 'mh-exec-'));
const store = new OrderStore(join(dir, 'o.db'));
const portfolio = new Portfolio(1.0);

let stateDuringSend: string | null = null;
let txDuringSend = false;

const venue = {
  async prepare() {
    return new Uint8Array([1, 2, 3, 4]);
  },
  async send() {
    // 在这个瞬间检查：订单必须已 SIGNED 且 tx 已落库
    const id = 'MINTX:buy:1';
    const rec = store.get(id);
    stateDuringSend = rec?.state ?? null;
    txDuringSend = Boolean(rec?.tx);
    return { sig: 'DRYTEST', dryRun: true };
  },
  async confirm() {
    return true;
  },
};

const exec = new Executor({ store, portfolio, venue, limits: DEFAULT_LIMITS });

const ctx = {
  openPositions: 0,
  mintExposureSol: 0,
  equitySol: 1.0,
  cashSol: 1.0,
  dayPnlSol: 0,
  staleMs: 100,
  halted: false,
};

const r = await exec.buy(
  { id: 'MINTX:buy:1', mint: 'MINTX', side: 'buy', sol: 0.1, maxSlipBps: 1200, reason: 'test', ttlMs: 5000 },
  ctx,
  { tokens: 1_000_000, price: 1e-7, mcapSol: 30, evidence: ['demand'] }
);

check('买入成功', r.ok && r.state === 'CONFIRMED', r.reason);
check('发送时已是 SIGNED 且 tx 已落库', stateDuringSend === 'SIGNED' && txDuringSend);
check('仓位已建立', portfolio.positions.has('MINTX'));
check('现金已扣除', Math.abs(portfolio.cashSol - 0.9) < 1e-9, String(portfolio.cashSol));

// 风控拒绝
const r2 = await exec.buy(
  { id: 'MINTY:buy:2', mint: 'MINTY', side: 'buy', sol: 0.9, maxSlipBps: 1200, reason: 'too big', ttlMs: 5000 },
  ctx,
  { tokens: 1, price: 1e-7, mcapSol: 30, evidence: [] }
);
check('超限被风控拒绝', !r2.ok && r2.reason === 'size_over_limit');
check('被拒不创建订单', store.get('MINTY:buy:2') === null);

// 卖出
const r3 = await exec.sell('MINTX', 1_000_000, 2e-7, 'take_profit');
check('卖出成功', r3.ok);
check('仓位已平', !portfolio.positions.has('MINTX'));
check('有已平仓记录', portfolio.closed.length === 1);
check('卖出盈利', portfolio.closed[0].pnlSol > 0, portfolio.closed[0].pnlSol.toFixed(4));

store.close();
console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
