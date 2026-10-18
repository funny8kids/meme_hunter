# 10 · 距离真实钱包 / 真实资金还差什么

> 当前系统是 **Solana-only** 研究/执行系统。  
> LIVE 仍然锁定；没有通过验证的候选，不应接真实资金。

---

## 0. 先纠正一个关键点：MetaMask 不是 Solana 钱包

| 钱包 | 链 | 对本项目 |
|---|---|---|
| **Phantom** | Solana + EVM | 可作为 Solana 浏览器钱包；手动签名可用 |
| **Solflare / Backpack** | Solana | 同类 |
| **MetaMask** | EVM（Ethereum / BSC / Base 等） | **不能直接签 Solana 交易** |
| MetaMask Snaps | 插件扩展 | 不是当前自动 runner 的可靠方案 |

如果你要接 **MetaMask 真钱**，那不是“接一个钱包”，而是：

> **新增一条 EVM 链的数据、DEX、策略、执行、对账和风控体系。**

这和当前 Solana 系统是两套产品。

---

## 1. 当前已经有什么

```text
src/engine/wallet.ts          从 SOLANA_PRIVATE_KEY 加载 keypair
src/engine/venue/pump.ts      pump.fun 曲线执行
src/engine/venue/jupiter.ts   迁移后 Jupiter 执行
src/live/router.ts            pump → Jupiter 路由
src/live/fill.ts              tx meta 实际成交解析
src/engine/executor.ts        风控 → 落库 → 签名 → 发送 → 确认
src/engine/reconcile.ts       账本 vs 链上对账
src/reconcile-live.ts         实盘启动对账
src/runner.ts                 paper / live runner + live gate
web/index.html#live           LIVE GATE / 钱包 / 对账 / Forward Equity
```

当前 live gate 必须同时满足：

1. `ALLOW_LIVE=1`
2. `DRY_RUN=0`
3. `RPC_URL` 已配置
4. `SOLANA_PRIVATE_KEY` 已配置
5. v1 验证为 `GO_LIVE`
6. crash OOS 为 `GO_LIVE`
7. 启动对账通过（`reconcile:live`）

任一失败：`exit 3`。

---

## 2. 真实接入的五种方式

### A. 只读 Phantom / Solflare 地址

- 只接 `SOLANA_PUBLIC_KEY`；
- 展示余额、持仓、PnL；
- 不签名、不交易。

**当前可实现，风险最低。**

### B. 浏览器 Phantom 手动签名

需要新增：

- `@solana/wallet-adapter` / Phantom provider；
- 前端连接钱包；
- 后端构建**未签名交易**；
- 用户在 Phantom 中确认；
- 后端提交并确认；
- 交易结果回写。

适合：

- 人工确认每一笔；
- 验证真实成交；
- 不适合全自动 runner。

**当前未实现。**

### C. 专用 Solana 热钱包（当前代码路径）

```bash
SOLANA_PRIVATE_KEY=...
RPC_URL=...
DRY_RUN=0
ALLOW_LIVE=1
node src/runner.ts --live --once
```

- 当前 `wallet.ts` 支持 base58 / JSON 数组；
- `PumpVenue` / `JupiterVenue` 可构建、签名、发送；
- `Executor` 已接入实际成交解析；
- 但**没有经过主网真实资金验证**。

适合：

- 极小资金；
- 受控测试。

不适合：

- 大资金；
- 长期无人值守。

### D. 远程签名 / 托管

- Turnkey / Fireblocks / Privy 等；
- 业务服务器只发 intent；
- 签名服务校验：
  - 最大 SOL；
  - 允许的 mint；
  - 允许的 program；
  - 每日限额；
- 私钥不落在业务服务器。

适合：

- 全自动；
- 放大资金。

**当前未实现。**

### E. MetaMask（EVM）

- 需要新增 EVM 链、DEX、token、RPC、gas、nonce、EIP-1559、MEV；
- 与当前 Solana 代码不兼容。

**不建议在当前阶段做。**

---

## 3. 当前真实资金缺口清单

