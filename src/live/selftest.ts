#!/usr/bin/env node
/**
 * Testnet / devnet 交易管道自检。
 *
 * 只做一笔自转，验证：
 *   RPC → 构建 → 签名 → 发送 → 确认 → 余额变化
 *
 * 不验证策略、滑点或 pump/Jupiter 主网流动性。
 *
 * 用法：
 *   NETWORK=devnet RPC_URL=https://api.devnet.solana.com \
 *   SOLANA_PRIVATE_KEY=... npm run live:selftest
 */

import { Connection, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { loadWallet } from '../engine/wallet.ts';
import { liveConfig } from './config.ts';

const cfg = liveConfig();
if (cfg.network === 'mainnet-beta') {
  console.error('⛔ selftest 只允许 devnet/testnet；拒绝 mainnet-beta');
  process.exit(2);
}
if (!cfg.rpcUrl) {
  console.error('RPC_URL 未设置');
  process.exit(1);
}

const wallet = loadWallet();
const conn = new Connection(cfg.rpcUrl, 'confirmed');
console.log(`network=${cfg.network} wallet=${wallet.address}`);

let balance = await conn.getBalance(wallet.address);
console.log(`balance=${(balance / 1e9).toFixed(6)} SOL`);
if (balance < 20_000_000) {
  console.log('余额不足，尝试 devnet airdrop 0.1 SOL…');
  try {
    const sig = await conn.requestAirdrop(wallet.address, 100_000_000);
    await conn.confirmTransaction(sig, 'confirmed');
    balance = await conn.getBalance(wallet.address);
    console.log(`airdrop=${sig} balance=${(balance / 1e9).toFixed(6)} SOL`);
  } catch (e) {
    console.error(`airdrop 失败：${(e as Error).message}`);
    process.exit(1);
  }
}

const lamports = 1_000; // 0.000001 SOL self transfer
const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: wallet.keypair.publicKey,
    toPubkey: wallet.keypair.publicKey,
    lamports,
  })
);

try {
  const sig = await sendAndConfirmTransaction(conn, tx, [wallet.keypair], { commitment: 'confirmed' });
  const after = await conn.getBalance(wallet.address);
  console.log(`selftest=OK sig=${sig}`);
  console.log(`before=${balance} after=${after} fee=${balance - after - lamports} lamports`);
} catch (e) {
  console.error(`selftest=FAIL ${(e as Error).message}`);
  process.exit(1);
}
