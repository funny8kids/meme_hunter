# 核心引擎设计（v1）

> 目标：一个**可重放、可对账、不可双花**的交易引擎。实盘和回测跑同一份代码。
> 技术底座：Node 24 原生跑 TypeScript（`node src/engine/engine.ts`），零构建、零依赖。
> 设计原则：宁可少功能，不可少确定性。

---

## 0. 五条不变量（先立规矩）

后面所有设计都从这五条推导出来。违反任何一条的代码不合并。

| # | 不变量 | 违反的后果 | 强制手段 |
|---|---|---|---|
| **I1** | **单一写入者**：所有状态变更只经由追加式事件日志，`seq` 严格单调 | 状态分叉、无法重放 | 只有 `Log.append()` 能改状态；其他模块只读 |
| **I2** | **一切可重放**：同一事件流 + 同一策略版本 + 同一随机种子 ⇒ 同一决策序列 | 回测骗自己 | 禁止裸 `Date.now()` / `Math.random()`，必须注入 |
| **I3** | **订单效果至多一次**：每个 intent 有唯一 id，重启后按链上签名对账 | 重复买入 / 重复卖出 | 签名先落库再发送；启动必对账 |
| **I4** | **热路径不阻塞**：任何慢操作进有界队列，溢出策略显式且可观测 | 行情高峰丢数据/卡死 | 队列有容量上限 + 溢出计数器 |
| **I5** | **风险先于执行**：未过前置检查的 intent 进不了执行平面；停机开关是**文件**不是内存变量 | 一次故障亏光 | `data/HALT` 存在即拒绝一切下单 |

---

## 1. 借鉴的五个工程范式

不是名词堆砌，每条都对应上面的不变量。

| 范式 | 出处 | 在本项目怎么用 |
|---|---|---|
| **单写入者 + 环形缓冲**（无锁机械同情） | LMAX Disruptor / 交易所网关 | 事件日志只由一个主循环写入；下游全是只读消费者 |
| **事件溯源 + 投影** | Kleppmann / CQRS | `events` 是唯一真相；`tokens`/`trades`/`positions` 都是投影，可随时重建 |
| **Crash-only software** | Candea & Fox | 不做优雅关闭的复杂逻辑，**重启即恢复**；恢复路径就是正常路径，天天走 |
| **确定性模拟测试** | FoundationDB | 录一段真实行情，重放必须得到逐字节一致的决策序列（golden replay） |
| **账本 + 对账** | 支付系统（Stripe/银行核心） | 仓位是账本，链上余额是外部对账单；两者不平就是事故，必须告警 |

外加一条来自交易的：**归因优先**（Renaissance 风格）——每一分 PnL 都要能追到「哪条规则、哪个参数版本」。

---

## 2. 总体架构：一个入口，多个读者

```
 Solana WS ──┐
 PumpPortal ─┼──▶ Decoder ──▶ Normalizer ──▶ ┌──────────────────────┐
 RPC/REST  ──┘   (纯函数)     (统一模型)      │  EVENT LOG (append)  │
                                              │  seq 单调 / 版本化    │
                                              └──────────┬───────────┘
                                                         │ 广播（只读）
                    ┌────────────────┬───────────────────┼──────────────────┬─────────────┐
                    ▼                ▼                   ▼                  ▼             ▼
              Features(流式)      Scorer/信号         Persist(批量)      Replay/回测    Metrics
                    │                │                   │
                    ▼                ▼                   ▼
              Signal ──▶ Risk ──▶ OrderIntent ──▶ Executor ──▶ Venue(pump/Jupiter)
                                                         │
                                                         ▼
                                              Fill/Confirm ──▶ 回到 EVENT LOG
```

**关键**：下游**不读 socket，只读日志**。这样采集断了不影响决策一致性，回放也能完整重现。

---

## 3. 事件模型

每条事件统一信封：

```ts
type Envelope<T> = {
  seq: number;        // 单调递增，唯一真相的坐标
  tsWall: number;     // 事件时间（链上/消息时间，ms）
  tsMono: number;     // 处理时间（单调时钟，用于延迟度量）
  v: number;          // schema 版本，配 upcaster
  type: string;
  payload: T;
};
```

事件目录（v1）：

