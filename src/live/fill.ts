/**
 * 从已确认链上交易解析实际成交。
 *
 * 实盘不能拿 expected.tokens / expected.price 记账；
 * 必须用 tx meta 的 token balance delta + SOL balance delta。
 */

export interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number; uiAmountString?: string };
}

export interface ParsedFill {
  mint: string;
  side: 'buy' | 'sell';
  /** 人类可读 token 数量 */
  tokens: number;
  /** 实际 SOL 成本/到手（含 fee 的余额差） */
  sol: number;
  /** sol / tokens */
  price: number;
  feeSol: number;
  preTokenAmount: number;
  postTokenAmount: number;
}

export interface TxLike {
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalanceEntry[];
    postTokenBalances?: TokenBalanceEntry[];
  } | null;
  transaction?: { message?: { accountKeys?: Array<{ pubkey?: { toBase58(): string } } | string> } };
}

function ownerKey(entry: TokenBalanceEntry): string | null {
  return entry.owner ?? null;
}

function amountOf(entry: TokenBalanceEntry | undefined): number {
  if (!entry?.uiTokenAmount?.amount) return 0;
  return Number(entry.uiTokenAmount.amount) / 10 ** Number(entry.uiTokenAmount.decimals ?? 0);
}

function tokenEntry(
  entries: TokenBalanceEntry[] | undefined,
  mint: string,
  owner: string
): TokenBalanceEntry | undefined {
  return (entries ?? []).find((e) => e.mint === mint && ownerKey(e) === owner);
}

function ownerBalance(
  balances: number[] | undefined,
  keys: Array<{ pubkey?: { toBase58(): string } } | string> | undefined,
  owner: string
): number | null {
  if (!balances || !keys) return null;
  const idx = keys.findIndex((k) => (typeof k === 'string' ? k : k.pubkey?.toBase58()) === owner);
  return idx >= 0 ? Number(balances[idx]) : null;
}

/**
 * 解析 owner 在某个 mint 上的实际成交。
 * 失败/无余额变化返回 null，调用方应把订单标为 UNKNOWN，而不是假装成交。
 */
export function parseActualFill(
  tx: TxLike | null,
  owner: string,
  mint: string,
  side: 'buy' | 'sell'
): ParsedFill | null {
  if (!tx?.meta || tx.meta.err) return null;
  const meta = tx.meta;
  if (!meta.preTokenBalances || !meta.postTokenBalances) return null;

  const pre = tokenEntry(meta.preTokenBalances, mint, owner);
  const post = tokenEntry(meta.postTokenBalances, mint, owner);
  const preAmount = amountOf(pre);
  const postAmount = amountOf(post);
  const delta = postAmount - preAmount;
  if (side === 'buy' && !(delta > 0)) return null;
  if (side === 'sell' && !(delta < 0)) return null;

  const keys = tx.transaction?.message?.accountKeys;
  const preSol = ownerBalance(meta.preBalances, keys, owner);
  const postSol = ownerBalance(meta.postBalances, keys, owner);
  if (preSol == null || postSol == null) return null;

  const solDelta = (postSol - preSol) / 1e9;
  const sol = side === 'buy' ? -solDelta : solDelta;
  if (!(sol > 0)) return null;

  const tokens = side === 'buy' ? delta : -delta;
  if (!(tokens > 0)) return null;

  return {
    mint,
    side,
    tokens,
    sol,
    price: sol / tokens,
    feeSol: Number(meta.fee ?? 0) / 1e9,
    preTokenAmount: preAmount,
    postTokenAmount: postAmount,
  };
}
