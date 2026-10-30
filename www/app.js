/* Trend Bot UI + data fetching. DEMO ONLY - no real orders are ever placed. */
const TE = window.TrendEngine;
const KEY = 'trendbot_v1';
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'LINK'];
const TABS = [['home', 'Home'], ['market', 'Market'], ['trades', 'Trades'], ['coins', 'Coins'], ['settings', 'Settings']];

let S = load();
let tab = 'home';
let scanning = false;
let err = '';

function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 1) { s.settings = { ...TE.defaults().settings, ...s.settings }; return s; } } catch (e) {}
  return TE.defaults();
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

/* ---------- data ---------- */
async function klines(sym, tf) {
  try {
    const r = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}USDT&interval=${tf}&limit=300`);
    const j = await r.json();
    if (j.retCode === 0 && j.result.list.length) {
      return j.result.list.slice().reverse().map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
    }
  } catch (e) {}
  const iv = tf === '60' ? '1h' : '15m';
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=${iv}&limit=300`);
  const j = await r.json();
  return j.map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] }));
}

async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    const data = {};
    await Promise.all(COINS.map(async sym => {
      try {
        const [h, m] = await Promise.all([klines(sym, '60'), klines(sym, '15')]);
        if (h.length < 210 || m.length < 60) return;
        const [book, flow] = await Promise.all([fetchBook(sym), fetchFlow(sym)]);
        data[sym] = { price: m[m.length - 1].c, c1h: h.slice(0, -1), c15: m.slice(0, -1), book, flow };
      } catch (e) {}
    }));
    if (!Object.keys(data).length) throw new Error('koi coin ka data nahi aaya');
    if (!S.macro || Date.now() - S.macro.t > 5 * 60e3) await refreshMacro();
    TE.step(S, data, Date.now());
    S.lastScan = Date.now();
    err = '';
    save();
  } catch (e) {
    err = 'Data nahi mila (internet check karo): ' + e.message;
  }
  scanning = false;
  render();
}


/* ---------- macro / news / whale data (each source optional; failures = neutral) ---------- */
const WHALE_MIN = { BTC: 100000, ETH: 50000, SOL: 25000, XRP: 25000, LINK: 15000 };
async function jget(url) { const r = await fetch(url); return r.json(); }
async function tget(url) { const r = await fetch(url); return r.text(); }

async function fetchHeadlines() {
  const feeds = ['https://www.coindesk.com/arc/outboundfeeds/rss/', 'https://cointelegraph.com/rss'];
  const out = [];
  await Promise.all(feeds.map(async u => {
    try {
      const x = new DOMParser().parseFromString(await tget(u), 'text/xml');
      x.querySelectorAll('item').forEach((it, i) => {
        if (i >= 15) return;
        const title = (it.querySelector('title') || {}).textContent || '';
        const d = Date.parse((it.querySelector('pubDate') || {}).textContent || '');
        if (title) out.push({ title: title.trim(), t: isFinite(d) ? d : Date.now() });
      });
    } catch (e) {}
  }));
  return out.sort((a, b) => b.t - a.t).slice(0, 25);
}

async function fetchCoinMacro(sym) {
  const c = { funding: null, buyRatio: null, whaleNet: 0, whaleTotal: 0 };
  const pair = sym + 'USDT';
  try {
    const j = await jget(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${pair}`);
    c.funding = parseFloat(j.result.list[0].fundingRate);
  } catch (e) {}
  try {
    const j = await jget(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${pair}&period=1h&limit=1`);
    c.buyRatio = parseFloat(j.result.list[0].buyRatio);
  } catch (e) {}
  try {
    const j = await jget(`https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=${pair}&limit=1000`);
    for (const t of j.result.list) {
      const v = parseFloat(t.size) * parseFloat(t.price);
      if (v >= WHALE_MIN[sym]) { c.whaleTotal += v; c.whaleNet += t.side === 'Buy' ? v : -v; }
    }
  } catch (e) {}
  return c;
}

