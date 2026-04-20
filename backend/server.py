"""
BTC/USDT K-Line Backend - FastAPI Mock Server
"""
import json
import random
from datetime import datetime, timedelta
from typing import Optional
import argparse

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5006)
    args = parser.parse_args()

    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="info")