/* ============================================================
   MEME HUNTER · Solana Terminal
   零框架、零构建：轮询 /v1/*，Canvas 手绘 K 线。
   代码结构：
     1) 工具/格式化
     2) API 与状态
     3) 市场 / 信号 / 持仓 / 成交
     4) 代币详情与图表
     5) 纸面测算 / 验证报告
     6) 搜索、轮询、事件绑定
   ============================================================ */

const $ = (id) => document.getElementById(id);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const state = {
  view: 'terminal',
  marketTab: 'hot',
  interval: '1h',
  sort: 'volume',
  page: 0,
  pageSize: 25,
  rank: [],
  rankTotal: 0,
  trenches: null,
  selected: null,
  selectedSymbol: '',
  info: null,
  security: null,
  kline: [],
  klineMeta: null,
  resolution: '1m',
  chartMode: 'candle',
  chartValue: 'price',
  hoverIndex: null,
  chartGeom: null,
  trades: [],
  signals: [],
  signalTotal: 0,
  signalTier: '',
  intel: null,
  intelTab: 'risk',
  wallets: [],
  walletTotal: 0,
  walletPage: 0,
  walletPageSize: 50,
  walletLabel: '',
  walletSort: 'score',
  walletQuery: '',
  walletMode: 'ranking',
  walletDetail: null,
  console: null,
  consoleJobs: [],
  experiments: null,
  shadow: null,
  live: null,
  liveOrders: [],
  livePositions: [],
  livePerf: null,
  dex: [],
  dexSort: 'liquidity',
  dexError: null,
  railOpen: false,
  smart: [],
  smartSide: '',
  watchlist: (() => { try { return JSON.parse(localStorage.getItem('mh.watchlist') || '[]'); } catch { return []; } })(),
  watchRows: [],
  consoleJob: null,
  events: [],
  stream: null,
  signalRefreshTimer: null,
  positions: [],
  analytics: null,
  validation: null,
  strategy: null,
  overview: null,
  searchTimer: null,
  searchItems: [],
  searchIndex: -1,
  selectSeq: 0,
  inFlight: new Set(),
  errors: new Map(),
  lastKlineKey: '',
};

/* ============================================================
   1) 工具 / 格式化
   ============================================================ */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) >>> 0;
  return h % 360;
}

function fmtInt(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-US');
}

function fmtSol(n, digits = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}k`;
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(digits);
  if (a >= 0.01) return v.toFixed(Math.max(digits, 3));
  if (a === 0) return '0';
  return v.toFixed(4);
}

const SUB_DIGITS = '₀₁₂₃₄₅₆₇₈₉';
function fmtSubscript(n) {
  return String(Math.max(0, Math.floor(n))).split('').map((d) => SUB_DIGITS[Number(d)] ?? d).join('');
}

function fmtPrice(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 0.01) return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  if (v >= 1e-6) return v.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  // 极小价格：0.00000002821 -> 0.0₇2821，比科学计数法更适合扫读
  const [coeff, expRaw] = v.toExponential(4).split('e-');
  const exp = Number(expRaw);
  const digits = coeff.replace('.', '').replace(/0+$/, '') || '1';
  return `0.0${fmtSubscript(Math.max(0, exp - 1))}${digits}`;
}

function fmtPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  if (Math.abs(v) >= 10000) return `${sign}${(v / 1000).toFixed(1)}k%`;
  return `${sign}${v.toFixed(2)}%`;
}

function fmtAge(sec) {
  const v = Number(sec);
  if (!Number.isFinite(v) || v < 0) return '—';
  if (v < 60) return `${Math.floor(v)}s`;
  if (v < 3600) return `${Math.floor(v / 60)}m`;
  if (v < 86400) return `${Math.floor(v / 3600)}h`;
  return `${Math.floor(v / 86400)}d`;
}

function fmtAgeMs(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v)) return '—';
  return fmtAge(v / 1000);
}

function fmtClock(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}`;
}

function fmtTokenAmount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(3)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(2);
}

function safeUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : '';
  } catch {
    return '';
  }
}

