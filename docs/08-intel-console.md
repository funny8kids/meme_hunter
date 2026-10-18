# 情报层 / 钱包 / 控制台

## 1. 新增数据层

| 文件 / 表 | 作用 |
|---|---|
| `src/enrich.ts` | RugCheck + DexScreener + token metadata + 本地前 10 秒买家，写安全/持有人/Dev/社交 |
| `src/candles.ts` | 把 `trades` 聚合成 `candles_1m`，排名/图表不再全量扫成交 |
| `src/wallets2.ts` | 时间切分 70/30 的钱包 OOS 画像、标签、可复制性 |
| `token_risk` | mint/freeze、Top10、LP、tax、bundle、风险分、DEX 价格/流动性 |
| `holder_snapshots` | 每个币最新 Top20 持有人 |
| `token_social` | X / Telegram / Website / image / description |
| `dev_history` | 创建者发币数、rug 数、最佳/平均峰值 |
| `wallet_profiles` | 钱包 OOS 指标、标签、copyability、score |

### 命令

```bash
npm run enrich -- --limit 30          # 增量补全最近 30 个币
npm run enrich -- --mints <mint>      # 指定币
npm run enrich -- --limit 30 --no-social --dex
npm run candles                       # 增量 1m K线
npm run candles -- --rebuild          # 全量重建
npm run wallets2                      # OOS 钱包画像
npm run dex                           # 迁移后 DEX 快照
npm run experiments                   # v1/v2/crash/仓位/退出矩阵
npm run validate:crash                # crash 风险版 walk-forward + 成本/延迟压力

# 前瞻 shadow（独立 SQLite，不吃资金、不下单）
node src/shadow.ts --strategy crash  --shadow-db data/shadow-crash.db --size 0.02
node src/shadow.ts --strategy wallet --shadow-db data/shadow-wallet.db --size 0.02
node src/shadow.ts --strategy wallet --min-wallets 2 --shadow-db data/shadow-wallet-conf.db --size 0.02
node src/shadow.ts --strategy wallet --min-wallets 2 --min-copyability 0.45 --min-oos 4 --shadow-db data/shadow-wallet-conf-q.db --size 0.05
node src/shadow-dex.ts --shadow-db data/shadow-dex.db --size 0.02
```

`collect.mjs` 会自动拉起 `candles-worker.mjs`、`dex-worker.mjs` 和 `enrich-worker.mjs`：
K 线每分钟增量、DEX 快照每 90 秒、新币安全/持有者数据每 2 分钟补全。

### 怎么读 Forward Shadow

不要只看总 PnL。meme 的收益极少数尾部交易主导，必须同时看：

- `pnlExBestSol`：剔除最好一笔后的 PnL；
- `medianPnlSol`：中位数，代表“普通一笔”；
- `topTradeShare`：最好一笔占总盈利比例，>50% 时 UI 标 `⚠`。

当前 crash shadow 的例子：总 PnL +0.217 SOL，但最好一笔 +0.218 SOL，剔除后约 -0.0004 SOL，中位数 -0.012 SOL。  
这说明它是**单笔尾部运气**，不是稳定 edge。全样本 crash 325 笔仍是负期望、PF 0.60。  
所以：**shadow 总 PnL 为正 ≠ 可实盘**。

## 2. 新增页面

- **钱包**：`#wallets`
  - 聪明钱动态：最近 smart_money/copyable 钱包买卖
  - 全部 / Smart Money / 可复制 / Sniper / Dev / 样本不足 / 亏损
  - 排序：评分、可复制性、实现盈亏、胜率、OOS 胜率、交易数、最近活跃
  - 点击钱包看最近 80 笔交易和 token 峰值
- **执行**：`#live`
  - LIVE GATE、钱包 public key、风控、对账、订单/持仓、Testnet/Dry-run checklist
  - Forward Equity：各 shadow 账本的累计 PnL 曲线、剔除最好一笔后的 PnL
- **DEX**：`#dex`
  - 迁移后市场：DEX、价格 USD、24h 涨跌/成交、流动性、风险
  - 点击行进入终端
- **控制台**：`#console`
  - 系统：uptime、内存、端口、DB、HALT、验证结论
  - 数据：tokens/trades/risk/holders/social/dev/candles/wallets
  - 操作：验证、补全情报、重建 K线、重算钱包、结局分析、HALT/解除、纸面 runner 启停
  - 后台任务日志、SSE 实时信号/迁移/风险事件