async function refreshMacro() {
  const m = { t: Date.now(), mcapChg: null, btcDom: null, fng: null, newsNet: 0, eventRisk: null, headlines: [], trending: [], coins: {} };
  await Promise.all([
    (async () => { try { const j = await jget('https://api.coingecko.com/api/v3/global'); m.mcapChg = j.data.market_cap_change_percentage_24h_usd; m.btcDom = j.data.market_cap_percentage.btc; } catch (e) {} })(),
    (async () => { try { const j = await jget('https://api.coingecko.com/api/v3/search/trending'); m.trending = j.coins.slice(0, 7).map(x => x.item.symbol.toUpperCase()); } catch (e) {} })(),
    (async () => { try { const j = await jget('https://api.alternative.me/fng/?limit=1'); m.fng = parseInt(j.data[0].value, 10); } catch (e) {} })(),
    (async () => { try { const n = TE.newsSummary(await fetchHeadlines(), Date.now()); m.newsNet = n.net; m.eventRisk = n.eventRisk; m.headlines = n.list.slice(0, 6); } catch (e) {} })(),
    ...COINS.map(async sym => { m.coins[sym] = await fetchCoinMacro(sym); })
  ]);
  S.macro = m;
  save();
}


/* ---------- order book + buyer/seller flow (pre-trade checks) ---------- */
async function fetchBook(sym) {
  const mk = (bids, asks) => {
    const mid = (bids[0][0] + asks[0][0]) / 2;
    const dep = lv => lv.slice(0, 50).reduce((a, x) => a + x[0] * x[1], 0);
    return { mid, spreadPct: (asks[0][0] - bids[0][0]) / mid * 100, bids, asks, bidDepth: dep(bids), askDepth: dep(asks) };
  };
  const num = l => l.map(x => [parseFloat(x[0]), parseFloat(x[1])]);
  try {
    const j = await jget(`https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${sym}USDT&limit=200`);
    if (j.retCode === 0) return mk(num(j.result.b), num(j.result.a));
  } catch (e) {}
  try {
    const j = await jget(`https://api.binance.com/api/v3/depth?symbol=${sym}USDT&limit=100`);
    return mk(num(j.bids), num(j.asks));
  } catch (e) { return null; }
}

async function fetchFlow(sym) {
  try {
    const j = await jget(`https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=${sym}USDT&limit=1000`);
    if (j.retCode === 0) {
      let b = 0, t = 0;
      for (const x of j.result.list) { const v = parseFloat(x.size) * parseFloat(x.price); t += v; if (x.side === 'Buy') b += v; }
      if (t > 0) return { buyShare: b / t };
    }
  } catch (e) {}
  try {
    const j = await jget(`https://api.binance.com/api/v3/trades?symbol=${sym}USDT&limit=1000`);
    let b = 0, t = 0;
    for (const x of j) { const v = parseFloat(x.qty) * parseFloat(x.price); t += v; if (!x.isBuyerMaker) b += v; }
    if (t > 0) return { buyShare: b / t };
  } catch (e) {}
  return null;
}

async function lastPrice(sym) {
  try {
    const j = await jget(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}USDT`);
    const p = parseFloat(j.result.list[0].lastPrice); if (p) return p;
  } catch (e) {}
  try { return parseFloat((await jget(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}USDT`)).price); } catch (e) { return null; }
}

/* open trades ka price har 5 second check (stop-loss / $5 target jaldi pakadne ke liye) */
let watching = false;
async function watch() {
  if (watching || scanning || !S.open.length) return;
  watching = true;
  try {
    const prices = {};
    await Promise.all([...new Set(S.open.map(t => t.sym))].map(async sym => { const p = await lastPrice(sym); if (p) prices[sym] = p; }));
    const before = S.open.length;
    TE.tick(S, prices, Date.now());
    save();
    render();
  } catch (e) {}
  watching = false;
}

/* ---------- helpers ---------- */
const fp = p => p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p >= 100 ? p.toFixed(2) : p >= 10 ? p.toFixed(3) : p.toFixed(4);
const sg = n => (n >= 0 ? '+' : '') + n.toFixed(2);
const cl = n => n >= 0 ? 'g' : 'r';
const hhmm = t => new Date(t).toISOString().slice(11, 16);
const hhmmss = t => new Date(t).toISOString().slice(11, 19);
const dmy = t => { const d = new Date(t).toISOString(); return d.slice(5, 10) + ' ' + d.slice(11, 16); };

function stats() {
  const n = S.closed.length, w = S.closed.filter(t => t.win).length;
  return { n, w, l: n - w, rate: n ? Math.round(w / n * 100) : 0, eq: TE.equityNow(S) };
}

