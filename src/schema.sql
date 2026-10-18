-- Meme Hunter 数据模型 v0
-- 设计原则：
--   1) 全量轻量落库（create/migration），不花 RPC
--   2) 只有进入候选池的币才做昂贵 enrich（holder/security/dev）
--   3) 成交明细按需订阅，且只保留短周期

CREATE TABLE IF NOT EXISTS tokens (
  mint              TEXT PRIMARY KEY,
  created_at        INTEGER NOT NULL,   -- unix ms（本地接收时间）
  creator           TEXT,               -- traderPublicKey（创建者）
  name              TEXT,
  symbol            TEXT,
  uri               TEXT,               -- metadata JSON
  pool              TEXT,               -- 'pump' / 'bonk' / ...
  initial_buy       REAL,               -- 创建者首买代币数量
  sol_amount        REAL,               -- 首买投入 SOL
  bonding_curve     TEXT,
  market_cap_sol    REAL,               -- 创建时市值（SOL）
  v_sol             REAL,
  v_tokens          REAL,
  is_mayhem         INTEGER DEFAULT 0,
  -- 以下为 enrich 阶段回填
  graduated_at      INTEGER,
  graduated_pool    TEXT,
  top10_rate        REAL,
  dev_hold_rate     REAL,
  liquidity_usd     REAL,
  score             REAL,
  enriched_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tokens_created  ON tokens(created_at);
CREATE INDEX IF NOT EXISTS idx_tokens_creator  ON tokens(creator);
CREATE INDEX IF NOT EXISTS idx_tokens_mcap     ON tokens(market_cap_sol);

CREATE TABLE IF NOT EXISTS trades (
  signature     TEXT NOT NULL,
  mint          TEXT NOT NULL,
  ts            INTEGER NOT NULL,       -- 链上/事件时间
  received_at   INTEGER,                -- 本地接收时间（用于新鲜度，不受链上时钟偏移影响）
  side          TEXT,                   -- buy / sell
  wallet        TEXT,
  sol_amount    REAL,
  token_amount  REAL,
  market_cap_sol REAL,
  v_sol         REAL,
  v_tokens      REAL,
  PRIMARY KEY (signature, mint)
);

CREATE INDEX IF NOT EXISTS idx_trades_mint_ts ON trades(mint, ts);
CREATE INDEX IF NOT EXISTS idx_trades_ts      ON trades(ts);
CREATE INDEX IF NOT EXISTS idx_trades_wallet  ON trades(wallet);
-- received_at 的索引由采集器在 ALTER TABLE 迁移之后创建，避免旧库在 schema 阶段报错。

CREATE TABLE IF NOT EXISTS migrations (
  mint    TEXT PRIMARY KEY,
  ts      INTEGER NOT NULL,
  pool    TEXT
);

-- 钱包画像：由自己的数据回算，不依赖任何付费 API
CREATE TABLE IF NOT EXISTS wallets (
  address        TEXT PRIMARY KEY,
  first_seen     INTEGER,
  trades         INTEGER DEFAULT 0,
  tokens_traded  INTEGER DEFAULT 0,
  wins           INTEGER DEFAULT 0,     -- 买后达到 +100% 的币数
  win_rate       REAL,
  avg_peak_x     REAL,                  -- 平均峰值倍数
  score          REAL,
  updated_at     INTEGER
);

-- 每个币的最终结局（用于标签与回测）
CREATE TABLE IF NOT EXISTS outcomes (
  mint          TEXT PRIMARY KEY,
  price_30s     REAL,
  price_5m      REAL,
  price_1h      REAL,
  price_24h     REAL,
  peak_x        REAL,                   -- 从创建起最大倍数
  peak_at       INTEGER,
  rugged        INTEGER DEFAULT 0,      -- 是否归零/毕业失败
  updated_at    INTEGER
);

-- 采集器/分析器状态（断点续传、健康检查）
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);

-- ---------------------------------------------------------------------------
-- v3：情报层 / 1m K 线 / 钱包 OOS 画像
-- ---------------------------------------------------------------------------

