/**
 * 钱包装载：只从环境变量读，不落磁盘明文。
 *
 * 支持两种格式：
 *   - base58（Phantom 导出）
 *   - JSON 数组（solana-keygen 生成的 id.json）
 */

import { Keypair } from '@solana/web3.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function bs58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 char: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c === '1') bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}

export interface Wallet {
  keypair: Keypair;
  address: string;
}

export function loadWallet(raw = process.env.SOLANA_PRIVATE_KEY): Wallet {
  if (!raw) throw new Error('SOLANA_PRIVATE_KEY 未设置');
  const trimmed = raw.trim();

  let secret: Uint8Array;
  if (trimmed.startsWith('[')) {
    secret = Uint8Array.from(JSON.parse(trimmed) as number[]);
  } else {
    secret = bs58decode(trimmed);
  }

  if (secret.length === 32) {
    const kp = Keypair.fromSeed(secret);
    return { keypair: kp, address: kp.publicKey.toBase58() };
  }
  if (secret.length !== 64) {
    throw new Error(`私钥长度异常: ${secret.length}（应为 32 或 64 字节）`);
  }
  const kp = Keypair.fromSecretKey(secret);
  return { keypair: kp, address: kp.publicKey.toBase58() };
}
