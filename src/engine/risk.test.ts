/**
 * S4 验收：风控与熔断。
 *
 * 断言：
 *   1. HALT 文件存在 → 一切下单被拒
 *   2. 超过单笔上限 → 拒
 *   3. 超过并发持仓 → 拒
 *   4. 价格陈旧 → 拒
 *   5. 当日亏损超限 → 拒
 *   6. 超过单币敞口 → 拒
 *   7. 现金不足 → 拒
 *   8. 正常情况 → 通过
 *   9. 指标能导出
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preTrade, HaltSwitch, DEFAULT_LIMITS } from './risk.ts';
import { Metrics } from './metrics.ts';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
}

const dir = mkdtempSync(join(tmpdir(), 'mh-risk-'));
const halt = new HaltSwitch(join(dir, 'HALT'));

const base = {
  openPositions: 0,
  mintExposureSol: 0,
  equitySol: 1.0,
  cashSol: 1.0,
  dayPnlSol: 0,
  staleMs: 500,
  halted: false,
};

const intent = { mint: 'MINT', sol: 0.1 };

console.log('S4 风控：');

check('正常下单通过', preTrade(intent, DEFAULT_LIMITS, base).ok);

check(
  'HALT 文件触发拒绝',
  (() => {
    halt.halt('test');
    const r = preTrade(intent, DEFAULT_LIMITS, { ...base, halted: halt.isHalted() });
    halt.clear();
    return !r.ok && r.reason === 'halted';
  })(),
  halt.isHalted() ? 'halt 未生效' : '已清理'
);

check(
  '单笔超限被拒',
  preTrade({ mint: 'MINT', sol: 0.5 }, DEFAULT_LIMITS, base).reason === 'size_over_limit'
);

check(
  '并发持仓超限被拒',
  preTrade(intent, DEFAULT_LIMITS, { ...base, openPositions: 3 }).reason === 'max_positions'
);

check(
  '价格陈旧被拒',
  preTrade(intent, DEFAULT_LIMITS, { ...base, staleMs: 60_000 }).reason === 'stale_price'
);

check(
  '当日亏损超限被拒',
  preTrade(intent, DEFAULT_LIMITS, { ...base, dayPnlSol: -0.2 }).reason === 'daily_loss_limit'
);

check(
  '单币敞口超限被拒',
  preTrade(intent, DEFAULT_LIMITS, { ...base, mintExposureSol: 0.2 }).reason === 'mint_exposure'
);

check(
  '现金不足被拒',
  preTrade(intent, DEFAULT_LIMITS, { ...base, cashSol: 0.05 }).reason === 'insufficient_cash'
);

const m = new Metrics();
m.inc('trades_total', 3);
m.set('positions_open', 2);
const text = m.render();
check('指标可导出', text.includes('meme_trades_total 3') && text.includes('meme_positions_open 2'));

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
