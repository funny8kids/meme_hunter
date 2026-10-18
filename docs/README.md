# Meme Hunter 文档

> **当前状态：研究系统可运行；没有通过验证的实盘候选；LIVE 锁定。**

## 先看什么

| 顺序 | 文档 | 内容 |
|---:|---|---|
| 1 | [01-overview.md](01-overview.md) | 系统全貌、数据流、当前证据 |
| 2 | [design/core-engine.md](design/core-engine.md) | 特征、评分、回测、执行、风控设计 |
| 3 | [design/terminal-and-validation.md](design/terminal-and-validation.md) | 终端与验证方法 |
| 4 | [operations/runbook.md](operations/runbook.md) | 启动、采集、排障、运维 |
| 5 | [operations/live-trading.md](operations/live-trading.md) | 实盘门禁、RPC、钱包、对账 |
| 6 | [10-real-wallet-gap.md](10-real-wallet-gap.md) | 距 MetaMask / Phantom 真实资金还差什么 |

## 目录结构

```text
docs/
  README.md                     # 本索引
  01-overview.md                # 系统总览
  10-real-wallet-gap.md         # 真实钱包/实盘差距分析
  design/
    core-engine.md              # 核心引擎设计
    terminal-and-validation.md  # 终端与验证
    intel-console.md            # 情报、DEX、控制台
    icon-options.html           # 图标设计对比
  operations/
    runbook.md                  # 运行手册
    live-trading.md             # 实盘接入
  research/
    tools-and-repos.md          # 工具/项目调研
    build-plan.md               # 自建计划
    re-survey.md                # 二次调研
    gmgn-plan.md                # GMGN 类方案（历史）
  assets/                       # README SVG / 截图
```

## 当前证据（摘要）

- 数据：约 17k tokens / 815k trades / 5h 有效成交
- 全样本实验：**0/12 正期望**
- crash OOS：**-0.0041 SOL/笔**，PF **0.54**
- crash bootstrap 95% CI：**[-0.0068, -0.0012]**
- shadow 合计：约 **-2 SOL**
- 所有 shadow 剔除最好一笔后，毛期望仍为负

结论：**当前没有正 edge；不接真实资金。**

## 关键原则

1. 先验证，再执行；
2. 先小额，再放大；
3. 私钥不进入 server / 前端；
4. 未知安全字段保持 `null`；
5. 不用未来函数、不过拟合、不加杠杆；
6. 没有 edge 时，最好的策略是不交易。

## 相关入口

- 根目录 [README](../README.md)
- 前端：`#terminal` / `#wallets` / `#dex` / `#live` / `#validation` / `#console`
- 实盘就绪页：`#live`
