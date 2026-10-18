# 逆向调研结论 + 方案 A（待审核）

> 时间：2026-10-18 · 目标：在「不指定具体目标」的前提下，判断这个赛道有没有值得逆向的东西
> 方法：REA 静态分析 + 直接抓取公开前端产物 + App Store / Play 检索

---

## 一、调研结论：**没有值得逆向的**

一句话：**这个赛道的价值 100% 在服务端，客户端是空壳。** 不是"难逆"，是"逆了也没用"。

---

## 二、证据

### 2.1 GMGN Web（最值得试的一个，已实测）

我把它的公开前端产物全下来了：

```
23 个 JS 文件 / 16.7 MB / 3,606 个模块 / 224 万 AST 节点 / 11,586 条静态发现
```

| 检查项 | 结果 | 含义 |
|---|---|---|
| 压缩 | ✅ 全量 minify（`_app` 单文件 8.7 MB） | 可读性接近 0 |
| Source Map | ❌ **全部 404**（`sourceMappingURL` 有，但 `.map` 不服务） | 拿不到原始源码 |
| 业务字段 | `smart_degen` 228 次、`bundler` 437 次、`sniper` 432 次 | **只是展示字段名** |
| 客户端算分 | ❌ **没有找到任何评分算术逻辑** | 分数是后端算好返回的 |
| 数据来源 | 前端只调 `/api/v1/...`（如 `/api/v1/dex_trades_polling`、`/api/v1/follow/follow_wallet`） | 纯展示层 |

**结论**：你逆出来的东西 = UI 布局 + 接口路径 + 字段名。而接口路径有 Cloudflare + 签名，且他们官方已经把这些接口公开卖 API 了（$290/年）——**逆向一个已经明码标价的东西，收益为负**。

### 2.2 Telegram Bot（Trojan / BONKbot / Bloom / Nova）

**零本地产物。** 你手机上的"客户端"就是 Telegram 本身。所有逻辑在对方服务器，你连字节都拿不到。

唯一能做的是抓 TLS 流量，但那需要中间人证书 + 逆向 Telegram 协议，成本远超收益，且违反服务条款。

### 2.3 移动端

确实有 App：

| App | Bundle ID | 判断 |
|---|---|---|
| GMGN - Meme Track | `io.gracematrix.gmgn` | 薄客户端 |
| pump.fun | `com.batonresearch.pump` | 薄客户端 |
| DEX Screener | `com.dexscreener` | 薄客户端 |

但移动端同样是调用同一套后端。而且本机环境里 APK 镜像站不可用（apkpure 返回空），进一步降低性价比。

> ⚠️ 顺带提醒：iOS 上还有 `GMGN AI`（MECANIZADOS DIAGO SL）这种同名 App，**大概率是山寨**。任何让你导入助记词的"GMGN"客户端都要警惕。

### 2.4 开源项目

已经是源码了，不需要逆向——直接 fork 就行（见上一条回复的许可证表）。

---

## 三、为什么结构性上就逆不到东西

1. **他们的护城河是数据管道 + 钱包聚类**，跑在服务器上，永远不会下发到客户端。
2. **前端越做越薄**是行业趋势（Next.js/React 全变成 RSC + API 调用）。
3. **他们已经在卖 API 了**——说明接口本身不保密，保密的是数据和算力。
4. 真正有价值的链上逻辑（pump.fun 曲线、费率）**本来就是公开的**，IDL/SDK 都有，不需要逆。

**所以：逆向这条路，投入产出比是负的。**

---

## 四、方案 A（请审核）

既然没有可逆的，就回到「fork 合法开源 + 复刻接口形状」。

### A 的目标

得到一个**命令和输出都像 GMGN、数据和执行都是你自己的**系统。

### 为什么 fork 而不是从零写

| | 从零写 | fork gmgn-skills |
|---|---|---|
| 命令设计 | 自己拍脑袋 | 继承 20+ 条已验证命令 |
| 参数格式 | 自己定 | 继承（含 TP/SL 的 `price_scale` 语义） |
| 输出格式 | 自己定 | 继承 `--json` / 表格 |
| AI Agent 可用性 | 无 | 继承 19 个 SKILL.md |
| 工作量 | 3 天 | **半天（A1）** |

