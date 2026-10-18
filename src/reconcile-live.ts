#!/usr/bin/env node
/**
 * 实盘启动前对账（只读链上 + 本地订单/仓位）。
 *
 * 必须在 live runner 之前跑：
 *   npm run reconcile:live
 *
 * 不平（UNKNOWN 订单、孤儿仓、缺失仓）时退出 2，live runner 不应启动。
 */

import { Connection } from '@solana/web3.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWallet } from './engine/wallet.ts';
import { OrderStore } from './engine/orders.ts';
import { PositionStore } from './engine/positionstore.ts';
import { reconcile, type OrphanPolicy } from './engine/reconcile.ts';
import { tokenBalances, signatureStatus } from './live/chain.ts';
import { liveConfig } from './live/config.ts';

const cfg = liveConfig();
if (!cfg.rpcUrl) {
  console.error('RPC_URL 未设置');
  process.exit(1);
}
const wallet = loadWallet();
const conn = new Connection(cfg.rpcUrl, 'confirmed');
const orders = new OrderStore('data/orders.db');
const positions = new PositionStore('data/positions.db');
const map = positions.load();
const policy = (process.env.ORPHAN_POLICY === 'adopt' ? 'adopt' : 'flatten') as OrphanPolicy;

const report = await reconcile(
  orders,
  map,
  {
    signatureStatus: (sig) => signatureStatus(conn, sig),
    tokenBalances: async () => {
      const balances = await tokenBalances(conn, wallet.address);
      return new Map([...balances.entries()].map(([mint, b]) => [mint, b.amount]));
    },
  },
  policy
);

// adopt 模式下把孤儿仓写入本地账本；flatten 模式只报告，不擅自卖出
if (policy === 'adopt') {
  for (const o of report.orphanPositions) {
    const existing = map.get(o.mint);
    if (!existing) {
      const p = {
        mint: o.mint,
        qty: Number(o.balance),
        costSol: 0,
        entryPrice: 0,
        entryMcapSol: 0,
        openedAt: Date.now(),
        intentId: 'recovered:orphan',
        evidence: ['recovered'],
        peakMcapSol: 0,
      };
      map.set(o.mint, p);
      positions.upsert(p);
    }
  }
}

mkdirSync('data/reports', { recursive: true });
const out = {
  generatedAt: new Date().toISOString(),
  network: cfg.network,
  wallet: wallet.address,
  policy,
  ok: report.ok,
  report,
};
writeFileSync('data/reports/live-reconcile-latest.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
positions.close();
orders.close();
process.exit(report.ok ? 0 : 2);
