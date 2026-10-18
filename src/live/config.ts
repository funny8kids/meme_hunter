/**
 * 实盘环境配置。只读环境变量，不读取/打印私钥。
 *
 * 安全默认值：
 *   - DRY_RUN 默认 true（只有显式 DRY_RUN=0 才会广播）
 *   - ALLOW_LIVE 必须显式 1
 *   - NETWORK 默认 mainnet-beta
 */

export type SolanaNetwork = 'mainnet-beta' | 'devnet' | 'testnet';

export interface LiveConfig {
  network: SolanaNetwork;
  rpcUrl: string;
  publicKey: string;
  dryRun: boolean;
  allowLive: boolean;
  maxSolPerTrade: number;
  maxPortfolioSol: number;
}

export function liveConfig(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const network = (env.NETWORK ?? 'mainnet-beta') as SolanaNetwork;
  return {
    network: ['mainnet-beta', 'devnet', 'testnet'].includes(network) ? network : 'mainnet-beta',
    rpcUrl: env.RPC_URL ?? '',
    publicKey: env.SOLANA_PUBLIC_KEY ?? '',
    dryRun: env.DRY_RUN !== '0',
    allowLive: env.ALLOW_LIVE === '1',
    maxSolPerTrade: Number(env.MAX_SOL_PER_TRADE ?? '0.02'),
    maxPortfolioSol: Number(env.MAX_PORTFOLIO_SOL ?? '0.1'),
  };
}
