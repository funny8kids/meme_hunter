#!/usr/bin/env node
/**
 * 实盘/纸面运行器：把已有采集数据接进引擎。
 *
 * 模式：
 *   --sim        完全离线：模拟 venue，不发任何网络请求（默认）
 *   --live       真发单（需要 SOLANA_PRIVATE_KEY + RPC_URL）
 *
 * 流程：
 *   轮询 trades 新行 → 特征 → 评分 → 风控 → 执行 → 持仓管理 → 落库
 *
 * 用法：
 *   node src/runner.ts --sim --db data/meme.db --size 0.1
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { Envelope } from './engine/types.ts';
import { FeatureEngine } from './engine/features.ts';
import { scoreFeatures, STRATEGY_VERSION } from './engine/scorer.ts';
import { PaperVenue } from './engine/venue/paper.ts';
import { Portfolio } from './engine/portfolio.ts';
import { PositionStore, SignalStore } from './engine/positionstore.ts';
import { OrderStore } from './engine/orders.ts';
import { Executor } from './engine/executor.ts';
import { DEFAULT_LIMITS, HaltSwitch } from './engine/risk.ts';
import { riskBudgetSize } from './engine/impact.ts';
import { makeNotifier, Heartbeat } from './engine/notify.ts';
import { RunnerState } from './engine/runnerstate.ts';

const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};

const MODE = argv.includes('--live') ? 'live' : 'sim';
const DB = arg('--db', 'data/meme.db');
const SIZE = Number(arg('--size', '0.1'));
const TP = Number(arg('--tp', '1.0'));
const SL = Number(arg('--sl', '0.5'));
const MAX_HOLD = Number(arg('--max-hold-min', '30')) * 60_000;
const POLL_MS = Number(arg('--poll', '1500'));
const COOLDOWN_MS = Number(arg('--cooldown-min', '10')) * 60_000;
const MAX_IMPACT_BPS = Math.max(1, Number(arg('--max-impact-bps', '300')));
const MAX_IMPACT_PCT = Math.max(0.0001, Math.min(0.5, Number(arg('--max-impact-pct', '0.015'))));
const MIN_SIZE_SOL = Math.max(0.0001, Number(arg('--min-size', '0.005')));
const RISK_PCT = Math.max(0.0001, Math.min(0.1, Number(arg('--risk-pct', '0.01'))));
const ONCE = argv.includes('--once');
const RESET_CURSOR = argv.includes('--reset-cursor');

mkdirSync('data', { recursive: true });

const tradeDb = new DatabaseSync(DB, { readOnly: true });
tradeDb.exec('PRAGMA busy_timeout = 5000;');
const venue = new PaperVenue({ feeBps: 100, prioritySol: 0.0005 });
const portfolio = new Portfolio(1.0);
const features = new FeatureEngine();
const positions = new PositionStore('data/positions.db');
const signals = new SignalStore('data/signals.db');
const orders = new OrderStore('data/orders.db');
const halt = new HaltSwitch('data/HALT');
const notify = makeNotifier();
const state = new RunnerState('data/runner.db');

// 恢复仓位（现金也要同步扣减，否则重启后权益虚高）
for (const [mint, p] of positions.load()) {
  portfolio.positions.set(mint, p);
  portfolio.cashSol -= p.costSol;
}
console.log(`[runner] 恢复持仓 ${portfolio.positions.size} 个，现金 ${portfolio.cashSol.toFixed(3)}`);

// 模拟 venue：绝不联网
let simCounter = 0;
// 「当日亏损」按 UTC 日切分；否则跨天后仍按累计亏损熔断
let dayKey = -1;
let dayStartRealized = 0;
const simVenue = {
  async prepare() {
    return new Uint8Array([0]);
  },
  async send() {
    simCounter++;
    return { sig: `SIM${simCounter}`, dryRun: true };
  },
  async confirm() {
    return true;
  },
};

if (MODE === 'live') {
  const gate = liveGate();
  if (!gate.ok) {
    console.error(`[runner] ⛔ LIVE 被门禁拒绝：${gate.reason}`);
    process.exit(3);
  }
}

const exec = new Executor({
  store: orders,
  portfolio,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  venue: MODE === 'live' ? (await liveVenue()) : (simVenue as any),
  limits: DEFAULT_LIMITS,
  notify,
});

async function liveVenue() {
  const { loadWallet } = await import('./engine/wallet.ts');
  const { LiveVenueRouter } = await import('./live/router.ts');
  const w = loadWallet();
  const migrated = tradeDb.prepare('SELECT 1 AS ok FROM migrations WHERE mint = ? LIMIT 1');
  return new LiveVenueRouter({
    keypair: w.keypair,
    rpcUrl: process.env.RPC_URL ?? '',
    dryRun: process.env.DRY_RUN !== '0',
    isMigrated: async (mint) => Boolean(migrated.get(mint)),
  });
}

const riskStmt = tradeDb.prepare('SELECT risk_score, risk_flags FROM token_risk WHERE mint = ?');
const REQUIRE_RISK = process.env.REQUIRE_RISK === '1';
function blockedByRisk(mint: string): boolean {
  const r = riskStmt.get(mint) as { risk_score: number | null; risk_flags: string | null } | undefined;
  if (!r) return REQUIRE_RISK;
  if ((r.risk_score ?? 0) >= 70) return true;
  try {
    const flags = JSON.parse(r.risk_flags ?? '[]') as string[];
    return flags.some((f) => ['honeypot', 'mint_authority', 'freeze_authority', 'dev_rug_history', 'top10_over_50pct'].includes(f));
  } catch {
    return false;
  }
}

const lastMcap = new Map<string, number>();
const minRow = (
  tradeDb.prepare('SELECT COALESCE(MIN(rowid),0) AS m FROM trades').get() as { m: number }
).m;
const savedCursor = RESET_CURSOR ? null : state.getCursor();
// 断点续跑：能从上次的 rowid 接着走，就不从头回放（避免重复触发历史信号）
let cursor = savedCursor ?? minRow;
// signaled 从 signals.db 恢复：重启后同一个币不会再次触发
const signaled = signals.signaledMints(STRATEGY_VERSION);
// cooldown 从 runner.db 恢复：卖完 10 分钟内不会再买回来
const cooldown = state.loadCooldowns(Date.now());

const heartbeat = new Heartbeat(notify);
heartbeat.start();

function poll(): Envelope[] {
  const rows = tradeDb
    .prepare(
      `SELECT rowid AS rid, signature, mint, ts, side, wallet, sol_amount, token_amount,
              market_cap_sol, v_sol, v_tokens
       FROM trades WHERE rowid > ? ORDER BY rowid ASC LIMIT 500`
    )
    .all(cursor) as Array<Record<string, unknown>>;

  const out: Envelope[] = [];
  for (const r of rows) {
    cursor = Number(r.rid);
    out.push({
      seq: cursor,
      tsWall: Number(r.ts),
      tsMono: Number(r.ts),
      v: 1,
      type: 'Trade',
      payload: {
        mint: String(r.mint),
        side: r.side === 'sell' ? 'sell' : 'buy',
        wallet: String(r.wallet ?? ''),
        sol: Number(r.sol_amount ?? 0),
        tokens: Number(r.token_amount ?? 0),
        vSol: Number(r.v_sol ?? 0),
        vTokens: Number(r.v_tokens ?? 0),
        mcapSol: Number(r.market_cap_sol ?? 0),
        sig: String(r.signature),
      },
    });
  }
  return out;
}

async function step(): Promise<void> {
  const events = poll();
  for (const evt of events) {
    if (evt.type !== 'Trade') continue;
    const tr = evt.payload;
    const ts = evt.tsWall;
    const dk = Math.floor(ts / 86_400_000);
    if (dk !== dayKey) {
      dayKey = dk;
      dayStartRealized = portfolio.realizedSol;
    }

    venue.onTrade(tr);
    features.onEvent(evt);
    portfolio.mark(tr.mint, tr.mcapSol);
    lastMcap.set(tr.mint, tr.mcapSol);

    // 离场
    for (const [mint, pos] of [...portfolio.positions]) {
      const cur = lastMcap.get(mint) ?? pos.entryMcapSol;
      const mult = pos.entryMcapSol > 0 ? cur / pos.entryMcapSol : 1;
      let reason = '';
      if (mult >= 1 + TP) reason = 'take_profit';
      else if (mult <= 1 - SL) reason = 'stop_loss';
      else if (ts - pos.openedAt >= MAX_HOLD) reason = 'timeout';
      if (!reason) continue;

      const q = venue.quoteSell(mint, pos.qty);
      if (!q) continue;
      const res = await exec.sell(mint, pos.qty, q.price, reason, ts);
      if (res.ok) {
        positions.remove(mint);
        state.setCooldown(mint, ts + COOLDOWN_MS);
        cooldown.set(mint, ts + COOLDOWN_MS);
      }
    }

    // 入场
    if (portfolio.positions.has(tr.mint)) continue;
    const last = cooldown.get(tr.mint);
    if (last !== undefined && ts < last) continue;

    const f = features.get(tr.mint);
    if (!f) continue;
    if (blockedByRisk(tr.mint)) continue;
    const s = scoreFeatures(f);
    if (!s.tier || s.tier === 'C') continue;
    if (signaled.has(tr.mint)) continue;
    signaled.add(tr.mint);
    const signalId = signals.save({
      mint: tr.mint,
      ts,
      score: s.score,
      tier: s.tier,
      evidence: s.evidence,
      strategyVersion: STRATEGY_VERSION,
      acted: false,
    });

    const reserves = venue.reserves(tr.mint);
    const sizeSol = riskBudgetSize({
      equitySol: portfolio.equitySol(),
      riskPct: RISK_PCT,
      stopLossPct: SL,
      liquiditySol: reserves?.vSol ?? 0,
      maxImpactPct: MAX_IMPACT_PCT,
      capSol: SIZE,
    });
    if (sizeSol < MIN_SIZE_SOL) continue;
    const quote = venue.quoteBuy(tr.mint, sizeSol);
    if (!quote || quote.impactBps > MAX_IMPACT_BPS) continue;

    const res = await exec.buy(
      {
        id: `${tr.mint}:buy:${evt.seq}`,
        mint: tr.mint,
        side: 'buy',
        sol: sizeSol,
        maxSlipBps: 1500,
        reason: `${s.tier}:${s.evidence.join(',')}`,
        ttlMs: 10_000,
      },
      {
        openPositions: portfolio.positions.size,
        mintExposureSol: 0,
        equitySol: portfolio.equitySol(),
        cashSol: portfolio.cashSol,
        dayPnlSol: portfolio.realizedSol - dayStartRealized,
        staleMs: f.staleMs,
        halted: halt.isHalted(),
      },
      { tokens: quote.tokensOut, price: quote.price, mcapSol: tr.mcapSol, evidence: s.evidence, ts }
    );

    if (res.ok) {
      signals.markActed(signalId);
      const p = portfolio.positions.get(tr.mint);
      if (p) positions.upsert(p);
    }
    heartbeat.beat();
  }
  // 整批处理完再推进 cursor：中途崩溃最多重复处理一批，
  // 幂等键（intent id）会挡住重复下单。
  state.setCursor(cursor);
}

function liveGate(): { ok: boolean; reason: string } {
  if (process.env.ALLOW_LIVE !== '1') return { ok: false, reason: 'ALLOW_LIVE!=1' };
  if (process.env.DRY_RUN !== '0') return { ok: false, reason: 'DRY_RUN!=0' };
  if (!process.env.RPC_URL) return { ok: false, reason: 'RPC_URL 未设置' };
  if (!process.env.SOLANA_PRIVATE_KEY) return { ok: false, reason: 'SOLANA_PRIVATE_KEY 未设置' };
  for (const path of ['data/reports/validation-latest.json', 'data/reports/crash-validation-latest.json']) {
    if (!existsSync(path)) return { ok: false, reason: `missing ${path}` };
    try {
      const r = JSON.parse(readFileSync(path, 'utf8'));
      if (r?.verdict !== 'GO_LIVE') return { ok: false, reason: `${path} verdict=${r?.verdict ?? '—'}` };
    } catch {
      return { ok: false, reason: `bad ${path}` };
    }
  }
  return { ok: true, reason: 'ok' };
}

async function main(): Promise<void> {
  if (MODE === 'live') {
    const gate = liveGate();
    if (!gate.ok) {
      console.error(`[runner] ⛔ LIVE 被门禁拒绝：${gate.reason}`);
      process.exit(3);
    }
    if (process.env.SKIP_RECONCILE !== '1') {
      const r = spawnSync(process.execPath, ['--no-warnings', 'src/reconcile-live.ts'], { stdio: 'inherit' });
      if (r.status !== 0) {
        console.error(`[runner] ⛔ 对账未通过，拒绝启动 live；status=${r.status ?? '—'}`);
        process.exit(3);
      }
    }
  }
  console.log(
    `[runner] mode=${MODE} db=${DB} size<=${SIZE} risk=${(RISK_PCT * 100).toFixed(2)}%/trade tp=${TP} sl=${SL} cooldown=${COOLDOWN_MS / 60_000}min`
  );
  if (halt.isHalted()) {
    console.log('[runner] ⛔ HALT 存在，拒绝启动。删除 data/HALT 后重试。');
    process.exit(3);
  }

  console.log(
    `[runner] cursor=${cursor}${savedCursor == null ? '（首次启动：从头开始）' : '（断点续跑）'}` +
      `  持仓=${portfolio.positions.size}  冷却中=${cooldown.size}  已发信号=${signaled.size}`
  );
  await step();
  console.log(
    `[runner] 首批完成: 持仓=${portfolio.positions.size} 订单=${JSON.stringify(orders.counts())} 现金=${portfolio.cashSol.toFixed(3)}`
  );

  if (ONCE) {
    heartbeat.stop();
    orders.close();
    positions.close();
    signals.close();
    state.close();
    return;
  }

  setInterval(() => {
    void step().catch((e) => console.error('[runner] step error', e));
  }, POLL_MS);
}

await main();
