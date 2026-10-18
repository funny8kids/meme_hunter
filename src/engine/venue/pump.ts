/**
 * pump.fun 执行（毕业前，走 bonding curve）。
 *
 * 交易由 PumpPortal 免费接口构建（返回可签名交易），我们本地签名后直发 RPC。
 * 这样不用维护 bonding curve 的账户表，也不依赖付费服务。
 *
 * DRY_RUN=1 时只构建不发送，用于本地排练。
 */

import { Connection, VersionedTransaction, type Keypair } from '@solana/web3.js';
import { resolveFill } from '../../live/chain.ts';

const TRADE_LOCAL = 'https://pumpportal.fun/api/trade-local';

export interface PumpOpts {
  keypair: Keypair;
  rpcUrl: string;
  /** 滑点百分比，例如 15 表示 15% */
  slippagePct?: number;
  /** 优先费 SOL */
  priorityFeeSol?: number;
  dryRun?: boolean;
}

export interface Submitted {
  sig: string;
  dryRun: boolean;
  txBytes: Uint8Array;
}

export class PumpVenue {
  readonly #kp: Keypair;
  readonly #conn: Connection;
  readonly #slip: number;
  readonly #prio: number;
  readonly dryRun: boolean;

  constructor(opts: PumpOpts) {
    this.#kp = opts.keypair;
    this.#conn = new Connection(opts.rpcUrl, 'confirmed');
    this.#slip = opts.slippagePct ?? 15;
    this.#prio = opts.priorityFeeSol ?? 0.0005;
    this.dryRun = opts.dryRun ?? process.env.DRY_RUN !== '0';
  }

  /** 构建未签名交易（base64 或二进制都由接口返回，这里统一成字节） */
  async build(action: 'buy' | 'sell', mint: string, amount: number): Promise<Uint8Array> {
    const body = {
      publicKey: this.#kp.publicKey.toBase58(),
      action,
      mint,
      amount: String(amount),
      denominatedInSol: action === 'buy' ? 'true' : 'false',
      slippage: this.#slip,
      priorityFee: this.#prio,
      pool: 'auto',
    };

    const res = await fetch(TRADE_LOCAL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`pump build ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json')) {
      const j = (await res.json()) as { transaction?: string } | string;
      const b64 = typeof j === 'string' ? j : j.transaction;
      if (!b64) throw new Error('pump build: empty transaction');
      return Uint8Array.from(Buffer.from(b64, 'base64'));
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** 只构建，便于「先落库签名，再发送」 */
  async prepare(action: 'buy' | 'sell', mint: string, amount: number): Promise<Uint8Array> {
    return this.build(action, mint, amount);
  }

  async buy(mint: string, sol: number): Promise<Submitted> {
    return this.send(await this.build('buy', mint, sol));
  }

  async sell(mint: string, tokenAmount: number): Promise<Submitted> {
    return this.send(await this.build('sell', mint, tokenAmount));
  }

  async send(bytes: Uint8Array): Promise<Submitted> {
    const tx = VersionedTransaction.deserialize(bytes);
    tx.sign([this.#kp]);

    if (this.dryRun) {
      // 本地排练：签名是真的，但不广播
      const sig = `DRY${Buffer.from(tx.signatures[0] ?? new Uint8Array(8)).toString('base64').slice(0, 20)}`;
      return { sig, dryRun: true, txBytes: bytes };
    }

    const sig = await this.#conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 0,
    });
    return { sig, dryRun: false, txBytes: bytes };
  }

  /** 轮询确认；返回 true=成功，false=失败/超时 */
  async confirm(sig: string, timeoutMs = 30_000): Promise<boolean> {
    if (sig.startsWith('DRY')) return true;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await this.#conn.getSignatureStatuses([sig]);
      const st = res.value[0];
      if (st?.err) return false;
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return true;
      await new Promise((r) => setTimeout(r, 1200));
    }
    return false;
  }
  async resolveFill(sig: string, mint: string, side: 'buy' | 'sell') {
    return resolveFill(this.#conn, sig, this.#kp.publicKey.toBase58(), mint, side);
  }

}
