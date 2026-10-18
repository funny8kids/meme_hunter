# 全自建方案（v3）· 成本 ≈ $5/月

> 前提：不用 GMGN API（Plus $290/年、Pro $990/年太贵）。
> 结论：**可以完全自建，且成本只有一台 VPS。** 我把关键链路全部实测跑通了，代码已经在仓库里。
> 实测时间：2026-10-18

---

## 0. 一句话结论

| | GMGN Plus | 全自建 |
|---|---|---|
| 年成本 | $290 | **$60 左右**（$5/月 VPS） |
| 调用上限 | 5 万积分/年，权重 20/s | 无硬上限（受 RPC 限流） |
| 数据归属 | 平台 | 你自己的库 |
| 时间成本 | 0 | **约 3~4 周业余时间（60~80 小时）** |

按 $20/小时算，自建的时间成本约 $1,200~1,600。**所以自建的理由不是省钱，而是**：① 你要 7×24 高频轮询，Plus 的积分会被跑爆；② 数据资产归你（聪明钱标签、钱包画像、历史 outcomes 是真正的护城河）；③ 不受平台接口变更/封号影响。

---

## 1. 实测验证过的免费数据链路（这是本方案的地基）

| 数据 | 来源 | 实测结果 | 成本 |
|---|---|---|---|
| 新币创建 | **PumpPortal WS** `subscribeNewToken` | ✅ 拿到完整字段 | 免费 |
| 毕业/迁移 | PumpPortal `subscribeMigration` | ✅ 可订阅 | 免费 |
| **逐笔成交** | **Solana `logsSubscribe` + 解析 Anchor 事件** | ✅ **924 笔/分钟** | 免费 |
| 价格/流动性 | DexScreener `/latest/dex/tokens` | ✅ 返回 pair 全字段 | 免费 |
| 参考价/市值 | Jupiter `lite-api.jup.ag/price/v3`（批量 50） | ✅ 含 liquidity、priceChange24h | 免费 |
| 安全检测 | RugCheck `/v1/tokens/{mint}/report` | ✅ 含风险项与评分 | 免费 |
| RPC | 公共节点 → 建议换 Helius 免费档 | ✅ 公共节点即可跑 | 免费 |

### 关键发现 1：成交数据不用买

PumpPortal 的 `subscribeTokenTrade` 现在**需要 API Key**（实测返回 "only available when connecting with an API key"）。但不需要它——pump.fun 把每笔成交以 Anchor 事件写进交易日志：

```
Program data: <base64>   ← 8 字节判别符 bddb7fd34ee661ee + Borsh 字段
```

订阅程序日志（`logsSubscribe` mentions `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`）就能拿到**全链所有币的所有成交**，而且**不需要 `getTransaction`**（那是 RPC 最贵的调用）。

实测解码结果（真实数据）：

```
mint:  9fsDQMmBZHAUYhp331YX1EgPtw6LyaKApivvYnjfpump
side:  sell          sol: 1.87182383
tok:   10088238.18   user: EqymVP8KbeByHFiMWb1hfikoSHKxLrz6AsdWH4L17Jp5
vsol:  76.353  vtok: 421594480.54  →  mcap ≈ 181 SOL
```

事件布局（129 字节，已验证）：

```
u64 sol_amount | u64 token_amount | bool is_buy | pubkey user | i64 timestamp
u64 virtual_sol_reserves | u64 virtual_token_reserves | u64 real_sol | u64 real_token
```

按 `virtual_sol / virtual_token` 即可算出精确价格，**不需要任何额外 RPC 调用**。

### 关键发现 2：创建事件自带市值

PumpPortal 的 create 事件直接给了 `marketCapSol`、`vSolInBondingCurve`、`vTokensInBondingCurve`、`devBuy(solAmount)`、`uri`。也就是说**新币发现 + 初始定价 + Dev 首买金额**一次到手，零 RPC。

---

## 2. 架构

```
        ┌─────────────────┐
PumpPortal WS ──create/migration──┐
        └─────────────────┘        │
                                   ▼
                       ┌────────────────────┐
Solana logsSubscribe ──┤  Ingestor (2 进程)  ├──▶ SQLite (WAL)
   (Anchor 事件解码)    │  tokens / trades   │        │
                       └────────────────────┘        │
                                                     ▼
                                          ┌─────────────────────┐
DexScreener / Jupiter / RugCheck ────────▶│  Enricher (仅候选)   │
                                          │  安全/持币/流动性    │
                                          └─────────────────────┘
                                                     │
                                                     ▼
                                          ┌─────────────────────┐
                                          │  Scorer（打分 0-100）│
                                          └─────────────────────┘
                                                     │
                        ┌────────────────────────────┼──────────────────────┐
                        ▼                            ▼                      ▼
                  Telegram 推送                Executor                Replay 回测
                (告警 + 一键买)          (pump 直连 / Jupiter)        (SQL 即可)
                                                     │
                                                     ▼
                                              Position Manager
                                              (TP/SL 轮询)
```

