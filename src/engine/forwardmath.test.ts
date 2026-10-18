/**
 * 前向峰值数学测试：结局分析与钱包画像都建立在它之上，必须逐例验证。
 */

import { buildSuffixMax, buildFwdWindowMax, lastIndexAtOrBefore, firstIndexAtOrAfter, median } from './forwardmath.ts';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function eqArr(a: Float64Array, b: Array<number | null>, tol = 1e-9): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const bi = b[i];
    if (bi === null) {
      if (Number.isFinite(a[i])) return false;
      continue;
    }
    if (Math.abs(a[i] - bi) > tol) return false;
  }
  return true;
}

console.log('前向峰值数学：');

// ---- 后缀最大 ----
{
  const v = new Float64Array([3, 1, 4, 1, 5, 9, 2]);
  const s = buildSuffixMax(v);
  check('后缀最大正确', eqArr(s, [9, 9, 9, 9, 9, 9, 2]));
}

// ---- 窗口前向最大：严格排除当前下标 ----
{
  const ts = new Float64Array([1000, 2000, 3000, 4000, 5000]);
  const v = new Float64Array([10, 50, 20, 80, 30]);
  const f = buildFwdWindowMax(ts, v, 2500); // 窗口 (j, ts[j]+2500]
  // j=0: ts<=3500 → i=1(50),2(20) → 50
  // j=1: ts<=4500 → i=2(20),3(80) → 80
  // j=2: ts<=5500 → i=3(80),4(30) → 80
  // j=3: ts<=6500 → i=4(30) → 30
  // j=4: 无后续 → NaN
  check('窗口前向最大（严格后续 + 时间窗）', eqArr(f, [50, 80, 80, 30, null]));
}

// ---- 窗口内的最高点出现在窗外时应被排除 ----
{
  const ts = new Float64Array([0, 100, 200]);
  const v = new Float64Array([1, 999, 2]);
  const f = buildFwdWindowMax(ts, v, 150); // j=0: 只允许 i=1 (ts=100<=150) → 999
  check('窗口边界包含', f[0] === 999);
  const f2 = buildFwdWindowMax(ts, v, 50); // j=0: i=1 超出窗 → 无
  check('窗口外被排除', !Number.isFinite(f2[0]));
}

// ---- 二分 ----
{
  const ts = new Float64Array([10, 20, 30, 40]);
  check('lastIndexAtOrBefore 命中', lastIndexAtOrBefore(ts, 25) === 1);
  check('lastIndexAtOrBefore 越界为 -1', lastIndexAtOrBefore(ts, 5) === -1);
  check('firstIndexAtOrAfter 命中', firstIndexAtOrAfter(ts, 25) === 2);
  check('firstIndexAtOrAfter 越界为 -1', firstIndexAtOrAfter(ts, 45) === -1);
}

// ---- 中位数 ----
{
  check('中位数（奇数）', median([3, 1, 2]) === 2);
  check('中位数（偶数）', median([4, 1, 3, 2]) === 2.5);
  check('中位数（空）', Number.isNaN(median([])));
}

// ---- 单调性破坏不了（相同时间戳） ----
{
  const ts = new Float64Array([100, 100, 100]);
  const v = new Float64Array([1, 2, 3]);
  const f = buildFwdWindowMax(ts, v, 0);
  check('相同时间戳仍严格排除自身', f[0] === 3 && f[1] === 3 && !Number.isFinite(f[2]));
}

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
