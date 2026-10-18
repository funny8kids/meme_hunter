/**
 * 启动对账（S6）：账本 vs 链上，不平就是事故。
 *
 * 只在启动时跑一次，跑完才允许接收新信号。
 * 所有外部状态（签名状态、余额）都由调用方注入，便于测试。
 */

import type { OrderStore, OrderRecord } from './orders.ts';
import type { Position } from './types.ts';

export type SigStatus = 'confirmed' | 'failed' | 'unknown';

export interface ReconcileDeps {
  /** 查询签名是否上链 */
  signatureStatus(sig: string): Promise<SigStatus>;
  /**
   * 钱包全部持仓快照（mint -> 最小单位余额）。
   * 必须返回**全部**非零持仓，否则识别不出孤儿仓。
   */
  tokenBalances(): Promise<Map<string, bigint>>;
}

export interface ReconcileReport {
  scannedOrders: number;
  confirmedOrders: number;
  failedOrders: number;
  unknownOrders: number;
  orphanPositions: Array<{ mint: string; balance: bigint }>;
  missingPositions: Array<{ mint: string; expected: number }>;
  ok: boolean;
}

export type OrphanPolicy = 'flatten' | 'adopt';

export async function reconcile(
  store: OrderStore,
  positions: Map<string, Position>,
  deps: ReconcileDeps,
  policy: OrphanPolicy = 'flatten'
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    scannedOrders: 0,
    confirmedOrders: 0,
    failedOrders: 0,
    unknownOrders: 0,
    orphanPositions: [],
    missingPositions: [],
    ok: false,
  };

  // 1) 处理所有悬而未决的订单
  for (const o of store.pending()) {
    report.scannedOrders++;
    const sig = o.sig;
    if (!sig) {
      // 签了但没发（或没来得及写 sig）——保守判定失败
      markFailed(store, o, 'no_signature_on_recovery', report);
      continue;
    }
    const st = await deps.signatureStatus(sig);
    if (st === 'confirmed') {
      if (o.state !== 'CONFIRMED') store.transition(o.id, 'CONFIRMED', { sig });
      report.confirmedOrders++;
    } else if (st === 'failed') {
      markFailed(store, o, 'chain_failed', report);
    } else {
      if (o.state !== 'UNKNOWN') store.transition(o.id, 'UNKNOWN', { reason: 'signature_not_found' });
      report.unknownOrders++;
    }
  }

  // 2) 账本 vs 链上余额
  // 注意：必须拿「全钱包快照」，只查已知 mint 永远发现不了孤儿仓。
  const balances = await deps.tokenBalances();
  const mints = new Set<string>([
    ...positions.keys(),
    ...balances.keys(),
    ...store.pending().map((o) => o.mint),
  ]);
  for (const mint of mints) {
    const balance = balances.get(mint) ?? 0n;
    const pos = positions.get(mint);

    if (balance > 0n && !pos) {
      report.orphanPositions.push({ mint, balance });
      if (policy === 'adopt') {
        positions.set(mint, {
          mint,
          qty: Number(balance),
          costSol: 0,
          entryPrice: 0,
          entryMcapSol: 0,
          openedAt: Date.now(),
          intentId: 'recovered:orphan',
          evidence: ['recovered'],
          peakMcapSol: 0,
        });
      }
      // flatten 由调用方按 policy 执行卖出（这里只报告，不擅自下单）
    } else if (balance === 0n && pos) {
      report.missingPositions.push({ mint, expected: pos.qty });
    }
  }

  report.ok =
    report.unknownOrders === 0 && report.orphanPositions.length === 0 && report.missingPositions.length === 0;
  return report;
}

function markFailed(store: OrderStore, o: OrderRecord, reason: string, report: ReconcileReport): void {
  if (o.state === 'UNKNOWN') store.transition(o.id, 'FAILED', { reason });
  else store.transition(o.id, 'FAILED', { reason });
  report.failedOrders++;
}
