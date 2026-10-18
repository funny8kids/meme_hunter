# 01 · 系统总览

## 1. 这是什么

Meme Hunter 是一个自托管的 Solana meme 研究、验证和受控执行系统。

它不是“预测下一个百倍币”的工具，而是一个回答下面问题的系统：

> **这个策略在真实成本、滑点、延迟和尾部风险之后，是否仍然有正期望？**

## 2. 数据流

```text
Pump.fun creators / trades / migrations
DEX snapshots (DexScreener)
Security / holders / dev / social
Wallet trades + profiles
        ↓
SQLite (WAL)
        ↓
1m candles + features
        ↓
v1 / v2 / crash / wallet / DEX research
        ↓
walk-forward + cost stress + bootstrap + FDR
        ↓
forward shadow（独立 SQLite）
        ↓
LIVE GATE
        ↓
PumpVenue / JupiterVenue
        ↓
actual fill + reconcile
```

## 3. 执行阶段

| 阶段 | 是否吃资金 | 用途 |
|---|---|---|
| OBSERVE | 否 | 发现、告警、研究 |
| PAPER | 否 | 纸面 runner |
| SHADOW | 否 | forward 前瞻样本 |
| LIVE | 是 | 受门禁控制的真实交易 |

当前处于 **OBSERVE / PAPER / SHADOW**，LIVE 锁定。

## 4. 当前数据

| 指标 | 约值 |
|---|---:|
| Tokens | 17k |
| Trades | 815k |
| 有效成交 | 5h |
| DEX snapshots | 8k |
| Wallet profiles | 45k |
| Risk records | 700+ |

## 5. 当前结果

- 全样本实验：**0/12 正期望**
- crash walk-forward：**-0.0041 SOL/笔**，PF **0.54**
- crash 95% CI：**[-0.0068, -0.0012]**
- shadow 合计：约 **-2 SOL**
- 剔除最好一笔后，全部策略毛期望为负

## 6. 结论

> **当前没有可实盘的正期望候选。**

下一步应优先补：

1. 迁移后 DEX 逐笔成交 / K 线；
2. 钱包类型学与 copyability 验证；
3. 真实小额主网成交对比；
4. 组合级风控与 live vs shadow 对比。

详见：

- [核心引擎](design/core-engine.md)
- [终端与验证](design/terminal-and-validation.md)
- [实盘接入](operations/live-trading.md)
- [真实钱包差距](10-real-wallet-gap.md)
