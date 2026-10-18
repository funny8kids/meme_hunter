/**
 * 前向峰值数学：结局分析与钱包画像共用的纯函数。
 *
 * 全部是确定性、O(n) 计算，不依赖任何外部服务：
 *   - 后缀最大：任意时点之后的全局峰值
 *   - 窗口前向最大：任意时点之后 W 毫秒内的峰值（单调队列）
 *   - 二分：时间轴定位
 */

/** 后缀最大：suffixMax[i] = max(v[i..n-1]) */
export function buildSuffixMax(v: Float64Array): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  let mx = -Infinity;
  for (let i = n - 1; i >= 0; i--) {
    if (v[i] > mx) mx = v[i];
    out[i] = mx;
  }
  return out;
}

/** 窗口前向最大：fwdW[j] = max(v[i]) 其中 j < i 且 ts[i] <= ts[j] + W（无则 NaN） */
export function buildFwdWindowMax(ts: Float64Array, v: Float64Array, W: number): Float64Array {
  const n = ts.length;
  const out = new Float64Array(n).fill(NaN);
  const dq = new Int32Array(n + 1);
  let head = 0;
  let tail = 0;
  let r = 1;
  for (let j = 0; j < n; j++) {
    const limit = ts[j] + W;
    while (r < n && ts[r] <= limit) {
      while (tail > head && v[dq[tail - 1]] <= v[r]) tail--;
      dq[tail++] = r;
      r++;
    }
    while (tail > head && dq[head] <= j) head++;
    if (tail > head) out[j] = v[dq[head]];
  }
  return out;
}

/** 最后一个 ts <= t 的下标，没有则 -1 */
export function lastIndexAtOrBefore(ts: Float64Array, t: number): number {
  let lo = 0;
  let hi = ts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** 第一个 ts >= t 的下标，没有则 -1 */
export function firstIndexAtOrAfter(ts: Float64Array, t: number): number {
  let lo = 0;
  let hi = ts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] >= t) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return ans;
}

export function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