const REGIME = {
  BULL: ['b-bull', 'Market UPTREND hai. Sirf LONG trade dhundh raha hoon.', 'sirf LONG'],
  BEAR: ['b-bear', 'Market DOWNTREND hai. Sirf SHORT trade dhundh raha hoon.', 'sirf SHORT'],
  SIDEWAYS: ['b-side', 'Market side mein hai. Abhi trade nahi lunga.', 'koi trade nahi'],
  VOLATILE: ['b-vol', 'Market bahut tez hai. Risk zyada, trade nahi lunga.', 'koi trade nahi']
};

/* ---------- screens ---------- */
function curve() {
  const pts = S.equity.slice(-120).map(p => p.v);
  if (pts.length < 2) return '<div class="empty">Abhi data nahi — bot ON karo</div>';
  const w = 340, h = 120, mn = Math.min(...pts), mx = Math.max(...pts), rg = (mx - mn) || 1;
  const xy = pts.map((v, i) => `${(i / (pts.length - 1) * w).toFixed(1)},${(h - 8 - (v - mn) / rg * (h - 16)).toFixed(1)}`).join(' ');
  const up = pts[pts.length - 1] >= pts[0];
  return `<svg viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${up ? '#22c55e' : '#ff5a5a'}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" points="${xy}"/></svg>`;
}

function home() {
  const s = stats(), pnl = s.eq - S.start, rg = REGIME[S.regime];
  const sub = !S.botOn ? 'Bot band hai — naye trade nahi lega'
    : S.lastScan ? 'Aakhri scan ' + hhmmss(S.lastScan) + ' UTC' : 'Pehla scan ho raha hai...';
  return `
  <div class="head"><h1>Trend Bot</h1><span class="badge b-demo">DEMO</span></div>
  ${err ? `<div class="err">${err}</div>` : ''}
  <div class="card"><div class="small">Demo balance (nakli paisa)</div>
    <div class="big">${s.eq.toFixed(2)}<small>USDT</small></div>
    <div class="${cl(pnl)}" style="margin-top:4px">${sg(pnl)} USDT (${sg(pnl / S.start * 100)}%)</div></div>
  <div class="card"><div class="row"><div><div class="lbl">Bot ${S.botOn ? 'ON' : 'OFF'}</div><div class="small" style="margin-top:4px">${sub}</div></div>
    <button class="sw ${S.botOn ? 'on' : ''}" onclick="toggleBot()" aria-label="bot on off"><i></i></button></div></div>
  <div class="card"><div class="row"><span class="lbl">Market ki situation</span><span class="badge ${rg[0]}">${S.regime}</span></div>
    <div style="margin-top:4px">${rg[1]}</div></div>
  <div class="card"><div class="small" style="margin-bottom:6px">Equity curve</div>${curve()}</div>
  <div class="stats">
    <div class="stat"><b>${s.n}</b><span>trade</span></div>
    <div class="stat"><b>${s.rate}%</b><span>win rate</span></div>
    <div class="stat"><b class="${cl(pnl)}">${sg(pnl)}</b><span>PnL</span></div></div>
  <div class="card"><div class="row"><span>Jeet (win)</span><span class="v g">${s.w}</span></div>
    <div class="row"><span>Haar (loss)</span><span class="v r">${s.l}</span></div>
    <div class="row"><span>Khule trade</span><span class="v">${S.open.length}</span></div></div>`;
}

function market() {
  const b = (S.info || {}).BTC, rg = REGIME[S.regime];
  const rows = [['BULL', 'sirf LONG', 'g'], ['BEAR', 'sirf SHORT', 'r'], ['SIDEWAYS', 'koi trade nahi', 'm'], ['VOLATILE', 'koi trade nahi', 'm']]
    .map(r => `<div class="row ${S.regime === r[0] ? 'active-row' : ''}"><span>${r[0]}</span><span class="v ${r[2]}">${r[1]}</span></div>`).join('');
  return `
  <div class="head"><h1>Market ki situation</h1></div>
  ${err ? `<div class="err">${err}</div>` : ''}
  <div class="card"><div class="row"><span class="badge ${rg[0]}">${S.regime}</span><span class="small">BTC ${b ? fp(b.price) : '--'}</span></div>
    <div style="margin-top:8px">Bot sirf tab long leta hai jab BTC ka 1h trend upar ho, aur short tab jab neeche ho.</div></div>
  <div class="card">
    <div class="row"><span>ADX (trend taqat)</span><span class="v">${b ? b.adx1h.toFixed(1) : '--'}</span></div>
    <div class="row"><span>RSI (15m)</span><span class="v">${b ? b.rsi.toFixed(0) : '--'}</span></div>
    <div class="row"><span>EMA50 / EMA200</span><span class="v">${b ? (b.ema50 / 1000).toFixed(1) + 'k / ' + (b.ema200 / 1000).toFixed(1) + 'k' : '--'}</span></div>
    <div class="row"><span>Volatility (1h)</span><span class="v">${b ? b.atrPct1h.toFixed(2) + '%' : '--'}</span></div></div>
  <div class="card"><div class="lbl" style="margin-bottom:6px">Bot ka dimaag</div>${rows}</div>
  ${khabar()}
  <div class="card"><div class="lbl" style="margin-bottom:6px">Entry ke liye sab chahiye</div>
    1h trend, 15m trend, RSI zone, breakout candle, volume, ATR. Ek bhi fail to trade nahi. Phir khabar/whale/funding filter bhi pass karna hota hai.</div>`;
}