| 事件 | 关键字段 | 生产者 |
|---|---|---|
| `TokenCreated` | mint, creator, devBuySol, mcapSol, vSol, vTokens, pool, uri | ingest |
| `Trade` | mint, side, wallet, sol, tokens, vSol, vTokens, sig | trades |
| `Migrated` | mint, pool | ingest |
| `PoolSnapshot` | mint, priceUsd, liquidityUsd, source | enrich |
| `FeatureTick` | mint, version, values{} | features |
| `Signal` | mint, score, tier, evidence[], strategyVersion | scorer |
| `OrderIntent` | id, mint, side, sol, maxSlipBps, reason, ttlMs | strategy |
| `OrderSubmitted` | id, sig, venue | executor |
| `OrderConfirmed` | id, sig, filledTokens, avgPrice, feeSol, slot | executor |
| `OrderFailed` | id, reason, retryable | executor |
| `PositionOpened` | mint, qty, costSol, entryPrice, intentId | portfolio |
| `PositionClosed` | mint, qty, proceedsSol, pnlSol, reason | portfolio |
| `RiskHalt` | reason, scope, until | risk |

**版本化**：`v` 只增不改。老事件用 `upcasters[v]` 函数转换，**绝不改动历史事件的含义**。

**幂等键**：`intentId = ${mint}:${side}:${signalSeq}`；重试用同一个 id，最多 3 次。

---

## 4. 热度分层与背压（I4）

| 队列 | 容量 | 溢出策略 | 理由 |
|---|---|---|---|
| ingress → log | 8,192 | 短暂阻塞 1ms，仍满则丢弃并计数 | 保护内存，丢的是行情不是钱 |
| log → features | 65,536 | 丢最旧 | 特征滞后本身就无意义 |
| log → persist | 262,144 | 溢出写 `data/overflow/*.ndjson` | **数据不能丢**，性能可以降 |
| signal → exec | 256 | 拒绝新 intent | 执行必须背压，不能排队到天荒地老 |
| exec → venue | 32 | 阻塞 | 交易不可丢，宁可慢 |

**规则**：任何 `push` 都必须有容量、有策略、有计数器。没有计数器的队列 = 隐形炸弹。

---

## 5. 订单状态机与崩溃恢复（I3）

```
                 ┌──────────┐
                 │  INTENT  │  ← 已过 Risk，已落库
                 └────┬─────┘
                      │ 构建 + 签名
                      ▼
                 ┌──────────┐
                 │  SIGNED  │  ← 签名已落库（关键：先落库再发）
                 └────┬─────┘
                      │ sendRawTransaction
                      ▼
                 ┌──────────┐
        ┌────────│SUBMITTED │────────┐
        │        └────┬─────┘        │
   超时/错误           │ 确认           │ 明确失败
        ▼              ▼              ▼
  ┌───────────┐  ┌───────────┐  ┌──────────┐
  │ RECONCILE │  │ CONFIRMED │  │  FAILED  │──retry≤3──▶ INTENT
  └─────┬─────┘  └─────┬─────┘  └──────────┘
        │              │
   查链上状态           ▼
        │        ┌───────────┐
        └───────▶│ POSITION  │
                 └───────────┘
```

**恢复算法**（进程启动第一件事，无条件执行）：

1. 读 `orders` 中状态 ∈ {SIGNED, SUBMITTED} 的记录。
2. 逐条 `getSignatureStatuses`。
3. 已确认 → 补 `OrderConfirmed` + `PositionOpened`。
4. 明确失败 → `OrderFailed`。
5. 查不到（expired/unknown）→ 标 `UNKNOWN`，再查钱包余额差。
6. 余额有、无对应仓位 → **孤儿仓**，按配置 `adopt`（接管并标记来源未知）或 `flatten`（立即市价卖出）。
7. 仓位有、余额无 → 标记 `closed_unknown_exit` 并告警。

> 只有走完 7 步，引擎才允许接受新信号。启动阶段默认 `HALT`。

---

## 6. 时钟与场所抽象（I2 的核心）

```ts
export interface Clock {
  now(): number;                       // 事件时间
  mono(): number;                      // 单调时间
  timer(ms: number, fn: () => void): () => void;
}

export interface Venue {
  quote(req: QuoteReq): Promise<Quote>;          // 预估产出
  submit(intent: OrderIntent): Promise<Ack>;     // 返回签名
  confirm(sig: string, timeoutMs: number): Promise<Fill | null>;
  position(mint: string): Promise<bigint>;
  balances(): Promise<Map<string, bigint>>;
}
```