- **终端**新增「代币情报」：风险分、风险 flags、Top holders、Top traders、Dev 历史、社交；支持 ☆ 自选。

## 3. 新增 API

| 路由 | 说明 |
|---|---|
| `GET /v1/token/risk?address=` | 风险 + Top20 holders + social + dev |
| `GET /v1/wallets?label=&sort=&q=&limit=&offset=` | 钱包 OOS 列表 |
| `GET /v1/wallet?address=` | 钱包详情 + 最近交易 |
| `GET /v1/alerts?limit=` | 最近信号 / 迁移 / 高危 |
| `GET /v1/console/status` | 系统/数据/健康/任务/事件 |
| `GET /v1/console/jobs` | 任务列表 + runner |
| `GET /v1/console/job?id=` | 任务详情 + 日志尾部 |
| `GET /v1/experiments/latest` | 策略实验矩阵结果 |
| `GET /v1/shadow` | forward shadow 的已平/未平/PnL |
| `GET /v1/live/status` | 实盘门禁、网络、钱包 public key、订单/持仓/对账 |
| `GET /v1/performance` | shadow 累计权益曲线、ex-best、账本对比 |
| `GET /v1/dex/markets` | 迁移后 DEX 市场快照 |
| `GET /v1/smart-money` | 最近聪明钱买入/卖出 |
| `GET /v1/token/traders` | 单币 Top traders |
| `GET /v1/trade/impact?mint=&size_sol=` | 本地流动性/冲击/往返成本估算 |
| `GET /v1/token/batch?addresses=` | 自选列表批量行情 |
| `POST /v1/console/action` | 白名单操作（验证/实验/情报/K线/钱包/分析/HALT/纸面） |
| `GET /v1/stream` | SSE：signal / migration / risk / health |

控制台写操作仅监听 `127.0.0.1`。设置 `CONSOLE_TOKEN` 后需带 `X-Console-Token`。

## 4. 流动性与冲击控制

meme 的“归零”经常不是方向错，而是仓位相对池子太大：

- 回测 `maxImpactBps`：单边冲击超过阈值就拒绝入场；
- `sizePctOfLiquidity`：仓位最多使用池子 SOL 侧流动性的固定比例；
- `minSizeSol`：缩放后太小就放弃，避免碎仓；
- forward shadow：按 `v_sol` / DEX liquidity 缩放 size，低于最小 size 直接跳过；
- 平仓统一扣 `exitHaircut`，DEX shadow 也扣 5%；
- 最大并发：普通 shadow 10，DEX shadow 5。

`src/engine/impact.ts` 是保守的恒定乘积近似，用于拦“小池子 + 大仓位”，不是精确链上报价。
`npm run validate:crash` 会同时跑成本压力、10s 延迟、随机基线、参数敏感性。

**固定优先费的尺寸陷阱**：0.001 SOL 往返优先费 / 0.02 SOL 仓位 = 5%，
再加平台费和滑点，0.02 SOL 的往返成本约 10%。  
所以小账户不是“仓位小更安全”，而是**被固定成本吃掉**。  
新增 `crash_005` forward 账本（0.05 SOL），用于 A/B 验证尺寸效应；不是调参结论。

## 5. 告警

设置以下环境变量后，服务端会对新信号、迁移、高危币发送 Telegram：

```bash
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...
```

未配置时静默；SSE 仍然工作。

## 6. 当前边界

- RugCheck/DexScreener 是公共端点，可能限流或短暂不可用；失败时未知字段保持 `null`。
- Top holders 来自第三方报告；不是完整链上全量排行。
- 前 10 秒 bundle 是本地成交近似，不等同于同 slot/资金源聚类。
- 钱包 OOS 目前只有约 2 小时有效数据，`insufficient` 标签必须保留；不要直接实盘跟单。
- `candles_1m` 最多 1 分钟延迟；1m 涨跌在边界分钟可能有偏差。

## 7. 策略实验矩阵（v2 / crash / 仓位 / 退出）

```bash
npm run experiments
```

输出 `data/reports/experiments-latest.json`，控制台「策略实验」直接显示。

当前全样本结论：

```text
NO_POSITIVE_ON_FULL_SAMPLE
crash -50% / 30m / TP100% SL50%: 期望 -0.0012, PF 0.72
v1 当前规则 / 3仓 / 30m:         期望 -0.0514, PF 0.00
```

crash 策略已经是最接近盈亏平衡的候选，但仍然为负；不要因为“接近”就上实盘。
真正判断必须等 7 天数据 + `validate.ts` 的 walk-forward/成本压力。
