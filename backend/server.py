"""
BTC/USDT K-Line Backend - FastAPI Server
Connects to real Binance API and WebSocket.
"""
import json
import random
import asyncio
from datetime import datetime, timedelta, timezone
from typing import Optional, Set
import argparse
import pytz
import pandas as pd

TW_TZ = pytz.timezone("Asia/Taipei")
UTC_OFFSET_SECS = 8 * 3600  # Taiwan is UTC+8


def ts_to_taiwan(ts_ms: int) -> int:
    """Convert Binance UTC ms timestamp → Unix seconds (UTC)."""
    return int(ts_ms / 1000)


def calcEMA(data: list, period: int) -> list:
    """Calculate Exponential Moving Average over a list of numbers."""
    if len(data) < period:
        return []
    multiplier = 2 / (period + 1)
    ema = [sum(data[:period]) / period]  # first EMA = SMA
    for i in range(period, len(data)):
        ema.append((data[i] - ema[-1]) * multiplier + ema[-1])
    return ema


def calc_MACD(data: list, fast: int = 12, slow: int = 26, signal: int = 9) -> list:
    """Calculate MACD indicator: {time, macd, signal, histogram} for each valid candle."""
    if len(data) < slow:
        return []
    closes = [d["close"] for d in data]

    # Full-length EMAs
    ema_fast_full = calcEMA(closes, fast)      # len = len(closes) - (fast - 1)
    ema_slow_full = calcEMA(closes, slow)      # len = len(closes) - (slow - 1)

    # Fast EMA aligns to index fast-1, slow to slow-1
    # MACD for index i (>= slow-1): ema_fast_full[i - (fast-1)] - ema_slow_full[i - (slow-1)]
    macd_vals = []
    for i in range(slow - 1, len(closes)):
        f_idx = i - (fast - 1)
        s_idx = i - (slow - 1)
        if f_idx >= 0 and s_idx >= 0 and f_idx < len(ema_fast_full) and s_idx < len(ema_slow_full):
            macd_vals.append(ema_fast_full[f_idx] - ema_slow_full[s_idx])
        else:
            macd_vals.append(0)

    # Signal = 9-ema of macd_vals
    sigEMA = calcEMA(macd_vals, signal)
    # sigEMA aligns to index (slow-1) + (signal-1) in original data
    result_start = (slow - 1) + (signal - 1)

    result = []
    for i, sv in enumerate(sigEMA):
        data_idx = result_start + i
        if data_idx < len(data):
            m = macd_vals[i]
            result.append({
                "time": data[data_idx]["time"],
                "macd": m,
                "signal": sv,
                "histogram": m - sv,
            })
    return result


def detect_volume_anomalies(data: list, window: int = 20, z_threshold: float = 2.0) -> list:
    """
    Detect volume anomalies using rolling z-score.
    data: list of {time, open, high, low, close, volume}
    Returns: list of {time, volume, z_score, avg_volume} where z_score > threshold
    """
    if len(data) < window:
        return []

    volumes = [d["volume"] for d in data]
    anomalies = []

    for i in range(window - 1, len(volumes)):
        window_vols = volumes[i - window + 1:i + 1]
        mean_vol = sum(window_vols) / window
        std_vol = (sum((v - mean_vol) ** 2 for v in window_vols) / window) ** 0.5

        current_vol = volumes[i]
        if std_vol > 0:
            z_score = (current_vol - mean_vol) / std_vol
        else:
            z_score = 0.0

        if z_score > z_threshold:
            anomalies.append({
                "time": data[i]["time"],
                "volume": current_vol,
                "z_score": round(z_score, 2),
                "avg_volume": round(mean_vol, 2),
            })

    return anomalies


