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
    """Convert Binance UTC ms timestamp → Taiwan time Unix seconds."""
    return int(ts_ms / 1000) + UTC_OFFSET_SECS


def resample_klines(data: list, rule: str) -> list:
    """Resample 日K data to 週K or 月K."""
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
    resampled['time'] = resampled.index.view('int64') // 10**9
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
            if interval == "1d":
                # Use pagination to get multi-year history
                raw = await get_binance_long_history(symbol, "1d", years=years)
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
            return { "symbol": symbol, "interval": interval, "data": data }
        except Exception:
            data = generate_mock_klines(num_bars=limit)
            from fastapi import Response
            return Response(
                content=json.dumps({ "symbol": symbol, "interval": interval, "data": data }),
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
                if interval == "1d":
                    data = full_data[-limit:]
                elif interval == "1w":
                    data = resample_klines(full_data, 'W')
                elif interval == "1mo":
                    data = resample_klines(full_data, 'ME')
                else:
                    data = full_data[-limit:]
                return { "symbol": symbol, "interval": interval, "data": data }
        except Exception:
            data = generate_mock_klines(num_bars=limit)
            from fastapi import Response
            return Response(
                content=json.dumps({ "symbol": symbol, "interval": interval, "data": data }),
                media_type="application/json",
                headers={"X-Data-Source": "mock"}
            )

    # US → yfinance
    elif market == "US":
        try:
            import yfinance as yf
            ticker = yf.Ticker(symbol)
            df = ticker.history(period="5y")  # 5-year history
            if df.empty:
                raise ValueError("No US data")
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
            return { "symbol": symbol, "interval": interval, "data": data }
        except Exception:
            data = generate_mock_klines(num_bars=limit)
            from fastapi import Response
            return Response(
                content=json.dumps({ "symbol": symbol, "interval": interval, "data": data }),
                media_type="application/json",
                headers={"X-Data-Source": "mock"}
            )

    # Fallback
    data = generate_mock_klines(num_bars=limit)
    return { "symbol": symbol, "interval": interval, "data": data }


@app.get("/health")
async def health():
    return {"status": "ok"}


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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5006)
    args = parser.parse_args()

    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="info")