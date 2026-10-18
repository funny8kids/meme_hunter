/**
 * 流式特征引擎：O(1) 摊还，只依赖 Trade / TokenCreated 事件，不花 RPC。
 *
 * 设计约束：
 *   - 纯内存状态，事件顺序决定结果（配合回放即确定）
 *   - 状态有 TTL，避免 8 万个币把内存吃光
 *   - 所有窗口基于「事件时间」，不是墙钟
 */

import type { Envelope } from './types.ts';

const WINDOW_MS = 5 * 60_000;
const RING_MAX = 600;
const BUYERS_MAX = 800;
const STATE_TTL_MS = 20 * 60_000;
const EVICT_EVERY = 5_000;
const TOTAL_SUPPLY = 1_000_000_000;

interface TradeRef {
  ts: number;
  side: 'buy' | 'sell';
  sol: number;
  tokens: number;
  wallet: string;
  mcapSol: number;
}

export interface MintState {
  mint: string;
  createdAt: number;
  creator: string;
  devBuySol: number;
  devTokens: number;
  lastMcapSol: number;
  peakMcapSol: number;
  firstMcapSol: number;
  lastTradeAt: number;
  ring: TradeRef[];
  buyers: Map<string, { tokens: number; lastAt: number }>;
}

export interface Features {
  mint: string;
  creator: string;
  ageSec: number;
  mcapSol: number;
  peakMcapSol: number;
  growthX: number;
  buys5m: number;
  sells5m: number;
  ratio5m: number;
  trades5m: number;
  uniqueBuyers5m: number;
  vol5m: number;
  volPrev5m: number;
  volAccel: number;
  devHeldPct: number;
  topBuyerShare: number;
  staleMs: number;
  solPerBuyer: number;
  /** 创建后前 10 秒的独立买家数 / 前 3 买家买入占比（bundle 近似） */
  first10sWallets: number;
  first10sTop3Share: number;
}

export class FeatureEngine {
  #states = new Map<string, MintState>();
  #now = 0;
  #events = 0;

  get size(): number {
    return this.#states.size;
  }