### 技术方案

```
┌─────────────────────────────────────────┐
│  vendor/gmgn-skills  (MIT, 保留版权声明)  │
│  ├─ 只改一处：host = process.env.API_BASE │
│  └─ 命令/参数/输出格式完全不动            │
└──────────────────┬──────────────────────┘
                   │ HTTP  /v1/*
                   ▼
┌─────────────────────────────────────────┐
│  src/server.mjs  (我们写的适配层)         │
│  ├─ /v1/market/rank       ← 自己的 DB    │
│  ├─ /v1/trenches          ← 自己的 DB    │
│  ├─ /v1/token/info        ← DB + candles │
│  ├─ /v1/token/security    ← 自建规则+RugCheck │
│  ├─ /v1/market/token_kline← candles      │
│  ├─ /v1/trade/quote       ← Jupiter      │
│  └─ /v1/trade/swap        ← pump 直连/Jupiter │
└──────────────────┬──────────────────────┘
                   ▼
        已有：ingest.mjs / trades.mjs / SQLite
```

### 三个决策点（需要你拍板）

**① 要不要保留 GMGN 的私钥处理？**
→ **不要。** 它把私钥明文存 `~/.config/gmgn/.env`。我们自己写签名，用加密存储。这会破坏与上游的兼容性，但不改会有安全债。

**② A1 还是 A2？**

| 版本 | 范围 | 工作量 | 能做什么 |
|---|---|---|---|
| **A1** | 只读：rank / trenches / token / kline / security | **4~6 小时** | 用命令行看数据、接 Telegram 推送 |
| **A2** | A1 + quote / swap / strategy（TP/SL） | 2~3 天 | 能真下单 |
| **A3** | A2 + 保留 SKILL.md 让 AI Agent 调用 | +1 天 | 自然语言下单 |

**③ 品牌处理**
上游 `SKILL.md` 里全是 GMGN 的链接和文案，需要替换成你自己的。MIT 允许改，但要保留 LICENSE 和版权声明。

### A1 的验收标准

```bash
API_BASE=http://127.0.0.1:8787 node vendor/gmgn-skills/dist/index.js \
  market trending --chain sol --interval 5m --limit 5 --json
```

返回的是**你自己数据库里算出来的**榜单，字段结构与 GMGN 一致。

### 风险

| 风险 | 应对 |
|---|---|
| 上游 CLI 更新，fork 分叉 | 只在 host 处打补丁，其余不动；或做成 patch 文件 |
| 接口语义不完全一致（字段缺失） | 缺的字段返回 `null`，不伪造 |
| 上游 SKILL.md 含 GMGN 品牌 | 全部替换，避免误导 |
| 有人以为这是 GMGN 官方 | 仓库 README 明确标注 fork 来源与 MIT 许可 |

### 我建议的范围

**先做 A1**（半天）。理由：A1 能让你的采集数据立刻"可读"，直接接上 Telegram 推送和人工研究；A2 的交易能力我们本来就要自己写（pump 直连），套不套 CLI 外壳影响不大。

---

## 五、这轮调研的副产品（有用）

1. GMGN 的**字段命名体系**可以直接抄——`smart_degen_count`、`rat_trader_amount_rate`、`bundler_trader_amount_rate`、`sniper_count`、`fresh_wallet_rate`、`suspected_insider_hold_rate`。这套命名是他们的产品抽象，抄命名不侵权，还能让你的数据和任何工具对接。
2. 他们的**信息架构**（Trenches 三栏：新创建/临近毕业/已毕业）值得抄，这套分类确实好用。
3. 确认了 GMGN 没有浏览器插件——所以不存在"完整客户端代码泄露"这种机会。

---

## 六、等你审核

请确认：

- [ ] 接受「不逆向」的结论
- [ ] A1 / A2 / A3 选哪个
- [ ] 私钥策略：自写签名（推荐）还是先沿用上游
- [ ] 是否要保留 SKILL.md（AI Agent 调用）

确认后我就开工。
