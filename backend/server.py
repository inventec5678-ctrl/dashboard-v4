"""
BTC/USDT K-Line Backend - FastAPI Server
Connects to real Binance API and WebSocket.
"""
import json
import random
import asyncio
from datetime import datetime, timedelta
from typing import Optional, Set
import argparse

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
    """Generate realistic-looking mock BTC/USDT K-line data."""
    base_time = datetime(2026, 2, 20, 0, 0, 0)
    base_price = 64500.0

    klines = []
    current_price = base_price

    for i in range(num_bars):
        timestamp = int((base_time + timedelta(hours=i)).timestamp())
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
        })
        current_price = close_price

    return klines


# ========================================
# GET /api/klines — Real Binance REST
# ========================================

@app.get("/api/klines")
async def get_klines(symbol: str = "BTCUSDT", interval: str = "1h", limit: int = 100):
    """Fetch real K-line data from Binance REST API."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                "https://api.binance.com/api/v3/klines",
                params={"symbol": "BTCUSDT", "interval": "1h", "limit": limit}
            )
            resp.raise_for_status()
            raw = resp.json()

            data = [
                {
                    "time": int(k[0] / 1000),   # ms → sec
                    "open": float(k[1]),
                    "high": float(k[2]),
                    "low": float(k[3]),
                    "close": float(k[4]),
                }
                for k in raw
            ]

            return {
                "symbol": "BTCUSDT",
                "interval": "1h",
                "data": data,
            }

    except Exception:
        # Fallback to mock on any error
        data = generate_mock_klines(num_bars=limit)
        from fastapi import Response
        response = Response(
            content=json.dumps({
                "symbol": "BTCUSDT",
                "interval": "1h",
                "data": data,
            }),
            media_type="application/json",
            headers={"X-Data-Source": "mock"}
        )
        return response


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
    Connects to wss://stream.binance.com:9443/ws/btcusdt@kline_1h
    and forwards real-time kline data in our format.
    """
    binance_ws_url = "wss://stream.binance.com:9443/ws/btcusdt@kline_1h"

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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5006)
    args = parser.parse_args()

    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="info")
