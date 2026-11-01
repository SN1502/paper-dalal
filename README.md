# PaperDalal

A paper trading app for Indian stocks (NSE and BSE) with live prices. Practise intraday and delivery trading with virtual money, real market prices, and the same rules and charges a discount broker applies. No API key or broker account needed.

Built with Expo SDK 58 (React Native 0.88) and TypeScript. Runs on Android and iOS.

## What it does

- **Live prices** for NSE/BSE stocks, ETFs and the Nifty 50, Sensex and Nifty Bank indices, refreshed every 3–15 seconds while the market is open (Yahoo Finance, with Google Finance as an automatic fallback).
- **Order types:** Market, Limit, Stop-loss (SL) and Stop-loss market (SL-M), with modify and cancel.
- **Products:** Intraday (MIS) with configurable leverage (default 5x) and short selling, and Delivery (CNC) where shares settle into Holdings the next day.
- **Exchange rules:** 9:15 AM–3:30 PM IST session, NSE tick sizes (₹0.01 below ₹250, ₹0.05 above), stop-loss trigger checks against the last price, no short selling in CNC, intraday orders blocked after square-off time.
- **Auto square-off** of intraday positions at 3:20 PM (configurable), and unfilled day orders expire at 3:30 PM.
- **After-market orders:** orders placed while the market is closed (evenings, weekends, holidays) queue and execute from the next session's open.
- **Catch-up when the app was closed:** if you had pending orders or open intraday positions, the app replays the 1-minute candles you missed, so limit orders, stop-losses and square-off fill at the prices they would really have filled at.
- **Charges** on every fill: brokerage (₹0 delivery; 0.03% or ₹20 intraday), STT, NSE/BSE transaction charges, SEBI fee, stamp duty, GST, and the DP charge on delivery sells, with a breakdown per trade.
- **Funds and P&L:** available margin, margin in use, funds reserved by open orders, realised/unrealised P&L, account value, and a daily P&L chart.
- **Stop-loss and target exits (GTT):** attach a stop-loss and target to any delivery holding; it sells automatically when either is hit, across days, including while the app was closed (replayed from 1-minute candles).
- **AI trader (Claude):** with your own Anthropic API key, Claude runs a research session each trading morning (optionally again at 2:45 PM). It reads the strategy signals below, searches the news, reads fundamentals, and paper-trades swing positions within hard limits you set.
- **Strategy signals from *151 Trading Strategies*:** a daily multifactor scan of about 130 liquid NSE stocks, built on Kakushadze & Serur's paper ([SSRN 3247865](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3247865)), shown on the Signals screen and on every stock page.
- Watchlist with search, intraday and historical charts (1D to 5Y) you can scrub, light and dark themes, and haptic feedback on fills.

Everything is stored on the phone. Nothing is sent anywhere except price requests.

## The AI trader

1. Create an API key in the Claude Console (platform.claude.com → Settings → API keys) and add credits. Usage is billed to your Anthropic account; the app shows an estimated cost per session and stops automatic sessions at your monthly budget.
2. In the app, open **AI → Settings**, paste the key and tap **Verify and save**. The key is stored in the phone's secure keystore and is sent only to api.anthropic.com.
3. Pick a model (Sonnet 5.5 by default), a schedule and your risk limits. You can also write standing instructions such as "avoid PSU banks".

Each session Claude:

- reviews its open positions (the composite rank, the technicals and the news) and sells or trails stops where the thesis has changed;
- runs the strategy scan, shortlists top-ranked stocks in strong sectors, then checks the news with web search and reads fundamentals (screener.in) to score earnings momentum and value;
- buys at most the number of new positions you allow, each with a stop-loss and target that become an automatic exit;
- writes a market view and a summary you can read in the AI tab, with every decision's reasoning and every search it made.

The app enforces these in code, whatever the model says: position size (default 10% of account value), risk per trade (default 1% lost if the stop is hit), number of AI positions, new buys per session, a cash reserve, a drawdown pause, minimum liquidity, NSE only, no shorting or F&O, stops 2–15% below entry with a reward-to-risk of at least 1.5, and stops that can only be raised. The AI can't sell positions you opened yourself.

Sessions run when the app is open during market hours, and in the background when Android allows (WorkManager, every 15 minutes or more; not after you swipe the app away). Web search must be enabled for your organization in the Claude Console; if it isn't, sessions still run without news.

## Strategy signals (151 Trading Strategies)

The app computes these itself from two years of daily prices, once a day, for the stocks in its universe. It needs no AI and works without an API key. Section numbers refer to the paper.

| Signal | Paper | How it's applied here |
| --- | --- | --- |
| Price momentum | §3.1 | 12-month return skipping the latest month: P(1 month ago) / P(13 months ago) − 1, plus mean/σ of the monthly returns |
| Low volatility | §3.4 | σ of daily returns over 252 trading days; lower ranks better |
| Residual momentum | §3.7 | Daily returns regressed on the Nifty 50 (instead of the Fama-French factors); mean/σ of residuals over the 12-1 month window |
| Multifactor rank | §3.6 | Average demeaned rank of momentum, residual momentum, low volatility and sector momentum, as a 0–100 percentile and decile |
| Sector rotation | §4.1, §4.1.1 | Equal-weighted sector indices ranked by 6-month return, with a 100-day moving-average filter |
| Dual momentum | §4.1.2 | Nifty 50 above both its 100- and 200-day averages = risk-on, below both = risk-off. With the market filter on (default), the AI only buys gold or silver ETFs in risk-off |
| Mean reversion | §3.9.1 | 5-day log return minus the sector's mean; laggards inside strong stocks are pullback entries |
| Moving averages | §3.11–3.13 | Price vs 50/100/200-day averages, MA(10) vs MA(30), MA(3) > MA(10) > MA(21) |
| Support and resistance | §3.14 | Pivot C = (H + L + Close)/3, R = 2C − L, S = 2C − H, from the last day and the last week |
| Channel | §3.15 | 20-day Donchian high and low, and where the price sits in it |
| KNN | §3.17 | 10-day forecast from price and volume moving-average ratios, k = ⌊√n⌋, with a time-ordered 60/40 validation hit rate |
| Alpha and R² | §4.2–4.3 | Intercept and R² of a one-year regression on the Nifty 50 |
| IBS | §4.4 | (Close − Low)/(High − Low) of the last day |
| Earnings momentum | §3.2 | SUE = (EPS − EPS four quarters earlier) / σ of the last 8 such changes. The AI reads quarterly EPS and the app computes it |
| Value | §3.3 | Book-to-price, from the book value per share the AI reads |

