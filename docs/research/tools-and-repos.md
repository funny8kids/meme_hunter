# 调研报告 + 方案 v2（取代 v1 的第 3~5 节）

> 调研时间：2026-10-18 · 方法：GitHub API 拉取真实 star/活跃度 + 直接抓取官网 + **实测调用 GMGN 官方 API**
> 结论先行：**不用自己搭数据层了。GMGN 在 2026 年放出了官方 OpenAPI，我用它的公开测试 key 实测跑通了实时数据。**
> 这意味着成本从「2~4 周开发 + 自建 ingestor」降到「3 天 + $0」。

---

## 一、产品层：目前公认做得好的工具

| 工具 | 形态 | 覆盖 | 优势 | 适合你吗 |
|---|---|---|---|---|
| **GMGN** | Web 终端 + TG Bot | SOL/BSC/Base/ETH | 数据维度最全（聪明钱/KOL/老鼠仓/bundle），有官方 OpenAPI | ✅ 首选，且能当我们的数据源 |
| **Axiom** | Web 终端 | SOL 为主 | 2025 年起增长最快，速度快、UI 顺 | 备选操作台 |
| **Photon** | Web 终端 | SOL | 老牌，速度极快 | 备选 |
| **BullX** | Web 终端 | 多链 | 多链 + 速度快 | 多链时用 |
| **Trojan** | TG Bot | SOL | 最早的一批 TG 狙击 bot | 纯手机操作用 |
| **BONKbot** | TG Bot | SOL | 稳定、体验好 | 纯手机操作用 |
| **Bloom / Nova / Pepeboost** | TG Bot | SOL/BSC | 中文社区常用 | 中文社群 |
| **Maestro / Banana Gun** | TG Bot | 多链 | 老牌多链 | 多链 |
| **DexScreener** | 行情 | 全链 | 免费行情/新池子，事实标准 | 看盘 + 免费数据源 |
| **RugCheck** | 安全 | SOL | 免费安全检测 API | 安全过滤 |
| **Bubblemaps / Cielo / AVE** | 持仓/钱包 | 多链 | 筹码结构、钱包画像 | 辅助验证 |

费率普遍 **0.5%~1%/笔**（以官网为准）。它们赚钱靠手续费，不靠交易——这点和我们不一样。

**关键判断**：这些工具已经把「发现 + 执行」做到 1 秒内，你在 UI 和速度上不可能赢。**你能赢的只有「筛选逻辑」和「纪律」**——而这恰恰不需要重写一个 GMGN。

---

## 二、数据/执行层：GMGN 官方 OpenAPI（已实测）

### 事实