function khabar() {
  const m = S.macro;
  if (!m) return '<div class="card"><div class="lbl">Khabar aur data</div><div class="small" style="margin-top:6px">Abhi load ho raha hai...</div></div>';
  const na = '--';
  const fng = m.fng == null ? na : m.fng + (m.fng < 25 ? ' (darr)' : m.fng > 75 ? ' (laalach)' : '');
  const news = m.newsNet >= 3 ? 'positive' : m.newsNet <= -3 ? 'negative' : 'neutral';
  const heads = (m.headlines || []).slice(0, 4).map(h => `<div class="small" style="padding:4px 0">${h.score > 0 ? '<b class="g">+</b>' : h.score < 0 ? '<b class="r">-</b>' : '·'} ${h.title}</div>`).join('');
  const whales = COINS.map(c => { const k = (m.coins || {})[c]; if (!k || !k.whaleTotal) return `${c}: --`; const r = k.whaleNet / k.whaleTotal; return `${c}: ${r > 0.3 ? 'kharid' : r < -0.3 ? 'bech' : 'barabar'}`; }).join(' · ');
  return `<div class="card"><div class="lbl" style="margin-bottom:6px">Khabar aur data (filter)</div>
    <div class="row"><span>Total market cap 24h</span><span class="v ${m.mcapChg >= 0 ? 'g' : 'r'}">${m.mcapChg == null ? na : sg(m.mcapChg) + '%'}</span></div>
    <div class="row"><span>BTC dominance</span><span class="v">${m.btcDom == null ? na : m.btcDom.toFixed(1) + '%'}</span></div>
    <div class="row"><span>Fear &amp; Greed</span><span class="v">${fng}</span></div>
    <div class="row"><span>Khabron ka mood</span><span class="v ${news === 'positive' ? 'g' : news === 'negative' ? 'r' : ''}">${news}</span></div>
    <div class="row"><span>CPI / Fed ka risk</span><span class="v ${m.eventRisk ? 'r' : 'g'}">${m.eventRisk ? 'HAAN - trade ruke' : 'nahi'}</span></div>
    <div class="row"><span>Trending (CoinGecko)</span><span class="v">${(m.trending || []).slice(0, 4).join(', ') || na}</span></div>
    <div class="small" style="margin-top:6px">Whale flow (Bybit badi trades): ${whales}</div>
    <div style="margin-top:8px">${heads}</div></div>`;
}

function tradeCard(t) {
  const cls = t.side === 'LONG' ? 'c-long' : 'c-short';
  return `<div class="card">
    <div class="trade-top"><div><b>${t.sym}</b><span class="chip ${cls}">${t.side}</span><span class="chip c-lev">${t.lev}x</span></div>
      <b class="${cl(t.pnl)}">${sg(t.pnl)}</b></div>
    <div class="small" style="margin-top:6px">entry ${fp(t.entry)} | ab ${fp(t.price)} | SL ${fp(t.sl)}${t.trailing ? ' (trail)' : ''}</div>
    ${t.why ? `<div class="small" style="margin-top:4px">kyun: ${t.why}</div>` : ''}
    <div class="trade-mid"><div class="small">size ${t.size.toFixed(0)} USDT<br>margin ${t.margin.toFixed(2)} USDT</div>
      <button class="btn" onclick="closeOne(${t.id})">Close</button></div></div>`;
}

