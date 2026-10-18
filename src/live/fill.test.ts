import { parseActualFill, type TxLike } from './fill.ts';

let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
}

const owner = 'OWNER';
const mint = 'MINT';
const key = (s: string) => ({ pubkey: { toBase58: () => s } });

function tx(side: 'buy' | 'sell'): TxLike {
  const preTokens = side === 'buy' ? 0 : 1_000_000;
  const postTokens = side === 'buy' ? 1_000_000 : 0;
  return {
    meta: {
      err: null,
      fee: 5000,
      preBalances: side === 'buy' ? [2_000_000_000, 1_000_000] : [1_000_000_000, 1_000_000],
      postBalances: side === 'buy' ? [1_000_000_000, 1_000_000] : [1_200_000_000, 1_000_000],
      preTokenBalances: [
        { accountIndex: 1, mint, owner, uiTokenAmount: { amount: String(preTokens), decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint, owner, uiTokenAmount: { amount: String(postTokens), decimals: 6 } },
      ],
    },
    transaction: { message: { accountKeys: [key(owner), key('TOKEN'), key('PROGRAM')] } },
  };
}

console.log('实际成交解析：');
const buy = parseActualFill(tx('buy'), owner, mint, 'buy');
check('买入解析成功', buy != null);
check('买入 token 数量正确', buy?.tokens === 1);
check('买入 SOL 成本正确', buy?.sol === 1);
check('买入价格正确', buy?.price === 1);
check('买入 fee 正确', buy?.feeSol === 0.000005);

const sell = parseActualFill(tx('sell'), owner, mint, 'sell');
check('卖出解析成功', sell != null);
check('卖出 token 数量正确', sell?.tokens === 1);
check('卖出 SOL 到手正确', sell?.sol === 0.2);
check('卖出价格正确', sell?.price === 0.2);

check('失败交易不解析', parseActualFill({ ...tx('buy'), meta: { ...tx('buy').meta, err: { code: 1 } } }, owner, mint, 'buy') === null);
check('无余额变化不解析', parseActualFill(tx('sell'), owner, mint, 'buy') === null);
check('无 token 账户不解析', parseActualFill({ ...tx('buy'), meta: { ...tx('buy').meta, preTokenBalances: [], postTokenBalances: [] } }, owner, mint, 'buy') === null);

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
