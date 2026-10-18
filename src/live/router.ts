/**
 * 实盘 venue 路由：
 *   - pump.fun 曲线 → PumpVenue
 *   - 已迁移 AMM → JupiterVenue
 *
 * 这是执行适配器，不是策略。默认 DRY_RUN=true；LIVE 仍需 runner 双重门禁。
 */

import { Connection, type Keypair } from '@solana/web3.js';
import { PumpVenue } from '../engine/venue/pump.ts';
import { JupiterVenue, SOL_MINT } from '../engine/venue/jupiter.ts';
import type { ExecVenue } from '../engine/executor.ts';
import { tokenBalances } from './chain.ts';

export interface LiveRouterOpts {
  keypair: Keypair;
  rpcUrl: string;
  dryRun: boolean;
  isMigrated: (mint: string) => Promise<boolean>;
}

export class LiveVenueRouter implements ExecVenue {
  readonly #pump: PumpVenue;
  readonly #jupiter: JupiterVenue;
  readonly #conn: Connection;
  readonly #owner: string;
  readonly #isMigrated: (mint: string) => Promise<boolean>;
  #active: ExecVenue | null = null;

  constructor(opts: LiveRouterOpts) {
    this.#pump = new PumpVenue({
      keypair: opts.keypair,
      rpcUrl: opts.rpcUrl,
      dryRun: opts.dryRun,
    });
    this.#jupiter = new JupiterVenue({
      keypair: opts.keypair,
      rpcUrl: opts.rpcUrl,
      dryRun: opts.dryRun,
    });
    this.#conn = new Connection(opts.rpcUrl, 'confirmed');
    this.#owner = opts.keypair.publicKey.toBase58();
    this.#isMigrated = opts.isMigrated;
  }

  async prepare(action: 'buy' | 'sell', mint: string, amount: number): Promise<Uint8Array> {
    const migrated = await this.#isMigrated(mint);
    if (migrated) {
      this.#active = this.#jupiter;
      if (action === 'buy') {
        return this.#jupiter.prepare(SOL_MINT, mint, BigInt(Math.round(amount * 1e9)));
      }
      const balances = await tokenBalances(this.#conn, this.#owner);
      const decimals = balances.get(mint)?.decimals ?? 6;
      return this.#jupiter.prepare(mint, SOL_MINT, BigInt(Math.round(amount * 10 ** decimals)));
    }
    this.#active = this.#pump;
    return this.#pump.prepare(action, mint, amount);
  }

  async send(bytes: Uint8Array): Promise<{ sig: string; dryRun: boolean }> {
    if (!this.#active) throw new Error('venue send before prepare');
    return this.#active.send(bytes);
  }

  async confirm(sig: string, timeoutMs?: number): Promise<boolean> {
    if (!this.#active) throw new Error('venue confirm before prepare');
    return this.#active.confirm(sig, timeoutMs);
  }

  async resolveFill(sig: string, mint: string, side: 'buy' | 'sell') {
    if (!this.#active?.resolveFill) return null;
    return this.#active.resolveFill(sig, mint, side);
  }
}
