#!/usr/bin/env node
/**
 * 情报补全：安全 / Top holders / Dev 历史 / 社交 / DEX 流动性 / bundle 估算。
 *
 * 数据源：
 *   - RugCheck 公共报告（mint/freeze、top holders、LP、insider networks、风险）
 *   - DexScreener（价格、USD 流动性、24h volume/pair）
 *   - token.uri 元数据（twitter/telegram/website）
 *   - 本地 trades（前 10 秒买家集中度）
 *   - 本地 tokens/outcomes（creator 历史）
 *
 * 未知字段一律 NULL，不伪造“安全”。可重复运行，幂等 upsert。
 *
 * 用法：
 *   node src/enrich.ts --limit 50
 *   node src/enrich.ts --limit 200 --social --dex
 *   node src/enrich.ts --mints <mint1>,<mint2> --rebuild
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(k);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const has = (k: string): boolean => argv.includes(k);
const DB_PATH = arg('--db', 'data/meme.db');
const LIMIT = Number(arg('--limit', '50'));
const MINTS = arg('--mints', '').split(',').map((s) => s.trim()).filter(Boolean);
const REBUILD = has('--rebuild');
const DO_SOCIAL = !has('--no-social');
const DO_DEX = !has('--no-dex');
const RUGCHECK = 'https://api.rugcheck.xyz/v1/tokens';
const DEX = 'https://api.dexscreener.com/latest/dex/tokens';
const TOTAL_SUPPLY = 1_000_000_000;
const NOW = Date.now();

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 10000;');
db.exec('PRAGMA journal_mode = WAL;');
db.exec(readFileSync(join(process.cwd(), 'src', 'schema.sql'), 'utf8'));

const tokens = MINTS.length
  ? db.prepare(`SELECT mint, creator, uri, created_at, market_cap_sol FROM tokens WHERE mint IN (${MINTS.map(() => '?').join(',')})`).all(...MINTS)
  : db
      .prepare(
        `SELECT t.mint, t.creator, t.uri, t.created_at, t.market_cap_sol
         FROM tokens t LEFT JOIN token_risk r ON r.mint = t.mint
         WHERE r.mint IS NULL OR r.checked_at < ? OR ? = 1
         ORDER BY t.created_at DESC LIMIT ?`
      )
      .all(NOW - 6 * 3600_000, REBUILD ? 1 : 0, LIMIT) as Array<{
        mint: string;
        creator: string | null;
        uri: string | null;
        created_at: number;
        market_cap_sol: number | null;
      }>;

if (!tokens.length) {
  console.log('[enrich] nothing to do');
  process.exit(0);
}

interface RugResponse {
  token?: { mintAuthority?: string | null; freezeAuthority?: string | null; supply?: string; decimals?: number };
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  creator?: string;
  creatorBalance?: number;
  topHolders?: Array<{ address: string; owner?: string; pct?: number; uiAmount?: number; insider?: boolean }>;
  totalHolders?: number;
  risks?: Array<{ name: string; value?: string; description?: string; level: string; score?: number }>;
  score?: number;
  score_normalised?: number;
  rugged?: boolean;
  totalMarketLiquidity?: number;
  markets?: Array<{
    pubkey?: string;
    lp?: { basePrice?: number; quoteUSD?: number; lpLockedPct?: number; baseUSD?: number };
    liquidityA?: string;
    liquidityB?: string;
  }>;
  tokenMeta?: { name?: string; symbol?: string; uri?: string };
  insiderNetworks?: Array<{ size?: number; tokenAmount?: number }>;
  graphInsidersDetected?: number;
  knownAccounts?: Record<string, { type?: string; name?: string }>;
  transferFee?: { buyTax?: number; sellTax?: number } | null;
  creatorTokens?: Array<{ mint?: string; rugged?: boolean; score?: number }>;
}

interface DexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  volume?: { h24?: number };
  priceChange?: { h24?: number };
}

const insRisk = db.prepare(`
  INSERT INTO token_risk (
    mint, checked_at, source, mint_authority, freeze_authority, supply, decimals, holder_count,
    top1_rate, top10_rate, lp_burned_pct, honeypot, buy_tax, sell_tax, bundle_rate, first_10s_wallets,
    dev_hold_rate, dev_rugged_rate, liquidity_usd, price_usd, fdv_usd, pair_address, dex_id,
    price_change_24h, volume_24h_usd, risk_score, risk_flags, raw
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(mint) DO UPDATE SET
    checked_at=excluded.checked_at, source=excluded.source,
    mint_authority=excluded.mint_authority, freeze_authority=excluded.freeze_authority,
    supply=excluded.supply, decimals=excluded.decimals, holder_count=excluded.holder_count,
    top1_rate=excluded.top1_rate, top10_rate=excluded.top10_rate, lp_burned_pct=excluded.lp_burned_pct,
    honeypot=excluded.honeypot, buy_tax=excluded.buy_tax, sell_tax=excluded.sell_tax,
    bundle_rate=excluded.bundle_rate, first_10s_wallets=excluded.first_10s_wallets,
    dev_hold_rate=excluded.dev_hold_rate, dev_rugged_rate=excluded.dev_rugged_rate,
    liquidity_usd=excluded.liquidity_usd, price_usd=excluded.price_usd, fdv_usd=excluded.fdv_usd,
    pair_address=excluded.pair_address, dex_id=excluded.dex_id,
    price_change_24h=excluded.price_change_24h, volume_24h_usd=excluded.volume_24h_usd,
    risk_score=excluded.risk_score, risk_flags=excluded.risk_flags, raw=excluded.raw
`);

const insHolder = db.prepare(`
  INSERT INTO holder_snapshots (mint, ts, rank, address, amount, pct)
  VALUES (?,?,?,?,?,?)
`);

const insSocial = db.prepare(`
  INSERT INTO token_social (mint, updated_at, twitter, telegram, website, image, description, raw)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(mint) DO UPDATE SET
    updated_at=excluded.updated_at, twitter=excluded.twitter, telegram=excluded.telegram,
    website=excluded.website, image=excluded.image, description=excluded.description, raw=excluded.raw
`);

const insDev = db.prepare(`
  INSERT INTO dev_history (creator, updated_at, tokens_created, rugged, best_peak_x, avg_peak_x, best_mint, last_created_at)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(creator) DO UPDATE SET
    updated_at=excluded.updated_at, tokens_created=excluded.tokens_created, rugged=excluded.rugged,
    best_peak_x=excluded.best_peak_x, avg_peak_x=excluded.avg_peak_x,
    best_mint=excluded.best_mint, last_created_at=excluded.last_created_at
`);

const localBundleStmt = db.prepare(`
  SELECT wallet, SUM(sol_amount) sol, COUNT(*) n
  FROM trades
  WHERE mint = ? AND side = 'buy' AND ts BETWEEN ? AND ?
  GROUP BY wallet
  ORDER BY sol DESC
`);
const devStmt = db.prepare(`
  SELECT COUNT(*) n,
         SUM(CASE WHEN o.rugged = 1 THEN 1 ELSE 0 END) rugged,
         MAX(o.peak_x) best,
         AVG(o.peak_x) avg,
         MAX(t.created_at) last
  FROM tokens t LEFT JOIN outcomes o ON o.mint = t.mint
  WHERE t.creator = ?
`);
const devBestStmt = db.prepare(`
  SELECT t.mint FROM tokens t LEFT JOIN outcomes o ON o.mint=t.mint
  WHERE t.creator = ? ORDER BY COALESCE(o.peak_x,0) DESC LIMIT 1
`);

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson<T>(url: string, ms = 8_000): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  return null;
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

function riskScore(input: {
  mintAuth: string | null;
  freezeAuth: string | null;
  top1: number | null;
  top10: number | null;
  lpBurned: number | null;
  honeypot: number | null;
  bundle: number | null;
  devRug: number | null;
  liquidityUsd: number | null;
  risks: Array<{ level: string }>;
}): number {
  let score = 0;
  if (input.mintAuth) score += 15;
  if (input.freezeAuth) score += 15;
  if (input.top1 != null && input.top1 > 0.2) score += 15;
  else if (input.top1 != null && input.top1 > 0.1) score += 8;
  if (input.top10 != null && input.top10 > 0.5) score += 20;
  else if (input.top10 != null && input.top10 > 0.3) score += 10;
  if (input.lpBurned != null && input.lpBurned < 50) score += 10;
  if (input.honeypot === 1) score += 50;
  if (input.bundle != null && input.bundle > 0.2) score += 10;
  if (input.devRug != null && input.devRug > 0.5) score += 15;
  if (input.liquidityUsd != null && input.liquidityUsd < 5000) score += 10;
  for (const r of input.risks) if (r.level === 'danger') score += 8;
  return Math.round(clamp(score));
}

async function enrichOne(t: {
  mint: string;
  creator: string | null;
  uri: string | null;
  created_at: number;
  market_cap_sol: number | null;
}): Promise<void> {
  const report = await fetchJson<RugResponse>(`${RUGCHECK}/${t.mint}/report`, 10_000);
  const creator = t.creator ?? report?.creator ?? null;
  if (creator && !t.creator) {
    try {
      db.prepare('UPDATE tokens SET creator = COALESCE(creator, ?) WHERE mint = ?').run(creator, t.mint);
    } catch { /* 旧库/锁冲突不阻塞情报补全 */ }
  }
  const dex = DO_DEX
    ? await fetchJson<{ pairs?: DexPair[] }>(`${DEX}/${t.mint}`, 6_000)
    : null;
  const pair = (dex?.pairs ?? [])
    .filter((p) => p.chainId === 'solana')
    .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0];

  const mintAuth = report?.token?.mintAuthority ?? report?.mintAuthority ?? null;
  const freezeAuth = report?.token?.freezeAuthority ?? report?.freezeAuthority ?? null;
  const supplyRaw = num(report?.token?.supply);
  const decimals = report?.token?.decimals ?? null;
  const supply = supplyRaw != null && decimals != null ? supplyRaw / 10 ** decimals : supplyRaw;

  const known = report?.knownAccounts ?? {};
  const poolOwners = new Set<string>();
  for (const [addr, info] of Object.entries(known)) {
    if (info?.type === 'AMM' || info?.type === 'LOCKER') poolOwners.add(addr);
  }
  for (const m of report?.markets ?? []) {
    if (m.pubkey) poolOwners.add(m.pubkey);
    if (m.liquidityA) poolOwners.add(m.liquidityA);
    if (m.liquidityB) poolOwners.add(m.liquidityB);
  }
  const holders = (report?.topHolders ?? [])
    .filter((h) => !h.owner || !poolOwners.has(h.owner))
    .filter((h) => (h.pct ?? 0) > 0)
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  const top1 = holders[0]?.pct != null ? holders[0].pct / 100 : null;
  const top10 = holders.length
    ? holders.slice(0, 10).reduce((a, h) => a + (h.pct ?? 0), 0) / 100
    : null;

  const lpBurned =
    report?.markets?.reduce<number | null>((best, m) => {
      const v = num(m.lp?.lpLockedPct);
      return v == null ? best : best == null ? v : Math.max(best, v);
    }, null) ?? null;

  const liquidityUsd =
    num(report?.totalMarketLiquidity) ??
    num(pair?.liquidity?.usd) ??
    num(report?.markets?.reduce((a, m) => a + Number(m.lp?.quoteUSD ?? 0), 0)) ??
    null;
  const priceUsd =
    num(pair?.priceUsd) ??
    num(report?.markets?.[0]?.lp?.basePrice) ??
    null;

  const risks = report?.risks ?? [];
  const honeypot =
    risks.some((r) => /honeypot/i.test(r.name)) ? 1 : null;
  const buyTax = num(report?.transferFee?.buyTax);
  const sellTax = num(report?.transferFee?.sellTax);

  const insiderTokens = (report?.insiderNetworks ?? []).reduce(
    (a, n) => a + Number(n.tokenAmount ?? 0),
    0
  );
  const bundleRate =
    insiderTokens > 0 && supplyRaw && supplyRaw > 0 ? insiderTokens / supplyRaw : null;

  // 本地前 10 秒买家集中度
  const first = (localBundleStmt.all(t.mint, t.created_at, t.created_at + 10_000) as Array<{
    wallet: string;
    sol: number;
    n: number;
  }>) ?? [];
  const first10sWallets = first.length;
  const first10sSol = first.reduce((a, x) => a + Number(x.sol ?? 0), 0);
  const top3Sol = first.slice(0, 3).reduce((a, x) => a + Number(x.sol ?? 0), 0);
  const localBundle = first10sSol > 0 ? top3Sol / first10sSol : null;
  const combinedBundle = Math.max(bundleRate ?? 0, localBundle ?? 0);
  const bundleForRisk = Math.max(bundleRate ?? 0, first10sWallets >= 3 ? (localBundle ?? 0) : 0);

  const dev = devStmt.get(creator ?? '') as
    | { n: number; rugged: number | null; best: number | null; avg: number | null; last: number | null }
    | undefined;
  const devRug =
    dev && dev.n > 0 ? Number(dev.rugged ?? 0) / dev.n : null;
  const devBest = devBestStmt.get(creator ?? '') as { mint: string } | undefined;

  const flags: string[] = [];
  if (mintAuth) flags.push('mint_authority');
  if (freezeAuth) flags.push('freeze_authority');
  if (honeypot === 1) flags.push('honeypot');
  if (top1 != null && top1 > 0.2) flags.push('top1_over_20pct');
  if (top10 != null && top10 > 0.5) flags.push('top10_over_50pct');
  if (lpBurned != null && lpBurned < 50) flags.push('lp_not_locked');
  if (bundleRate != null && bundleRate > 0.1) flags.push('insider_network');
  if (localBundle != null && localBundle > 0.6 && first10sWallets >= 3) flags.push('bundle_first_10s');
  if (devRug != null && devRug > 0.5) flags.push('dev_rug_history');
  if (liquidityUsd != null && liquidityUsd < 5000) flags.push('low_liquidity');
  if (buyTax != null && buyTax > 5) flags.push('buy_tax');
  if (sellTax != null && sellTax > 5) flags.push('sell_tax');
  if (!report) flags.push('rugcheck_unavailable');

  const risk = riskScore({
    mintAuth,
    freezeAuth,
    top1,
    top10,
    lpBurned,
    honeypot,
    bundle: bundleForRisk,
    devRug,
    liquidityUsd,
    risks,
  });

  const checkedAt = Date.now();
  insRisk.run(
    t.mint,
    checkedAt,
    report ? 'rugcheck+dexscreener+local' : 'dexscreener+local',
    mintAuth,
    freezeAuth,
    supply,
    decimals,
    num(report?.totalHolders),
    top1,
    top10,
    lpBurned,
    honeypot,
    buyTax,
    sellTax,
    combinedBundle,
    first10sWallets,
    supplyRaw && report?.creatorBalance != null ? Number(report.creatorBalance) / supplyRaw : null,
    devRug,
    liquidityUsd,
    priceUsd,
    num(pair?.fdv),
    pair?.pairAddress ?? report?.markets?.[0]?.pubkey ?? null,
    pair?.dexId ?? (report?.markets?.length ? 'rugcheck-market' : null),
    num(pair?.priceChange?.h24),
    num(pair?.volume?.h24),
    risk,
    JSON.stringify(flags),
    JSON.stringify({
      risks: risks.map((r) => ({ name: r.name, level: r.level, value: r.value })),
      graphInsidersDetected: report?.graphInsidersDetected ?? null,
      rugged: report?.rugged ?? null,
      scoreNormalised: report?.score_normalised ?? null,
      localFirst10s: { wallets: first10sWallets, top3Share: localBundle },
    })
  );

  if (holders.length) {
    db.prepare('DELETE FROM holder_snapshots WHERE mint = ?').run(t.mint);
    const rank = holders.slice(0, 20);
    for (let i = 0; i < rank.length; i++) {
      const h = rank[i];
      insHolder.run(t.mint, checkedAt, i + 1, h.address, Number(h.uiAmount ?? 0), (h.pct ?? 0) / 100);
    }
  }

  if (creator) {
    insDev.run(
      creator,
      checkedAt,
      dev?.n ?? 0,
      dev?.rugged ?? 0,
      dev?.best ?? null,
      dev?.avg ?? null,
      devBest?.mint ?? null,
      dev?.last ?? null
    );
  }

  if (DO_SOCIAL) {
    const metaUrl = report?.tokenMeta?.uri ?? t.uri;
    if (metaUrl && /^https?:\/\//i.test(metaUrl)) {
      const meta = await fetchJson<{
        twitter?: string;
        telegram?: string;
        website?: string;
        image?: string;
        description?: string;
      }>(metaUrl, 5000);
      if (meta) {
        insSocial.run(
          t.mint,
          checkedAt,
          meta.twitter ?? null,
          meta.telegram ?? null,
          meta.website ?? null,
          meta.image ?? null,
          meta.description ?? null,
          JSON.stringify(meta)
        );
      }
    }
  }

  console.log(
    `[enrich] ${t.mint.slice(0, 8)}… risk=${risk} top10=${top10 == null ? '—' : (top10 * 100).toFixed(1) + '%'} ` +
      `lp=${lpBurned == null ? '—' : lpBurned.toFixed(0) + '%'} flags=${flags.join(',') || 'none'}`
  );
}

console.log(`[enrich] ${tokens.length} tokens`);
for (let i = 0; i < tokens.length; i++) {
  try {
    await enrichOne(tokens[i]);
  } catch (e) {
    console.error(`[enrich] ${tokens[i].mint} failed: ${(e as Error).message}`);
  }
  // 公共 RugCheck 有限流；留出间隔
  await new Promise((r) => setTimeout(r, 280));
}

db.close();
console.log('[enrich] done');