-- 单币安全与链上结构快照（未知字段保持 NULL，不伪造 0）
CREATE TABLE IF NOT EXISTS token_risk (
  mint              TEXT PRIMARY KEY,
  checked_at        INTEGER,
  source            TEXT,
  mint_authority    TEXT,
  freeze_authority  TEXT,
  supply            REAL,
  decimals          INTEGER,
  holder_count      INTEGER,
  top1_rate         REAL,
  top10_rate        REAL,
  lp_burned_pct     REAL,
  honeypot          INTEGER,          -- NULL = 未检测，不是安全
  buy_tax           REAL,
  sell_tax          REAL,
  bundle_rate       REAL,
  first_10s_wallets INTEGER,
  dev_hold_rate     REAL,
  dev_rugged_rate   REAL,
  liquidity_usd     REAL,
  price_usd         REAL,
  fdv_usd           REAL,
  pair_address      TEXT,
  dex_id            TEXT,
  price_change_24h  REAL,
  volume_24h_usd    REAL,
  risk_score        REAL,
  risk_flags        TEXT,             -- JSON string[]
  raw               TEXT              -- JSON
);
CREATE INDEX IF NOT EXISTS idx_token_risk_score ON token_risk(risk_score);
CREATE INDEX IF NOT EXISTS idx_token_risk_checked ON token_risk(checked_at);

-- Top holder 快照
CREATE TABLE IF NOT EXISTS holder_snapshots (
  mint     TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  rank     INTEGER NOT NULL,
  address  TEXT,
  amount   REAL,
  pct      REAL,
  PRIMARY KEY (mint, ts, rank)
);
CREATE INDEX IF NOT EXISTS idx_holder_mint_ts ON holder_snapshots(mint, ts);

-- 社交/元数据（从 token.uri 或第三方解析）
CREATE TABLE IF NOT EXISTS token_social (
  mint        TEXT PRIMARY KEY,
  updated_at  INTEGER,
  twitter     TEXT,
  telegram    TEXT,
  website     TEXT,
  image       TEXT,
  description TEXT,
  raw         TEXT
);

-- Dev（创建者）历史
CREATE TABLE IF NOT EXISTS dev_history (
  creator         TEXT PRIMARY KEY,
  updated_at      INTEGER,
  tokens_created  INTEGER,
  rugged          INTEGER,
  best_peak_x     REAL,
  avg_peak_x      REAL,
  best_mint       TEXT,
  last_created_at INTEGER
);

-- 1 分钟 K 线（服务端排名/图表不再全量扫 trades）
CREATE TABLE IF NOT EXISTS candles_1m (
  mint     TEXT NOT NULL,
  bucket   INTEGER NOT NULL,
  open     REAL,
  high     REAL,
  low      REAL,
  close    REAL,
  volume   REAL,
  buys     INTEGER,
  sells    INTEGER,
  swaps    INTEGER,
  v_sol    REAL,
  v_tokens REAL,
  PRIMARY KEY (mint, bucket)
);
CREATE INDEX IF NOT EXISTS idx_candles_bucket ON candles_1m(bucket);

-- 钱包 OOS 画像 / 标签 / 可复制性
CREATE TABLE IF NOT EXISTS wallet_profiles (
  address          TEXT PRIMARY KEY,
  updated_at       INTEGER,
  window_days      INTEGER,
  trades           INTEGER DEFAULT 0,
  tokens_traded    INTEGER DEFAULT 0,
  buys             INTEGER DEFAULT 0,
  sells            INTEGER DEFAULT 0,
  first_seen       INTEGER,
  last_seen        INTEGER,
  realized_proxy_sol REAL,
  win_rate         REAL,
  avg_peak_x       REAL,
  median_hold_sec  REAL,
  best_peak_x      REAL,
  max_drawdown_pct REAL,
  score            REAL,
  labels           TEXT,             -- JSON string[]
  oos_trades       INTEGER DEFAULT 0,
  oos_win_rate     REAL,
  oos_avg_peak_x   REAL,
  early_buy_rate   REAL,
  copyability      REAL,
  insufficient     INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wallet_profile_score ON wallet_profiles(score);
CREATE INDEX IF NOT EXISTS idx_wallet_profile_copy ON wallet_profiles(copyability);

-- 迁移后 DEX 市场快照（DexScreener）
CREATE TABLE IF NOT EXISTS dex_snapshots (
  mint             TEXT NOT NULL,
  ts               INTEGER NOT NULL,
  pair_address     TEXT,
  dex_id           TEXT,
  price_usd        REAL,
  liquidity_usd    REAL,
  fdv_usd          REAL,
  volume_24h_usd   REAL,
  price_change_24h REAL,
  buys_24h         INTEGER,
  sells_24h        INTEGER,
  raw              TEXT,
  PRIMARY KEY (mint, ts)
);
CREATE INDEX IF NOT EXISTS idx_dex_mint_ts ON dex_snapshots(mint, ts);
CREATE INDEX IF NOT EXISTS idx_dex_ts ON dex_snapshots(ts);