三个实现：

| 实现 | 时钟 | 成交 | 用途 |
|---|---|---|---|
| `LiveVenue` | `SystemClock` | pump 直连 / Jupiter | 实盘 |
| `PaperVenue` | `ReplayClock` | 用下一个 `Trade` 事件的价格 + 模型化滑点/费 | 回测 & 影子盘 |
| `ReplayVenue` | `ReplayClock` | 按历史真实成交价（保守取 worst） | 事后复盘 |

**策略代码里不允许出现** `Date.now()`、`Math.random()`、`fetch`。全部走注入。这条用 ESLint 或 CI grep 强制。

---

## 7. 特征：流式、O(1)、可解释

每个 mint 一个状态对象，随事件增量更新（不是每 5 秒跑 SQL）：

| 特征 | 计算 | 用途 |
|---|---|---|
| `ageSec` / `mcapSol` / `vSolPct` | 直接取 | 阶段判断 |
| `buySellRatio5m` | 环形缓冲计数 | 动量 |
| `uniqueBuyers5m` | Set（带 TTL 上限） | 真实需求 |
| `solVolume5m` | 累加 + EWMA | 热度 |
| `volumeZ` | 相对同类 launchpad 基线 | 异常放量 |
| `devHeldPct` | 创建者买入 − 创建者卖出 | 跑路风险 |
| `priceImpact` | Δprice/Δsol | 流动性代理 |
| `topBuyerShare` | 买家集中度（近似） | 砸盘风险 |
| `staleMs` | 距最后一次成交 | 停牌/死亡检测 |

> 这些全部可以只靠 `Trade` 事件算出来，**不额外花 RPC**。

---

## 8. 评分与归因

```ts
type Rule = {
  id: string;
  weight: number;
  veto?: boolean;                          // 一票否决
  test: (f: Features) => boolean | number;
};
```

- `score = Σ weight × test(f)`，`veto` 规则不通过直接淘汰。
- 每条 `Signal` 带 `evidence: string[]`（命中了哪些 rule id）。
- 每天出报表：**按 rule 统计命中后的平均峰值倍数、胜率、期望值**。
- 这一步是唯一能告诉你「哪条规则真的有用」的机制。

参数版本化：`strategyVersion = hash(params)`，写进每笔 `Signal`。三个月后能回答「v7 比 v6 好多少」。

---

## 9. 风控

**前置（同步，必过）**
1. `data/HALT` 不存在
2. 币不在黑名单
3. 最后一次成交距今 < 5s
4. `quote.expectedOut` 与模型价偏差 < 15%（防价格源打架）
5. 并发持仓 < 3
6. 单币敞口 < 25% 总资金
7. 当日亏损 > 15% → 自动写 `HALT`

**后置（异步监控）**
- 价格陈旧 > 10s → 标记 `stale`，止盈止损暂停（避免用脏价成交）
- 单仓回撤触发移动止损
- 全仓熔断

> `HALT` 是文件，不是变量：外部 `touch data/HALT` 立刻生效，进程崩了也生效。

---

## 10. 可观测性

| 指标 | 目标 | 采集点 |
|---|---|---|
| ingest lag p99 | < 2s | `tsWall` vs 链上时间 |
| decision latency p99 | < 50ms | `Trade` → `Signal` |
| persist queue depth | < 10k | gauge |
| fill rate | > 90% / 30s | orders |
| duplicate fill | **0** | intent 去重表 |
| restart reconcile | 100% | 启动自检 |
| 心跳 | 每 10s 写文件，5min 未更新告警 | 独立于主循环 |

审计：`decisions` 表永久保留（每笔信号、每个 veto、每次拒绝的原因）。这是复盘和归因的原料。

---

## 11. 存储分层

| 层 | 内容 | 保留 | 介质 |
|---|---|---|---|
| L0 日志 | `events` | 7 天 | SQLite（WAL） |
| L1 明细 | `trades` | 48h | SQLite |
| L2 聚合 | `candles` (5s→1m) | 永久 | SQLite |
| L3 事实 | orders / positions / signals / decisions | 永久 | SQLite |
| L4 冷备 | 每日 `sqlite3 .backup` | 30 天 | 本地压缩 |