function shortAddr(addr, head = 4, tail = 4) {
  const s = String(addr ?? '');
  if (!s) return '—';
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function cls(n) {
  return n > 0 ? 'up' : n < 0 ? 'down' : 'dim';
}

function setText(id, value) {
  const el = $(id);
  if (el && el.textContent !== String(value)) el.textContent = String(value);
}

function setHTML(el, html) {
  if (!el) return;
  if (el.__lastHTML === html) return;
  el.__lastHTML = html;
  el.innerHTML = html;
}

function setHidden(id, hidden) {
  const el = $(id);
  if (el) el.hidden = Boolean(hidden);
}

function toast(message, isError = false) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function throttleError(key, message) {
  const now = Date.now();
  const last = state.errors.get(key) ?? 0;
  if (now - last < 8000) return;
  state.errors.set(key, now);
  toast(message, true);
}

const SVG_SEARCH = `<svg viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="4.8" stroke="currentColor" stroke-width="1.6"/><path d="m12.2 12.2 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

/* ============================================================
   2) API 与状态
   ============================================================ */

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function api(path, params = {}, timeout = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(path + qs(params), { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    const json = await res.json();
    let data = json?.data;
    if (data && typeof data === 'object' && 'code' in data && 'data' in data) data = data.data;
    return data ?? {};
  } finally {
    clearTimeout(timer);
  }
}

async function guard(key, task) {
  if (state.inFlight.has(key)) return;
  state.inFlight.add(key);
  try {
    await task();
  } finally {
    state.inFlight.delete(key);
  }
}

/* ============================================================
   3) 市场 / 信号 / 持仓 / 成交
   ============================================================ */

function tokenIconHtml(symbol, address, large = false) {
  const name = String(symbol || address || '?');
  const letter = name.slice(0, 2).toUpperCase();
  const h = hashHue(address || name);
  return `<span class="token-icon${large ? ' lg' : ''}" style="--h:${h}">${esc(letter)}</span>`;
}

function sparkline(values, clsName = '') {
  const vals = (values || []).map(Number).filter(Number.isFinite);
  if (vals.length < 2) {
    return `<svg class="spark flat ${clsName}" viewBox="0 0 62 24" preserveAspectRatio="none"><path class="line" d="M0 12 H62"/></svg>`;
  }
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (!(hi > lo)) { hi = lo + Math.max(Math.abs(lo) * 0.01, 1e-12); }
  const x = (i) => (i / (vals.length - 1)) * 62;
  const y = (v) => 21 - ((v - lo) / (hi - lo)) * 18;
  const pts = vals.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const area = `M0,24 L${pts.replaceAll(' ', ' L')} L62,24 Z`;
  const trend = vals[vals.length - 1] >= vals[0] ? 'up' : 'down';
  return `<svg class="spark ${trend} ${clsName}" viewBox="0 0 62 24" preserveAspectRatio="none"><path class="area" d="${area}"/><path class="line" d="M${pts.replaceAll(' ', ' L')}"/></svg>`;
}

function marketRowHtml(r, mode) {
  const symbol = r.symbol || shortAddr(r.address, 3, 3);
  const name = r.name || (mode === 'hot' ? '未命名代币' : '新创建');
  const age = r.age_sec != null ? fmtAge(r.age_sec) : '—';
  const change = mode === 'hot' ? Number(r.price_change_percent) : null;
  const riskNum = Number(r.risk_score);
  const mcap = Number(r.market_cap ?? 0);
  const progress = Number(r.progress ?? 0);
  const flag = r.is_migrated ? '<span class="flag migrated">MIG</span>' : '';
  const risk = Number(r.risk_score);
  const riskFlag = Number.isFinite(risk) && risk >= 60 ? `<span class="flag" style="color:var(--red)">RISK ${Math.round(risk)}</span>` : '';
  const sub = mode === 'hot'
    ? `${age} · ${fmtInt(r.swaps ?? 0)} swaps · ${r.buys ?? 0}/${r.sells ?? 0}${flag ? ' · ' + flag : ''}${riskFlag ? ' · ' + riskFlag : ''}`
    : mode === 'watch'
      ? `${age} · ${riskNum >= 60 ? 'RISK ' + Math.round(riskNum) : '自选'} · ${fmtSol(r.liquidity)}◎`
      : `${age} · 曲线 ${(progress * 100).toFixed(0)}% · dev ${fmtSol(r.dev_buy_sol ?? 0)}◎${flag ? ' · ' + flag : ''}`;
  const changeHtml = mode === 'hot'
    ? `<div class="chg ${change == null ? 'dim' : cls(change)}">${fmtPct(change)}</div>`
    : mode === 'watch'
      ? `<div class="chg ${riskNum >= 60 ? 'down' : 'dim'}">${riskNum >= 60 ? 'HIGH RISK' : 'WATCH'}</div>`
      : `<div class="chg ${progress >= 0.6 ? 'up' : 'dim'}">${(progress * 100).toFixed(0)}%</div>`;
  const spark = mode === 'hot' || mode === 'watch'
    ? sparkline(r.spark)
    : `<div class="mini-progress" title="曲线进度"><i style="width:${clamp(progress * 100, 0, 100)}%"></i></div>`;
  return `<div class="market-row${r.address === state.selected ? ' selected' : ''}" data-address="${esc(r.address)}" data-symbol="${esc(r.symbol || '')}" data-name="${esc(r.name || '')}">
    ${tokenIconHtml(r.symbol, r.address)}
    <div class="market-main">
      <div class="sym">${esc(symbol)}</div>
      <div class="sub">${esc(name).slice(0, 26)} · ${sub}</div>
    </div>
    ${spark}
    <div class="market-metrics">
      <div class="mc">${fmtSol(mcap)}◎</div>
      ${changeHtml}
      <div class="vol">${mode === 'hot' ? `${fmtSol(r.volume)}◎` : mode === 'watch' ? `${fmtSol(r.market_cap)}◎` : `dev ${fmtSol(r.dev_buy_sol ?? 0)}◎`}</div>
    </div>
  </div>`;
}

function renderMarket() {
  const list = $('market-list');
  if (!list) return;
  let rows = [];
  let total = 0;
  let hint = '';
  let mode = 'hot';

  if (state.marketTab === 'hot') {
    rows = state.rank;
    total = state.rankTotal;
    hint = total ? `共 ${total} 个代币 · 按${sortLabel(state.sort)}排序` : '暂无数据 · 先启动采集器';
  } else if (state.marketTab === 'watch') {
    mode = 'watch';
    rows = state.watchRows;
    total = rows.length;
    hint = total ? `自选 ${total} 个` : '在代币详情点 ☆ 加入自选';
  } else {
    mode = state.marketTab;
    const t = state.trenches ?? {};
    if (mode === 'new') rows = t.new_creation ?? [];
    else if (mode === 'soon') rows = t.near_completion ?? [];
    else rows = t.completed ?? [];
    total = rows.length;
    hint = mode === 'new' ? '最近 30 分钟创建' : mode === 'soon' ? '曲线 ≥ 60% 的代币' : '最近迁移到 DEX';
  }

  if (!rows.length) {
    setHTML(list, `<div class="empty-state">${state.marketTab === 'hot' ? '暂无数据 · 先运行 npm run collect' : '这个窗口内暂无代币'}</div>`);
  } else {
    setHTML(list, rows.map((r) => marketRowHtml(r, mode)).join(''));
  }

  setText('market-count', total ? `${total}` : '—');
  setText('market-hint', hint);

  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  setText('page-label', state.marketTab === 'hot' ? `${Math.min(state.page + 1, pages)} / ${pages}` : '—');
  $('page-prev').disabled = state.marketTab !== 'hot' || state.page <= 0;
  $('page-next').disabled = state.marketTab !== 'hot' || state.page >= pages - 1;
}

function sortLabel(sort) {
  return ({
    volume: '成交额', change: '涨幅', mcap: '市值', age: '新到', trades: '成交笔数', progress: '曲线进度',
  })[sort] ?? '成交额';
}

function renderTape() {
  const track = $('tape-track');
  if (!track) return;
  const rows = state.rank.slice(0, 16);
  if (!rows.length) {
    setHTML(track, '<span class="tape-empty">等待行情数据…</span>');
    return;
  }
  const item = (r) => {
    const sym = r.symbol || shortAddr(r.address, 3, 3);
    const chg = Number(r.price_change_percent);
    return `<span class="tape-item ${cls(chg)}" data-address="${esc(r.address)}" data-symbol="${esc(r.symbol || '')}">
      <span class="sym">${esc(sym)}</span><span>${fmtPct(chg)}</span><span class="mc">${fmtSol(r.market_cap)}◎</span>
    </span>`;
  };
  const html = rows.map(item).join('');
  setHTML(track, html + html);
}

function renderSignals() {
  const feed = $('signal-feed');
  if (!feed) return;
  const rows = state.signals;
  setText('signal-count', rows.length ? `${fmtInt(state.signalTotal || rows.length)} 条 · ${fmtAgeMs(Date.now() - rows[0].ts)}前` : '—');
  if (!rows.length) {
    setHTML(feed, '<div class="empty-state">暂无信号 · 运行 <code>npm run runner</code> 后出现</div>');
    return;
  }
  setHTML(feed, rows.slice(0, 60).map((s) => {
    const sym = s.symbol || shortAddr(s.mint, 4, 4);
    const evidence = (s.evidence || []).slice(0, 5).join(' · ') || '—';
    return `<div class="signal-row" data-address="${esc(s.mint)}" data-symbol="${esc(s.symbol || '')}">
      <span class="tier-badge ${esc(s.tier)}">${esc(s.tier)}</span>
      <div class="sig-main">
        <div class="sig-sym">${esc(sym)} <span class="age">${fmtAgeMs(Date.now() - s.ts)}前</span></div>
        <div class="sig-ev">${esc(evidence)}</div>
      </div>
      <div class="sig-score">${Math.round(Number(s.score) || 0)}<small>SCORE</small></div>
    </div>`;
  }).join(''));
}

function renderPositions() {
  const body = $('positions-body');
  if (!body) return;
  const rows = state.positions;
  setText('positions-count', rows.length ? `${rows.length} 个` : '—');
  const totalCost = rows.reduce((a, p) => a + (Number(p.cost_sol) || 0), 0);
  const totalCurrent = rows.reduce((a, p) => {
    const mult = p.entry_mcap > 0 ? p.current_mcap / p.entry_mcap : 1;
    return a + (Number(p.cost_sol) || 0) * mult;
  }, 0);
  const pnl = totalCost > 0 ? ((totalCurrent - totalCost) / totalCost) * 100 : 0;
  setText('positions-total', rows.length ? `成本 ${fmtSol(totalCost)}◎ · 当前 ${fmtSol(totalCurrent)}◎ · ${fmtPct(pnl)}` : '—');

  if (!rows.length) {
    setHTML(body, '<tr><td colspan="7" class="empty-cell">空仓 · 运行器产生信号后自动建仓</td></tr>');
    return;
  }
  setHTML(body, rows.map((p) => {
    const sym = p.symbol || shortAddr(p.mint, 4, 4);
    return `<tr class="clickable" data-address="${esc(p.mint)}" data-symbol="${esc(p.symbol || '')}">
      <td class="sym-cell">${esc(sym)}</td>
      <td class="r">${fmtSol(p.cost_sol)}◎</td>
      <td class="r">${fmtSol(p.entry_mcap)}◎</td>
      <td class="r">${fmtSol(p.current_mcap)}◎</td>
      <td class="r ${cls(p.pnl_pct)}">${fmtPct(p.pnl_pct)}</td>
      <td class="r">${Number(p.peak_x || 1).toFixed(2)}x</td>
      <td class="r dim">${fmtAge(p.age_sec)}</td>
    </tr>`;
  }).join(''));
}

function renderTrades() {
  const body = $('trades-body');
  if (!body) return;
  const rows = state.trades;
  setText('trades-count', rows.length ? `${rows.length}` : '—');
  setText('trades-mint', state.selected ? shortAddr(state.selected, 5, 5) : '—');
  if (!rows.length) {
    setHTML(body, `<tr><td colspan="6" class="empty-cell">${state.selected ? '该代币暂无成交' : '选择代币查看成交'}</td></tr>`);
    return;
  }
  setHTML(body, rows.slice(0, 50).map((t) => `<tr>
    <td class="dim">${fmtClock(t.ts)}</td>
    <td><span class="side-pill ${t.side === 'buy' ? 'buy' : 'sell'}">${t.side === 'buy' ? 'BUY' : 'SELL'}</span></td>
    <td class="r">${fmtPrice(t.price)}</td>
    <td class="r">${fmtSol(t.sol, 3)}</td>
    <td class="r">${fmtSol(t.market_cap)}◎</td>
    <td class="dim">${shortAddr(t.wallet, 3, 3)}</td>
  </tr>`).join(''));
}

/* ============================================================
   4) 代币详情与图表
   ============================================================ */

function renderTokenHead() {
  const info = state.info;
  if (!info) {
    setText('token-symbol', '选择代币');
    setText('token-name', '从左侧市场开始');
    setText('token-mint', '—');
    setText('token-age', '—');
    setText('token-price', '—');
    setText('token-change', '—');
    setText('stat-mcap', '—');
    setText('stat-depth', '—');
    setText('stat-volume', '—');
    setText('stat-buysell', '—');
    setText('stat-peak', '—');
    setText('stat-progress', '—');
    if ($('progress-fill')) $('progress-fill').style.width = '0%';
    return;
  }
  const sym = info.symbol || shortAddr(info.address, 4, 4);
  setText('token-symbol', sym);
  setText('token-name', info.name || '未命名代币');
  setText('token-mint', shortAddr(info.address, 6, 6));
  setText('token-age', info.age_sec != null ? `${fmtAge(info.age_sec)}前创建` : '—');
  setText('token-price', fmtPrice(info.price));
  const chg = info.price_change_percent1h;
  const changeEl = $('token-change');
  if (changeEl) {
    changeEl.innerHTML = `<span class="${cls(chg)}">${chg == null ? '—' : (chg >= 0 ? '▲' : '▼') + ' ' + fmtPct(chg)}</span><span class="period">1H</span>`;
  }
  setText('stat-mcap', `${fmtSol(info.market_cap)}◎`);
  setText('stat-depth', info.dex?.liquidity_usd != null ? `$${fmtSol(info.dex.liquidity_usd)}` : `${fmtSol(info.liquidity)}◎`);
  setText('stat-volume', `${fmtSol(info.volume_1h)}◎`);
  setText('stat-buysell', `${fmtInt(info.buys_1h)} / ${fmtInt(info.sells_1h)}`);
  setText('stat-peak', `${fmtSol(info.peak_market_cap)}◎`);
  setText('stat-progress', `${((Number(info.progress) || 0) * 100).toFixed(1)}%`);
  if ($('progress-fill')) $('progress-fill').style.width = `${clamp((Number(info.progress) || 0) * 100, 0, 100)}%`;

  const avatar = $('token-avatar');
  if (avatar) {
    avatar.textContent = String(sym).slice(0, 2).toUpperCase();
    avatar.style.setProperty('--h', hashHue(info.address));
  }

  const curve = $('token-curve');
  const migrated = $('token-migrated');
  if (curve) curve.hidden = !info.is_on_curve;
  if (migrated) migrated.hidden = !info.is_migrated;

  const tags = [];
  if (info.is_migrated) tags.push('<span class="tag migrated">MIGRATED</span>');
  else tags.push('<span class="tag curve">CURVE</span>');
  tags.push(`<span class="tag">1H SWAPS ${fmtInt(info.swaps_1h)}</span>`);
  if (info.dex) {
    tags.push(`<span class="tag">${esc(info.dex.id || 'DEX')}</span>`);
    if (info.dex.price_usd != null) tags.push(`<span class="tag" title="DexScreener USD 价格">$${fmtPrice(info.dex.price_usd)}</span>`);
  }
  if (Number(info.liquidity) > 0) {
    const imp = 0.02 / (Number(info.liquidity) + 0.02);
    tags.push(`<span class="tag" title="0.02 SOL 买入冲击（恒定乘积近似）">0.02◎ IMPACT ${(imp * 100).toFixed(2)}%</span>`);
  }
  if (info.stale_sec != null && info.stale_sec > 60) tags.push(`<span class="tag warn">STALE ${fmtAge(info.stale_sec)}</span>`);
  if (info.last_trade?.wallet) tags.push(`<span class="tag">LAST ${shortAddr(info.last_trade.wallet, 3, 3)}</span>`);
  const risk = state.intel?.risk;
  if (risk) {
    const score = Math.round(Number(risk.risk_score) || 0);
    tags.push(`<span class="tag ${score >= 60 ? 'warn' : 'ok'}">RISK ${score}</span>`);
    for (const f of (risk.risk_flags ?? []).slice(0, 2)) tags.push(`<span class="tag warn">${esc(f)}</span>`);
  } else {
    tags.push('<span class="tag off">INTEL 未补全</span>');
  }
  setHTML($('token-tags'), tags.join(''));
  renderWatchButton();
}

function renderChartLegend(candle) {
  if (!candle) {
    setHTML($('chart-legend'), '<span>O <b>—</b></span><span>H <b>—</b></span><span>L <b>—</b></span><span>C <b>—</b></span><span>V <b>—</b></span>');
    return;
  }
  setHTML($('chart-legend'),
    `<span>O <b>${chartFmt(chartValue(candle.open))}</b></span><span>H <b>${chartFmt(chartValue(candle.high))}</b></span>` +
    `<span>L <b>${chartFmt(chartValue(candle.low))}</b></span><span>C <b>${chartFmt(chartValue(candle.close))}</b></span>` +
    `<span>V <b>${fmtSol(candle.volume)}◎</b></span>`
  );
}

function chartValue(v) {
  return state.chartValue === 'mcap' ? v * 1_000_000_000 : v;
}

function chartFmt(v) {
  return state.chartValue === 'mcap' ? `${fmtSol(v)}◎` : fmtPrice(v);
}

function fmtAxis(v) {
  return chartFmt(v);
}

function drawChart() {
  const canvas = $('chart');
  const shell = $('chart-shell');
  if (!canvas || !shell) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = shell.clientWidth;
  const h = shell.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const all = state.kline;
  const data = all.slice(-180);
  const empty = $('chart-empty');
  if (!data.length) {
    if (empty) empty.hidden = false;
    renderChartLegend(null);
    state.chartGeom = null;
    return;
  }
  if (empty) empty.hidden = true;

  const padL = 10;
  const padR = 62;
  const padT = 24;
  const padB = 22;
  const volH = Math.max(28, h * 0.16);
  const chartH = Math.max(40, h - padT - padB - volH - 8);
  const innerW = Math.max(10, w - padL - padR);
  const n = data.length;
  const step = innerW / Math.max(1, n);

  let lo = Infinity;
  let hi = -Infinity;
  let maxVol = 0;
  for (const c of data) {
    lo = Math.min(lo, chartValue(c.low));
    hi = Math.max(hi, chartValue(c.high));
    maxVol = Math.max(maxVol, Number(c.volume) || 0);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
  if (hi <= lo) {
    const pad = Math.max(Math.abs(hi) * 0.02, 1e-12);
    lo -= pad;
    hi += pad;
  }
  const y = (v) => padT + chartH - ((v - lo) / (hi - lo)) * chartH;
  const xAt = (i) => (n === 1 ? padL + innerW / 2 : padL + step * (i + 0.5));

  // 网格与 y 轴刻度
  ctx.lineWidth = 1;
  ctx.font = '9px "JetBrains Mono", "SFMono-Regular", monospace';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 3; i++) {
    const yy = padT + (chartH / 3) * i;
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    const val = hi - ((hi - lo) / 3) * i;
    ctx.fillStyle = '#5b687b';
    ctx.textAlign = 'left';
    ctx.fillText(fmtAxis(val), w - padR + 7, yy);
  }

  // x 轴时间刻度
  const labels = n === 1 ? [0] : [0, Math.floor((n - 1) * 0.33), Math.floor((n - 1) * 0.66), n - 1];
  ctx.textAlign = 'center';
  ctx.fillStyle = '#4f5c6f';
  for (const i of [...new Set(labels)]) {
    const c = data[i];
    if (!c) continue;
    const x = xAt(i);
    const d = new Date(c.time * 1000);
    const label = n === 1 || (data[n - 1].time - data[0].time) > 86400
      ? `${d.getMonth() + 1}/${d.getDate()}`
      : d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
    ctx.fillText(label, clamp(x, padL + 18, w - padR - 18), h - 11);
  }

  // 成交量
  const volTop = h - padB - volH;
  for (let i = 0; i < n; i++) {
    const c = data[i];
    const vh = maxVol > 0 ? (Number(c.volume) || 0) / maxVol * volH : 0;
    if (vh <= 0) continue;
    const up = c.close >= c.open;
    ctx.fillStyle = up ? 'rgba(45,212,160,0.25)' : 'rgba(255,100,124,0.25)';
    const bw = Math.max(1, Math.min(8, step * 0.55));
    ctx.fillRect(xAt(i) - bw / 2, volTop + volH - vh, bw, vh);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.beginPath();
  ctx.moveTo(padL, volTop + volH);
  ctx.lineTo(w - padR, volTop + volH);
  ctx.stroke();

  // 蜡烛 / 折线
  const bodyW = Math.max(1.5, Math.min(9, step * 0.58));
  if (state.chartMode === 'line') {
    const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
    grad.addColorStop(0, 'rgba(79,157,255,0.20)');
    grad.addColorStop(1, 'rgba(79,157,255,0)');
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const px = xAt(i);
      const py = y(chartValue(data[i].close));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    const linePath = ctx;
    ctx.lineTo(xAt(n - 1), padT + chartH);
    ctx.lineTo(xAt(0), padT + chartH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const px = xAt(i);
      const py = y(chartValue(data[i].close));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = '#4f9dff';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  } else {
    for (let i = 0; i < n; i++) {
      const c = data[i];
      const px = xAt(i);
      const up = c.close >= c.open;
      const color = up ? '#2dd4a0' : '#ff647c';
      const wickTop = y(chartValue(c.high));
      const wickBottom = y(chartValue(c.low));
      const openY = y(chartValue(c.open));
      const closeY = y(chartValue(c.close));
      const bw = n === 1 ? Math.min(18, innerW * 0.2) : bodyW;

      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(px, wickTop);
      ctx.lineTo(px, wickBottom);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.fillStyle = color;
      const top = Math.min(openY, closeY);
      const bh = Math.max(1, Math.abs(closeY - openY));
      ctx.fillRect(px - bw / 2, top, bw, bh);

      // 单点/全平数据：给一个可见的水平刻度，避免出现一根占满全屏的色块
      if (Math.abs(wickBottom - wickTop) < 0.8) {
        ctx.fillRect(px - bw / 2, wickTop - 0.5, bw, 1.5);
      }
    }
  }

  // 最新价虚线
  const last = data[n - 1];
  const lastY = y(chartValue(last.close));
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = 'rgba(79,157,255,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, lastY);
  ctx.lineTo(w - padR, lastY);
  ctx.stroke();
  ctx.setLineDash([]);

  const label = state.chartValue === 'mcap' ? `${fmtSol(chartValue(last.close))}◎` : fmtPrice(last.close);
  ctx.font = '9px "JetBrains Mono", "SFMono-Regular", monospace';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(79,157,255,0.16)';
  ctx.fillRect(w - padR + 1, lastY - 8, Math.min(tw + 10, padR - 2), 16);
  ctx.fillStyle = '#a8ceff';
  ctx.textAlign = 'left';
  ctx.fillText(label, w - padR + 6, lastY);

  // 悬停十字线 + tooltip
  const hover = state.hoverIndex != null && data[state.hoverIndex] ? state.hoverIndex : null;
  if (hover != null) {
    const c = data[hover];
    const hx = xAt(hover);
    const hy = y(chartValue(c.close));
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(hx, padT);
    ctx.lineTo(hx, h - padB);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(padL, hy);
    ctx.lineTo(w - padR, hy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#dcecff';
    ctx.beginPath();
    ctx.arc(hx, hy, 2.4, 0, Math.PI * 2);
    ctx.fill();
    renderChartLegend(c);
    renderTooltip(c, hx, hy, w, h);
  } else {
    renderChartLegend(last);
    const tip = $('chart-tooltip');
    if (tip) tip.hidden = true;
  }

  state.chartGeom = { padL, padR, padT, padB, step, n, data };
}

function renderTooltip(c, x, y, w, h) {
  const tip = $('chart-tooltip');
  if (!tip) return;
  const time = new Date(c.time * 1000).toLocaleString('zh-CN', { hour12: false });
  tip.innerHTML = `
    <div class="tt-time">${esc(time)}</div>
    <div class="tt-row"><span>O</span><b>${chartFmt(chartValue(c.open))}</b></div>
    <div class="tt-row"><span>H</span><b>${chartFmt(chartValue(c.high))}</b></div>
    <div class="tt-row"><span>L</span><b>${chartFmt(chartValue(c.low))}</b></div>
    <div class="tt-row"><span>C</span><b class="${cls(c.close - c.open)}">${chartFmt(chartValue(c.close))}</b></div>
    <div class="tt-row"><span>V</span><b>${fmtSol(c.volume)}◎</b></div>`;
  tip.hidden = false;
  const tw = tip.offsetWidth || 160;
  const th = tip.offsetHeight || 124;
  tip.style.left = `${clamp(x + 14, 8, Math.max(8, w - tw - 10))}px`;
  tip.style.top = `${clamp(y - th / 2, 8, Math.max(8, h - th - 8))}px`;
}

function renderChart() {
  drawChart();
}

async function loadKline() {
  if (!state.selected) return;
  const d = await api('/v1/token/kline', {
    chain: 'sol',
    address: state.selected,
    resolution: state.resolution,
  });
  state.kline = d.list ?? [];
  state.klineMeta = d.meta ?? null;
  state.hoverIndex = null;
  renderChart();
}

async function loadSelected(force = false) {
  if (!state.selected) {
    state.info = null;
    state.trades = [];
    state.kline = [];
    state.intel = null;
    renderTokenHead();
    renderTrades();
    renderChart();
    renderCalc();
    renderSignalCard();
    renderTokenIntel();
    return;
  }
  const seq = ++state.selectSeq;
  const address = state.selected;
  const [infoRes, klineRes, tradesRes, secRes, riskRes] = await Promise.allSettled([
    api('/v1/token/info', { chain: 'sol', address }),
    api('/v1/token/kline', { chain: 'sol', address, resolution: state.resolution }),
    api('/v1/token/trades', { address, limit: 50 }),
    api('/v1/token/security', { chain: 'sol', address }),
    api('/v1/token/risk', { address }),
  ]);
  if (seq !== state.selectSeq || address !== state.selected) return;

  if (infoRes.status === 'fulfilled') state.info = infoRes.value;
  else throttleError('token-info', '代币信息加载失败');
  if (klineRes.status === 'fulfilled') {
    state.kline = klineRes.value.list ?? [];
    state.klineMeta = klineRes.value.meta ?? null;
  }
  if (tradesRes.status === 'fulfilled') state.trades = tradesRes.value.trades ?? [];
  if (secRes.status === 'fulfilled') state.security = secRes.value;
  state.intel = riskRes.status === 'fulfilled' ? riskRes.value : null;

  renderTokenHead();
  renderTrades();
  renderChart();
  renderCalc();
  renderSignalCard();
  renderTokenIntel();
}

function renderWatchButton() {
  const btn = $('watch-toggle');
  if (!btn) return;
  const active = state.selected && state.watchlist.includes(state.selected);
  btn.textContent = active ? '★' : '☆';
  btn.title = active ? '移出自选' : '加入自选';
  btn.classList.toggle('watched', Boolean(active));
}

function toggleWatch() {
  if (!state.selected) return;
  const i = state.watchlist.indexOf(state.selected);
  if (i >= 0) state.watchlist.splice(i, 1);
  else state.watchlist.unshift(state.selected);
  state.watchlist = state.watchlist.slice(0, 50);
  try { localStorage.setItem('mh.watchlist', JSON.stringify(state.watchlist)); } catch { /* ignore */ }
  renderWatchButton();
  toast(i >= 0 ? '已移出自选' : '已加入自选');
  if (state.marketTab === 'watch') loadMarket().catch(() => {});
}

function selectToken(address, symbol = '') {
  if (!address) return;
  state.selected = address;
  state.selectedSymbol = symbol || '';
  state.hoverIndex = null;
  try {
    history.replaceState(null, '', `#token=${encodeURIComponent(address)}`);
  } catch { /* ignore */ }
  document.querySelectorAll('.market-row').forEach((el) => {
    el.classList.toggle('selected', el.dataset.address === address);
  });
  renderSignalCard();
  renderWatchButton();
  loadSelected(true).catch(() => throttleError('select', '切换代币失败'));
}

