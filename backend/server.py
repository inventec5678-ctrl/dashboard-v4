"""
BTC/USDT K-Line Backend - FastAPI Mock Server
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

app = FastAPI(title="Crypto K-Line API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def generate_mock_klines(num_bars: int = 100) -> list:
    """Generate realistic-looking mock BTC/USDT K-line data."""
    # Start from roughly 2 months ago
    base_time = datetime(2026, 2, 20, 0, 0, 0)
    base_price = 64500.0

    klines = []
    current_price = base_price

    for i in range(num_bars):
        timestamp = int((base_time + timedelta(hours=i)).timestamp())

        # Random walk for price
        change_pct = random.uniform(-0.025, 0.030)  # ±3% max swing
        open_price = current_price
        close_price = open_price * (1 + change_pct)

        # High/Low based on open and close
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


@app.get("/api/klines")
async def get_klines(symbol: str = "BTCUSDT", interval: str = "1h", limit: int = 100):
    """Return mock K-line data for BTC/USDT."""
    data = generate_mock_klines(num_bars=limit)
    return {
        "symbol": symbol,
        "interval": interval,
        "data": data,
    }


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

# Mock price state — persists across broadcasts
_BASE_PRICE = 64500.0
_OPEN_PRICE = 64500.0  # base open for changePct calc
_current_price = _BASE_PRICE


@app.websocket("/ws/klines")
async def websocket_klines(websocket: WebSocket):
    global _current_price
    await manager.connect(websocket)
    try:
        # Send initial price immediately on connect
        await websocket.send_text(json.dumps({
            "type": "price_update",
            "symbol": "BTCUSDT",
            "price": round(_current_price, 2),
            "changePct": round(((_current_price - _OPEN_PRICE) / _OPEN_PRICE) * 100, 2),
        }))

        while True:
            await asyncio.sleep(3)

            # Random walk ±50 USDT
            delta = random.uniform(-50, 50)
            _current_price = max(_current_price + delta, 1000)
            change_pct = ((_current_price - _OPEN_PRICE) / _OPEN_PRICE) * 100

            msg = {
                "type": "price_update",
                "symbol": "BTCUSDT",
                "price": round(_current_price, 2),
                "changePct": round(change_pct, 2),
            }
            await manager.broadcast(msg)

    except WebSocketDisconnect:
        manager.disconnect(websocket)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5006)
    args = parser.parse_args()

    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="info")