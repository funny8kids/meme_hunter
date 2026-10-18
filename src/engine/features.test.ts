/**
 * 特征引擎测试：聚焦本轮修复的 Dev 持仓跟踪（此前 initial_buy 未初始化，
 * 导致 v_dev 否决规则形同虚设），以及非重复场景下的行为。
 */

import { FeatureEngine } from './features.ts';
import type { Envelope } from './types.ts';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

const SUPPLY = 1_000_000_000;

function created(ts: number, mint: string, creator: string, devBuyTokens: number): Envelope {
  return {
    seq: 1,
    tsWall: ts,
    tsMono: ts,
    v: 1,
    type: 'TokenCreated',
    payload: {
      mint,
      creator,
      name: 'T',
      symbol: 'T',
      pool: 'pump',
      devBuySol: 1,
      devBuyTokens,
      mcapSol: 30,
      vSol: 30,
      vTokens: SUPPLY,
      sig: `c-${mint}`,
    },
  };
}

function trade(ts: number, seq: number, mint: string, wallet: string, side: 'buy' | 'sell', tokens: number, mcap = 30): Envelope {
  return {
    seq,
    tsWall: ts,
    tsMono: ts,
    v: 1,
    type: 'Trade',
    payload: { mint, side, wallet, sol: 0.1, tokens, vSol: 30, vTokens: SUPPLY, mcapSol: mcap, sig: `t-${seq}` },
  };
}

console.log('特征引擎（Dev 持仓）：');

// ---- 1. 创建者首买被计入 devHeldPct ----
{
  const fe = new FeatureEngine();
  fe.onEvent(created(1000, 'M1', 'DEV', 0.2 * SUPPLY)); // dev 持有 20%
  fe.onEvent(trade(2000, 2, 'M1', 'W1', 'buy', 1000));
  const f = fe.get('M1')!;
  check('devHeldPct 从首买初始化（20%）', Math.abs(f.devHeldPct - 0.2) < 1e-9, `得到 ${f.devHeldPct}`);
}

// ---- 2. 创建者卖出扣减 devHeldPct ----
{
  const fe = new FeatureEngine();
  fe.onEvent(created(1000, 'M2', 'DEV', 0.2 * SUPPLY));
  fe.onEvent(trade(2000, 2, 'M2', 'DEV', 'sell', 0.15 * SUPPLY));
  fe.onEvent(trade(3000, 3, 'M2', 'W1', 'buy', 1000));
  const f = fe.get('M2')!;
  check('创建者卖出后 devHeldPct = 5%', Math.abs(f.devHeldPct - 0.05) < 1e-9, `得到 ${f.devHeldPct}`);
}

// ---- 3. 创建者继续买入累计 ----
{
  const fe = new FeatureEngine();
  fe.onEvent(created(1000, 'M3', 'DEV', 0.1 * SUPPLY));
  fe.onEvent(trade(2000, 2, 'M3', 'DEV', 'buy', 0.1 * SUPPLY));
  fe.onEvent(trade(3000, 3, 'M3', 'W1', 'buy', 1000));
  const f = fe.get('M3')!;
  check('创建者加仓后 devHeldPct = 20%', Math.abs(f.devHeldPct - 0.2) < 1e-9, `得到 ${f.devHeldPct}`);
}

// ---- 4. 非创建者交易不影响 devHeldPct ----
{
  const fe = new FeatureEngine();
  fe.onEvent(created(1000, 'M4', 'DEV', 0.1 * SUPPLY));
  fe.onEvent(trade(2000, 2, 'M4', 'W1', 'buy', 0.5 * SUPPLY));
  fe.onEvent(trade(3000, 3, 'M4', 'W2', 'sell', 0.4 * SUPPLY));
  const f = fe.get('M4')!;
  check('别人的买卖不改变 devHeldPct', Math.abs(f.devHeldPct - 0.1) < 1e-9, `得到 ${f.devHeldPct}`);
}

// ---- 5. 老事件（无 devBuyTokens 字段）不报错 ----
{
  const fe = new FeatureEngine();
  const evt = created(1000, 'M5', 'DEV', 0);
  delete (evt.payload as Record<string, unknown>).devBuyTokens;
  fe.onEvent(evt);
  fe.onEvent(trade(2000, 2, 'M5', 'W1', 'buy', 1000));
  const f = fe.get('M5')!;
  check('缺字段时退化为 0（不炸）', f.devHeldPct === 0);
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