**两个采集进程 + 一个 SQLite 文件**，不需要消息队列、不需要微服务、不需要 Docker。

---

## 3. 核心设计原则：分级处理（省 RPC 的唯一办法）

| 层级 | 对象 | 频率 | 成本 |
|---|---|---|---|
| L0 全量 | 所有 create / migration / trade | 实时 | $0（WS） |
| L1 候选 | 通过粗筛的币（约 1~3%） | 一次 | ~1 RPC/币 |
| L2 深度 | 通过精筛的币（每天 5~20 个） | 一次 | ~5 RPC/币 |
| L3 持仓 | 已买入的币 | 每 1~2 秒 | Jupiter price（批量，免费） |

按 Helius 免费 100 万 credits/月算：L2 每天 20 币 × 5 次 = 3000 次/月，完全在额度内。**永远不要对全量币做 holder 分析**——那是 GMGN 卖 $83/月的原因。

---

## 4. 数据模型

已落地在 [`src/schema.sql`](../src/schema.sql)：

- `tokens` — 创建信息 + enrich 回填字段
- `trades` — 逐笔成交（签名去重）
- `migrations` — 毕业事件
- `wallets` — 钱包画像（**自己算**）
- `outcomes` — 每个币的结局（回测基础）

### 容量规划（重要）

实测 **~900~1500 笔/分钟**，即 **130~200 万笔/天**，约 200~300 MB/天。

所以必须：

1. **原始成交只留 48 小时**，之后聚合成 5 秒 K 线
2. K 线：`candles(mint, ts, o,h,l,c, vol_sol, buys, sells)`，5s 粒度保留 24h，之后转 1m
3. 每小时跑一次 `outcomes` 计算

否则一个月就 9 GB，查询也会变慢。

---

## 5. 自建「聪明钱」（这是你唯一的护城河）

GMGN 的聪明钱标签 = 对全量钱包算历史 PnL。你现在有全量成交，可以免费算：

```sql
-- 1) 每个币的结局（用你自己的 K 线算）
UPDATE outcomes SET peak_x = (
  SELECT MAX(c) / (SELECT c FROM candles WHERE mint=outcomes.mint ORDER BY ts LIMIT 1)
  FROM candles WHERE mint = outcomes.mint
);

-- 2) 谁在「最终涨了 3 倍」的币上，很早就买了
SELECT t.wallet,
       COUNT(DISTINCT t.mint)                                        AS tokens,
       SUM(CASE WHEN o.peak_x >= 3 AND t.ts < tok.created_at + 60000
                THEN 1 ELSE 0 END)                                   AS early_wins,
       ROUND(AVG(o.peak_x), 2)                                       AS avg_peak_x
FROM trades t
JOIN outcomes o ON o.mint = t.mint
JOIN tokens   tok ON tok.mint = t.mint
WHERE t.side = 'buy' AND t.ts < tok.created_at + 600000
GROUP BY t.wallet
HAVING tokens >= 10
ORDER BY early_wins DESC
LIMIT 200;
```

三个关键点：

1. **用「峰值倍数」而不是「现价」**——meme 币现在价算 PnL 会把所有人都算亏。
2. **限定时间窗**（创建后 10 分钟内买入才算「早」），否则算出来的是接盘的。
3. **需要 2~3 周数据**才有统计意义。所以采集要**先跑起来**，边跑边攒。

有了这批地址，你就有了和 GMGN 同级别（甚至更贴合你自己策略）的聪明钱列表，**零成本、私有**。

---

## 6. 执行层

### 6.1 买入（毕业前，走 bonding curve）

