# 实盘接入（当前仍锁定）

> 原则：策略没有通过 OOS / 成本压力 / forward shadow，不允许接真实钱包。

## 页面

前端新增 `#live`「执行 / 实盘就绪」：

- LIVE GATE：v1 / crash OOS / ALLOW_LIVE / DRY_RUN / RPC / 钱包 / HALT / 对账 / UNKNOWN 订单；
- 网络与钱包 public key；
- 风控边界；
- 对账结果；
- 订单 / 持仓；
- Testnet / Dry-run 工程检查清单。

**页面不会显示、接收或保存私钥。**

## 环境变量

```bash
# 只读地址，给 server / 前端展示用
export SOLANA_PUBLIC_KEY=...

# 只给 live runner / reconcile 进程
export SOLANA_PRIVATE_KEY=...
export RPC_URL=https://...
export NETWORK=mainnet-beta        # mainnet-beta | devnet | testnet

# 默认就是 dry-run；只有显式 0 才会广播
export DRY_RUN=1

# 双门禁
export ALLOW_LIVE=1

# 资金边界
export MAX_SOL_PER_TRADE=0.02
export MAX_PORTFOLIO_SOL=0.1

# 可选：没有安全数据就拒绝开仓（更严格，样本会更少）
export REQUIRE_RISK=1
```

`SOLANA_PRIVATE_KEY` 不要放进仓库、前端、日志或聊天记录。  
生产环境使用独立 signer / secret manager；热钱包只放极小资金。

## 实盘启动前

```bash
# devnet 交易管道自检（只做自转，不验证策略）
NETWORK=devnet RPC_URL=https://api.devnet.solana.com npm run live:selftest

npm run reconcile:live
npm run runner -- --live --once
```

`runner --live` 当前会检查：

1. `ALLOW_LIVE=1`
2. `DRY_RUN=0`
3. `RPC_URL` 已配置
4. `SOLANA_PRIVATE_KEY` 已配置
5. `validation-latest.json` 为 `GO_LIVE`
6. `crash-validation-latest.json` 为 `GO_LIVE`
7. 启动对账通过（除非 `SKIP_RECONCILE=1`，不推荐）

任一失败直接 exit 3。

## 执行层

- `PumpVenue`：pump.fun 曲线；
- `JupiterVenue`：迁移后 AMM；
- `LiveVenueRouter`：按 `migrations` 路由；
- 实际成交：`Executor` 通过 `resolveFill` 读取 tx meta 的 token / SOL 余额差；
- 对账：`reconcile-live.ts` 查订单、全钱包 token balance、孤儿仓/缺失仓；
- `DRY_RUN` 默认开启；只有 `DRY_RUN=0` 才广播。

## Testnet 的正确用途

devnet / local validator 用于：

- 钱包/ATA；
- 签名、发送、确认；
- blockhash 过期；
- 重试 / 幂等；
- 订单状态机；
- 对账；
- HALT / systemd 重启。

**不能用于**：

- 判断策略胜率；
- 估计滑点 / MEV；
- 判断 pump.fun / Jupiter 主网流动性；
- 调 TP/SL。

## 上线顺序

1. 主网 OOS / shadow 通过；
2. `reconcile:live` 通过；
3. `DRY_RUN=1` 构建/签名不广播；
4. 主网 0.01–0.02 SOL 单笔买卖；
5. 10–50 笔，对比 live vs shadow；
6. 才考虑放大。

当前没有通过 `GO_LIVE` 的候选，所以 `#live` 页面应显示 `DRY RUN` 或 `LIVE LOCKED`。
