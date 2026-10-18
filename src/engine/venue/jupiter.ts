/**
 * Jupiter 执行（毕业后，走 AMM 路由）。
 *
 * 走 lite-api（免费），返回可签名交易，本地签名直发。
 */

import { Connection, VersionedTransaction, type Keypair } from '@solana/web3.js';
import { resolveFill } from '../../live/chain.ts';

const BASE = 'https://lite-api.jup.ag/swap/v1';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface JupiterOpts {
  keypair: Keypair;
  rpcUrl: string;
  slippageBps?: number;
  dryRun?: boolean;
}

export interface SwapResult {
  sig: string;
  dryRun: boolean;
}

export class JupiterVenue {
  readonly #kp: Keypair;
  readonly #conn: Connection;
  readonly #slipBps: number;
  readonly dryRun: boolean;

  constructor(opts: JupiterOpts) {
    this.#kp = opts.keypair;
    this.#conn = new Connection(opts.rpcUrl, 'confirmed');
    this.#slipBps = opts.slippageBps ?? 1500;
    this.dryRun = opts.dryRun ?? process.env.DRY_RUN !== '0';
  }

  async quote(inputMint: string, outputMint: string, amount: bigint) {
    const url =
      `${BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
      `&amount=${amount.toString()}&slippageBps=${this.#slipBps}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`jupiter quote ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async buy(mint: string, lamports: number): Promise<SwapResult> {
    return this.send(await this.prepare(SOL_MINT, mint, BigInt(Math.round(lamports))));
  }

  async sell(mint: string, tokenBaseUnits: bigint): Promise<SwapResult> {
    return this.send(await this.prepare(mint, SOL_MINT, tokenBaseUnits));
  }

  /** 构建未签名交易字节，便于先落库再发送 */
  async prepare(inputMint: string, outputMint: string, amount: bigint): Promise<Uint8Array> {
    const quoteResponse = await this.quote(inputMint, outputMint, amount);

    const res = await fetch(`${BASE}/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: this.#kp.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`jupiter swap ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const { swapTransaction } = (await res.json()) as { swapTransaction: string };
    return Uint8Array.from(Buffer.from(swapTransaction, 'base64'));
  }

  async send(bytes: Uint8Array): Promise<SwapResult> {
    const tx = VersionedTransaction.deserialize(bytes);
    tx.sign([this.#kp]);

    if (this.dryRun) {
      return { sig: `DRY${Buffer.from(tx.signatures[0] ?? new Uint8Array(8)).toString('base64').slice(0, 20)}`, dryRun: true };
    }

    const sig = await this.#conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 0,
    });
    return { sig, dryRun: false };
  }

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
