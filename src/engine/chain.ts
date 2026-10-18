/**
 * 链上只读视图：余额快照 + 签名状态。
 *
 * 对账必须用「全钱包快照」，逐个 mint 查询永远发现不了孤儿仓。
 */

import { Connection, PublicKey } from '@solana/web3.js';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

export class ChainView {
  readonly connection: Connection;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  /** 全钱包持仓快照：mint -> 最小单位余额（0 不返回） */
  async tokenBalances(owner: string): Promise<Map<string, bigint>> {
    const ownerPk = new PublicKey(owner);
    const out = new Map<string, bigint>();

    for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
      const res = await this.connection.getParsedTokenAccountsByOwner(ownerPk, { programId });
      for (const { account } of res.value) {
        const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } })
          .parsed?.info;
        const mint = info?.mint;
        const amount = info?.tokenAmount?.amount;
        if (!mint || !amount) continue;
        const v = BigInt(amount);
        if (v > 0n) out.set(mint, (out.get(mint) ?? 0n) + v);
      }
    }
    return out;
  }

  async signatureStatus(sig: string): Promise<'confirmed' | 'failed' | 'unknown'> {
    const res = await this.connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const st = res.value[0];
    if (!st) return 'unknown';
    if (st.err) return 'failed';
    if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return 'confirmed';
    return 'unknown';
  }
}