| 能力 | 状态 | 缺口 |
|---|---|---|
| Solana keypair 加载 | ✅ | 需要 secret manager / 权限 |
| pump.fun 执行 | ⚠️ | 未主网实测、无 Jito、无 simulate |
| Jupiter 执行 | ⚠️ | lite-api、无真实路由/失败回退 |
| pump → Jupiter 路由 | ⚠️ | 已接，未实测 |
| 实际成交解析 | ⚠️ | 代码/测试有，未主网验证 |
| 启动对账 | ⚠️ | 命令有，未真实钱包跑过 |
| 卖出路径 | ❌/⚠️ | token decimals、ATA、WSOL、失败重试未验证 |
| 动态优先费 | ❌ | 固定参数 |
| Jito / MEV | ❌ | 未接 |
| simulateTransaction | ❌ | 未接 |
| Phantom 浏览器连接 | ❌ | 未接 wallet-adapter |
| MetaMask / EVM | ❌ | 不支持 |
| 连续对账 | ⚠️ | 仅启动/手动 |
| 日亏 / 回撤熔断 | ⚠️ | 有 HALT，缺自动 live 熔断 |
| 同 Dev/叙事集群敞口 | ❌ | 未做 |
| live vs shadow | ⚠️ | 页面有 shadow，实盘对比未跑 |
| 真实策略 edge | ❌ | 当前无正期望 |

---

## 4. 工程完成度（粗略）

| 层 | 完成度 | 说明 |
|---|---:|---|
| 数据采集 | 70% | pump 完整；DEX 只有快照，缺逐笔 |
| 安全/钱包情报 | 45% | 覆盖低；钱包样本短 |
| 策略验证 | 80% | 工具完整；缺正向候选 |
| 执行适配 | 45% | venue/fill 有；未主网验证 |
| 对账 | 55% | 启动对账有；未持续运行 |
| 钱包 UX | 20% | 只有 public key 展示；无 Phantom 连接 |
| 风控/运维 | 75% | HALT/systemd/live gate 有；缺自动熔断 |
| 真实盈利证据 | **0%** | 没有通过 GO_LIVE 的候选 |

> 钱包接入只是最后 10%；真正难的是数据、执行一致性、成本和 edge。

---

## 5. 推荐上线顺序

### Phase 0：只读

- 配置 `SOLANA_PUBLIC_KEY`；
- 页面展示余额/持仓；
- 不签名。

### Phase 1：Phantom 手动签名

- 接入 wallet-adapter；
- 后端返回未签名交易；
- 用户确认；
- 验证买入/卖出/ATA/WSOL。

### Phase 2：专用热钱包 dry-run

- `DRY_RUN=1`；
- 构建 + 签名，不广播；
- 验证 simulate / fill / reconcile。

### Phase 3：主网极小资金

- 专用热钱包；
- 0.01–0.02 SOL；
- 1 买 1 卖；
- 人工核对实际成交。

### Phase 4：10–50 笔

- 对比 live vs shadow；
- 失败率、滑点、卖出成功率；
- 不达标停止。

### Phase 5：远程签名 + 放大

- 远程 signer；
- 交易策略白名单；
- 每日限额；
- 多策略资金分配。

---

## 6. 私钥怎么放

### 最小可行（仅小额）

```bash
chmod 600 ~/.config/meme-hunter/live.env
```

systemd：

```ini
EnvironmentFile=/home/dominic-jamil/.config/meme-hunter/live.env
```

### 不建议

- 提交到 Git；
- 放前端；
- 发聊天；
- 放 server 进程；
- 用主钱包；
- 用 Phantom 助记词。

### 推荐

- 专用热钱包；
- 远程 signer / HSM；
- 交易白名单 + 限额；
- 每日归集利润；
- 私钥轮换。

---

## 7. 结论

### 接 Phantom 真钱

**可以，但需要先决定：**

- 手动签名 → 接 wallet-adapter；
- 自动 runner → 用专用 keypair / 远程 signer，不是 Phantom 浏览器自动签。

### 接 MetaMask 真钱

**当前系统不支持**。  
MetaMask 是 EVM；要做 MetaMask，需要另建 EVM 数据/执行/风控层。

### 最重要的现实

> 钱包接入不会让负期望变正。  
> 当前所有候选剔除最好一笔后毛期望为负；在这些数字改变之前，真实资金不应该接入。

下一步：

1. 不接 MetaMask；
2. 先做只读 + Phantom 手动签名；
3. 用专用热钱包 dry-run；
4. 等 `GO_LIVE` 通过，再做 0.01 SOL 主网验证；
5. 通过 10–50 笔再放大。