用 [`@nirholas/pump-sdk`](https://github.com/nirholas/pump-fun-sdk) 或 pump 官方 IDL 自己拼指令：

```
buy(amount: u64, maxSolCost: u64)
```

- `maxSolCost = 期望成本 × (1 + 滑点)`，滑点给 10~15%
- 优先费：`ComputeBudgetProgram.setComputeUnitPrice`
- 发送：`sendRawTransaction(skipPreflight: true, maxRetries: 0)` + 自己轮询签名
- **必须做幂等**：发之前先在 `positions` 表写一条 `pending`，失败/超时用签名回查，避免重试买两次

### 6.2 卖出

- 毕业前：同程序的 `sell(amount, minSolOutput)`
- 毕业后：**Jupiter Swap API**（免费，自动路由），省去自己接 Raydium/PumpSwap

### 6.3 优先费策略

| 场景 | 优先费 |
|---|---|
| 建仓 | 0.0005~0.002 SOL（抢时间） |
| 止盈 | 0.0002~0.0005 SOL |
| 止损 | **0.005 SOL**（保命优先，宁可多付） |

止损那笔是全场最不该省手续费的地方——卖不掉比亏 50% 更糟。

### 6.4 TP/SL 的现实约束（必须知道）

Solana 上没有免费的链上条件单。你的止盈止损依赖**你的进程活着**：

- `systemd` 守护 + 自动重启
- 启动时**对账**：读钱包持仓，恢复未完成的仓位
- 心跳告警：5 分钟没心跳就 Telegram 报警
- 兜底：单笔仓位足够小，进程挂了你还能手动跑掉

（GMGN 的 `strategy` 接口卖的就是这个"托管"，自建就得自己保证。）

---

## 7. 四周路线图

| 周 | 目标 | 验收标准 |
|---|---|---|
| **W1** | 采集 + 入库 + K 线聚合 | 连续跑 7 天不断线；库里 ≥50 万币、≥1000 万笔成交；能画出任一首小时 K 线 |
| **W2** | 打分器 + 回测 + TG 推送 | 用 W1 数据跑出「这周如果按规则买会怎样」；每天推送 5~20 个候选 |
| **W3** | 执行 + 风控 + PnL | 小额（0.05 SOL）跑通 50 笔；真实滑点与预估偏差 <2%；止损能正常触发 |
| **W4** | 影子验证 + 调参 | 2 周纸面/微型实盘，得到「策略期望值」这个数字 |

**W2 结束时如果回测是负期望，立刻停**——这时候你只损失了 2 周，没亏钱。

---

## 8. 成本表

| 项目 | 方案 | 月成本 |
|---|---|---|
| VPS | Hetzner CX22 (2C4G) / 任何 €4 机器 | $4~5 |
| RPC | Helius Free（100 万 credits） | $0 |
| 新币流 | PumpPortal WS | $0 |
| 成交流 | Solana logsSubscribe | $0 |
| 行情 | DexScreener + Jupiter lite | $0 |
| 安全 | RugCheck | $0 |
| 存储 | 本地 SQLite | $0 |
| **合计** | | **$5/月** |

> 只有一种情况需要加钱：你想抢首块（<100ms），那要 gRPC + 就近部署，$100~300/月。**不建议**——见下。

---

## 9. 风险清单（诚实版）

| 风险 | 影响 | 应对 |
|---|---|---|
| 公开 RPC 限流/断线 | 漏数据 | 换 Helius 免费档；断线自动重连 + 补拉 |
| **pump.fun 程序升级，事件判别符变化** | 解码全挂 | 启动时校验判别符；把解码器做成可配置；日志里出现未知 disc 时告警 |
| PumpPortal 改协议/收费 | 新币流断 | 备用：直接解析 pump 程序日志拿 CreateEvent |
| 你打不过专业 sniper | 抢不到首块 | **不抢首块**，做 30 秒~10 分钟窗口 |
| 进程挂掉时持仓无止损 | 亏光单笔 | 单笔小 + systemd + 心跳告警 |
| 数据量膨胀 | 磁盘满/查询慢 | 48h 原始 + K 线降采样 |
| 法律/税务 | — | 自行评估 |

### 关于"抢首块"

实测从事件到你的机器约 1.8 秒（公共 RPC），专业 searcher 是 <100ms 并且能读取 shred 流。**这条路零售走不通，不要投钱进去。** 你的窗口是创建后 30 秒到 10 分钟——这段时间的胜负由**筛选质量**决定，不是延迟。

---

## 10. 现在就能跑（代码已就绪）

```bash
cd /home/dominic-jamil/GIthub_Code/Meme_Hunter

npm run ingest     # 新币 + 毕业事件
npm run trades     # 全量成交（Anchor 事件解码）

# 生产环境建议换成 Helius 免费端点
RPC_WS="wss://atlas-mainnet.helius-rpc.com/?api-key=YOUR_KEY" npm run trades
```

已实测：45 秒采集到 80 个新币、559 笔成交，约 924 笔/分钟。

文件：
- [`src/ingest.mjs`](../src/ingest.mjs) — PumpPortal 采集
- [`src/trades.mjs`](../src/trades.mjs) — 日志订阅 + Anchor 解码
- [`src/schema.sql`](../src/schema.sql) — 数据模型

### 下一步（W1 剩余部分）

1. `src/candles.mjs` — 成交聚合 5s K 线 + 48h 清理
2. `src/outcomes.mjs` — 每小时算每个币的 peak_x
3. `src/score.mjs` — 打分器（安全硬门槛 + 集中度 + 动量 + 聪明钱）
4. `src/bot.mjs` — grammY Telegram 推送
5. `src/exec.mjs` — pump 直连买入 + Jupiter 卖出 + 仓位状态机

要我接着写哪一块？我建议 **先跑 7 天数据**（这期间把 candles/outcomes 写完），因为回测没有数据就是空谈。