/* ============================================================
   5) 纸面测算 / 信号卡 / 验证
   ============================================================ */

function renderCalc() {
  const info = state.info;
  const input = $('calc-size');
  const amount = Number(input?.value) || 0;
  const note = $('calc-note');
  if (!info || !(info.v_sol > 0) || !(info.v_tokens > 0) || amount <= 0) {
    setText('calc-tokens', '—');
    setText('calc-impact', '—');
    setText('calc-fee', '—');
    setText('calc-slip', '—');
    setText('calc-roundtrip', '—');
    setText('calc-weight', '—');
    if (note) {
      note.textContent = info ? '曲线估算 · 不发送交易' : '选择代币后估算';
      note.classList.remove('warn');
    }
    return;
  }
  const fee = amount * 0.01;
  const eff = amount - fee;
  const rawTokens = (info.v_tokens * eff) / (info.v_sol + eff);
  const slip = 0.015;
  const tokensOut = rawTokens * (1 - slip);
  const impact = (eff / info.v_sol) * 100;
  const roundTripPct = 0.01 * 2 + slip * 2 + (impact / 100) * 2 + 0.001 / amount;
  setText('calc-tokens', fmtTokenAmount(tokensOut));
  setText('calc-impact', `${impact.toFixed(2)}%`);
  setText('calc-fee', `${fmtSol(fee, 4)}◎`);
  setText('calc-slip', `${fmtSol(amount * slip, 4)}◎`);
  setText('calc-roundtrip', `${(roundTripPct * 100).toFixed(2)}%`);
  setText('calc-weight', `${((amount / 1.0) * 100).toFixed(1)}%`);
  if (note) {
    note.textContent = roundTripPct > 0.08
      ? `往返成本约 ${(roundTripPct * 100).toFixed(1)}% · 毛涨幅需 >${(roundTripPct * 100).toFixed(1)}% 才回本`
      : `往返成本约 ${(roundTripPct * 100).toFixed(1)}% · 曲线估算，不含 MEV / 失败重试`;
    note.classList.toggle('warn', roundTripPct > 0.08 || impact > 8);
  }
}

function ruleById(id) {
  return (state.strategy?.rules ?? []).find((r) => r.id === id) ?? null;
}

function renderSignalCard() {
  const body = $('signal-card-body');
  if (!body) return;
  setText('strategy-version', state.strategy?.version ?? '—');
  const rows = state.signals ?? [];
  let sig = state.selected ? rows.find((s) => s.mint === state.selected) : null;
  let isSelected = Boolean(sig);
  if (!sig) sig = rows[0] ?? null;
  if (!sig) {
    setHTML(body, `<div class="empty-state">暂无信号 · 运行 <code>npm run runner</code> 后出现<br/>评分规则可解释，每条信号带 evidence</div>`);
    setText('signal-fresh', '—');
    return;
  }
  const score = Math.round(Number(sig.score) || 0);
  const tier = sig.tier || 'C';
  const color = tier === 'A' ? 'var(--amber)' : tier === 'B' ? 'var(--accent)' : 'var(--violet)';
  const evidence = sig.evidence || [];
  const ruleQuality = state.validation?.report?.statistics?.ruleQuality?.rules ?? [];
  const qMap = new Map(ruleQuality.map((r) => [r.id, r]));
  const chips = evidence.map((id) => {
    const rule = ruleById(id);
    const q = qMap.get(id);
    const bad = q && q.qValue != null && q.qValue < 0.1 && (q.lift2x ?? 0) < 1;
    return `<span class="evidence-chip ${bad ? 'fail' : 'pass'}" title="${esc(rule?.desc ?? id)}">
      ${esc(id)}${rule?.weight ? `<b>+${rule.weight}</b>` : ''}
    </span>`;
  }).join('');
  const ruleRows = (ruleQuality.filter((r) => !r.veto).slice(0, 4).length
    ? ruleQuality.filter((r) => !r.veto).slice(0, 4)
    : (state.strategy?.rules ?? []).filter((r) => !r.veto).slice(0, 4).map((r) => ({
        id: r.id, p2: null, lift2x: null, qValue: null,
      }))).map((r) => {
    const rule = ruleById(r.id);
    const lift = r.lift2x;
    const good = lift != null && lift > 1.1;
    const bad = lift != null && lift < 0.9;
    const width = lift == null ? (rule?.weight ?? 10) : clamp(lift * 50, 4, 100);
    return `<div class="rq-row ${good ? 'good' : bad ? 'bad' : ''}">
      <b>${esc(r.id)}</b>
      <span class="rq-bar"><i style="width:${width.toFixed(0)}%"></i></span>
      <span>${lift == null ? `w${rule?.weight ?? 0}` : `${lift.toFixed(2)}x`}</span>
    </div>`;
  }).join('');

  setHTML(body, `
    <div class="signal-hero">
      <div class="score-ring" style="--score:${clamp(score, 0, 100)};--ring:${color}">
        <span class="score-num">${score}</span><span class="score-max">/100</span>
      </div>
      <div class="signal-summary">
        <div class="ss-top">
          <span class="ss-sym">${esc(sig.symbol || shortAddr(sig.mint, 5, 5))}</span>
          <span class="tier-badge ${esc(tier)}">${esc(tier)}</span>
        </div>
        <div class="ss-sub">${isSelected ? '当前代币信号' : (state.selected ? '该币暂无信号 · 全市场最新' : '全市场最新')} · ${fmtAgeMs(Date.now() - sig.ts)}前 · ${sig.acted ? '已执行' : '未执行'}</div>
        <div class="ss-tier">${evidence.length} 条证据命中 · 策略 ${esc(sig.strategy_version || state.strategy?.version || '—')}</div>
      </div>
    </div>
    <div class="evidence-list">${chips || '<span class="evidence-chip">无 evidence</span>'}</div>
    <div class="rule-quality-mini">
      ${ruleRows}
    </div>`);
  setText('signal-fresh', sig.ts ? `${fmtAgeMs(Date.now() - sig.ts)}前` : '—');
}

function riskLevel(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return { cls: '', label: '未补全' };
  if (n >= 60) return { cls: 'high', label: `风险 ${Math.round(n)}` };
  if (n >= 30) return { cls: 'mid', label: `风险 ${Math.round(n)}` };
  return { cls: 'low', label: `风险 ${Math.round(n)}` };
}

