// Simulation test: random-walk market with trending phases, checks engine sanity.
const TE = require('../www/engine.js');

let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / 0.7071; };

function makeSeries(n, start) {
  const out = []; let p = start, drift = 0.0004;
  for (let i = 0; i < n; i++) {
    if (i % 500 === 0) drift = (rnd() - 0.45) * 0.0012;
    const o = p, c = p * (1 + drift + gauss() * 0.0025);
    const h = Math.max(o, c) * (1 + rnd() * 0.0015), l = Math.min(o, c) * (1 - rnd() * 0.0015);
    out.push({ t: i * 900000, o, h, l, c, v: 100 + rnd() * 100 + (Math.abs(c - o) / o) * 40000 });
    p = c;
  }
  return out;
}
function to1h(k) {
  const o = [];
  for (let i = 0; i + 3 < k.length; i += 4) {
    const g = k.slice(i, i + 4);
    o.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g[3].c, v: g.reduce((a, x) => a + x.v, 0) });
  }
  return o;
}

const coins = ['BTC', 'ETH', 'SOL'];
const series = {}; coins.forEach((c, i) => series[c] = makeSeries(9000, 100 * (i + 1)));
const S = TE.defaults(); S.botOn = true;

for (let i = 1000; i < 9000; i += 2) {
  const data = {};
  coins.forEach(c => {
    const k = series[c].slice(0, i + 1);
    const closed = k.slice(0, -1);
    const full = closed.length - (closed.length % 4);
    const lc = closed[closed.length - 1], px = k[k.length - 1].c;
    data[c] = { price: px, c1h: to1h(closed.slice(0, full)).slice(-300), c15: closed.slice(-300),
      book: { mid: px, spreadPct: 0.01, bids: [[px * 0.9999, 1e7]], asks: [[px * 1.0001, 1e7]], bidDepth: 1e8, askDepth: 1e8 },
      flow: { buyShare: lc.c > lc.o ? 0.6 : 0.4 } };
  });
  TE.step(S, data, series.BTC[i].t + 1.7e12);
}

const fail = m => { console.error('FAIL:', m); process.exit(1); };
const wins = S.closed.filter(t => t.win).length;
console.log(`trades=${S.closed.length} wins=${wins} open=${S.open.length} balance=${S.balance.toFixed(2)} regime=${S.regime}`);
if (!isFinite(S.balance) || S.balance <= 0) fail('balance broken');
if (S.open.length > S.settings.maxOpen) fail('too many open trades');
if (S.closed.some(t => t.lev !== 20)) fail('leverage must be 20x');
if (S.closed.some(t => !isFinite(t.pnl))) fail('bad pnl');
if (S.open.some(t => t.margin > 100 * 3)) fail('margin sanity');
if (!S.closed.length) fail('simulation produced no trades');
if (S.closed.some(t => t.reason.startsWith('TARGET') && t.pnl < 5)) fail('target closed below +5');
if (S.closed.every(t => !t.why)) fail('trades must carry a why note');
// bot OFF must not open trades
const S2 = TE.defaults();
const d = {}; coins.forEach(c => { const k = series[c].slice(0, 3000); const cl = k.slice(0, -1); d[c] = { price: k[k.length - 1].c, c1h: to1h(cl.slice(0, cl.length - cl.length % 4)).slice(-300), c15: cl.slice(-300) }; });
TE.step(S2, d, Date.now());
if (S2.open.length) fail('bot off opened a trade');
console.log('OK');

// ---- macro filter tests ----
const now = Date.now();
const S3 = TE.defaults();
S3.macro = { t: now, mcapChg: -2.5, newsNet: -4, fng: 50, eventRisk: null, coins: { BTC: { funding: 0.0008, buyRatio: 0.7, whaleNet: 1, whaleTotal: 1 } } };
let b = TE.macroBias(S3, 'BTC', 'LONG');
if (b.score > -2) fail('bearish macro should block LONG, got ' + b.score);
b = TE.macroBias(S3, 'ETH', 'SHORT');
if (b.score < 1) fail('bearish macro should favour SHORT, got ' + b.score);
S3.macro.t = now - 3600e3;
if (!TE.macroBias(S3, 'BTC', 'LONG').stale) fail('old macro must be stale');
const n = TE.newsSummary([
  { title: 'US CPI data due today', t: now - 3600e3 },
  { title: 'Bitcoin ETF inflow hits record high', t: now - 1000 },
  { title: 'Exchange hack drains $50M', t: now - 2000 }], now);
if (!n.eventRisk) fail('CPI headline should flag event risk');
if (n.net !== 0) fail('news net expected 0, got ' + n.net);
console.log('MACRO OK');

// ---- pre-trade confirmation ----
const goodA = { candle: { bull: true, body: 0.7, upWick: 0.1, loWick: 0.2 } };
const deep = { mid: 100, spreadPct: 0.01, bids: [[99.99, 1e5]], asks: [[100.01, 1e5]], bidDepth: 1e7, askDepth: 1e7 };
let c = TE.confirmEntry(goodA, 'LONG', 400, deep, { buyShare: 0.6 });
if (!c.ok) fail('good setup should pass: ' + c.why);
if (TE.confirmEntry({ candle: { bull: false, body: 0.7, upWick: 0.1, loWick: 0.1 } }, 'LONG', 400, deep, { buyShare: 0.6 }).ok) fail('bearish candle must block LONG');
if (TE.confirmEntry(goodA, 'LONG', 400, deep, { buyShare: 0.4 }).ok) fail('sellers dominating must block LONG');
if (TE.confirmEntry(goodA, 'LONG', 400, { ...deep, asks: [[100.01, 1]] }, { buyShare: 0.6 }).ok) fail('thin book must block');
if (TE.confirmEntry(goodA, 'LONG', 400, { ...deep, bidDepth: 1e6, askDepth: 1e7 }, { buyShare: 0.6 }).ok) fail('ask wall must block LONG');
if (TE.confirmEntry(goodA, 'LONG', 400, null, { buyShare: 0.6 }).ok) fail('missing book must block');
if (TE.confirmEntry({ candle: { bull: false, body: 0.7, upWick: 0.2, loWick: 0.1 } }, 'SHORT', 400, deep, { buyShare: 0.4 }).ok !== true) fail('good SHORT should pass');

// ---- stop-loss and +$5 target ----
const mk = (side) => { const S = TE.defaults(); S.open.push({ id: 1, sym: 'BTC', side, lev: 20, entry: 100, price: 100, peak: 100, sl: side === 'LONG' ? 99.5 : 100.5, atr: 5, size: 400, margin: 20, openedAt: 0, trailing: false, pnl: -0.44 }); return S; };
let T = mk('LONG'); TE.tick(T, { BTC: 101.5 }, Date.now());
if (T.open.length || !T.closed[0].reason.startsWith('TARGET')) fail('LONG should hit +5 target');
T = mk('LONG'); TE.tick(T, { BTC: 99.45 }, Date.now());
if (T.open.length || T.closed[0].reason !== 'STOP-LOSS') fail('LONG should stop out');
if (T.closed[0].pnl < -20 * 0.15) fail('loss bigger than ~10-12% of margin: ' + T.closed[0].pnl);
T = mk('SHORT'); TE.tick(T, { BTC: 98.5 }, Date.now());
if (T.open.length || !T.closed[0].reason.startsWith('TARGET')) fail('SHORT should hit +5 target');
T = mk('LONG'); TE.tick(T, { BTC: 100.4 }, Date.now());
if (T.open.length !== 1) fail('trade should stay open inside range');
console.log('CONFIRM/SL/TP OK');