  onEvent(evt: Envelope): void {
    this.#now = evt.tsWall;
    this.#events++;

    if (evt.type === 'TokenCreated') {
      const p = evt.payload;
      if (!this.#states.has(p.mint)) {
        this.#states.set(p.mint, {
          mint: p.mint,
          // 真实创建时间优先；缺失时退回事件时间（老事件兼容）
          createdAt: Number.isFinite(p.createdAt) ? Number(p.createdAt) : evt.tsWall,
          creator: p.creator,
          devBuySol: p.devBuySol,
          // 创建者首买的代币数量（v1 老事件缺失时为 0，随后靠 creator 成交修正）
          devTokens: p.devBuyTokens ?? 0,
          lastMcapSol: p.mcapSol,
          peakMcapSol: p.mcapSol,
          firstMcapSol: p.mcapSol,
          lastTradeAt: evt.tsWall,
          ring: [],
          buyers: new Map(),
        });
      }
      return;
    }

    if (evt.type === 'Trade') {
      const t = evt.payload;
      let s = this.#states.get(t.mint);
      if (!s) {
        // 中途启动：用首笔成交兜底建状态
        s = {
          mint: t.mint,
          createdAt: evt.tsWall,
          creator: '',
          devBuySol: 0,
          devTokens: 0,
          lastMcapSol: t.mcapSol,
          peakMcapSol: t.mcapSol,
          firstMcapSol: t.mcapSol,
          lastTradeAt: evt.tsWall,
          ring: [],
          buyers: new Map(),
        };
        this.#states.set(t.mint, s);
      }

      s.ring.push({
        ts: evt.tsWall,
        side: t.side,
        sol: t.sol,
        tokens: t.tokens,
        wallet: t.wallet,
        mcapSol: t.mcapSol,
      });
      if (s.ring.length > RING_MAX) s.ring.splice(0, s.ring.length - RING_MAX);

      s.lastMcapSol = t.mcapSol;
      s.lastTradeAt = evt.tsWall;
      if (t.mcapSol > s.peakMcapSol) s.peakMcapSol = t.mcapSol;

      if (t.side === 'buy') {
        const b = s.buyers.get(t.wallet);
        if (b) {
          b.tokens += t.tokens;
          b.lastAt = evt.tsWall;
        } else {
          if (s.buyers.size >= BUYERS_MAX) {
            // 淘汰最旧的（Map 插入序 = 近似 LRU）
            const oldest = s.buyers.keys().next().value;
            if (oldest !== undefined) s.buyers.delete(oldest);
          }
          s.buyers.set(t.wallet, { tokens: t.tokens, lastAt: evt.tsWall });
        }
      }

      // Dev 持仓跟踪
      if (s.creator && t.wallet === s.creator) {
        s.devTokens += t.side === 'buy' ? t.tokens : -t.tokens;
        if (s.devTokens < 0) s.devTokens = 0;
      }

      if (this.#events % EVICT_EVERY === 0) this.evict();
    }
  }

  /** 清理长期无成交的币，防止内存无界增长 */
  evict(): number {
    let removed = 0;
    for (const [mint, s] of this.#states) {
      if (this.#now - s.lastTradeAt > STATE_TTL_MS) {
        this.#states.delete(mint);
        removed++;
      }
    }
    return removed;
  }

  get(mint: string): Features | null {
    const s = this.#states.get(mint);
    if (!s) return null;
    return this.#compute(s);
  }

  #compute(s: MintState): Features {
    const now = this.#now;
    const winStart = now - WINDOW_MS;
    const prevStart = now - 2 * WINDOW_MS;

    let buys = 0;
    let sells = 0;
    let trades = 0;
    let vol = 0;
    let volPrev = 0;

    // 从尾部（最新）往前扫，遇到窗口外就停
    for (let i = s.ring.length - 1; i >= 0; i--) {
      const r = s.ring[i];
      if (r.ts < prevStart) break;
      if (r.ts >= winStart) {
        trades++;
        vol += r.sol;
        if (r.side === 'buy') buys++;
        else sells++;
      } else {
        volPrev += r.sol;
      }
    }

    // 5 分钟内活跃买家 + 买入集中度
    let uniqueBuyers = 0;
    let buyTokens = 0;
    let maxBuyerTokens = 0;
    for (const [, v] of s.buyers) {
      if (v.lastAt < winStart) continue;
      uniqueBuyers++;
      buyTokens += v.tokens;
      if (v.tokens > maxBuyerTokens) maxBuyerTokens = v.tokens;
    }

    // 前 10 秒买家集中度（只依赖本地成交，回测/实盘一致）
    const firstCut = s.createdAt + 10_000;
    const firstBuyers = new Map<string, number>();
    let firstBuySol = 0;
    for (const r of s.ring) {
      if (r.ts > firstCut) break;
      if (r.side !== 'buy') continue;
      firstBuySol += r.sol;
      firstBuyers.set(r.wallet, (firstBuyers.get(r.wallet) ?? 0) + r.sol);
    }
    const top3 = [...firstBuyers.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);

    const growthX = s.firstMcapSol > 0 ? s.lastMcapSol / s.firstMcapSol : 1;
    const eps = 1e-9;

    return {
      mint: s.mint,
      creator: s.creator,
      ageSec: Math.max(0, (now - s.createdAt) / 1000),
      mcapSol: s.lastMcapSol,
      peakMcapSol: s.peakMcapSol,
      growthX,
      buys5m: buys,
      sells5m: sells,
      ratio5m: buys / Math.max(1, sells),
      trades5m: trades,
      uniqueBuyers5m: uniqueBuyers,
      vol5m: vol,
      volPrev5m: volPrev,
      volAccel: (vol + eps) / (volPrev + eps),
      devHeldPct: s.devTokens / TOTAL_SUPPLY,
      topBuyerShare: buyTokens > 0 ? maxBuyerTokens / buyTokens : 0,
      staleMs: Math.max(0, now - s.lastTradeAt),
      solPerBuyer: vol / Math.max(1, buys),
      first10sWallets: firstBuyers.size,
      first10sTop3Share: firstBuySol > 0 ? top3 / firstBuySol : 0,
    };
  }
}