function renderTokenIntel() {
  const body = $('intel-body');
  if (!body) return;
  const pill = $('intel-risk-pill');
  const headPill = $('token-risk-badge');
  const data = state.intel;
  const risk = data?.risk;
  $('token-intel')?.classList.toggle('incomplete', !risk);
  if (!state.selected) {
    setText('intel-fresh', '未选择');
    if (pill) { pill.className = 'risk-pill'; pill.textContent = '—'; }
    if (headPill) { headPill.className = 'risk-pill token-risk'; headPill.textContent = 'RISK —'; }
    setHTML(body, '<div class="empty-state">选择代币后加载</div>');
    return;
  }
  if (!risk) {
    setText('intel-fresh', '未补全');
    if (pill) { pill.className = 'risk-pill'; pill.textContent = '未补全'; }
    if (headPill) { headPill.className = 'risk-pill token-risk'; headPill.textContent = 'RISK ?'; }
    if (state.intelTab === 'risk') {
      setHTML(body, '<div class="empty-state">安全数据未补全<div class="intel-actions"><button data-intel-action="enrich">补全当前币</button></div></div>');
      return;
    }
  } else {
    const level = riskLevel(risk.risk_score);
    if (pill) { pill.className = `risk-pill ${level.cls}`; pill.textContent = level.label; }
    if (headPill) { headPill.className = `risk-pill token-risk ${level.cls}`; headPill.textContent = `RISK ${Math.round(Number(risk.risk_score) || 0)}`; }
    setText('intel-fresh', data.updatedAt ? `${fmtAgeMs(Date.now() - data.updatedAt)}前` : '—');
  }
  const flags = risk?.risk_flags ?? [];
  const tab = state.intelTab;

  if (tab === 'holders') {
    const rows = data.holders ?? [];
    setHTML(body, rows.length
      ? rows.map((h) => `<div class="holder-row">
          <span>#${h.rank}</span><span class="h-addr" title="${esc(h.address)}">${esc(shortAddr(h.address, 5, 4))}</span>
          <span class="r">${((Number(h.pct) || 0) * 100).toFixed(2)}%</span>
          <span class="h-bar"><i style="width:${clamp((Number(h.pct) || 0) * 100 * 2, 1, 100)}%"></i></span>
        </div>`).join('')
      : '<div class="empty-state">暂无 holder 快照</div>');
    return;
  }

  if (tab === 'dev') {
    const d = data.dev ?? {};
    setHTML(body, `<div class="dev-grid">
      <div><span>创建币数</span><b>${fmtInt(d.tokens_created)}</b></div>
      <div><span>Rug 次数</span><b>${fmtInt(d.rugged)}</b></div>
      <div><span>最佳峰值</span><b>${d.best_peak_x == null ? '—' : Number(d.best_peak_x).toFixed(2) + 'x'}</b></div>
      <div><span>平均峰值</span><b>${d.avg_peak_x == null ? '—' : Number(d.avg_peak_x).toFixed(2) + 'x'}</b></div>
    </div>
    <div class="intel-kv"><div><span>最佳币</span><b>${esc(shortAddr(d.best_mint, 6, 4))}</b></div>
    <div><span>最近创建</span><b>${d.last_created_at ? fmtAgeMs(Date.now() - d.last_created_at) + '前' : '—'}</b></div></div>`);
    return;
  }

  if (tab === 'traders') {
    const rows = data.traders ?? [];
    setHTML(body, rows.length
      ? rows.map((t) => `<div class="trader-row" title="${esc(t.wallet)}">
          <span class="h-addr">${esc(shortAddr(t.wallet, 6, 4))}</span>
          <span>${labelChips(t.labels)}</span>
          <span class="r">${fmtSol(t.buy_sol, 2)} / ${fmtSol(t.sell_sol, 2)}</span>
        </div>`).join('')
      : '<div class="empty-state">暂无 trader 数据</div>');
    return;
  }

  if (tab === 'social') {
    const s = data.social;
    const tw = safeUrl(s?.twitter);
    const tg = safeUrl(s?.telegram);
    const web = safeUrl(s?.website);
    setHTML(body, (tw || tg || web || s?.description)
      ? `<div class="social-list">
          ${tw ? `<a href="${esc(tw)}" target="_blank" rel="noreferrer">X · ${esc(tw)}</a>` : ''}
          ${tg ? `<a href="${esc(tg)}" target="_blank" rel="noreferrer">TG · ${esc(tg)}</a>` : ''}
          ${web ? `<a href="${esc(web)}" target="_blank" rel="noreferrer">WEB · ${esc(web)}</a>` : ''}
          ${s?.description ? `<p>${esc(s.description)}</p>` : ''}
        </div>`
      : '<div class="empty-state">暂无社交数据</div>');
    return;
  }

  if (!risk) {
    setHTML(body, '<div class="empty-state">安全数据未补全<div class="intel-actions"><button data-intel-action="enrich">补全当前币</button></div></div>');
    return;
  }

  const kv = [
    ['Mint 权限', risk.mint_authority ? '存在' : '无'],
    ['Freeze 权限', risk.freeze_authority ? '存在' : '无'],
    ['Top10', risk.top10_rate == null ? '—' : `${(risk.top10_rate * 100).toFixed(1)}%`],
    ['Top1', risk.top1_rate == null ? '—' : `${(risk.top1_rate * 100).toFixed(1)}%`],
    ['LP 锁定', risk.lp_burned_pct == null ? '—' : `${Number(risk.lp_burned_pct).toFixed(0)}%`],
    ['流动性', risk.liquidity_usd == null ? '—' : `$${fmtSol(risk.liquidity_usd)}`],
    ['持有人', fmtInt(risk.holder_count)],
    ['前10s 钱包', fmtInt(risk.first_10s_wallets)],
    ['Insider', risk.bundle_rate == null ? '—' : `${(risk.bundle_rate * 100).toFixed(1)}%`],
    ['Dev 持仓', risk.dev_hold_rate == null ? '—' : `${(risk.dev_hold_rate * 100).toFixed(1)}%`],
    ['Dev Rug', risk.dev_rugged_rate == null ? '—' : `${(risk.dev_rugged_rate * 100).toFixed(1)}%`],
    ['Honeypot', risk.honeypot == null ? '未检测' : risk.honeypot ? '是' : '否'],
  ];
  setHTML(body, `
    <div class="risk-head">
      <span class="risk-score">${Math.round(Number(risk.risk_score) || 0)}<small>/100</small></span>
      <div class="risk-flags">${flags.length ? flags.map((f) => `<span class="flag-chip">${esc(f)}</span>`).join('') : '<span class="flag-chip ok">无高危标记</span>'}</div>
    </div>
    <div class="intel-kv">${kv.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>`);
}

function verdictText(v) {
  return v?.verdictLabel || v?.verdict || '—';
}

function renderValidationMini() {
  const box = $('validation-mini-body');
  if (!box) return;
  const v = state.validation?.report;
  setText('validation-fresh', v?.generatedAt ? `${fmtAgeMs(Date.now() - new Date(v.generatedAt).getTime())}前` : '未运行');
  if (!v) {
    setHTML(box, '<div class="empty-state">尚未运行验证 · <code>npm run validate</code></div>');
    return;
  }
  const gates = v.gates ?? [];
  const pass = gates.filter((g) => g.pass).length;
  const reasons = (v.reasons ?? []).slice(0, 3);
  const stress = (v.costs ?? []).slice(0, 3);
  setHTML(box, `
    <div class="verdict-line">
      <span class="verdict-badge ${esc(v.verdict)}">${esc(v.verdict)}</span>
      <b>${esc(verdictText(v))}</b>
      <span>${gates.length ? `${pass}/${gates.length} 门槛` : ''}</span>
    </div>
    <ul class="validation-reasons-mini">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    <div style="margin-top:7px">
      ${stress.map((s) => `<div class="gate-mini-row ${Number(s.aggregate?.expectancySol) > 0 ? 'pass' : 'fail'}">
        <span class="g-dot"></span><span>${esc(s.label)}</span><b>${Number(s.aggregate?.expectancySol ?? 0).toFixed(4)} SOL/笔</b>
      </div>`).join('')}
    </div>`);
}

function gateIcon(pass) {
  return `<span class="gate-icon">${pass ? '✓' : '✕'}</span>`;
}