Strategies that need short selling, options data or exchange market access aren't used: §3.5 implied volatility, the short legs of §3.8 pairs trading, §3.18 dollar-neutral optimisation, §3.19 market-making and the full §3.20 alpha-combo procedure.

## Run it on your phone (fastest)

You need Node.js 20+ on a computer and the **Expo Go** app on your phone (Play Store / App Store), on the same Wi-Fi.

```bash
npm install
npm start
```

Scan the QR code with Expo Go (Android) or the Camera app (iOS). If your phone is on a different network, use `npx expo start --tunnel`.

Expo Go only supports the latest Expo SDK. If Expo Go says the project's SDK is unsupported, run `npx expo install expo@latest --fix` or build an APK instead.

## Install it as a real app (Android APK)

**With GitHub Actions (no Android Studio needed).** Every push to `main` builds a release APK and publishes it under this repo's **Releases** (as `v1.0.<build number>`), so you can download and install it straight from your phone. Allow installs from your browser or file manager when Android asks. You can also start a build by hand from the **Actions** tab (**Build Android APK → Run workflow**); a build takes about 15 minutes.

**With EAS Build (Expo's cloud).** `npx eas-cli@latest build -p android --profile preview` gives you a download link for an APK. Needs a free Expo account.

**Locally.** With Android Studio installed: `npx expo run:android`.

The APK from GitHub Actions is signed with a debug key, which is fine for installing on your own phone. Use EAS (`--profile production`) for a Play Store build.

## How the engine works

The engine (`src/engine/engine.ts`) is a set of pure functions with no network access, covered by unit tests (`npm test`).

| Rule | Behaviour |
| --- | --- |
| Market order | Fills at the last traded price, plus optional slippage (Funds → Market order slippage). |
| Limit order | Fills at once at the last price if marketable; otherwise rests and fills at your limit price when the market reaches it. A gap through your price at the open fills at the better opening price. |
| SL / SL-M | Waits for the trigger. SL-M then fills at market; SL becomes a limit order at your price. |
| Delivery (CNC) buy | Full value plus charges is debited. Shares show under Positions today and move to Holdings at the next day's rollover. |
| Delivery (CNC) sell | Sells today's buys first, then holdings. Short selling isn't allowed. DP charge applies once per stock per day when selling from holdings. |
| Intraday (MIS) | Blocks value ÷ leverage as margin; only P&L and charges hit cash. Short selling is allowed. Squared off at the set time. |
| Funds | Available = cash − intraday margin − funds reserved by open orders − intraday mark-to-market losses. Orders are re-checked for funds when they execute. |
| Market status | Judged from the IST clock and from whether today's prices are actually arriving, so exchange holidays are detected without a holiday calendar. Orders only ever execute against prices from today's live session. |

## Price data and its limits

Prices come from Yahoo Finance's public endpoints, the same data behind finance.yahoo.com. They need no key, but they are unofficial: Yahoo can change or rate-limit them. If Yahoo fails three times in a row, the app switches to Google Finance pages for NSE stocks and indices for two minutes, then tries Yahoo again. The Funds tab shows which source is active.

All symbols are refreshed in one batched request per cycle. If the batch endpoint stops answering, the app falls back to one request per symbol: stocks with open orders or positions (and the one on screen) still refresh every cycle, and the rest every 15 seconds, to stay clear of rate limits.

This is polling, not a tick-by-tick broker feed: the price can move between refreshes, so a limit that is touched and left within a few seconds can be missed live (the catch-up replay uses 1-minute candles). Outside market hours the app refreshes once a minute. Mobile data use during market hours is a few MB per hour with batching and more without it; a 10–15 second refresh (Funds → Price refresh) cuts it further.

## Project layout

```
src/
  app/            Screens (Expo Router): Markets, Orders, Portfolio, Funds, stock detail, order ticket, search
  engine/         Trading engine (orders, GTT exits), charges, selectors, types
  strategies/     151 Trading Strategies signals: scan, single-stock rules, SUE/value, daily cache
  ai/             Claude client, agent loop, tools, risk limits, schedule, background task
  data/           Yahoo + Google price sources, failover, bundled symbol list
  state/          Persistence, live quote store, polling controller
  ui/             Theme, components, chart
tests/            Engine, strategy and AI-agent tests (node --test; Claude is mocked)
.github/workflows Android APK build
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Start the dev server for Expo Go |
| `npm test` | Run the engine, strategy and AI-agent tests |
| `npm run typecheck` | TypeScript check |
| `npm run export:check` | Bundle the Android JavaScript to catch build errors |

## Disclaimer

PaperDalal is a simulator for learning. The AI trader and the strategy signals are experiments, not recommendations: past patterns described in research papers may not repeat, and AI models make mistakes. It places no real orders and moves no money. Prices can be delayed or wrong, and charges are an approximation of a typical discount broker's equity schedule. Not investment advice.