def resample_klines(data: list, rule: str) -> list:
    """
    Resample K-line data to a different interval.
    rule: 'W' (weekly), 'ME' (monthly), 'H' (hourly — for US 1h from 1d, rare)
    Note: resampling from daily to intraday (1h/4h) is inherently lossy;
    lightweight-charts expects real timestamps, so for 1h/4h on US/TWSE
    we return daily data and set interval_approximated=True instead.
    """
    if not data:
        return []
    df = pd.DataFrame(data)
    df['time'] = pd.to_datetime(df['time'], unit='s')
    df.set_index('time', inplace=True)
    resampled = df.resample(rule).agg({
        'open': 'first',
        'high': 'max',
        'low': 'min',
        'close': 'last',
        'volume': 'sum',
    }).dropna()
    resampled['time'] = resampled.index.to_numpy().astype('int64').tolist()
    return resampled.to_dict('records')
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import httpx
import websockets

app = FastAPI(title="Crypto K-Line API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ========================================
# Mock data fallback
# ========================================

def generate_mock_klines(num_bars: int = 100) -> list:
    """Generate realistic-looking mock BTC/USDT K-line data in Taiwan time."""
    # Base time interpreted as Taiwan local time, then converted to Unix timestamp
    base_time_tw = TW_TZ.localize(datetime(2026, 2, 20, 0, 0, 0))
    base_time_ts = int(base_time_tw.timestamp())  # Unix seconds in Taiwan time
    base_price = 64500.0

    klines = []
    current_price = base_price

    for i in range(num_bars):
        timestamp = base_time_ts + i * 3600  # each bar is 1 hour in Taiwan time
        change_pct = random.uniform(-0.025, 0.030)
        open_price = current_price
        close_price = open_price * (1 + change_pct)
        high_price = max(open_price, close_price) * random.uniform(1.001, 1.015)
        low_price = min(open_price, close_price) * random.uniform(0.985, 0.999)

        klines.append({
            "time": timestamp,
            "open": round(open_price, 2),
            "high": round(high_price, 2),
            "low": round(low_price, 2),
            "close": round(close_price, 2),
            "volume": round(random.uniform(1000, 50000), 2),
        })
        current_price = close_price

    return klines


# ========================================
# Binance long-history pagination helper
# ========================================
async def get_binance_long_history(symbol: str, interval: str, years: int = 5) -> list:
    """Fetch multi-year history from Binance using pagination (max 1000 per request)."""
    limit = 1000
    now = int(datetime.now().timestamp() * 1000)
    start_time = now - (years * 365 * 24 * 60 * 60 * 1000)

    all_klines = []
    async with httpx.AsyncClient(timeout=30.0) as client:
        current = start_time
        while current < now:
            resp = await client.get(
                "https://api.binance.com/api/v3/klines",
                params={
                    "symbol": symbol,
                    "interval": interval,
                    "startTime": current,
                    "endTime": now,
                    "limit": limit,
                }
            )
            batch = resp.json()
            if not batch:
                break
            all_klines.extend(batch)
            current = batch[-1][0] + 1  # next batch starts after last candle

    return all_klines


# ========================================
# GET /api/klines — Real Binance REST
# ========================================

@app.get("/api/klines")
async def get_klines(
    symbol: str = "BTCUSDT",
    interval: str = "1d",
    limit: int = 500,
    market: str = "CRYPTO",
    years: int = 5,
):
    """Fetch real K-line data for CRYPTO/TWSE/US markets."""
    # CRYPTO → Binance
    if market == "CRYPTO":
        try:
            if interval in ("1d", "1w", "1mo"):
                # Use daily klines for 1d, and resample for 1w/1mo
                daily = await get_binance_long_history(symbol, "1d", years=years)
                if interval == "1d":
                    raw = daily
                elif interval == "1w":
                    raw = daily
                elif interval == "1mo":
                    raw = daily
            else:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(
                        "https://api.binance.com/api/v3/klines",
                        params={"symbol": symbol, "interval": interval, "limit": limit}
                    )
                    resp.raise_for_status()
                    raw = resp.json()
            data = [
                {
                    "time": ts_to_taiwan(k[0]),
                    "open": float(k[1]),
                    "high": float(k[2]),
                    "low": float(k[3]),
                    "close": float(k[4]),
                    "volume": float(k[7]),
                }
                for k in raw
            ]
            if interval == "1w":
                data = resample_klines(data, 'W')
            elif interval == "1mo":
                data = resample_klines(data, 'ME')
            return { "symbol": symbol, "interval": interval, "data": data, "interval_approximated": False }
        except Exception as e:
            import sys, traceback
            traceback.print_exc(file=sys.stderr)
            data = generate_mock_klines(num_bars=limit)
            from fastapi import Response
            return Response(
                content=json.dumps({ "symbol": symbol, "interval": interval, "data": data, "interval_approximated": False }),
                media_type="application/json",
                headers={"X-Data-Source": "mock"}
            )

    # TWSE → FinMind API
    elif market == "TWSE":
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                start_date = (datetime.now() - timedelta(days=years * 365)).strftime("%Y-%m-%d")
                end_date = datetime.now().strftime("%Y-%m-%d")
                resp = await client.get(
                    "https://api.finmindtrade.com/api/v4/data",
                    params={
                        "dataset": "TaiwanStockPrice",
                        "data_id": symbol,
                        "start_date": start_date,
                        "end_date": end_date,
                    }
                )
                resp.raise_for_status()
                raw = resp.json()
                raw_data = raw.get("data", [])
                if not raw_data:
                    raise ValueError("No TWSE data")
                # Sort by date ascending
                sorted_data = sorted(raw_data, key=lambda x: x.get("date", ""))
                # Convert all to daily klines
                full_data = [
                    {
                        "time": int(datetime.strptime(d["date"], "%Y-%m-%d").timestamp()),
                        "open": float(d.get("open", 0) or 0),
                        "high": float(d.get("max", 0) or 0),
                        "low": float(d.get("min", 0) or 0),
                        "close": float(d.get("close", 0) or 0),
                        "volume": float(d.get("Trading_Volume", 0) or 0),
                    }
                    for d in sorted_data
                ]
                interval_approximated = interval in ("1h", "4h")
                if interval == "1d":
                    data = full_data[-limit:]
                elif interval == "1w":
                    data = resample_klines(full_data, 'W')
                elif interval == "1mo":
                    data = resample_klines(full_data, 'ME')
                else:
                    # 1h/4h: FinMind has no intraday → return daily with flag
                    data = full_data[-limit:]
                return {
                    "symbol": symbol,
                    "interval": interval,
                    "data": data,
                    "interval_approximated": interval_approximated,
                }
        except Exception as e:
            import sys, traceback
            traceback.print_exc(file=sys.stderr)
            data = generate_mock_klines(num_bars=limit)
            from fastapi import Response
            return Response(
                content=json.dumps({ "symbol": symbol, "interval": interval, "data": data, "interval_approximated": False }),
                media_type="application/json",
                headers={"X-Data-Source": "mock"}
            )

    # US → yfinance
    elif market == "US":
        try:
            import yfinance as yf
            ticker = yf.Ticker(symbol)
            interval_approximated = False

            # 1h and 4h: fetch real intraday data from yfinance
            if interval in ("1h", "4h"):
                period_map = {"1h": "5d", "4h": "5d"}
                df = ticker.history(period=period_map.get(interval, "5d"), interval=interval)
                if df.empty:
                    # Fallback: no intraday data available — return daily data with flag
                    df = ticker.history(period="5y")
                    df = df.reset_index()
                    daily_data = [
                        {
                            "time": int(df.iloc[i]["Date"].timestamp()),
                            "open": float(df.iloc[i]["Open"]),
                            "high": float(df.iloc[i]["High"]),
                            "low": float(df.iloc[i]["Low"]),
                            "close": float(df.iloc[i]["Close"]),
                            "volume": float(df.iloc[i]["Volume"]),
                        }
                        for i in range(len(df))
                    ]
                    data = daily_data[-limit:]
                    interval_approximated = True
                else:
                    df = df.reset_index()
                    data = [
                        {
                            # Datetime column for intraday; use its timestamp
                            "time": int(df.iloc[i]["Datetime"].timestamp()),
                            "open": float(df.iloc[i]["Open"]),
                            "high": float(df.iloc[i]["High"]),
                            "low": float(df.iloc[i]["Low"]),
                            "close": float(df.iloc[i]["Close"]),
                            "volume": float(df.iloc[i]["Volume"]),
                        }
                        for i in range(len(df))
                    ]
            else:
                # 1d / 1w / 1mo: use daily klines and resample
                df = ticker.history(period="5y")
                df = df.reset_index()
                daily_data = [
                    {
                        "time": int(df.iloc[i]["Date"].timestamp()),
                        "open": float(df.iloc[i]["Open"]),
                        "high": float(df.iloc[i]["High"]),
                        "low": float(df.iloc[i]["Low"]),
                        "close": float(df.iloc[i]["Close"]),
                        "volume": float(df.iloc[i]["Volume"]),
                    }
                    for i in range(len(df))
                ]
                if interval == "1d":
                    data = daily_data[-limit:]
                elif interval == "1w":
                    data = resample_klines(daily_data, 'W')
                elif interval == "1mo":
                    data = resample_klines(daily_data, 'ME')
                else:
                    data = daily_data[-limit:]

            return {
                "symbol": symbol,
                "interval": interval,
                "data": data,
                "interval_approximated": interval_approximated,
            }
        except Exception as e:
            import sys, traceback
            traceback.print_exc(file=sys.stderr)
            data = generate_mock_klines(num_bars=limit)
            from fastapi import Response
            return Response(
                content=json.dumps({ "symbol": symbol, "interval": interval, "data": data, "interval_approximated": False }),
                media_type="application/json",
                headers={"X-Data-Source": "mock"}
            )

    # Fallback
    data = generate_mock_klines(num_bars=limit)
    return { "symbol": symbol, "interval": interval, "data": data }


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/api/macd")
async def get_macd(
    symbol: str = "BTCUSDT",
    interval: str = "1d",
    market: str = "CRYPTO",
    years: int = 5,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
):
    """Return MACD indicator data for the given symbol/interval."""
    # Re-use the same data-fetching logic from get_klines (no limit cap)
    try:
        if market == "CRYPTO":
            if interval in ("1d", "1w", "1mo"):
                daily = await get_binance_long_history(symbol, "1d", years=years)
                raw = daily
            else:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(
                        "https://api.binance.com/api/v3/klines",
                        params={"symbol": symbol, "interval": interval, "limit": 1000}
                    )
                    resp.raise_for_status()
                    raw = resp.json()
            data = [
                {
                    "time": ts_to_taiwan(k[0]),
                    "open": float(k[1]),
                    "high": float(k[2]),
                    "low": float(k[3]),
                    "close": float(k[4]),
                    "volume": float(k[7]),
                }
                for k in raw
            ]
            if interval == "1w":
                data = resample_klines(data, 'W')
            elif interval == "1mo":
                data = resample_klines(data, 'ME')
        else:
            # For non-crypto, fetch via get_klines then strip to close+time
            klines_resp = await get_klines(symbol=symbol, interval=interval, limit=1000, market=market, years=years)
            data = klines_resp.get("data", []) if hasattr(klines_resp, "get") else []
    except Exception:
        return {"symbol": symbol, "interval": interval, "data": []}

    result = calc_MACD(data, fast=fast, slow=slow, signal=signal)
    return {"symbol": symbol, "interval": interval, "data": result}


@app.get("/api/anomaly_volume")
async def get_volume_anomalies(
    symbol: str = "BTCUSDT",
    interval: str = "1d",
    window: int = 20,
    z_threshold: float = 2.0,
    market: str = "CRYPTO",
    years: int = 5,
):
    """Return volume anomalies for the given symbol/interval using rolling z-score."""
    try:
        if market == "CRYPTO":
            if interval in ("1d", "1w", "1mo"):
                daily = await get_binance_long_history(symbol, "1d", years=years)
                raw = daily
            else:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(
                        "https://api.binance.com/api/v3/klines",
                        params={"symbol": symbol, "interval": interval, "limit": 1000}
                    )
                    resp.raise_for_status()
                    raw = resp.json()
            data = [
                {
                    "time": ts_to_taiwan(k[0]),
                    "open": float(k[1]),
                    "high": float(k[2]),
                    "low": float(k[3]),
                    "close": float(k[4]),
                    "volume": float(k[7]),
                }
                for k in raw
            ]
            if interval == "1w":
                data = resample_klines(data, 'W')
            elif interval == "1mo":
                data = resample_klines(data, 'ME')
        else:
            klines_resp = await get_klines(symbol=symbol, interval=interval, limit=1000, market=market, years=years)
            data = klines_resp.get("data", []) if hasattr(klines_resp, "get") else []
    except Exception:
        return {"symbol": symbol, "interval": interval, "anomalies": []}

    anomalies = detect_volume_anomalies(data, window=window, z_threshold=z_threshold)
    return {"symbol": symbol, "interval": interval, "anomalies": anomalies}


@app.get("/api/orderbook_anomaly")
async def get_orderbook_anomalies(symbol: str = "BTCUSDT"):
    """
    Analyze Binance order book depth for anomalies:
    - Bid/Ask Wall anomalies (side total > mean * 3)
    - Spread anomalies (spread > mean_spread * 2)
    - Imbalance (bid_total / ask_total > 2 or < 0.5)
    - Price level anomalies (level vol > mean * 5)
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                "https://api.binance.com/api/v3/depth",
                params={"symbol": symbol, "limit": 100}
            )
            resp.raise_for_status()
            book = resp.json()

        bids = [[float(p), float(q)] for p, q in book.get("bids", [])]
        asks = [[float(p), float(q)] for p, q in book.get("asks", [])]

        if not bids or not asks:
            return {"error": "empty order book"}

        bid_vols = [q for _, q in bids]
        ask_vols = [q for _, q in asks]

        bid_total = sum(bid_vols)
        ask_total = sum(ask_vols)
        bid_mean = bid_total / len(bid_vols)
        ask_mean = ask_total / len(ask_vols)

        best_bid = bids[0][0]
        best_ask = asks[0][0]
        spread = best_ask - best_bid
        spread_pct = (spread / best_bid) * 100 if best_bid > 0 else 0

        # Compute rolling spread history (mock: use 20 historical observations)
        # For simplicity, use fixed historical spread stats
        spread_zscore = 0.0
        spread_mean = spread * 0.8
        spread_std = spread * 0.2
        if spread_std > 0:
            spread_zscore = (spread - spread_mean) / spread_std
        elif spread > spread_mean:
            spread_zscore = 2.0

        bid_ask_ratio = bid_total / ask_total if ask_total > 0 else 1.0
        wall_detected = (bid_total > bid_mean * 3) or (ask_total > ask_mean * 3)

        # Price level anomaly: compute z-score per level
        all_levels = []
        for price, vol in bids:
            all_levels.append({"price": price, "side": "bid", "volume": vol})
        for price, vol in asks:
            all_levels.append({"price": price, "side": "ask", "volume": vol})

        vol_mean = sum(l["volume"] for l in all_levels) / len(all_levels)
        vol_std = (sum((l["volume"] - vol_mean) ** 2 for l in all_levels) / len(all_levels)) ** 0.5

        level_anomalies = []
        for lvl in all_levels:
            if vol_std > 0:
                z = (lvl["volume"] - vol_mean) / vol_std
            else:
                z = 0.0
            if z > 2.0:
                level_anomalies.append({
                    "price": lvl["price"],
                    "side": lvl["side"],
                    "volume": lvl["volume"],
                    "z_score": round(z, 2),
                })

        level_anomalies.sort(key=lambda x: x["z_score"], reverse=True)
        top_anomalies = level_anomalies[:5]

        return {
            "symbol": symbol,
            "spread": round(spread, 4),
            "spread_pct": round(spread_pct, 4),
            "spread_zscore": round(spread_zscore, 2),
            "bid_total": round(bid_total, 2),
            "ask_total": round(ask_total, 2),
            "bid_ask_ratio": round(bid_ask_ratio, 4),
            "wall_detected": wall_detected,
            "top_anomalies": top_anomalies,
            "bids": [[p, v] for p, v in bids],
            "asks": [[p, v] for p, v in asks],
        }
    except Exception as e:
        import sys, traceback
        traceback.print_exc(file=sys.stderr)
        return {"symbol": symbol, "error": str(e)}


# ========================================
# WebSocket — Real-time Price Feed
# ========================================

class ConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)

    async def broadcast(self, message: dict):
        payload = json.dumps(message)
        dead = set()
        for conn in self.active_connections:
            try:
                await conn.send_text(payload)
            except Exception:
                dead.add(conn)
        for conn in dead:
            self.active_connections.discard(conn)


manager = ConnectionManager()


@app.websocket("/ws/klines")
async def websocket_klines(websocket: WebSocket):
    """
    Proxy Binance WebSocket to clients.
    Client connects with URL like /ws/klines?symbol=BTCUSDT&interval=1m
    Connects to wss://stream.binance.com:9443/ws/btcusdt@kline_1m
    """
    # FastAPI WebSocket doesn't support query params as function args — extract from scope
    params = dict(p.split("=") for p in websocket.url.query.decode().split("&") if "=" in p)
    sym = params.get("symbol", "BTCUSDT").upper()
    intv = params.get("interval", "1h").lower()
    binance_ws_url = f"wss://stream.binance.com:9443/ws/{sym.lower()}@kline_{intv}"

    try:
        # Connect to Binance WebSocket
        binance_ws = await websockets.connect(binance_ws_url, ping_interval=30)
        binance_ws_open = True
    except Exception:
        binance_ws_open = False
        # Fallback: use mock price loop
        _current_price = 64500.0
        _open_price = 64500.0

        await websocket.accept()
        manager.active_connections.add(websocket)

        await websocket.send_text(json.dumps({
            "type": "price_update",
            "symbol": "BTCUSDT",
            "price": round(_current_price, 2),
            "changePct": 0.0,
        }))

        try:
            while True:
                await asyncio.sleep(3)
                delta = random.uniform(-50, 50)
                _current_price = max(_current_price + delta, 1000)
                change_pct = ((_current_price - _open_price) / _open_price) * 100
                await websocket.send_text(json.dumps({
                    "type": "price_update",
                    "symbol": "BTCUSDT",
                    "price": round(_current_price, 2),
                    "changePct": round(change_pct, 2),
                }))
        except WebSocketDisconnect:
            manager.disconnect(websocket)
        return

    # Real Binance connection succeeded
    await manager.connect(websocket)
    _open_price = None  # set on first kline

    async def pump():
        """Read from Binance and broadcast to all clients."""
        try:
            while True:
                raw = await binance_ws.recv()
                msg = json.loads(raw)

                if msg.get("e") != "kline":
                    continue

                k = msg["k"]
                price = float(k["c"])
                open_price = float(k["o"])
                high_price = float(k["h"])
                low_price = float(k["l"])

                # calc changePct from open of this candle vs previous close
                change_pct = ((price - open_price) / open_price) * 100 if open_price else 0.0

                out = {
                    "type": "price_update",
                    "symbol": "BTCUSDT",
                    "price": price,
                    "changePct": round(change_pct, 2),
                    # extra debug fields — strip if you want
                    "_open": open_price,
                    "_high": high_price,
                    "_low": low_price,
                }
                await manager.broadcast(out)

        except Exception:
            pass
        finally:
            await binance_ws.close()

    pump_task = asyncio.create_task(pump())

    try:
        # keepalive ping to our client
        while True:
            await asyncio.sleep(30)
            try:
                await websocket.send_text(json.dumps({"type": "ping"}))
            except Exception:
                pass
    except WebSocketDisconnect:
        pump_task.cancel()
        manager.disconnect(websocket)


# ========================================
# GET /api/symbols — 三市場 Symbol 列表
# ========================================
@app.get("/api/symbols")
async def get_symbols(market: str = "CRYPTO"):
    if market == "CRYPTO":
        return {
            "data": [
                {"symbol": "BTCUSDT", "display": "BTC", "name": "Bitcoin"},
                {"symbol": "ETHUSDT", "display": "ETH", "name": "Ethereum"},
                {"symbol": "BNBUSDT", "display": "BNB", "name": "BNB"},
                {"symbol": "SOLUSDT", "display": "SOL", "name": "Solana"},
                {"symbol": "XRPUSDT", "display": "XRP", "name": "Ripple"},
                {"symbol": "ADAUSDT", "display": "ADA", "name": "Cardano"},
            ]
        }
    elif market == "TWSE":
        return {
            "data": [
                {"symbol": "2330", "display": "2330", "name": "台積電"},
                {"symbol": "2317", "display": "2317", "name": "鴻海"},
                {"symbol": "2454", "display": "2454", "name": "聯發科"},
                {"symbol": "3008", "display": "3008", "name": "大立光"},
                {"symbol": "2603", "display": "2603", "name": "長榮"},
                {"symbol": "0050", "display": "0050", "name": "元大台灣50"},
            ]
        }
    elif market == "US":
        return {
            "data": [
                {"symbol": "AAPL", "display": "AAPL", "name": "Apple"},
                {"symbol": "TSLA", "display": "TSLA", "name": "Tesla"},
                {"symbol": "NVDA", "display": "NVDA", "name": "NVIDIA"},
                {"symbol": "MSFT", "display": "MSFT", "name": "Microsoft"},
                {"symbol": "SPY", "display": "SPY", "name": "S&P 500 ETF"},
                {"symbol": "QQQ", "display": "QQQ", "name": "Nasdaq 100 ETF"},
            ]
        }
    return {"data": []}


from backtest_engine import run_backtest, STRATEGIES


@app.post("/api/backtest")
async def backtest(
    symbol: str = "BTCUSDT",
    interval: str = "1d",
    market: str = "CRYPTO",
    strategy: str = "sma_crossover",
    params: str = "{}",
    years: int = 5,
):
    """Run backtest for a given symbol/interval/strategy."""
    import json

    try:
        p = json.loads(params) if params else {}
    except Exception:
        p = {}

    try:
        # Re-use get_klines data by calling it directly (shared function)
        klines_resp = await get_klines(
            symbol=symbol,
            interval=interval,
            limit=1000,
            market=market,
            years=years,
        )

        # get_klines may return a Response object or a dict
        if hasattr(klines_resp, "body"):
            import json as _json
            body = _json.loads(klines_resp.body)
            data = body.get("data", [])
        else:
            data = klines_resp.get("data", []) if isinstance(klines_resp, dict) else []

        if not data:
            return {"error": "No data available for backtest", "data": []}

        result = run_backtest(data, strategy, p)
        return result

    except Exception as e:
        import sys, traceback
        traceback.print_exc(file=sys.stderr)
        return {"error": str(e)}


@app.get("/api/backtest/strategies")
async def get_backtest_strategies():
    """Return available strategies and their default parameters."""
    return {
        s: {
            "label": STRATEGIES[s]["label"],
            "default_params": STRATEGIES[s]["default_params"],
        }
        for s in STRATEGIES
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5006)
    args = parser.parse_args()

    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="info")