function renderValidationView() {
  const v = state.validation?.report;
  if (!v) {
    setHTML($('validation-reasons'), '<div class="empty-state">运行 <code>npm run validate</code> 后，这里会显示结论与失败原因。</div>');
    return;
  }
  const badge = $('verdict-badge');
  if (badge) {
    badge.className = `verdict-badge ${v.verdict}`;
    badge.textContent = v.verdict;
  }
  setText('verdict-label', verdictText(v));
  setText('verdict-time', v.generatedAt ? `生成于 ${new Date(v.generatedAt).toLocaleString('zh-CN', { hour12: false })}` : '—');

  const reasons = v.reasons ?? [];
  const top = reasons.slice(0, 3);
  const rest = reasons.slice(3);
  setHTML($('validation-reasons'), `<div class="reason-head"><span class="reason-kicker">主要失败项</span><span>${top.length} / ${reasons.length} 项</span></div>
    <ul class="reason-list">${top.map((r, i) => `<li class="${i === 0 ? 'critical' : ''}">${esc(r)}</li>`).join('')}</ul>
    ${rest.length ? `<details class="reason-more"><summary>展开全部 ${reasons.length} 项</summary><ul>${rest.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>` : ''}`);

  const gates = v.gates ?? [];
  const pass = gates.filter((g) => g.pass).length;
  setText('gate-summary', `${pass}/${gates.length} 通过`);
  setHTML($('gate-list'), gates.map((g) => `<div class="gate-item ${g.pass ? 'pass' : 'fail'}">
    ${gateIcon(g.pass)}
    <div class="gate-main">
      <div class="g-label">${esc(g.label)}</div>
      <div class="g-value">${esc(g.value)}</div>
    </div>
    <div class="gate-threshold">${esc(g.threshold)}</div>
  </div>`).join(''));

  const a = v.dataAudit ?? {};
  const auditItems = [
    ['成交笔数', fmtInt(a.trades), `${fmtInt(a.mintsWithTrades)} 币有成交`],
    ['有效时长', `${a.activeHours ?? '—'}h`, `跨度 ${a.durationHours ?? '—'}h · 覆盖 ${a.coveragePct ?? '—'}%`],
    ['创建币数', fmtInt(a.tokens), `币覆盖率 ${a.tokenCoveragePct ?? '—'}%`],
    ['最长中断', `${a.maxGapMinutes ?? '—'}min`, '采集中断会伪装成样本'],
    ['脏数据', `${fmtInt(a.badMcapRows)} 条`, `空市值 / 非正市值`],
    ['价格跳变', `${fmtInt(a.jumpOutliers)} 次`, `最大 ${a.worstJumpRatio ?? '—'}x`],
    ['数据年龄', `${a.dataAgeHours ?? '—'}h`, a.dataAgeHours > 6 ? '数据偏旧' : '较新'],
    ['重复键', fmtInt(a.duplicateTradeKeys), '应为 0'],
    ['采集空小时', fmtInt(a.emptyHourBuckets), `每小时桶 ${a.hourlyBuckets ?? '—'}`],
  ];
  setHTML($('audit-grid'), auditItems.map(([k, val, sub]) => `<div class="audit-item"><span>${esc(k)}</span><b>${esc(val)}</b><em>${esc(sub)}</em></div>`).join('') +
    ((a.notes ?? []).length ? `<ul class="audit-notes">${a.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''));

  const wf = v.walkForward ?? {};
  const folds = wf.folds ?? [];
  setText('wf-summary', `${wf.positiveFolds ?? 0}/${wf.foldCount ?? folds.length} 折盈利 · 汇总 ${Number(wf.aggregate?.pnlSol ?? 0).toFixed(4)} SOL`);
  const wfRows = folds.map((f) => `<tr>
    <td>#${f.index}</td>
    <td class="dim">${fmtDateTime(f.fromTs)} → ${fmtDateTime(f.toTs)}</td>
    <td class="r">${f.closed}</td>
    <td class="r ${cls(f.pnlSol)}">${Number(f.pnlSol).toFixed(4)}</td>
    <td class="r ${cls(f.expectancySol)}">${Number(f.expectancySol).toFixed(4)}</td>
    <td class="r">${(Number(f.winRate) * 100).toFixed(1)}%</td>
    <td class="r">${Number(f.profitFactor).toFixed(2)}</td>
    <td class="r">${Number(f.maxDrawdownPct).toFixed(1)}%</td>
    <td class="r dim">${f.stuckExits}</td>
  </tr>`);
  if (wf.aggregate) {
    wfRows.push(`<tr>
      <td><b>汇总</b></td><td class="dim">全部样本外折</td>
      <td class="r">${wf.aggregate.closed}</td>
      <td class="r ${cls(wf.aggregate.pnlSol)}">${Number(wf.aggregate.pnlSol).toFixed(4)}</td>
      <td class="r ${cls(wf.aggregate.expectancySol)}">${Number(wf.aggregate.expectancySol).toFixed(4)}</td>
      <td class="r">${(Number(wf.aggregate.winRate) * 100).toFixed(1)}%</td>
      <td class="r">${Number(wf.aggregate.profitFactor).toFixed(2)}</td>
      <td class="r">${Number(wf.aggregate.maxDrawdownPct).toFixed(1)}%</td>
      <td class="r dim">${wf.aggregate.stuckExits}</td>
    </tr>`);
  }
  setHTML($('wf-body'), wfRows.join('') || '<tr><td colspan="9" class="empty-cell">暂无数据</td></tr>');

  const scenarios = [...(v.costs ?? []), ...(v.latency ?? []).filter((s) => s.id !== 'base')];
  setHTML($('stress-list'), scenarios.length ? scenarios.map((s) => `<div class="stress-row">
    <span class="s-label">${esc(s.label)}</span>
    <b>${s.aggregate?.closed ?? 0} 笔</b>
    <b class="${cls(s.aggregate?.expectancySol)}">${Number(s.aggregate?.expectancySol ?? 0).toFixed(4)}</b>
    <b class="${cls(s.aggregate?.profitFactor)}">PF ${Number(s.aggregate?.profitFactor ?? 0).toFixed(2)}</b>
  </div>`).join('') : '<div class="empty-state">暂无数据</div>');

  const b = v.statistics?.bootstrap ?? {};
  const randomEdge = v.randomBaseline?.edgeVsRandomSol;
  const statItems = [
    ['单笔期望 CI', `${Number(b.expectancySol?.ci95?.[0] ?? 0).toFixed(4)} … ${Number(b.expectancySol?.ci95?.[1] ?? 0).toFixed(4)}`, 'SOL / 笔，按币种重采样'],
    ['总盈亏 CI', `${Number(b.meanPnlSol?.ci95?.[0] ?? 0).toFixed(4)} … ${Number(b.meanPnlSol?.ci95?.[1] ?? 0).toFixed(4)}`, 'SOL'],
    ['胜率 CI', `${(Number(b.winRate?.ci95?.[0] ?? 0) * 100).toFixed(1)}% … ${(Number(b.winRate?.ci95?.[1] ?? 0) * 100).toFixed(1)}%`, `${b.trades ?? 0} 笔 / ${b.mints ?? 0} 币`],
    ['盈亏比 CI', `${Number(b.profitFactor?.ci95?.[0] ?? 0).toFixed(2)} … ${Number(b.profitFactor?.ci95?.[1] ?? 0).toFixed(2)}`, '95% 区间'],
    ['随机基线优势', randomEdge == null ? '—' : `${Number(randomEdge).toFixed(4)}`, '策略期望 − 随机期望'],
    ['验证耗时', `${Number(v.elapsedMs ?? 0) / 1000}s`, `${v.strategyVersion ?? ''}`],
  ];
  setHTML($('stats-grid'), statItems.map(([k, val, sub]) => `<div class="stat-box"><span>${esc(k)}</span><b>${esc(val)}</b><em>${esc(sub)}</em></div>`).join(''));

  const rq = v.statistics?.ruleQuality;
  const rules = rq?.rules ?? [];
  setText('rule-summary', rq ? `基准 ≥2x ${((rq.baseline?.p2 ?? 0) * 100).toFixed(2)}% · n=${rq.baseline?.samples ?? 0}` : '—');
  setHTML($('rule-body'), rules.length ? rules.map((r) => {
    let conclusion = '中性';
    let clsName = 'dim';
    if (r.veto) {
      conclusion = `误杀 ${((r.falseKillPct ?? 0) * 100).toFixed(1)}%`;
      clsName = 'dim';
    } else if (r.qValue != null && r.qValue < 0.1 && (r.lift2x ?? 0) > 1.2) {
      conclusion = '有效';
      clsName = 'up';
    } else if (r.qValue != null && r.qValue < 0.1 && (r.lift2x ?? 0) < 0.9) {
      conclusion = '反向'; 
      clsName = 'down';
    } else if (r.qValue != null) {
      conclusion = r.qValue < 0.1 ? '显著但 lift 不足' : '不显著';
    }
    return `<tr>
      <td class="sym-cell">${esc(r.id)}</td>
      <td class="dim">${r.veto ? 'VETO' : 'SCORE'}</td>
      <td class="r">${fmtInt(r.samples)}</td>
      <td class="r">${r.p15 == null ? '—' : `${(r.p15 * 100).toFixed(1)}%`}</td>
      <td class="r">${r.p2 == null ? '—' : `${(r.p2 * 100).toFixed(1)}%`}</td>
      <td class="r">${r.medianMult == null ? '—' : `${r.medianMult.toFixed(2)}x`}</td>
      <td class="r ${r.lift2x != null && r.lift2x > 1.1 ? 'up' : r.lift2x != null && r.lift2x < 0.9 ? 'down' : ''}">${r.lift2x == null ? '—' : `${r.lift2x.toFixed(2)}x`}</td>
      <td class="r">${r.qValue == null ? '—' : r.qValue.toFixed(3)}</td>
      <td class="${clsName}">${conclusion}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="9" class="empty-cell">暂无数据</td></tr>');
  const recs = v.recommendations ?? [];
  setHTML($('rule-note'),
    recs.length
      ? '<b style="color:var(--text-2)">建议</b><br>' + recs.map((r) => esc(r)).join('<br>')
      : '—'
  );

  const sens = v.sensitivity;
  setText('sens-summary', sens ? `${((sens.profitablePct ?? 0) * 100).toFixed(0)}% 组合正期望 · 中位 ${Number(sens.medianExpectancySol ?? 0).toFixed(4)} SOL/笔` : '—');
  const cells = sens?.cells ?? [];
  setHTML($('sens-grid'), cells.length ? [...cells]
    .sort((x, y) => Number(y.expectancySol) - Number(x.expectancySol))
    .slice(0, 8)
    .map((c) => `<div class="sens-row ${Number(c.expectancySol) > 0 ? 'good' : 'bad'}">
      <span>TP ${c.tpPct} · SL ${c.slPct} · ${c.maxHoldMin}m</span>
      <b>${Number(c.expectancySol).toFixed(4)}</b>
    </div>`).join('') : '<div class="empty-state">暂无数据</div>');

}

/* ============================================================
   6) 加载函数 / 搜索 / 轮询
   ============================================================ */

async function loadOverview() {
  const o = await api('/v1/overview');
  state.overview = o;
  const s = o.stats ?? {};
  setText('kpi-tokens', fmtInt(s.tokens));
  setText('kpi-trades', fmtInt(s.trades));
  setText('kpi-volume', fmtSol(s.volumeSol));
  setText('kpi-rate', fmtInt(s.tradeRate1m));
  setText('kpi-signals', fmtInt(s.signals));
  setText('kpi-positions', fmtInt(s.positions));
  const m = o.market ?? {};
  setText('kpi-buysell', `${fmtInt(m.buys)} / ${fmtInt(m.sells)}${m.buySellRatio ? ` · ${m.buySellRatio}` : ''}`);
  const v = o.validation;
  const verdictEl = $('kpi-verdict');
  if (verdictEl) {
    verdictEl.dataset.verdict = v?.verdict ?? '';
    verdictEl.textContent = v?.verdictLabel ?? '未验证';
    verdictEl.className = `verdict-text ${v?.verdict === 'GO_LIVE' ? 'up' : v?.verdict === 'NO_GO' ? 'down' : v?.verdict === 'PAPER_ONLY' ? 'warn' : 'dim'}`;
  }

  const age = Number(s.dataAgeSec);
  const ingestAge = Number(o.health?.ingestAgeSec);
  const live = $('live-status');
  if (live) {
    let status = 'bad';
    let label = 'NO DATA';
    if (Number.isFinite(ingestAge) && ingestAge > 180) {
      status = 'bad';
      label = `INGEST ${fmtAge(ingestAge)}`;
    } else if (Number.isFinite(age)) {
      if (age < 120) { status = 'live'; label = `LIVE ${fmtAge(age)}`; }
      else if (age < 600) { status = 'warn'; label = `DELAY ${fmtAge(age)}`; }
      else { status = 'bad'; label = `TRADES ${fmtAge(age)}`; }
    }
    live.dataset.state = status;
    live.title = `最近成交 ${s.dataAgeSec ?? '—'}s · 采集日志 ${o.health?.collectorLogAgeSec ?? '—'}s · 新币 ${o.health?.ingestAgeSec ?? '—'}s`;
    const text = live.querySelector('span');
    if (text) text.textContent = label;
  }

  const pos = o.positions ?? {};
  setText('hdr-equity', pos.currentSol != null ? `${fmtSol(pos.currentSol)}◎` : '—');
  const eqPct = $('hdr-equity-pct');
  if (eqPct) {
    eqPct.textContent = pos.count ? `${fmtPct(pos.pnlPct)}` : '空仓';
    eqPct.className = cls(pos.pnlPct);
  }
  setText('footer-data-age', s.dataAgeSec != null ? `DATA ${fmtAge(s.dataAgeSec)} AGO` : 'DATA —');
  setText('footer-db', o.health?.db ?? 'data/meme.db');
}

async function loadMarket() {
  if (state.marketTab === 'watch') {
    const addresses = state.watchlist.slice(0, 50);
    const d = addresses.length
      ? await api('/v1/token/batch', { addresses: addresses.join(',') }, 10000)
      : { tokens: [] };
    state.watchRows = d.tokens ?? [];
    renderMarket();
    return;
  }
  if (state.marketTab === 'hot') {
    const d = await api('/v1/market/rank', {
      chain: 'sol',
      interval: state.interval,
      limit: state.pageSize,
      offset: state.page * state.pageSize,
      sort: state.sort,
    });
    state.rank = d.rank ?? [];
    state.rankTotal = d.total ?? state.rank.length;
    if (!state.rank.length && state.page > 0) {
      state.page = Math.max(0, Math.ceil(state.rankTotal / state.pageSize) - 1);
      return loadMarket();
    }
  } else {
    state.trenches = await api('/v1/trenches', { chain: 'sol' }, 12000);
  }
  renderMarket();
  renderTape();

  if (!state.selected) {
    const first = state.marketTab === 'hot' ? state.rank[0] : (state.trenches?.new_creation?.[0]);
    if (first) selectToken(first.address, first.symbol || '');
  }
}

async function loadSignals() {
  const d = await api('/v1/signals', { limit: 80, tier: state.signalTier });
  state.signals = d.signals ?? [];
  state.signalTotal = d.total ?? state.signals.length;
  renderSignals();
  renderSignalCard();
}

async function loadPositions() {
  const d = await api('/v1/positions');
  state.positions = d.positions ?? [];
  renderPositions();
}

async function loadAnalytics() {
  const d = await api('/v1/analytics');
  state.analytics = d;
}

function labelChips(labels) {
  return (labels ?? []).map((l) => `<span class="label-chip ${esc(l)}">${esc(l)}</span>`).join('');
}

function setWalletMode(mode) {
  state.walletMode = mode === 'smart' ? 'smart' : 'ranking';
  document.querySelectorAll('#wallet-modes button').forEach((b) => {
    const on = b.dataset.wmode === state.walletMode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('[data-wpanel]').forEach((el) => {
    el.hidden = el.dataset.wpanel !== state.walletMode;
  });
  const filters = $('wallet-filters');
  const actions = $('wallet-page-actions');
  if (filters) filters.hidden = state.walletMode === 'smart';
  if (actions) actions.hidden = state.walletMode === 'smart';
  if (state.walletMode === 'smart') loadSmart().catch(() => {});
}

async function loadWallets() {
  const d = await api('/v1/wallets', {
    limit: state.walletPageSize,
    offset: state.walletPage * state.walletPageSize,
    label: state.walletLabel,
    sort: state.walletSort,
    q: state.walletQuery,
  });
  state.wallets = d.wallets ?? [];
  state.walletTotal = d.total ?? state.wallets.length;
  renderWalletsPage();
}

function renderWalletsPage() {
  const body = $('wallet-body');
  if (!body) return;
  const rows = state.wallets;
  const pages = Math.max(1, Math.ceil(state.walletTotal / state.walletPageSize));
  setText('wallet-count', `${fmtInt(state.walletTotal)} 个`);
  setText('wallet-page', `${Math.min(state.walletPage + 1, pages)} / ${pages}`);
  setHTML($('wallet-hint'), rows.length
    ? `第 ${state.walletPage * state.walletPageSize + 1}–${state.walletPage * state.walletPageSize + rows.length} 条 · OOS 为后 30% 时间样本`
    : '无匹配钱包');
  $('wallet-prev').disabled = state.walletPage <= 0;
  $('wallet-next').disabled = state.walletPage >= pages - 1;

  if (!rows.length) {
    setHTML(body, '<tr><td colspan="12" class="empty-cell">无匹配钱包 · 运行控制台「重算钱包画像」</td></tr>');
    return;
  }
  setHTML(body, rows.map((w, i) => {
    const pnl = Number(w.realized_proxy_sol) || 0;
    return `<tr class="${w.address === state.walletDetail?.address ? 'selected' : ''}" data-address="${esc(w.address)}">
      <td class="dim">${state.walletPage * state.walletPageSize + i + 1}</td>
      <td><div class="wallet-addr">${esc(shortAddr(w.address, 6, 5))}</div><div class="wallet-sub">${fmtInt(w.trades)} 笔 · ${fmtInt(w.tokens_traded)} 币</div></td>
      <td>${labelChips(w.labels)}</td>
      <td class="r">${fmtInt(w.trades)}</td>
      <td class="r">${fmtInt(w.tokens_traded)}</td>
      <td class="r ${cls(pnl)}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)}</td>
      <td class="r">${((Number(w.win_rate) || 0) * 100).toFixed(1)}%</td>
      <td class="r">${Number(w.avg_peak_x || 0).toFixed(2)}x</td>
      <td class="r">${w.oos_trades ? `${((Number(w.oos_win_rate) || 0) * 100).toFixed(0)}% / ${w.oos_trades}` : '—'}</td>
      <td class="r">${w.median_hold_sec == null ? '—' : fmtAge(w.median_hold_sec)}</td>
      <td class="r ${Number(w.copyability) >= 0.5 ? 'up' : 'dim'}">${((Number(w.copyability) || 0) * 100).toFixed(0)}%</td>
      <td class="r">${Number(w.score || 0).toFixed(2)}</td>
    </tr>`;
  }).join(''));
}

async function loadWalletDetail(address) {
  const d = await api('/v1/wallet', { address }, 12000);
  state.walletDetail = { address, ...d };
  renderWalletDetail();
  document.querySelectorAll('#wallet-body tr').forEach((tr) => {
    tr.classList.toggle('selected', tr.dataset.address === address);
  });
}


async function loadSmart() {
  const d = await api('/v1/smart-money', { limit: 60, side: state.smartSide }, 15000);
  state.smart = d.trades ?? [];
  renderSmart();
}

function renderSmart() {
  const body = $('smart-feed-body');
  if (!body) return;
  const rows = state.smart;
  setText('smart-feed-count', rows.length ? `${rows.length} 条` : '—');
  if (!rows.length) {
    setHTML(body, '<tr><td colspan="8" class="empty-cell">暂无聪明钱交易</td></tr>');
    return;
  }
  setHTML(body, rows.map((t) => `<tr class="clickable" data-address="${esc(t.mint)}">
    <td class="dim">${fmtClock(t.ts)}</td>
    <td><div class="wallet-addr">${esc(shortAddr(t.wallet, 5, 4))}</div><div class="wallet-sub">${((Number(t.copyability) || 0) * 100).toFixed(0)}% copy</div></td>
    <td>${labelChips(t.labels)}</td>
    <td class="sym-cell">${esc(t.symbol || shortAddr(t.mint, 4, 4))}</td>
    <td><span class="side-pill ${t.side === 'buy' ? 'buy' : 'sell'}">${t.side === 'buy' ? 'BUY' : 'SELL'}</span></td>
    <td class="r">${fmtSol(t.sol_amount, 3)}</td>
    <td class="r">${fmtSol(t.market_cap_sol)}◎</td>
    <td class="r ${Number(t.risk_score) >= 60 ? 'down' : 'dim'}">${t.risk_score == null ? '—' : Math.round(t.risk_score)}</td>
  </tr>`).join(''));
}

async function loadDex() {
  try {
    const d = await api('/v1/dex/markets', { limit: 80, sort: state.dexSort }, 15000);
    state.dex = d.markets ?? [];
    state.dexError = null;
    renderDex();
  } catch (e) {
    state.dex = [];
    state.dexError = e?.message || 'DEX 数据加载失败';
    renderDex();
    throw e;
  }
}

function renderDex() {
  const body = $('dex-body');
  if (!body) return;
  if (state.dexError) {
    setText('dex-count', '—');
    setText('dex-liq', '—');
    setText('dex-vol', '—');
    setText('dex-risk', '—');
    setText('dex-fresh', '连接失败');
    setHTML(body, `<tr><td colspan="8" class="empty-cell"><div class="table-error"><b>DEX 数据加载失败</b><span>${esc(state.dexError)}</span><button class="primary-btn" data-dex-retry>重试</button></div></td></tr>`);
    return;
  }
  const rows = state.dex;
  setText('dex-count', fmtInt(rows.length));
  setText('dex-liq', `$${fmtSol(rows.reduce((a, r) => a + (Number(r.liquidity_usd) || 0), 0))}`);
  setText('dex-vol', `$${fmtSol(rows.reduce((a, r) => a + (Number(r.volume_24h_usd) || 0), 0))}`);
  const knownRisk = rows.filter((r) => r.risk_score != null).length;
  setText('dex-risk', `${fmtInt(rows.filter((r) => Number(r.risk_score) >= 60).length)} / ${fmtInt(knownRisk)}`);
  const freshestTs = rows.reduce((m, r) => Math.max(m, Number(r.ts) || 0), 0);
  setText('dex-fresh', freshestTs ? `${fmtAgeMs(Date.now() - freshestTs)}前` : '—');
  if (!rows.length) {
    setHTML(body, '<tr><td colspan="8" class="empty-cell">暂无 DEX 快照 · 等待迁移或运行 npm run dex</td></tr>');
    return;
  }
  setHTML(body, rows.map((r) => `<tr class="clickable" data-address="${esc(r.mint)}">
    <td><div class="sym-cell">${esc(r.symbol || shortAddr(r.mint, 5, 4))}</div><div class="wallet-sub">${esc(r.name || '').slice(0, 24)}</div></td>
    <td class="dim">${esc(r.dex_id || '—')}</td>
    <td class="r dim">${r.migrated_at ? fmtAgeMs(Date.now() - r.migrated_at) : '—'}</td>
    <td class="r">${r.price_usd == null ? '—' : `$${fmtPrice(r.price_usd)}`}</td>
    <td class="r ${cls(r.price_change_24h)}">${fmtPct(r.price_change_24h)}</td>
    <td class="r">${r.liquidity_usd == null ? '—' : `$${fmtSol(r.liquidity_usd)}`}</td>
    <td class="r">${r.volume_24h_usd == null ? '—' : `$${fmtSol(r.volume_24h_usd)}`}</td>
    <td class="r ${Number(r.risk_score) >= 60 ? 'down' : 'dim'}" title="${r.risk_score == null ? '风险数据未补全' : 'RugCheck / holders 风险分'}">${r.risk_score == null ? '—' : Math.round(r.risk_score)}</td>
  </tr>`).join(''));
}

function renderWalletDetail() {
  const box = $('wallet-detail-body');
  if (!box) return;
  const d = state.walletDetail;
  if (!d?.profile) {
    setText('wallet-detail-title', '点击上方钱包');
    setText('wallet-detail-meta', '');
    setHTML(box, '<div class="empty-state">选择钱包查看最近交易</div>');
    return;
  }
  const p = d.profile;
  setText('wallet-detail-title', shortAddr(d.address, 8, 6));
  setText('wallet-detail-meta', `${fmtInt(p.trades)} 笔 · ${fmtInt(p.tokens_traded)} 币 · 更新 ${fmtAgeMs(Date.now() - p.updated_at)}前`);
  const summary = [
    ['实现盈亏', `${(Number(p.realized_proxy_sol) || 0).toFixed(3)} SOL`],
    ['胜率', `${((Number(p.win_rate) || 0) * 100).toFixed(1)}%`],
    ['平均峰值', `${Number(p.avg_peak_x || 0).toFixed(2)}x`],
    ['OOS', `${p.oos_trades} 笔 / ${((Number(p.oos_win_rate) || 0) * 100).toFixed(0)}%`],
    ['中位持仓', p.median_hold_sec == null ? '—' : fmtAge(p.median_hold_sec)],
    ['可复制性', `${((Number(p.copyability) || 0) * 100).toFixed(0)}%`],
  ];
  const trades = d.trades ?? [];
  setHTML(box, `
    <div class="wallet-summary">${summary.map(([k, v]) => `<div class="wallet-stat"><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>
    <div class="filter-chips" style="margin-bottom:8px">${labelChips(p.labels)}</div>
    <div class="table-wrap" style="max-height:260px">
      <table class="data-table compact">
        <thead><tr><th>时间</th><th>方向</th><th>代币</th><th class="r">SOL</th><th class="r">市值</th><th class="r">峰值</th></tr></thead>
        <tbody>${trades.length ? trades.map((t) => `<tr>
          <td class="dim">${fmtClock(t.ts)}</td>
          <td><span class="side-pill ${t.side === 'buy' ? 'buy' : 'sell'}">${t.side === 'buy' ? 'BUY' : 'SELL'}</span></td>
          <td class="sym-cell">${esc(t.symbol || shortAddr(t.mint, 4, 4))}</td>
          <td class="r">${fmtSol(t.sol_amount, 3)}</td>
          <td class="r">${fmtSol(t.market_cap_sol)}◎</td>
          <td class="r">${t.peak_x == null ? '—' : `${Number(t.peak_x).toFixed(2)}x`}</td>
        </tr>`).join('') : '<tr><td colspan="6" class="empty-cell">暂无交易</td></tr>'}</tbody>
      </table>
    </div>`);
}

async function loadStrategy() {
  if (state.strategy) return;
  state.strategy = await api('/v1/strategy');
  setText('strategy-version', state.strategy.version ?? '—');
  renderSignalCard();
}

async function loadValidation(force = false) {
  if (!force && state.validation?.at && Date.now() - state.validation.at < 25_000) {
    renderValidationMini();
    return;
  }
  const d = await api('/v1/validation/latest', {}, 15000);
  state.validation = { at: Date.now(), available: d.available, report: d.report };
  renderValidationMini();
  renderValidationView();
  renderSignalCard();
}

/* ---------- 控制台 ---------- */

function kvHtml(items) {
  return items.map(([k, v, tone]) => `<div class="kv"><span>${esc(k)}</span><b class="${tone ?? ''}">${esc(v ?? '—')}</b></div>`).join('');
}

function renderConsole() {
  const c = state.console;
  if (!c) return;
  const s = c.server ?? {};
  const d = c.data ?? {};
  setText('console-uptime', `UP ${fmtAge(s.uptimeSec)}`);
  setHTML($('console-system'), kvHtml([
    ['运行时长', fmtAge(s.uptimeSec)],
    ['内存', `${s.memoryMb ?? '—'} MB`],
    ['端口', s.port],
    ['数据库', shortAddr(s.db, 10, 8)],
    ['HALT', c.halt ? 'ON' : 'OFF', c.halt ? 'down' : 'up'],
    ['验证', c.validation?.verdict ?? '—', c.validation?.verdict === 'GO_LIVE' ? 'up' : 'warn'],
  ]));
  setHTML($('console-data'), kvHtml([
    ['代币', fmtInt(d.tokens)],
    ['成交', fmtInt(d.trades)],
    ['风险记录', `${fmtInt(d.risk)} / 高危 ${fmtInt(d.highRisk)}`, Number(d.highRisk) > 0 ? 'warn' : ''],
    ['Holder 行', fmtInt(d.holders)],
    ['社交', fmtInt(d.social)],
    ['Dev', fmtInt(d.devs)],
    ['1m K线', fmtInt(d.candles)],
    ['DEX 快照', fmtInt(d.dex)],
    ['钱包画像', fmtInt(d.wallets)],
  ]));
  setHTML($('console-health'), kvHtml([
    ['数据延迟', d.dataAgeSec == null ? '—' : fmtAge(d.dataAgeSec), d.dataAgeSec > 120 ? 'warn' : 'up'],
    ['采集/新币', d.ingestAgeSec == null ? '—' : fmtAge(d.ingestAgeSec), d.ingestAgeSec > 180 ? 'down' : 'up'],
    ['Runner', c.runner?.running ? `PID ${c.runner.pid}` : '停止', c.runner?.running ? 'up' : 'dim'],
    ['DB 大小', d.dbSize == null ? '—' : `${(d.dbSize / 1024 / 1024).toFixed(1)} MB`],
    ['日志大小', d.logSize == null ? '—' : `${(d.logSize / 1024 / 1024).toFixed(1)} MB`],
  ]));
  const halt = $('console-halt-pill');
  if (halt) {
    halt.dataset.state = c.halt ? 'bad' : 'live';
    const span = halt.querySelector('span');
    if (span) span.textContent = c.halt ? 'HALT ON' : 'HALT OFF';
  }
  setText('console-active-job', c.activeJob ? `${c.activeJob.action} · ${c.activeJob.status}` : '空闲');
  setText('console-job-count', `${(c.jobs ?? []).length} 条`);
  setText('console-runner', c.runner?.running ? `RUNNER ${c.runner.pid}` : 'RUNNER OFF');
  renderConsoleJobs(c.jobs ?? []);
  loadExperiments().catch(() => {});
  loadShadow().catch(() => {});
  if (!state.events.length) state.events = c.events ?? [];
  renderEvents();
}

async function loadExperiments() {
  const d = await api('/v1/experiments/latest', {}, 8000);
  state.experiments = d?.available ? d.report : null;
  renderExperiments();
}

async function loadLive() {
  const [status, orders, positions, perf] = await Promise.all([
    api('/v1/live/status', {}, 12000),
    api('/v1/orders', {}, 12000),
    api('/v1/positions', {}, 12000),
    api('/v1/performance', {}, 12000),
  ]);
  state.live = status;
  state.liveOrders = orders.orders ?? [];
  state.livePositions = positions.positions ?? [];
  state.livePerf = perf;
  renderLive();
}

function equitySvg(points, width = 560, height = 112) {
  const vals = (points || []).map((p) => Number(p.pnl) || 0);
  if (vals.length < 2) return '<div class="empty-state">样本不足</div>';
  let lo = Math.min(0, ...vals);
  let hi = Math.max(0, ...vals);
  if (hi === lo) hi = lo + 1;
  const pad = 8;
  const x = (i) => pad + (i / (vals.length - 1)) * (width - pad * 2);
  const y = (v) => height - pad - ((v - lo) / (hi - lo)) * (height - pad * 2);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(vals.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg class="equity-svg ${up ? 'up' : 'down'}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <line x1="${pad}" y1="${y(0).toFixed(1)}" x2="${width - pad}" y2="${y(0).toFixed(1)}" class="equity-zero"/>
    <path d="${area}" class="equity-area"/>
    <path d="${line}" class="equity-line"/>
    <circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(vals[vals.length - 1]).toFixed(1)}" r="2.4" class="equity-dot"/>
  </svg>`;
}

function renderLivePerformance() {
  const p = state.livePerf;
  if (!p) {
    setText('live-perf-fresh', '—');
    setHTML($('live-equity-chart'), '<div class="empty-state">暂无数据</div>');
    setHTML($('live-perf-list'), '<div class="empty-state">暂无数据</div>');
    return;
  }
  setText('live-perf-fresh', p.generatedAt ? `${fmtAgeMs(Date.now() - p.generatedAt)}前` : '—');
  const agg = p.aggregate ?? [];
  const total = agg.length ? Number(agg[agg.length - 1].pnl) : 0;
  const gross = Object.values(p.summary ?? {}).reduce((a, x) => a + (Number(x?.grossPnlSol) || 0), 0);
  const costs = Object.values(p.summary ?? {}).reduce((a, x) => a + (Number(x?.costSol) || 0), 0);
  setHTML($('live-equity-chart'), `${equitySvg(agg)}
    <div class="perf-total ${total >= 0 ? 'up' : 'down'}">${total >= 0 ? '+' : ''}${total.toFixed(4)} SOL <span>净 · 已平仓</span></div>
    <div class="perf-cost">毛 ${gross >= 0 ? '+' : ''}${gross.toFixed(4)} · 成本 ${costs.toFixed(4)} SOL</div>`);
  const names = { crash: 'crash 0.02', crash_005: 'crash 0.05', wallet: 'wallet copy', wallet_conf: 'wallet ≥2', wallet_conf_q: 'wallet q≥2', dex: 'dex migration' };
  const books = Object.entries(p.books ?? {});
  setHTML($('live-perf-list'), books.length ? books.map(([k, v]) => {
    const s = p.summary?.[k] ?? {};
    const dep = s.topTradeShare != null && s.topTradeShare > 0.5;
    return `<div class="perf-row">
      <span class="p-name" title="gross=${Number(s.grossPnlSol ?? 0).toFixed(4)} cost=${Number(s.costSol ?? 0).toFixed(4)} avg=${(Number(s.avgCostPct ?? 0) * 100).toFixed(1)}%">${esc(names[k] ?? k)}${dep ? ' ⚠' : ''}</span>
      <span class="p-spark">${equitySvg(v.points, 120, 30)}</span>
      <b class="${v.pnlSol >= 0 ? 'up' : 'down'}">${Number(v.pnlSol).toFixed(4)}</b>
      <span class="dim">${s.closed ?? v.trades} 平</span>
      <span class="dim">exBest ${Number(s.pnlExBestSol ?? 0).toFixed(4)}</span>
    </div>`;
  }).join('') : '<div class="empty-state">暂无 shadow</div>');
}

function renderLive() {
  const d = state.live;
  const statusEl = $('exec-status');
  if (!d) {
    setText('exec-status', '—');
    setText('exec-reason', '执行状态加载失败');
    setHTML($('exec-checks'), '<div class="empty-state">—</div>');
    return;
  }
  const halt = d.status === 'HALT';
  const clsName = halt ? 'halt' : d.ready ? 'ready' : d.dryRun ? 'dry' : 'locked';
  if (statusEl) {
    statusEl.className = `exec-status ${clsName}`;
    statusEl.textContent = halt ? 'HALT' : d.ready ? 'LIVE READY' : d.dryRun ? 'DRY RUN' : 'LIVE LOCKED';
  }
  const failed = (d.checks ?? []).filter((c) => !c.pass);
  setText('exec-reason', d.ready
    ? '所有门禁通过；仍需从极小资金开始。'
    : failed.length
      ? `未通过：${failed.map((c) => c.label).join(' · ')}`
      : '尚未配置实盘门禁。');
  setText('exec-network', `${d.network ?? '—'} · ${d.dryRun ? 'DRY RUN' : 'LIVE'}`);
  setHTML($('exec-checks'), (d.checks ?? []).map((c) => `<div class="exec-check ${c.pass ? 'pass' : 'fail'}">
    <span>${c.pass ? '✓' : '×'}</span><b>${esc(c.label)}</b><em>${esc(c.detail)}</em>
  </div>`).join(''));

  setHTML($('exec-wallet'), [
    ['网络', esc(d.network ?? '—')],
    ['钱包', d.publicKey ? `<span class="mono">${esc(shortAddr(d.publicKey, 6, 6))}</span>` : '未配置'],
    ['RPC', d.rpcConfigured ? '已配置' : '未配置'],
    ['ALLOW_LIVE', d.allowLive ? 'ON' : 'OFF'],
    ['DRY_RUN', d.dryRun ? 'ON' : 'OFF'],
    ['来源', d.walletSource ?? '—'],
  ].map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join(''));

  const r = d.risk ?? {};
  setHTML($('exec-risk'), [
    ['单笔上限', `${Number(r.maxSolPerTrade ?? 0).toFixed(3)} SOL`],
    ['组合上限', `${Number(r.maxPortfolioSol ?? 0).toFixed(3)} SOL`],
    ['最大持仓', fmtInt(r.maxPositions)],
    ['日亏上限', `${(Number(r.dailyLossPct ?? 0) * 100).toFixed(0)}%`],
    ['HALT', d.halt ? 'ON' : 'OFF'],
  ].map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join(''));

  const rec = d.reconcile;
  setText('exec-reconcile-fresh', rec?.generatedAt ? `${fmtAgeMs(Date.now() - new Date(rec.generatedAt).getTime())}前` : '未运行');
  setHTML($('exec-reconcile'), [
    ['状态', rec ? (rec.ok ? '通过' : '不平') : '未运行'],
    ['UNKNOWN 订单', fmtInt(d.orderCounts?.UNKNOWN ?? 0)],
    ['孤儿仓', fmtInt(rec?.report?.orphanPositions?.length ?? 0)],
    ['缺失仓', fmtInt(rec?.report?.missingPositions?.length ?? 0)],
    ['订单总数', fmtInt(Object.values(d.orderCounts ?? {}).reduce((a, b) => a + Number(b || 0), 0))],
  ].map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join(''));

  renderLivePerformance();

  setText('exec-orders-count', `${state.liveOrders.length} 笔`);
  setHTML($('exec-orders-body'), state.liveOrders.length ? state.liveOrders.map((o) => `<tr>
    <td class="dim">${fmtClock(o.created_at)}</td>
    <td class="mono">${esc(shortAddr(o.mint, 5, 4))}</td>
    <td><span class="side-pill ${o.side === 'buy' ? 'buy' : 'sell'}">${(o.side || '').toUpperCase()}</span></td>
    <td class="r">${fmtSol(o.sol, 4)}</td>
    <td><span class="order-state ${esc(o.state)}">${esc(o.state)}</span></td>
    <td class="mono dim">${o.sig ? esc(shortAddr(o.sig, 6, 4)) : '—'}</td>
    <td class="dim">${esc(o.reason || '—')}</td>
  </tr>`).join('') : '<tr><td colspan="7" class="empty-cell">暂无订单</td></tr>');

  setText('exec-positions-count', `${state.livePositions.length} 个`);
  setHTML($('exec-positions-body'), state.livePositions.length ? state.livePositions.map((p) => `<tr>
    <td><b>${esc(p.symbol || shortAddr(p.mint, 5, 4))}</b></td>
    <td class="r">${fmtSol(p.cost_sol, 4)}◎</td>
    <td class="r">${fmtSol(p.entry_mcap)}◎</td>
    <td class="r">${fmtSol(p.current_mcap)}◎</td>
    <td class="r ${cls(p.pnl_pct)}">${fmtPct(p.pnl_pct)}</td>
  </tr>`).join('') : '<tr><td colspan="5" class="empty-cell">暂无持仓</td></tr>');

  setHTML($('exec-checklist'), [
    ['钱包 public key', Boolean(d.publicKey), d.publicKey ? '只读地址，不暴露私钥' : '未配置'],
    ['RPC', Boolean(d.rpcConfigured), d.rpcConfigured ? '已配置' : '未配置'],
    ['dry-run 安全默认', d.dryRun, d.dryRun ? 'ON · 不广播' : 'OFF · 会广播'],
    ['实际成交解析', true, 'tx meta 余额差已接入 Executor'],
    ['启动对账', rec?.ok === true, rec ? (rec.ok ? '通过' : '不平') : '运行 npm run reconcile:live'],
    ['UNKNOWN 订单 = 0', Number(d.orderCounts?.UNKNOWN ?? 0) === 0, `${d.orderCounts?.UNKNOWN ?? 0} 笔`],
    ['HALT 关闭', !d.halt, d.halt ? '存在 HALT' : 'OFF'],
    ['Venue Router', false, 'pump → Jupiter 已接入，待实测'],
    ['Devnet / local validator 自检', false, '待运行'],
  ].map(([label, pass, detail]) => `<div class="check-row ${pass ? 'pass' : 'fail'}"><span>${pass ? '✓' : '×'}</span><b>${esc(label)}</b><em>${esc(detail)}</em></div>`).join('') +
    '<p class="exec-note">Testnet/devnet 只验证交易管道；策略有效性必须由主网 OOS 和 forward shadow 证明。</p>');
}

async function loadShadow() {
  const d = await api('/v1/shadow', {}, 8000);
  state.shadow = d;
  renderShadow();
}

function renderShadow() {
  const box = $('console-shadow');
  if (!box) return;
  const d = state.shadow;
  if (!d) {
    setText('console-shadow-fresh', '—');
    setHTML(box, '<div class="empty-state">shadow 未运行</div>');
    return;
  }
  const names = { crash: 'crash 30m', crash_005: 'crash 0.05', wallet: 'wallet copy', wallet_conf: 'wallet ≥2', wallet_conf_q: 'wallet q≥2', dex: 'dex migration' };
  const rows = Object.entries(d).filter(([, v]) => v?.available);
  setText('console-shadow-fresh', rows.length ? 'LIVE' : '未运行');
  setHTML(box, rows.length
    ? rows.map(([k, v]) => {
        const dep = v.topTradeShare != null && v.topTradeShare > 0.5;
        const tip = `best=${Number(v.bestPnlSol || 0).toFixed(4)} exBest=${Number(v.pnlExBestSol || 0).toFixed(4)} median=${Number(v.medianPnlSol || 0).toFixed(4)}${dep ? ` top=${Math.round(v.topTradeShare * 100)}%` : ''}`;
        return `<div class="exp-row" title="${esc(tip)}">
        <span class="e-name">${esc(names[k] ?? k)}${dep ? ' ⚠' : ''}</span>
        <b class="${v.pnlSol > 0 ? 'up' : 'down'}">${Number(v.pnlSol).toFixed(4)}</b>
        <b>${v.closed} 平 / ${v.open} 开</b>
        <b>${Math.round((v.winRate || 0) * 100)}%</b>
      </div>`;
      }).join('')
    : '<div class="empty-state">shadow 未运行</div>');
}

function renderExperiments() {
  const box = $('console-experiments');
  if (!box) return;
  const r = state.experiments;
  if (!r) {
    setText('console-exp-verdict', '—');
    setHTML(box, '<div class="empty-state">运行策略实验</div>');
    return;
  }
  setText('console-exp-verdict', r.verdict ?? '—');
  const rows = (r.results ?? []).slice(0, 6);
  setHTML(box, rows.map((x) => `<div class="exp-row">
    <span class="e-name">${esc(x.label)}</span>
    <b class="${Number(x.expectancySol) > 0 ? 'up' : 'down'}">${Number(x.expectancySol ?? 0).toFixed(4)}</b>
    <b>PF ${Number(x.profitFactor ?? 0).toFixed(2)}</b>
    <b>${Math.round((Number(x.winRate) || 0) * 100)}%</b>
  </div>`).join('') || '<div class="empty-state">无结果</div>');
}

function renderConsoleJobs(jobs) {
  const box = $('console-jobs');
  if (!box) return;
  state.consoleJobs = jobs;
  if (!jobs.length) {
    setHTML(box, '<div class="empty-state">暂无任务</div>');
    return;
  }
  setHTML(box, jobs.map((j) => `<div class="job-row" data-job="${esc(j.id)}">
    <span class="j-action">${esc(j.action)}</span>
    <span class="j-status ${esc(j.status)}">${esc(j.status)}</span>
    <span class="dim">${j.endedAt ? fmtAgeMs(Date.now() - j.endedAt) + '前' : '进行中'}</span>
  </div>`).join(''));
}

async function loadJobLog(id) {
  const d = await api('/v1/console/job', { id, lines: 160 }, 8000);
  const box = $('console-job-log');
  if (box) {
    box.textContent = d.logTail || '（无日志）';
    box.scrollTop = box.scrollHeight;
  }
}

async function loadConsole() {
  const c = await api('/v1/console/status', {}, 12000);
  state.console = c;
  renderConsole();
  const active = c.activeJob;
  if (active) {
    await loadJobLog(active.id).catch(() => {});
    pollActiveJob(active.id);
  }
}

let consolePoll = null;
function pollActiveJob(id) {
  if (consolePoll) return;
  consolePoll = setInterval(async () => {
    try {
      const d = await api('/v1/console/job', { id, lines: 160 }, 8000);
      const box = $('console-job-log');
      if (box) {
        box.textContent = d.logTail || '（无日志）';
        box.scrollTop = box.scrollHeight;
      }
      if (d.status !== 'running') {
        clearInterval(consolePoll);
        consolePoll = null;
        toast(`任务 ${d.action} ${d.status}`);
        loadConsole().catch(() => {});
        loadWallets().catch(() => {});
        loadValidation(true).catch(() => {});
        if (state.selected) loadSelected(true).catch(() => {});
      }
    } catch {
      clearInterval(consolePoll);
      consolePoll = null;
    }
  }, 2000);
}

async function runConsoleAction(action, extra = {}) {
  const res = await fetch('/v1/console/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
  const json = await res.json();
  let d = json?.data;
  if (d && typeof d === 'object' && 'code' in d && 'data' in d) d = d.data;
  if (!d || d.error) throw new Error(d?.error ?? 'action failed');
  if (d.job) {
    toast(`${action} 已启动`);
    state.consoleJob = d.job.id;
    loadJobLog(d.job.id).catch(() => {});
    pollActiveJob(d.job.id);
  } else {
    toast(`${action} 完成`);
  }
  loadConsole().catch(() => {});
  return d;
}

function pushEvent(evt) {
  state.events.unshift(evt);
  state.events = state.events.slice(0, 120);
  renderEvents();
}

function renderEvents() {
  const box = $('console-events');
  if (!box) return;
  if (!state.events.length) {
    setHTML(box, '<div class="empty-state">暂无事件</div>');
    return;
  }
  setHTML(box, state.events.map((e) => `<div class="event-row ${esc(e.level ?? 'info')}" ${e.detail ? `data-address="${esc(e.detail)}"` : ''}>
    <span class="e-type">${esc(e.type)}</span>
    <span class="e-title">${esc(e.title)}</span>
    <span class="e-time">${fmtClock(e.ts)}</span>
  </div>`).join(''));
}

function connectStream() {
  if (state.stream) return;
  if (!window.EventSource) {
    setText('console-stream-status', 'NO SSE');
    return;
  }
  const es = new EventSource('/v1/stream');
  state.stream = es;
  es.addEventListener('hello', () => setText('console-stream-status', 'SSE LIVE'));
  es.addEventListener('signal', (e) => {
    const d = JSON.parse(e.data);
    pushEvent({
      type: 'signal',
      ts: d.ts,
      level: d.tier === 'A' ? 'high' : 'info',
      title: `${d.tier} ${d.score} · ${d.symbol || shortAddr(d.mint, 4, 4)}`,
      detail: d.mint,
    });
    clearTimeout(state.signalRefreshTimer);
    state.signalRefreshTimer = setTimeout(() => {
      loadSignals().catch(() => {});
      loadOverview().catch(() => {});
    }, 800);
  });
  es.addEventListener('migration', (e) => {
    const d = JSON.parse(e.data);
    pushEvent({ type: 'migration', ts: d.ts, level: 'info', title: `${d.symbol || shortAddr(d.mint, 4, 4)} → ${d.pool || 'dex'}`, detail: d.mint });
  });
  es.addEventListener('risk', (e) => {
    const d = JSON.parse(e.data);
    pushEvent({ type: 'risk', ts: d.ts, level: 'high', title: `风险 ${Math.round(d.risk_score)} · ${shortAddr(d.mint, 4, 4)}`, detail: d.mint });
  });
  es.addEventListener('health', (e) => {
    const d = JSON.parse(e.data);
    setText('console-stream-status', d.dataAgeSec == null ? 'SSE' : `SSE · ${fmtAge(d.dataAgeSec)}`);
  });
  es.onerror = () => {
    setText('console-stream-status', 'SSE RECONNECT');
  };
}

function setRail(open) {
  state.railOpen = Boolean(open);
  document.body.classList.toggle('rail-open', state.railOpen);
  const toggle = $('rail-toggle');
  const backdrop = $('rail-backdrop');
  const rail = $('right-rail');
  toggle?.setAttribute('aria-expanded', String(state.railOpen));
  if (backdrop) backdrop.hidden = !state.railOpen;
  rail?.classList.toggle('open', state.railOpen);
  if (state.railOpen) {
    setTimeout(() => $('rail-close')?.focus(), 60);
  }
}

function switchView(view) {
  const allowed = new Set(['terminal', 'wallets', 'dex', 'live', 'validation', 'console']);
  state.view = allowed.has(view) ? view : 'terminal';
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${state.view}`));
  if (state.view !== 'terminal' && state.railOpen) setRail(false);
  const railBtn = $('rail-toggle');
  if (railBtn) railBtn.hidden = state.view !== 'terminal';
  const activeView = $(`view-${state.view}`);
  if (activeView) activeView.scrollTop = 0;
  try {
    history.replaceState(
      null,
      '',
      state.view === 'terminal'
        ? (state.selected ? `#token=${encodeURIComponent(state.selected)}` : '#terminal')
        : `#${state.view}`
    );
  } catch { /* ignore */ }
  if (state.view === 'validation') {
    loadValidation(true).catch(() => throttleError('validation', '验证报告加载失败'));
  } else if (state.view === 'wallets') {
    loadWallets().catch(() => throttleError('wallets', '钱包画像加载失败'));
    loadSmart().catch(() => {});
  } else if (state.view === 'dex') {
    loadDex().catch(() => throttleError('dex', 'DEX 数据加载失败'));
  } else if (state.view === 'live') {
    loadLive().catch(() => throttleError('live', '执行状态加载失败'));
  } else if (state.view === 'console') {
    connectStream();
    loadConsole().catch(() => throttleError('console', '控制台加载失败'));
  } else {
    setTimeout(() => drawChart(), 30);
  }
  const resetScroll = () => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    if (activeView) activeView.scrollTop = 0;
  };
  resetScroll();
  setTimeout(resetScroll, 80);
  setTimeout(resetScroll, 260);
  setTimeout(resetScroll, 600);
  setTimeout(resetScroll, 1000);
}

/* ---------- 搜索 ---------- */

function closeSearch() {
  const box = $('search-results');
  if (box) box.hidden = true;
  state.searchItems = [];
  state.searchIndex = -1;
}

function renderSearchResults(results) {
  const box = $('search-results');
  if (!box) return;
  state.searchItems = results;
  if (!results.length) {
    setHTML(box, '<div class="search-empty">没有匹配的代币</div>');
    box.hidden = false;
    return;
  }
  setHTML(box, results.map((r, i) => `<button class="search-item${i === state.searchIndex ? ' active' : ''}" data-index="${i}">
    ${tokenIconHtml(r.symbol, r.address)}
    <span class="si-main"><b>${esc(r.symbol || shortAddr(r.address, 4, 4))}</b><span>${esc(shortAddr(r.address, 8, 8))} · ${esc(r.name || '未命名')}</span></span>
    <span class="si-mcap">${fmtSol(r.market_cap)}◎</span>
  </button>`).join(''));
  box.hidden = false;
}

async function onSearchInput() {
  const input = $('search-input');
  const term = (input?.value ?? '').trim();
  clearTimeout(state.searchTimer);
  if (!term) {
    closeSearch();
    return;
  }
  state.searchTimer = setTimeout(async () => {
    try {
      const d = await api('/v1/search', { q: term }, 6000);
      renderSearchResults(d.results ?? []);
    } catch {
      closeSearch();
    }
  }, 180);
}

/* ---------- 轮询 ---------- */

function startPolling() {
  setInterval(() => {
    if (document.hidden) return;
    guard('overview', () => loadOverview().catch(() => throttleError('overview', '总览接口异常')));
  }, 5000);

  setInterval(() => {
    if (document.hidden || state.view !== 'terminal') return;
    guard('market', () => loadMarket().catch(() => throttleError('market', '市场接口异常')));
  }, 8000);

  setInterval(() => {
    if (document.hidden || state.view !== 'terminal') return;
    guard('selected', () => {
      if (state.selected) return loadSelected(false);
    }).catch?.(() => {});
  }, 7000);

  setInterval(() => {
    if (document.hidden || state.view !== 'terminal') return;
    guard('signals', () => loadSignals().catch(() => {}));
  }, 10_000);

  setInterval(() => {
    if (document.hidden || state.view !== 'terminal') return;
    guard('positions', () => loadPositions().catch(() => {}));
  }, 8000);

  setInterval(() => {
    if (document.hidden) return;
    guard('analytics', () => loadAnalytics().catch(() => {}));
  }, 30_000);

  setInterval(() => {
    if (document.hidden || state.view !== 'validation') return;
    guard('validation', () => loadValidation(true).catch(() => {}));
  }, 30_000);

  setInterval(() => {
    if (document.hidden || state.view !== 'console') return;
    guard('console', () => loadConsole().catch(() => {}));
  }, 6000);

  setInterval(() => {
    if (document.hidden || state.view !== 'wallets') return;
    guard('wallets', () => loadWallets().catch(() => {}));
    guard('smart', () => loadSmart().catch(() => {}));
  }, 15_000);

  setInterval(() => {
    if (document.hidden || state.view !== 'live') return;
    guard('live', () => loadLive().catch(() => {}));
  }, 5000);
}

/* ---------- 事件绑定 ---------- */

function bindEvents() {
  $('market-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    state.marketTab = btn.dataset.tab;
    state.page = 0;
    document.querySelectorAll('#market-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    loadMarket().catch(() => throttleError('market', '市场接口异常'));
  });

  $('market-sort')?.addEventListener('change', (e) => {
    state.sort = e.target.value;
    state.page = 0;
    loadMarket().catch(() => throttleError('market', '排序失败'));
  });

  $('page-prev')?.addEventListener('click', () => {
    if (state.page > 0) { state.page--; loadMarket().catch(() => {}); }
  });
  $('page-next')?.addEventListener('click', () => {
    const pages = Math.max(1, Math.ceil(state.rankTotal / state.pageSize));
    if (state.page < pages - 1) { state.page++; loadMarket().catch(() => {}); }
  });

  $('market-list')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-address]');
    if (row) selectToken(row.dataset.address, row.dataset.symbol || '');
  });
  $('tape-track')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-address]');
    if (row) selectToken(row.dataset.address, row.dataset.symbol || '');
  });
  $('signal-feed')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-address]');
    if (row) selectToken(row.dataset.address, row.dataset.symbol || '');
  });
  $('positions-body')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-address]');
    if (row) selectToken(row.dataset.address, row.dataset.symbol || '');
  });

  $('signal-tiers')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tier]');
    if (!btn) return;
    state.signalTier = btn.dataset.tier;
    document.querySelectorAll('#signal-tiers button').forEach((b) => b.classList.toggle('active', b === btn));
    loadSignals().catch(() => {});
  });

  $('resolution-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-res]');
    if (!btn) return;
    state.resolution = btn.dataset.res;
    document.querySelectorAll('#resolution-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    loadKline().catch(() => throttleError('kline', 'K 线加载失败'));
  });

  $('chart-candle')?.addEventListener('click', () => {
    state.chartMode = 'candle';
    $('chart-candle').classList.add('active');
    $('chart-line').classList.remove('active');
    drawChart();
  });
  $('chart-line')?.addEventListener('click', () => {
    state.chartMode = 'line';
    $('chart-line').classList.add('active');
    $('chart-candle').classList.remove('active');
    drawChart();
  });
  $('chart-price')?.addEventListener('click', () => {
    state.chartValue = 'price';
    $('chart-price').classList.add('active');
    $('chart-mcap').classList.remove('active');
    drawChart();
  });
  $('chart-mcap')?.addEventListener('click', () => {
    state.chartValue = 'mcap';
    $('chart-mcap').classList.add('active');
    $('chart-price').classList.remove('active');
    drawChart();
  });

  $('calc-size')?.addEventListener('input', () => {
    document.querySelectorAll('#calc-presets button').forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === Number($('calc-size').value)));
    renderCalc();
  });
  $('calc-presets')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-size]');
    if (!btn) return;
    $('calc-size').value = btn.dataset.size;
    document.querySelectorAll('#calc-presets button').forEach((b) => b.classList.toggle('active', b === btn));
    renderCalc();
  });

  $('token-risk-badge')?.addEventListener('click', () => {
    if (innerWidth <= 1280) setRail(true);
    else $('token-intel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  $('watch-toggle')?.addEventListener('click', toggleWatch);
  $('copy-mint')?.addEventListener('click', async () => {
    if (!state.selected) return;
    try {
      await navigator.clipboard.writeText(state.selected);
      toast('合约地址已复制');
    } catch {
      toast('复制失败，请手动选择', true);
    }
  });

  $('open-validation')?.addEventListener('click', () => switchView('validation'));
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  $('rail-toggle')?.addEventListener('click', () => setRail(!state.railOpen));
  $('rail-close')?.addEventListener('click', () => setRail(false));
  $('rail-backdrop')?.addEventListener('click', () => setRail(false));

  const search = $('search-input');
  search?.addEventListener('input', onSearchInput);
  search?.addEventListener('focus', () => { if (state.searchItems.length) $('search-results').hidden = false; });
  search?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSearch(); search.blur(); return; }
    if (!state.searchItems.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.searchIndex = Math.min(state.searchItems.length - 1, state.searchIndex + 1);
      renderSearchResults(state.searchItems);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.searchIndex = Math.max(0, state.searchIndex - 1);
      renderSearchResults(state.searchItems);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = state.searchItems[state.searchIndex] ?? state.searchItems[0];
      if (r) {
        selectToken(r.address, r.symbol || '');
        closeSearch();
        search.value = '';
        search.blur();
      }
    }
  });
  $('search-results')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-index]');
    if (!btn) return;
    const r = state.searchItems[Number(btn.dataset.index)];
    if (r) {
      selectToken(r.address, r.symbol || '');
      closeSearch();
      if (search) { search.value = ''; search.blur(); }
    }
  });
  document.addEventListener('click', (e) => {
    if (!$('global-search')?.contains(e.target)) closeSearch();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      e.preventDefault();
      search?.focus();
    }
    if (e.key === 'Escape') {
      if (state.railOpen) { setRail(false); return; }
      closeSearch();
    }
  });

  $('chart')?.addEventListener('mousemove', (e) => {
    const g = state.chartGeom;
    if (!g) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.floor((x - g.padL) / g.step);
    state.hoverIndex = clamp(idx, 0, g.n - 1);
    drawChart();
  });
  $('chart')?.addEventListener('mouseleave', () => {
    state.hoverIndex = null;
    drawChart();
  });

  $('intel-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-intel]');
    if (!btn) return;
    state.intelTab = btn.dataset.intel;
    document.querySelectorAll('#intel-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    renderTokenIntel();
  });
  $('intel-body')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-intel-action="enrich"]');
    if (!btn || !state.selected) return;
    btn.disabled = true;
    btn.textContent = '补全中…';
    try {
      await runConsoleAction('enrich-one', { mint: state.selected });
      toast('已提交补全任务');
    } catch (err) {
      toast(`补全失败：${err.message}`, true);
      btn.disabled = false;
      btn.textContent = '补全当前币';
    }
  });

  $('wallet-modes')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-wmode]');
    if (btn) setWalletMode(btn.dataset.wmode);
  });

  $('wallet-filters')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-label]');
    if (!btn) return;
    state.walletLabel = btn.dataset.label;
    state.walletPage = 0;
    document.querySelectorAll('#wallet-filters button').forEach((b) => b.classList.toggle('active', b === btn));
    loadWallets().catch(() => throttleError('wallets', '钱包加载失败'));
  });
  $('wallet-sort')?.addEventListener('change', (e) => {
    state.walletSort = e.target.value;
    state.walletPage = 0;
    loadWallets().catch(() => {});
  });
  let walletTimer = null;
  $('wallet-search')?.addEventListener('input', (e) => {
    clearTimeout(walletTimer);
    walletTimer = setTimeout(() => {
      state.walletQuery = e.target.value.trim();
      state.walletPage = 0;
      loadWallets().catch(() => {});
    }, 220);
  });
  $('wallet-prev')?.addEventListener('click', () => {
    if (state.walletPage > 0) { state.walletPage--; loadWallets().catch(() => {}); }
  });
  $('wallet-next')?.addEventListener('click', () => {
    const pages = Math.max(1, Math.ceil(state.walletTotal / state.walletPageSize));
    if (state.walletPage < pages - 1) { state.walletPage++; loadWallets().catch(() => {}); }
  });
  $('smart-feed-body')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-address]');
    if (tr) { selectToken(tr.dataset.address, ''); switchView('terminal'); }
  });
  $('smart-side')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-side]');
    if (!btn) return;
    state.smartSide = btn.dataset.side;
    document.querySelectorAll('#smart-side button').forEach((b) => b.classList.toggle('active', b === btn));
    loadSmart().catch(() => {});
  });
  $('dex-sort')?.addEventListener('change', (e) => {
    state.dexSort = e.target.value;
    loadDex().catch(() => {});
  });
  $('dex-refresh')?.addEventListener('click', () => loadDex().catch(() => toast('DEX 刷新失败', true)));
  $('dex-body')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-dex-retry]')) { loadDex().catch(() => {}); return; }
    const tr = e.target.closest('tr[data-address]');
    if (tr) { selectToken(tr.dataset.address, ''); switchView('terminal'); }
  });
  $('wallet-body')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-address]');
    if (tr) loadWalletDetail(tr.dataset.address).catch(() => toast('钱包详情加载失败', true));
  });

  $('live-refresh')?.addEventListener('click', () => loadLive().catch(() => toast('执行状态刷新失败', true)));
  $('console-refresh')?.addEventListener('click', () => loadConsole().catch(() => toast('控制台刷新失败', true)));
  $('console-actions')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'halt' && !confirm('确认触发 HALT？运行器会停止开新仓。')) return;
    btn.disabled = true;
    try {
      await runConsoleAction(action);
    } catch (err) {
      toast(`操作失败：${err.message}`, true);
    } finally {
      btn.disabled = false;
    }
  });
  $('console-jobs')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-job]');
    if (row) loadJobLog(row.dataset.job).catch(() => {});
  });
  $('console-events')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-address]');
    if (row) {
      selectToken(row.dataset.address, '');
      switchView('terminal');
    }
  });

  window.addEventListener('resize', () => {
    if (innerWidth > 1280 && state.railOpen) setRail(false);
    drawChart();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAll().catch(() => {});
  });
  window.addEventListener('hashchange', routeFromHash);
}

