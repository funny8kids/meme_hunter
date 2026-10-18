/**
 * 链上只读/执行辅助。只被 live runner / live reconcile 使用。
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { parseActualFill, type ParsedFill, type TxLike } from './fill.ts';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

export type SignatureStatus = 'confirmed' | 'failed' | 'unknown';

export async function signatureStatus(conn: Connection, sig: string): Promise<SignatureStatus> {
  const res = await conn.getSignatureStatuses([sig]);
  const st = res.value[0];
  if (!st) return 'unknown';
  if (st.err) return 'failed';
  if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return 'confirmed';
  return 'unknown';
}

export interface TokenBalance {
  amount: bigint;
  decimals: number;
}

/**
 * 返回钱包全部非零 token 余额。
 * 必须同时查 Token-2022，否则会漏掉新标准 token。
 */
export async function tokenBalances(conn: Connection, owner: string): Promise<Map<string, TokenBalance>> {
  const ownerKey = new PublicKey(owner);
  const out = new Map<string, TokenBalance>();
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    try {
      const res = await conn.getParsedTokenAccountsByOwner(ownerKey, { programId });
      for (const { account } of res.value) {
        const info = account.data.parsed?.info as
          | { mint?: string; tokenAmount?: { amount?: string; decimals?: number } }
          | undefined;
        const mint = info?.mint;
        const raw = info?.tokenAmount?.amount;
        if (!mint || !raw) continue;
        const amount = BigInt(raw);
        if (amount <= 0n) continue;
        out.set(mint, { amount, decimals: Number(info.tokenAmount?.decimals ?? 0) });
      }
    } catch {
      // Token-2022 未启用/接口不支持时，不影响 Token 标准
    }
  }
  return out;
}

export async function resolveFill(
  conn: Connection,
  sig: string,
  owner: string,
  mint: string,
  side: 'buy' | 'sell'
): Promise<ParsedFill | null> {
  const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  return parseActualFill(tx as unknown as TxLike, owner, mint, side);
}
