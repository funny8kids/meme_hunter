# 运行手册

> 全部零构建：Node ≥ 22.5 直接跑 `.ts` / `.mjs`。唯一外部依赖是 `@solana/web3.js`（签名与 RPC）。

---

## 0. 一次性准备

```bash
cd Meme_Hunter
npm install                      # 只装 @solana/web3.js
npm install --prefix vendor/gmgn-skills && npm run --prefix vendor/gmgn-skills build
```

---

## 1. 采集（先跑，积累数据）

```bash
npm run ingest      # PumpPortal：新币 + 迁移
npm run trades      # Solana logsSubscribe：全量成交（Anchor 解码）
```

生产环境换 Helius 免费端点：

```bash
RPC_WS="wss://atlas-mainnet.helius-rpc.com/?api-key=XXX" npm run trades
```

验收：`data/meme.db` 里 `tokens` / `trades` 持续增长。

---

## 2. 回测（决定要不要投钱）

```bash
npm run backtest -- --db data/meme.db      # 真实数据
npm run backtest:demo                      # 合成数据，仅自检
```

输出：胜率 / 盈亏比 / 最大回撤 / 每条规则的贡献。报告落在 `data/reports/`。

> **先跑满 7 天再下结论。** 数据不足时平仓数会是 0。

### 2.1 情报 / K线 / 钱包画像

```bash
npm run enrich -- --limit 30          # 安全 / holders / Dev / 社交 / DEX
npm run enrich -- --mints <mint>
npm run candles                       # 1m K线增量
npm run wallets2                      # OOS 钱包画像
```

采集总控会自动拉起 candles worker。

### 2.2 严苛验证（决定能不能投钱）

```bash
npm run validate:quick     # 小网格，快速自检
npm run validate           # 4 折 walk-forward + 成本/延迟压力 + bootstrap + FDR
```

报告落在 `data/reports/validation-latest.json`，前端「策略验证」页直接读取。
验证内容包括：数据审计、样本外折、成本/延迟压力、死币折价、cluster bootstrap、
随机入场基线、参数平原、规则 BH-FDR。

判定：`INSUFFICIENT_DATA` / `NO_GO` / `PAPER_ONLY` / `GO_LIVE`。
**只有 `GO_LIVE` 才允许考虑极小资金实盘。**

> 详细方法与当前数据结论见 `docs/07-terminal-and-validation.md`。

---

## 3. 本地 API（GMGN 接口形状 + 控制台）

```bash
npm run server -- --port 8787 --db data/meme.db
```

| 路由 | 说明 |
|---|---|
| `GET /v1/overview` | 终端首屏：KPI、市场汇总、持仓估值、验证结论 |
| `GET /v1/market/rank` | 榜单（1m/5m/1h/24h 涨跌、sparkline、排序/搜索） |
| `GET/POST /v1/trenches` | 新创建/临近毕业/已毕业 |
| `GET /v1/token/info` | 代币信息 + 1h 统计 |
| `GET /v1/token/security` | 安全（未知字段返回 null，不伪造 0） |
| `GET /v1/market/token_kline` | K 线 |
| `GET /v1/token/trades` | 最近成交 |
| `GET /v1/signals` | 信号 + 代币元数据 |
| `GET /v1/positions` | 持仓 + 当前市值/浮盈亏 |
| `GET /v1/validation/latest` | 验证报告（`?compact=1` 摘要） |
| `GET /v1/strategy` | 规则集 / 权重 / 版本 |
| `GET /v1/search` | 代币/合约搜索 |
| `GET /v1/token/risk` | 安全 / Top20 holders / Dev / 社交 |
| `GET /v1/wallets` / `GET /v1/wallet` | OOS 钱包画像 / 详情 |
| `GET /v1/alerts` | 最近信号 / 迁移 / 高危 |
| `GET /v1/console/status` / `jobs` / `job` | 控制台状态 / 任务 / 日志 |
| `POST /v1/console/action` | 验证/情报/K线/钱包/分析/HALT/纸面 runner |
| `GET /v1/stream` | SSE 实时事件 |
| `GET /v1/trade/quote` | Jupiter 报价转发 |
| `GET /metrics` `GET /health` | 指标 / 健康检查 |

前端在 `http://127.0.0.1:8787/`，包含 终端 / 钱包 / 验证 / 控制台。
设计说明见 `docs/07-terminal-and-validation.md`、`docs/08-intel-console.md`。

---

## 4. CLI（fork 自 gmgn-skills，MIT）

仓库里已克隆并打好补丁：`src/config.ts` 的 host 改成 `process.env.API_BASE`。

```bash
API_BASE=http://127.0.0.1:8787 GMGN_API_KEY=local-dev \
  npm run cli -- market trending --chain sol --interval 1h --limit 3 --raw
```

返回的是你自己库里的数据。

---

## 5. 运行器（纸面 / 实盘）

```bash
# 纸面（默认）：完全不联网、不发单
npm run runner -- --once

# 常驻
npm run runner -- --poll 1500
```

参数：`--size 0.1 --tp 1.0 --sl 0.5 --max-hold-min 30 --db data/meme.db`

实盘：

```bash
export SOLANA_PRIVATE_KEY=<base58 或 JSON 数组>
export RPC_URL=<Helius 端点>
export TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=123
node src/runner.ts --live
```

> 首次实盘务必先 `DRY_RUN=1 node src/runner.ts --live`：会真实构建并签名，但不广播。

---

## 6. 熔断

```bash
touch data/HALT          # 立刻停手（进程重启也有效）
rm data/HALT             # 解除
```

运行器启动时若检测到 HALT 会直接退出码 3。

---

## 7. 测试

```bash
npm test
```

| 套件 | 覆盖 |
|---|---|
| `determinism.test.ts` | 重放逐字节一致、种子注入、seq 单调 |
| `risk.test.ts` | 8 项风控 + 熔断文件 + 指标 |
| `orders.test.ts` | 状态机白名单、幂等、重试上限、启动对账、孤儿仓 |
| `exec.test.ts` | 私钥两种格式、**发送前已落库**、风控拒绝不建单、买卖闭环 |

---

## 8. 目录

```
src/
  ingest.mjs / trades.mjs     采集
  server.mjs                  /v1 适配层
  runner.ts                   运行器
  engine/
    types.ts log.ts bus.ts    事件模型 / 日志 / 有界队列
    engine.ts clock.ts        回放 / 时钟
    features.ts scorer.ts     特征 / 评分
    risk.ts metrics.ts        风控 / 指标
    orders.ts positionstore.ts 状态机 / 持久化
    executor.ts reconcile.ts  执行 / 对账
    venue/{paper,pump,jupiter}.ts
    notify.ts                 Telegram + 心跳
vendor/gmgn-skills/           上游 CLI（MIT，已打补丁）
docs/                         方案与设计
data/                         数据库 / 报告 / HALT
```

---

## 9. 已知边界

- 实盘成交数量目前用**报价估算**，链上真实余额差由 S6 对账纠正。
- `security` 接口未接入 RugCheck，未知字段返回 `null`（刻意不伪造）。
- 运行器 cursor 已持久化到 `data/runner.db`，重启从上次 rowid 续跑。
- 未实现链上条件单：止盈止损依赖进程存活，靠 systemd + 心跳告警兜底。
- 采集器元数据补齐逻辑（`tokens` upsert）需要重启 `collect.mjs` 才生效；历史已丢的元数据无法本地恢复。
- 验证器需要至少 24h 有效成交才能给出初步结论，7 天 + 100 笔平仓才允许 `GO_LIVE`。