估算：L1 约 200~300 MB/天，靠 L2 降采样控制总量。

---

## 12. 目录与模块边界

```
src/
  engine/
    types.ts        # 事件与接口（唯一类型来源）
    clock.ts        # SystemClock / ReplayClock
    log.ts          # append-only + seq + upcaster
    bus.ts          # 有界队列（容量/策略/计数强制）
    engine.ts       # 主循环（唯一写入者）
    features.ts     # 流式特征
    scorer.ts       # 规则引擎 + 证据
    risk.ts         # 前置检查 + 熔断
    portfolio.ts    # 仓位账本
    reconcile.ts    # 启动对账
    venue/
      paper.ts
      pump.ts
      jupiter.ts
    metrics.ts
    backtestcore.ts # 可复用的回测内核（延迟/滑点/死币折价）
    stats.ts        # bootstrap / FDR 等验证统计
  server.mjs        # A1 适配层（/v1/*）+ 静态终端
  validate.ts       # 严苛验证器（walk-forward + 压力 + FDR）
  ingest.mjs        # 已有
  trades.mjs        # 已有
web/                # 零构建终端（index.html / style.css / app.js）
```

**边界规则**：`venue/` 之外不允许构造交易；`engine.ts` 之外不允许 append；`features.ts` 纯函数，无 IO。

---

## 13. 构建顺序（每步都可独立验收）

| 步 | 内容 | 验收 | 估时 |
|---|---|---|---|
| **S1** | `types` + `log` + `bus` + 回放骨架 | 录 10 分钟真实行情，重放两次得到**逐字节相同**的决策序列 | 1 天 |
| **S2** | `features` + `scorer` + `decisions` 落库 | 每个币的特征可复现；规则命中率报表可出 | 1 天 |
| **S3** | `PaperVenue` + 回测报告 | 出「过去 7 天按规则买卖」的净值曲线 + 逐条归因 | 1 天 |
| **S4** | `risk` + `HALT` + 指标 | 手工触发熔断；压测队列不丢数据 | 0.5 天 |
| **S5** | `pump.ts` + `jupiter.ts` + 订单状态机 | 小额实盘 20 笔，无重复成交，重启对账 100% | 2 天 |
| **S6** | `reconcile` + 告警 | 强杀进程 10 次，每次恢复后仓位与链上一致 | 1 天 |

**先做 S1**：没有确定性回放，后面全是拍脑袋。

---

## 14. 明确不做（防过度工程）

- ❌ 微服务 / K8s / 消息队列（单机 SQLite + 单进程足够）
- ❌ 自建验证节点、gRPC、colocation（延迟不是我们的 edge）
- ❌ 机器学习（先用可解释规则跑出正期望再说）
- ❌ 多链（Solana 先做透）
- ❌ 重前端框架 / SSR（已有一个零构建的只读终端，见 `docs/07-terminal-and-validation.md`）
- ❌ 优雅关闭的复杂逻辑（crash-only，重启即恢复）

---

## 15. 编码约束（CI 强制）

1. 禁止裸 `Date.now()` / `new Date()` / `Math.random()` / `fetch`（必须注入）
2. 所有外部调用必须有超时 + 熔断计数
3. 所有异常必须显式处理，禁止空 `catch`
4. 每个 `queue.push` 必须有容量与溢出策略
5. 每个对外操作必须能回答「重放时会发生什么」
6. 事件 schema 只增不改

---

## 16. 与 A1 的关系

A1（fork gmgn-skills + 适配层）是**展示层**，引擎是**决策层**。二者解耦：

```
CLI/Telegram ──▶ /v1/* ──▶ server.mjs ──▶ 读投影表（tokens/signals/positions）
                                              ▲
                                              │ 由引擎写入
                                         engine.ts
```

A1 可以先用现有采集数据跑起来，引擎并行开发，在 S5 汇合。

---

## 17. 待确认

- [ ] S1 先做，还是先把 A1 做出来用着？
- [ ] `PaperVenue` 的滑点模型：固定 bps，还是按 `priceImpact` 估算（更真实，但更复杂）？
- [ ] 孤儿仓默认 `adopt` 还是 `flatten`？（建议 `flatten`，安全第一）

确认后按 S1 → S6 推进。