function trades() {
  const s = stats();
  const open = S.open.length ? S.open.map(tradeCard).join('') : '<div class="card empty">Koi khula trade nahi</div>';
  const closed = S.closed.slice(0, 40).map(t => `<div class="row" style="border-bottom:1px solid var(--line)">
      <div style="min-width:0"><b>${t.sym}</b> ${t.side} <span class="chip c-lev">${t.lev}x</span><div class="small">${t.reason} · ${dmy(t.closedAt)}</div></div>
      <div class="v ${cl(t.pnl)}">${sg(t.pnl)}<div class="small">${t.win ? 'WIN' : 'LOSS'}</div></div></div>`).join('');
  return `
  <div class="head"><h1>Trades</h1></div>
  <div class="small">Jeet <b class="g">${s.w}</b> · Haar <b class="r">${s.l}</b> · Win rate <b>${s.rate}%</b></div>
  <div class="sec">Khule trade</div>${open}
  <div class="sec">Band hue trade</div>
  <div class="card">${closed || '<div class="empty">Abhi koi band trade nahi</div>'}</div>`;
}

function coins() {
  const rows = COINS.map(sym => {
    const i = (S.info || {})[sym];
    if (!i) return `<div class="card"><b>${sym}</b> <span class="m">--</span></div>`;
    const col = i.kind === 'ok' || i.kind === 'sig' ? 'g' : 'm';
    return `<div class="card coin"><div style="min-width:0"><b style="font-size:18px">${sym}</b> <span class="m">${fp(i.price)}</span>
      <div class="${col}" style="margin-top:4px">${i.text}</div></div>
      <div class="r2">1h ${i.trend1h}<br>RSI ${i.rsi.toFixed(0)}</div></div>`;
  }).join('');
  return `<div class="head"><h1>Coins</h1></div><div class="sub">Bot har coin ke baare mein kya soch raha hai</div>${err ? `<div class="err">${err}</div>` : ''}${rows}`;
}

function settings() {
  const st = S.settings;
  return `
  <div class="head"><h1>Settings</h1></div>
  <div class="card"><div class="row"><span>Mode</span><span class="badge b-demo">DEMO</span></div>
    <div class="row"><span>Market data</span><span class="v">Bybit</span></div>
    <div class="row"><span>Leverage</span><span class="v">${st.lev}x</span></div></div>
  <div class="card">
    <div class="row"><span>Risk per trade</span><span class="v">${st.risk}%</span></div>
    <div class="row"><span>Max khule trade</span><span class="v">${st.maxOpen}</span></div>
    <div class="row"><span>Daily loss limit</span><span class="v">${st.dayLoss}%</span></div>
    <div class="row"><span>Loss ke baad cooldown</span><span class="v">${st.coolMin} min</span></div></div>
  <div class="card">
    <div class="row"><span>Stop = 2 x ATR</span><span class="v">Auto</span></div>
    <div class="row"><span>Max loss per trade</span><span class="v">~${st.maxLossPct}% margin</span></div>
    <div class="row"><span>Profit target</span><span class="v">+${st.tpUSDT} USDT</span></div>
    <div class="row"><span>Trailing stop</span><span class="v">${st.trail ? 'On' : 'Off'}</span></div></div>
  <div class="card"><div class="small" style="margin-bottom:10px">Demo balance reset karo</div>
    <button class="btn" onclick="resetDemo()">Reset 100 USDT</button></div>
  <div class="small">Asli paisa wala mode abhi band hai. Pehle demo mein lagatar profit dekho.</div>`;
}

/* ---------- actions ---------- */
function toggleBot() {
  S.botOn = !S.botOn;
  save(); render();
  if (S.botOn) scan();
}
function closeOne(id) {
  const t = S.open.find(x => x.id === id);
  if (t) { TE.closeTrade(S, t, t.price, 'MANUAL', Date.now()); save(); render(); }
}
function resetDemo() {
  if (!confirm('Demo balance 100 USDT pe reset karein? Saare trade history delete ho jayenge.')) return;
  const on = S.botOn;
  S = TE.defaults(); S.botOn = on;
  save(); render();
}
function go(t) { tab = t; render(); window.scrollTo(0, 0); }

function render() {
  const f = { home, market, trades, coins, settings }[tab];
  document.getElementById('app').innerHTML = f();
  document.getElementById('nav').innerHTML = TABS.map(t => `<button class="${tab === t[0] ? 'on' : ''}" onclick="go('${t[0]}')">${t[1]}</button>`).join('');
}

render();
scan();
setInterval(scan, 30000);
setInterval(watch, 5000);
