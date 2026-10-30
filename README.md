# Trend Bot (DEMO)

Demo crypto trading bot app. 100 USDT nakli balance, 20x leverage, sirf demo — asli order kabhi nahi jata.

## APK kaise banaye (GitHub se)

1. GitHub pe naya repository banao (e.g. `trend-bot`).
2. Is zip ke andar ki saari files repository mein upload karo (`.github` folder bhi — hidden folder hai, usko zaroor upload karna).
3. Repository mein **Actions** tab kholo -> **Build APK** -> **Run workflow**.
4. 5-8 minute baad run ke andar **Artifacts** mein `TrendBot-apk` download karo, zip kholo, `app-debug.apk` phone mein install karo.

## Bot kaise kaam karta hai

- Coins: BTC, ETH, SOL, XRP, LINK (Bybit public chart data, har 30 second scan).
- Market regime BTC 1h se: BULL (sirf long), BEAR (sirf short), SIDEWAYS / VOLATILE (koi trade nahi).
- Entry ke liye sab chahiye: 1h trend, 15m trend, RSI zone, breakout candle, volume, ATR. Ek bhi fail = trade nahi.
- Signal milne ke baad trade kholne se pehle 3 check: candle mazboot (body bada, wick chhota), liquidity (spread aur order book slippage), buyers vs sellers (order book + taker flow). Fail = trade nahi.
- Stop-loss: 2 x ATR, lekin margin ke ~10% loss se zyada kabhi nahi (20x pe ~0.5% price move). Profit +5 USDT par trade band (target). Trailing stop bhi.
- Open trade ka price har 5 second check hota hai.
- Risk 2% per trade, max 3 khule trade, daily loss limit 6%, loss ke baad 30 min cooldown.
- Fees (0.055% har side) PnL mein shamil hain.
- Home pe ON/OFF switch: OFF = naye trade nahi. Khule trade ka stop-loss phir bhi kaam karta rahta hai.

## Zaroori baatein

- Bot tab chalta hai jab app khula ho. App band = scan band.
- Sirf demo hai. Pehle kai hafte demo result dekho. 20x leverage mein chhoti galti se poora margin ja sakta hai.
- News / X (Twitter) padhne ka feature isme nahi hai (X API paid hai).

## Test

`npm test` — random market pe engine ka simulation test.