- 官方仓库：[GMGNAI/gmgn-skills](https://github.com/GMGNAI/gmgn-skills) — **620 star，MIT，2026-10-16 仍在更新**
- 形态：`gmgn-cli`（npm 包 `gmgn-cli`）+ 19 个 Agent Skill
- 地址：`https://openapi.gmgn.ai`，鉴权头 `X-APIKEY` + `timestamp` + `client_id`；交易类接口额外用 Ed25519 签名
- 申请：<https://gmgn.ai/ai>（生成 Ed25519 密钥对 → 填公钥 → 拿 API Key）
- 计费：**README 与官网均未公开价格**，需登录后确认（这是目前唯一的未知数）

### 我实测的结果（用文档里的公开 demo key）

```bash
# 实时 Solana 热榜
GET /v1/market/rank?chain=sol&interval=1h&limit=3
→ code=0，返回真实在跑的币，字段包括：
   price / price_change_percent{1m,5m,1h} / volume / liquidity / market_cap /
   swaps / buys / sells / holder_count / top_10_holder_rate /
   launchpad / exchange / twitter / website / creation_timestamp

# 安全检测
GET /v1/token/security?chain=sol&address=<mint>
→ is_honeypot / buy_tax / sell_tax / renounced_mint / renounced_freeze_account /
  burn_status / top_10_holder_rate / lock_summary

# 新币（trenches）
POST /v1/trenches?chain=sol
→ 返回结构正确，但 demo key 下数组为空（疑似需正式 key 或参数），待确认
```

**结论：数据层免费可跑通。** 你不需要写 RPC 解析、不需要 Geyser、不需要自己算持币集中度。

### 可用接口清单（从源码提取，共 40+）

| 类别 | 接口 |
|---|---|
| 行情 | `/v1/market/rank`（热榜 1m/5m/1h/6h/24h）、`/v1/market/token_kline`、`/v1/market/hot_searches` |
| 新币 | `/v1/trenches`（新创建 / 临近毕业 / 已毕业） |
| 信号 | `/v1/market/token_signal`（**聪明钱集群买入、KOL 喊单、暴涨、聪明钱出货**） |
| 代币 | `/v1/token/info`、`/v1/token/security`、`/v1/token/pool_info`、`token_top_holders`、`token_top_traders` |
| 钱包 | `/v1/user/wallet_stats`（胜率/PnL）、`wallet_activity`、`wallet_profits`、`created_tokens`（Dev 历史） |
| 跟踪 | `/v1/user/smartmoney`、`/v1/user/kol`、`/v1/trade/follow_wallet` |
| **交易** | `/v1/trade/quote`、`/v1/trade/swap`、`/v1/trade/multi_swap`（多钱包）、`/v1/trade/strategy/create`（**TP/SL + 移动止盈止损**）、`query_order`、`cancel` |
| 发币 | `/v1/cooking/create_token` |

**最有价值的一条**：`strategy/create` 支持 `profit_stop` / `loss_stop` 多档 + 移动止盈。也就是说，「2x 卖一半、4x 卖一半、-50% 止损」这种纪律可以写成 API 调用，不用你盯盘。

### ⚠️ 安全警告（来自源码）

`gmgn-cli` 把你的私钥**明文**存在 `~/.config/gmgn/.env`（代码里只是把权限收紧到 600）。
→ **必须用专用热钱包，只放你准备亏掉的钱。**

---

## 三、GitHub 开源项目清单（含风险评级）

数据来自 GitHub API 实时拉取（star / 最后 push 时间）。

| 项目 | ★ | 语言 | 用途 | 评级 |
|---|---|---|---|---|
| [GMGNAI/gmgn-skills](https://github.com/GMGNAI/gmgn-skills) | 620 | TS | GMGN 官方 CLI + Skills | ⭐⭐⭐⭐⭐ 直接用 |
| [chainstacklabs/pumpfun-bonkfun-bot](https://github.com/chainstacklabs/pumpfun-bonkfun-bot) | 1032 | Python | pump.fun/letsbonk 监听+狙击+交易，**不依赖第三方 API** | ⭐⭐⭐⭐ 学架构；作者明示 NOT FOR PRODUCTION |
| [chainstacklabs/pumpfun-cli](https://github.com/chainstacklabs/pumpfun-cli) | — | Python | pump.fun 命令行工具 | ⭐⭐⭐⭐ 工具化参考 |
| [nirholas/pump-fun-sdk](https://github.com/nirholas/pump-fun-sdk) | 137 | TS | pump.fun 协议 SDK（曲线/AMM/毕业/费用） | ⭐⭐⭐⭐⭐ 自建执行层首选依赖 |
| [ChainBuff/open-sol-bot](https://github.com/ChainBuff/open-sol-bot) | 404 | Python | TG 跟单机器人（对标 GMGN Bot），含监控/跟单/激活码 | ⭐⭐⭐ 中文，可直接读；作者明示仅测试 |
| [nhovongoc0-max/meme-radar](https://github.com/nhovongoc0-max/meme-radar) | 540 | JS | 本地只读多链 Meme 雷达，用 AVE 免费额度 | ⭐⭐⭐⭐ 抄它的筛选维度与 UI 思路，**不含交易** |
| [h100envy/gem-search](https://github.com/h100envy/gem-search) | 214 | Py/JS | bundle 检测 / 关联钱包 / Dev 历史侦查 | ⭐⭐⭐⭐ 侦查维度值得抄 |
| [yllvar/Smart_Money_Follower](https://github.com/yllvar/Smart_Money_Follower) | 155 | Python | 用 GMGN wrapper 筛聪明钱钱包 | ⭐⭐⭐ 小而直接 |
| [1f1n/gmgnai-wrapper](https://github.com/1f1n/gmgnai-wrapper) | 144 | Python | GMGN 非官方接口封装 | ⭐⭐ 已被官方 API 取代 |
| [WSOL12/Solana-Arbitrage-Bot](https://github.com/WSOL12/Solana-Arbitrage-Bot) | 525 | TS | 跨 DEX 套利 + Jito | ⭐⭐ 套利≠meme，但 Jito 用法可参考 |
| [cicere/pumpfun-bundler](https://github.com/cicere/pumpfun-bundler) | 438 | TS | 发币 + 25 钱包捆绑买入 | ⚠️ **高风险**：用于自建盘/坐庄，法律与道德风险 |
| [mortdeus/solana-copy-sniper-mev-trading-bot](https://github.com/mortdeus/solana-copy-sniper-mev-trading-bot) | 4498 | Rust | 声称最强 MEV/跟单 bot | ❌ **典型引流陷阱**：README 里没有可用代码，全是「即将上线」，让你私聊 Telegram 买定制。star 数异常 |

### 识别骗局的三个信号（我在这 4498 star 的项目上全部命中）

1. README 大量关键词堆砌（"solana sniper bot" 重复十几次）+ 让你 star
2. 没有可运行代码，只有截图和「Coming soon」
3. 结尾一定是「私聊 Telegram 定制/买完整版」

**永远不要把私钥交给任何从 GitHub 下载的 bot。** 这类仓库最常见的盈利方式是直接掏空你的钱包。

---

## 四、修订后的方案：3 天 MVP（成本 ≈ $0）

原 v1 的最大成本是「自建数据层」。现在可以整段砍掉。

```
gmgn-cli（官方数据+执行）
        │
        ▼
  你的筛选器（唯一的差异化）──▶ SQLite（记录一切）
        │
        ▼
   Telegram 推送（附 GMGN 链接 + 一键买）
        │
        ▼
  gmgn-cli swap + strategy（自动 TP/SL）
```

### Day 1 · 打通数据（4~6 小时）
1. 去 <https://gmgn.ai/ai> 申请 API Key（先确认价格；不确定就先用 demo key 开发）
2. `npx skills add GMGNAI/gmgn-skills` 或 `npm i -g gmgn-cli`
3. 写一个 30 秒轮询脚本，把三份数据落 SQLite：
   - `market rank --chain sol --interval 5m`
   - `trenches --chain sol`
   - `token_signal`（聪明钱集群买入 / 暴涨）
4. 验收：库里每小时有 200+ 条候选，能画出「新币存活曲线」

### Day 2 · 筛选器（核心，4~8 小时）
一个打分函数，输入一个 mint，输出 0~100 分。起步规则（阈值先用我的，之后用数据调）：

| 维度 | 规则 | 理由 |
|---|---|---|
| 安全 | `is_honeypot=0`、`buy_tax=sell_tax=0`、`renounced_mint=true`、`burn_status=burn` | 硬门槛，不满足直接丢 |
| 集中度 | `top_10_holder_rate < 0.25` | 防砸盘 |
| Dev | `dev_hold_rate < 5%` 且 Dev 历史无跑路 | 防出货 |
| 流动性 | `liquidity > $15k` | 保证卖得掉 |
| 动量 | `buys/sells > 1.5`（5m）+ `holder_count` 快速增长 | 有人真在买 |
| 聪明钱 | `smart_degen_count >= 2` 或 KOL 持仓 | 跟聪明钱 |
| 阶段 | `mcap < $500k` 且 `age < 30min` | 早期才有赔率 |

验收：每天推送 **5~20 个**，而不是 500 个。宁缺毋滥。

### Day 3 · 推送 + 执行（4~6 小时）
1. TG Bot 推送：币名 / 评分 / 通过的原因 / GMGN 链接 / 一键买按钮
2. 手动确认后调 `swap`，同时挂 `strategy`：
   ```json
   [{"order_type":"profit_stop","side":"sell","price_scale":"100","sell_ratio":"50"},
    {"order_type":"profit_stop","side":"sell","price_scale":"300","sell_ratio":"50"},
    {"order_type":"loss_stop","side":"sell","price_scale":"50","sell_ratio":"100"}]
   ```
   （+100% 卖一半、+300% 卖一半、-50% 清仓）
3. 从这一刻起，**纪律由代码执行，不由你的情绪执行**

### 之后 2 周：影子验证（$0）
不投钱，只记录：每条推送在 5m/1h/24h 后的价格。
2 周后你会得到一个残酷但值钱的数字：**你的筛选器到底有没有正期望**。
- 有 → 上小资金（$100~300），单笔 0.05 SOL
- 没有 → 停止，你已经省下了 $500 学费

---

## 五、关于「快速翻倍」的数学（请认真读）

meme 币的赔率结构是：**大多数归零，极少数 10 倍**。所以策略不是「找会翻倍的币」（没人能预测），而是：

> **用固定小注，买很多次低概率高赔率的机会，让 1~2 次大赢覆盖所有小亏。**

一个能赚钱的组合长这样（假设每笔 0.1 SOL，10 笔）：

| 结果 | 笔数 | 单笔收益 | 小计 |
|---|---|---|---|
| 5x | 1 | +0.4 | +0.4 |
| 2x | 2 | +0.1 | +0.2 |
| 1.5x | 1 | +0.05 | +0.05 |
| -50% | 3 | -0.05 | -0.15 |
| -80% | 3 | -0.08 | -0.24 |
| **合计** | 10 | | **+0.26 SOL（+26%）** |

注意几个反直觉的点：

1. **胜率只要 40% 就能赚钱**，前提是赔率结构对。
2. **止损必须硬**。-80% 的那 3 笔，如果没有止损会变成 -0.3，直接吃掉全部利润。
3. **止盈必须让利润跑**。第一笔 5x 卖出太早，整个模型就崩了——这正是要用移动止盈的原因。
4. **单笔必须小**。0.1 SOL 亏光不心疼，才能拿住 10 笔不被情绪打断。

**如果你做不到「单笔小、止损硬、不追高」，任何系统都救不了你。** 这是这套方案里唯一没法用代码解决的问题。

---

## 六、避坑清单

- ❌ 买「GMGN 源码」/「稳赚机器人」——99% 是木马或收钱跑路
- ❌ 把私钥粘进任何 GitHub 下载的 bot
- ❌ 用主钱包交易（`gmgn-cli` 私钥是明文存储）
- ❌ 上来就做自动全仓梭哈——先手动确认 2 周
- ❌ 追已经涨了 10 倍的币（此时赔率已经反过来）
- ❌ 同时开 5 个以上仓位（你会看不过来，且手续费吃掉利润）
- ❌ 借钱/加杠杆
- ⚠️ 中国境内：虚拟货币交易相关活动存在法律风险，自行评估（本方案只做技术讨论）

---

## 七、下一步

我现在可以直接开始写 Day 1 + Day 2 的代码（TypeScript，单体，跑在你自己机器上）。需要你确认两件事：

1. **GMGN API 计费**：去 <https://gmgn.ai/ai> 登录看一下价格。如果按次收费很贵 → 退回 v1 的免费源自建方案。
2. **什么时候开始**：确认后我就把「数据采集 + 打分 + TG 推送」写出来，你只需要填 API Key。

> 说明：v1 文档里的自建方案（PumpPortal + Helius + Jupiter）没有作废，它是 GMGN API 不可用/太贵时的 Plan B，代码结构可以复用。
