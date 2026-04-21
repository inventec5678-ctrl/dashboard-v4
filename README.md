# 📊 Dashboard V4 — Real-Time Multi-Market Trading Dashboard

![Node](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue) ![Status](https://img.shields.io/badge/status-production-brightgreen)

> A real-time, multi-market financial dashboard tracking crypto, US stocks, and Taiwan TWSE equities — with technical indicators, volume anomaly detection, institutional flow, and backtesting capabilities.

---

## ✨ Features

### 📈 Markets & Assets

| Market | Assets | Data Source |
|--------|--------|-------------|
| **CRYPTO** | BTC, ETH, XRP, DOGE | Binance Real-time WebSocket |
| **US Equities** | AAPL, TSLA, NVDA, MSFT, SPY, QQQ | yfinance |
| **TWSE** | 2330, 2317, 2454, 3008, 2603, 0050 | FinMind API |

### ⏱ Timeframe Support

- **CRYPTO:** 1m / 5m / 15m / 1H / 4H / 1D / 1W / 1M
- **US:** 1H / 4H / 1D / 1W / 1M
- **TWSE:** 1D / 1W / 1M (daily resampled)

### 🛠 Technical Indicators

- **RSI14** — Dynamic thresholds (adjustable), green on oversold / red on overbought
- **MACD** — MACD line + Signal line + Histogram bars
- **Volume** — Candlestick-volume composite chart
- **Volume Anomaly** — ▲ arrow markers when z-score > 2 (abnormal volume spikes)

### 🔥 Panels & Tools

- **📊 ForeignPanel** — Taiwan stock institutional/foreign investor net buy/sell data (FinMind API)
- **📉 BacktestPanel** — Strategy backtesting engine supporting:
  - SMA Crossover
  - RSI
  - MACD
  - Bollinger Bands
- **📚 Order Book Anomaly** — Real-time order book anomaly detection
- **💹 Price Change %** — Intraday / weekly / monthly % change based on previous close

---

## 🖥 UI Overview

- **Dark theme** with glassmorphism aesthetics
- **Accent color:** `#00D9A5` (tech-green glow)
- **Charting:** [lightweight-charts v4](https://tradingview.github.io/lightweight-charts/) (TradingView)
- **Frontend:** SolidJS + Vite + TypeScript
- **Backend:** FastAPI (Python, port `5006`)

---

## 🚀 Quick Start

### Prerequisites

- Node.js ≥ 22.0.0
- Python ≥ 3.10
- `pip` / `uv`

### 1. Start Backend

```bash
cd backend
pip install fastapi uvicorn pandas pytz
uvicorn server:app --host 0.0.0.0 --port 5006 --reload
```

### 2. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs at `http://localhost:5173` and proxies API calls to `http://localhost:5006`.

---

## 🔌 API Endpoints

### Crypto (Binance)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/crypto/klines?symbol=BTCUSDT&interval=1h` | OHLCV klines |
| `GET` | `/api/crypto/symbols` | Available crypto pairs |
| `WS` | `/ws/crypto?symbols=BTCUSDT,ETHUSDT` | Real-time candle stream |

### US Stocks (yfinance)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/us/klines?symbol=AAPL&interval=1d` | Historical OHLCV |
| `GET` | `/api/us/symbols` | Available US tickers |

### TWSE (FinMind)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/twse/klines?symbol=2330&interval=1d` | Taiwan stock daily K-line |
| `GET` | `/api/twse/foreign/{symbol}` | Foreign institutional net buy/sell |
| `GET` | `/api/twse/symbols` | Available TWSE tickers |

### Backtest

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/backtest` | Run backtest with strategy + parameters |

---

## 🧩 Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | SolidJS, Vite, TypeScript |
| **Charts** | lightweight-charts v4 (TradingView) |
| **Backend** | FastAPI (Python 3.10+) |
| **Data — Crypto** | Binance WebSocket / REST API |
| **Data — US Stocks** | yfinance |
| **Data — TWSE** | FinMind API |

---

## 📂 Project Structure

```
dashboard-v4/
├── backend/
│   ├── server.py          # FastAPI server (port 5006)
│   └── backtest_engine.py # Backtesting engine
├── frontend/
│   ├── src/
│   │   ├── App.tsx        # Main dashboard layout
│   │   ├── BacktestPanel.tsx
│   │   ├── ForeignPanel.tsx
│   │   └── styles/
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
├── agents/
├── MASTER_PLAN.md
└── AGILE_WORKFLOW.md
```

---

## 📄 License

MIT — free to use, modify, and distribute.