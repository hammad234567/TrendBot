/* Trend Bot engine - indicators, signal rules, demo trade manager.
   Pure functions (no network, no DOM) so it can be tested in node. */
(function (root) {
  const sum = (a, s, e) => { let t = 0; for (let i = s; i < e; i++) t += a[i]; return t; };

  function ema(a, p) {
    const k = 2 / (p + 1);
    let e = a[0];
    const o = [e];
    for (let i = 1; i < a.length; i++) { e = a[i] * k + e * (1 - k); o.push(e); }
    return o;
  }

  function rsi(c, p = 14) {
    if (c.length < p + 2) return 50;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
    g /= p; l /= p;
    for (let i = p + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
      l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
    }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }

  function trueRanges(k) {
    const tr = [];
    for (let i = 1; i < k.length; i++) {
      tr.push(Math.max(k[i].h - k[i].l, Math.abs(k[i].h - k[i - 1].c), Math.abs(k[i].l - k[i - 1].c)));
    }
    return tr;
  }

  function atr(k, p = 14) {
    if (k.length < p + 2) return 0;
    const tr = trueRanges(k);
    let a = sum(tr, 0, p) / p;
    for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p;
    return a;
  }

  function adx(k, p = 14) {
    if (k.length < p * 2 + 2) return 20;
    const tr = trueRanges(k), pd = [], md = [];
    for (let i = 1; i < k.length; i++) {
      const up = k[i].h - k[i - 1].h, dn = k[i - 1].l - k[i].l;
      pd.push(up > dn && up > 0 ? up : 0);
      md.push(dn > up && dn > 0 ? dn : 0);
    }
    let trS = sum(tr, 0, p), pS = sum(pd, 0, p), mS = sum(md, 0, p);
    const dx = [];
    for (let i = p; i <= tr.length; i++) {
      if (i > p) {
        trS = trS - trS / p + tr[i - 1];
        pS = pS - pS / p + pd[i - 1];
        mS = mS - mS / p + md[i - 1];
      }
      const pdi = 100 * pS / trS, mdi = 100 * mS / trS;
      dx.push(100 * Math.abs(pdi - mdi) / ((pdi + mdi) || 1));
    }
    let a = sum(dx, 0, Math.min(p, dx.length)) / Math.min(p, dx.length);
    for (let i = p; i < dx.length; i++) a = (a * (p - 1) + dx[i]) / p;
    return a;
  }

  /* d = { price, c1h: closed 1h candles, c15: closed 15m candles } (oldest first) */
  function analyze(d) {
    const c1 = d.c1h.map(x => x.c), c15 = d.c15.map(x => x.c);
    const e50 = ema(c1, 50), e200 = ema(c1, 200);
    const E50 = e50[e50.length - 1], E200 = e200[e200.length - 1];
    const last1 = c1[c1.length - 1];
    let trend1h = 'FLAT';
    if (E50 > E200 && last1 > E50) trend1h = 'UP';
    else if (E50 < E200 && last1 < E50) trend1h = 'DOWN';

    const f = ema(c15, 20), s = ema(c15, 50);
    const trend15 = f[f.length - 1] > s[s.length - 1] ? 'UP' : 'DOWN';

    const n = d.c15.length, lastC = d.c15[n - 1];
    const prev = d.c15.slice(Math.max(0, n - 21), n - 1);
    const hh = Math.max(...prev.map(x => x.h));
    const ll = Math.min(...prev.map(x => x.l));
    const vavg = sum(prev.map(x => x.v), 0, prev.length) / prev.length;

    const at15 = atr(d.c15), at1 = atr(d.c1h);
    const rg = (lastC.h - lastC.l) || 1e-12;
    const candle = {
      bull: lastC.c > lastC.o,
      body: Math.abs(lastC.c - lastC.o) / rg,
      upWick: (lastC.h - Math.max(lastC.o, lastC.c)) / rg,
      loWick: (Math.min(lastC.o, lastC.c) - lastC.l) / rg
    };
    return {
      candle,
      price: d.price,
      trend1h, trend15,
      ema50: E50, ema200: E200,
      adx1h: adx(d.c1h),
      rsi15: rsi(c15),
      atr15: at15,
      atrPct15: at15 / d.price * 100,
      atrPct1h: at1 / d.price * 100,
      breakUp: lastC.c > hh,
      breakDn: lastC.c < ll,
      volOk: lastC.v > vavg * 1.2
    };
  }

  /* Market regime is decided from BTC 1h */
  function regimeOf(a) {
    if (a.atrPct1h > 2.2) return 'VOLATILE';
    if (a.adx1h < 18) return 'SIDEWAYS';
    if (a.trend1h === 'UP') return 'BULL';
    if (a.trend1h === 'DOWN') return 'BEAR';
    return 'SIDEWAYS';
  }

  /* Every condition must pass, otherwise no trade */
  function signal(a, regime) {
    if (regime === 'SIDEWAYS') return { side: null, why: 'wait: market sideways' };
    if (regime === 'VOLATILE') return { side: null, why: 'wait: market bahut tez' };
    const up = regime === 'BULL';
    if (a.trend1h !== (up ? 'UP' : 'DOWN')) return { side: null, why: 'wait: 1h trend' };
    if (a.trend15 !== (up ? 'UP' : 'DOWN')) return { side: null, why: 'wait: 15m trend' };
    const r = a.rsi15;
    if (up ? !(r >= 48 && r <= 70) : !(r >= 30 && r <= 52)) {
      return { side: null, why: up ? 'wait: RSI 48-70' : 'wait: RSI 30-52' };
    }
    if (!(up ? a.breakUp : a.breakDn)) return { side: null, why: 'wait: breakout candle' };
    if (!a.volOk) return { side: null, why: 'wait: volume' };
    if (a.atrPct15 < 0.12 || a.atrPct15 > 2) return { side: null, why: 'wait: ATR theek nahi' };
    return { side: up ? 'LONG' : 'SHORT', why: '' };
  }


  /* ---------- macro / news / whale layer (filter only, never forces a trade) ---------- */
  const BULL_KW = /(etf approv|approved|inflow|rally|surge|soar|record high|all-time high|adoption|rate cut|bullish|accumulat|jumps|breakout)/i;
  const BEAR_KW = /(hack|exploit|ban\b|lawsuit|sues|crash|plunge|outflow|sell-?off|tariff|rate hike|bearish|liquidat|dump|fraud|collapse|bankrupt)/i;
  const EVENT_KW = /(\bcpi\b|fomc|fed decision|powell|jobs report|nonfarm|\bnfp\b|inflation data|ppi\b)/i;

  function scoreHeadline(title) {
    let s = 0;
    if (BULL_KW.test(title)) s += 1;
    if (BEAR_KW.test(title)) s -= 1;
    return s;
  }

  /* headlines: [{title, t(ms)}] -> news mood + event risk */
  function newsSummary(headlines, now) {
    let net = 0, eventRisk = null;
    const list = headlines.map(h => {
      const sc = scoreHeadline(h.title);
      net += sc;
      if (!eventRisk && EVENT_KW.test(h.title) && now - h.t < 6 * 3600e3 && now - h.t > -3 * 3600e3) eventRisk = h.title;
      return { title: h.title, t: h.t, score: sc, trump: /trump/i.test(h.title) };
    });
    return { list, net, eventRisk };
  }

  const MACRO_MAX_AGE = 20 * 60e3;

  /* score for taking `side` on `sym`; <= -2 blocks the trade */
  function macroBias(S, sym, side) {
    const m = S.macro;
    if (!m || !m.t || Date.now() - m.t > MACRO_MAX_AGE) return { score: 0, notes: [], stale: true };
    const dir = side === 'LONG' ? 1 : -1;
    let score = 0; const notes = [];
    const add = (v, txt) => { score += v; notes.push((v > 0 ? '+' : '') + v + ' ' + txt); };

    if (m.mcapChg != null) {
      if (m.mcapChg > 1) add(dir, 'market cap upar (' + m.mcapChg.toFixed(1) + '%)');
      else if (m.mcapChg < -1) add(-dir, 'market cap neeche (' + m.mcapChg.toFixed(1) + '%)');
    }
    if (m.newsNet >= 3) add(dir, 'khabrein positive');
    else if (m.newsNet <= -3) add(-dir, 'khabrein negative');
    if (m.fng != null) {
      if (dir === 1 && m.fng > 80) add(-1, 'extreme greed (' + m.fng + ')');
      if (dir === -1 && m.fng < 20) add(-1, 'extreme fear (' + m.fng + ')');
    }
    const c = (m.coins || {})[sym];
    if (c) {
      if (c.funding != null) {
        if (dir === 1 && c.funding > 0.0005) add(-1, 'funding zyada (longs bhare hue)');
        if (dir === -1 && c.funding < -0.0005) add(-1, 'funding negative (shorts bhare hue)');
      }
      if (c.buyRatio != null) {
        if (dir === 1 && c.buyRatio > 0.65) add(-1, 'long/short ratio crowded long');
        if (dir === -1 && c.buyRatio < 0.35) add(-1, 'long/short ratio crowded short');
      }
      if (c.whaleTotal > 0) {
        const r = c.whaleNet / c.whaleTotal;
        if (r > 0.3) add(dir, 'whale buying');
        else if (r < -0.3) add(-dir, 'whale selling');
      }
    }
    return { score, notes, stale: false };
  }


  /* walk the order book to see how much price moves when we trade `notional` USDT */
  function slippagePct(levels, notional, mid) {
    let need = notional, cost = 0, qty = 0;
    for (const [p, q] of levels) {
      const take = Math.min(need, p * q);
      cost += take; qty += take / p; need -= take;
      if (need <= 1e-9) break;
    }
    if (need > 1e-9 || qty === 0) return Infinity; // book too thin
    return Math.abs(cost / qty - mid) / mid * 100;
  }

  /* Pre-trade check, run AFTER the signal: candle, liquidity, buyers vs sellers */
  function confirmEntry(a, side, size, book, flow) {
    const up = side === 'LONG', c = a.candle, notes = [];
    const okCandle = up ? (c.bull && c.body >= 0.5 && c.upWick <= 0.3) : (!c.bull && c.body >= 0.5 && c.loWick <= 0.3);
    if (!okCandle) return { ok: false, why: 'wait: candle kamzor' };
    notes.push('candle mazboot');
    if (!book) return { ok: false, why: 'wait: liquidity data nahi' };
    if (book.spreadPct > 0.05) return { ok: false, why: 'wait: spread zyada' };
    const slip = slippagePct(up ? book.asks : book.bids, size, book.mid);
    if (slip > 0.05) return { ok: false, why: 'wait: liquidity kam' };
    notes.push('liquidity theek (slip ' + slip.toFixed(3) + '%)');
    const ratio = book.bidDepth / (book.askDepth || 1);
    if (up ? ratio < 0.8 : ratio > 1.25) return { ok: false, why: up ? 'wait: ask wall (sellers bhari)' : 'wait: bid wall (buyers bhari)' };
    notes.push('book ' + (ratio >= 1 ? 'buyers' : 'sellers') + ' ' + ratio.toFixed(2));
    if (!flow) return { ok: false, why: 'wait: buyer/seller data nahi' };
    if (up ? flow.buyShare < 0.52 : flow.buyShare > 0.48) return { ok: false, why: up ? 'wait: sellers zyada' : 'wait: buyers zyada' };
    notes.push('buyers ' + Math.round(flow.buyShare * 100) + '%');
    return { ok: true, notes };
  }

  const FEE = 0.00055; // taker fee per side

  function defaults() {
    const now = Date.now();
    return {
      v: 1, botOn: false, balance: 100, start: 100,
      open: [], closed: [], equity: [{ t: now, v: 100 }],
      cool: {}, day: null, regime: 'SIDEWAYS', info: {}, lastScan: null, nextId: 1,
      settings: { lev: 20, risk: 2, maxOpen: 3, dayLoss: 6, coolMin: 30, atrMult: 2, trail: true, maxLossPct: 10, tpUSDT: 5 }
    };
  }

  function pnlOf(t, price) {
    const dir = t.side === 'LONG' ? 1 : -1;
    return dir * (price - t.entry) / t.entry * t.size - t.size * FEE * 2;
  }

  function closeTrade(S, t, price, reason, now) {
    const pnl = pnlOf(t, price);
    S.balance += pnl;
    S.open = S.open.filter(x => x.id !== t.id);
    S.closed.unshift({
      why: t.why, id: t.id, sym: t.sym, side: t.side, lev: t.lev, entry: t.entry, exit: price,
      size: t.size, pnl, reason, openedAt: t.openedAt, closedAt: now, win: pnl > 0
    });
    if (S.closed.length > 300) S.closed.length = 300;
    if (pnl <= 0) S.cool[t.sym] = now + S.settings.coolMin * 60000;
    S.equity.push({ t: now, v: S.balance + S.open.reduce((a, x) => a + (x.pnl || 0), 0) });
  }


  /* stop-loss / trailing / take-profit for open trades. prices = {SYM: lastPrice} */
  function manage(S, prices, now) {
    const st = S.settings;
    for (const t of [...S.open]) {
      const p = prices[t.sym]; if (!p) continue;
      const dir = t.side === 'LONG' ? 1 : -1;
      if (dir * (p - t.peak) > 0) t.peak = p;
      if (st.trail && dir * (t.peak - t.entry) >= t.atr) {
        const ns = t.peak - dir * t.atr * 1.5;
        if (dir * (ns - t.sl) > 0) { t.sl = ns; t.trailing = true; }
      }
      t.price = p;
      t.pnl = pnlOf(t, p);
      if (st.tpUSDT && t.pnl >= st.tpUSDT) { closeTrade(S, t, p, 'TARGET +' + st.tpUSDT + '$', now); continue; }
      if (dir * (p - t.sl) <= 0) {
        const protectedStop = dir * (t.sl - t.entry) > 0;
        closeTrade(S, t, p, protectedStop ? 'TRAIL' : 'STOP-LOSS', now);
      }
    }
  }

  function tick(S, prices, now) { manage(S, prices, now); return S; }

  function dayKey(now) { return new Date(now).toISOString().slice(0, 10); }

  /* one scan: manage open trades, then look for new entries (only if botOn) */
  function step(S, data, now) {
    const st = S.settings, an = {};
    for (const sym in data) an[sym] = analyze(data[sym]);
    if (an.BTC) S.regime = regimeOf(an.BTC);

    // 1) manage open trades (always, even when bot is off, so stops still work)
    const prices = {}; for (const sym in an) prices[sym] = an[sym].price;
    manage(S, prices, now);

    // 2) day loss limit
    const dk = dayKey(now);
    if (!S.day || S.day.key !== dk) S.day = { key: dk, bal: S.balance };
    const dayBlocked = (S.balance - S.day.bal) <= -(S.day.bal * st.dayLoss / 100);

    // 3) per-coin status + entries
    const info = {};
    for (const sym in an) {
      const a = an[sym];
      const base = {
        price: a.price, trend1h: a.trend1h, rsi: a.rsi15, adx1h: a.adx1h,
        ema50: a.ema50, ema200: a.ema200, atrPct1h: a.atrPct1h
      };
      if (S.open.some(t => t.sym === sym)) { info[sym] = { ...base, text: 'trade chal raha hai', kind: 'ok' }; continue; }
      if ((S.cool[sym] || 0) > now) { info[sym] = { ...base, text: 'cooldown (loss ke baad)', kind: 'wait' }; continue; }
      const sig = signal(a, S.regime);
      if (!sig.side) { info[sym] = { ...base, text: sig.why, kind: 'wait' }; continue; }
      if (!S.botOn) { info[sym] = { ...base, text: 'SIGNAL ' + sig.side + ' (bot off)', kind: 'sig' }; continue; }
      const mb = macroBias(S, sym, sig.side);
      if (S.macro && S.macro.eventRisk && !mb.stale) { info[sym] = { ...base, text: 'wait: khabar ka risk (CPI/Fed)', kind: 'wait' }; continue; }
      if (mb.score <= -2) { info[sym] = { ...base, text: 'wait: macro ulta (' + mb.score + ')', kind: 'wait' }; continue; }
      if (dayBlocked) { info[sym] = { ...base, text: 'aaj ka loss limit lag gaya', kind: 'wait' }; continue; }
      if (S.open.length >= st.maxOpen) { info[sym] = { ...base, text: 'SIGNAL ' + sig.side + ' (max trade full)', kind: 'sig' }; continue; }

      const price = a.price, dir = sig.side === 'LONG' ? 1 : -1;
      // stop: 2xATR, but never more than maxLossPct of margin (10% of margin = 10/lev % price move)
      const stopDist = Math.min(st.atrMult * a.atr15, price * (st.maxLossPct / 100) / st.lev);
      const risk = S.balance * st.risk / 100;
      const size = Math.min(risk / (stopDist / price), S.balance * st.lev / st.maxOpen);
      const margin = size / st.lev;
      const used = S.open.reduce((x, t) => x + t.margin, 0);
      if (size < 5 || margin > S.balance - used) { info[sym] = { ...base, text: 'SIGNAL ' + sig.side + ' (margin kam)', kind: 'sig' }; continue; }
      const cf = confirmEntry(a, sig.side, size, data[sym].book, data[sym].flow);
      if (!cf.ok) { info[sym] = { ...base, text: cf.why, kind: 'wait' }; continue; }

      S.open.push({
        id: S.nextId++, sym, side: sig.side, lev: st.lev, entry: price, price, peak: price,
        sl: price - dir * stopDist, atr: a.atr15, size, margin, openedAt: now, trailing: false,
        why: cf.notes.join(', ') + ' | ' + (mb.notes.length ? mb.notes.join(', ') : (mb.stale ? 'macro data nahi tha' : 'macro neutral')),
        pnl: -size * FEE * 2
      });
      info[sym] = { ...base, text: 'trade chal raha hai', kind: 'ok' };
    }
    S.info = info;

    // 4) equity point
    const eq = S.balance + S.open.reduce((x, t) => x + (t.pnl || 0), 0);
    const lastPt = S.equity[S.equity.length - 1];
    if (!lastPt || now - lastPt.t > 60000) S.equity.push({ t: now, v: eq });
    if (S.equity.length > 400) S.equity.splice(0, S.equity.length - 400);
    return S;
  }

  function equityNow(S) { return S.balance + S.open.reduce((x, t) => x + (t.pnl || 0), 0); }

  const api = { tick, confirmEntry, slippagePct, newsSummary, scoreHeadline, macroBias, ema, rsi, atr, adx, analyze, regimeOf, signal, defaults, step, closeTrade, equityNow, pnlOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TrendEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