function routeFromHash() {
  const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (['validation', 'wallets', 'dex', 'live', 'console'].includes(hash)) {
    switchView(hash);
    return;
  }
  if (hash.startsWith('token=')) {
    const addr = hash.slice('token='.length);
    if (addr && addr !== state.selected) selectToken(addr, '');
    if (state.view !== 'terminal') switchView('terminal');
  }
}

async function refreshAll() {
  await Promise.allSettled([
    loadOverview(),
    loadMarket(),
    loadSignals(),
    loadPositions(),
    loadAnalytics(),
    loadValidation(),
    loadStrategy(),
    loadSelected(false),
  ]);
}

async function init() {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  bindEvents();

  const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (['validation', 'wallets', 'dex', 'live', 'console'].includes(hash)) state.view = hash;
  else if (hash.startsWith('token=')) state.selected = hash.slice('token='.length);

  switchView(state.view);
  connectStream();
  const initial = await Promise.allSettled([
    loadOverview(),
    loadMarket(),
    loadSignals(),
    loadPositions(),
    loadAnalytics(),
    loadStrategy(),
    loadValidation(),
    state.view === 'wallets' ? loadWallets() : Promise.resolve(),
    state.view === 'wallets' ? loadSmart() : Promise.resolve(),
    state.view === 'dex' ? loadDex() : Promise.resolve(),
    state.view === 'console' ? loadConsole() : Promise.resolve(),
  ]);
  const failed = initial.filter((r) => r.status === 'rejected').length;
  if (failed) throttleError('init', `初始化有 ${failed} 个接口失败，请确认 server 已启动`);
  if (state.selected) await loadSelected(true);
  else {
    const first = state.rank[0];
    if (first) selectToken(first.address, first.symbol || '');
  }

  window.scrollTo(0, 0);
  new ResizeObserver(() => drawChart()).observe($('chart-shell'));
  startPolling();

  setInterval(() => {
    const now = new Date();
    const time = now.toLocaleTimeString('zh-CN', { hour12: false });
    setText('clock', time);
    setText('footer-clock', `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${time}`);
  }, 1000);
}

init();
