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
- Watchlist with search, intraday and historical charts (1D to 5Y) you can scrub, light and dark themes, and haptic feedback on fills.

Everything is stored on the phone. Nothing is sent anywhere except price requests.

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
  engine/         Trading engine, charges, selectors, types
  data/           Yahoo + Google price sources, failover, bundled symbol list
  state/          Persistence, live quote store, polling controller
  ui/             Theme, components, chart
tests/            Engine unit tests (node --test)
.github/workflows Android APK build
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Start the dev server for Expo Go |
| `npm test` | Run the engine tests |
| `npm run typecheck` | TypeScript check |
| `npm run export:check` | Bundle the Android JavaScript to catch build errors |

## Disclaimer

PaperDalal is a simulator for learning. It places no real orders and moves no money. Prices can be delayed or wrong, and charges are an approximation of a typical discount broker's equity schedule. Not investment advice.
