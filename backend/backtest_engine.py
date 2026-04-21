"""
Backtesting Engine — Dashboard V4
Supports SMA Crossover, RSI Threshold, MACD Cross, Bollinger Breakout strategies.
"""
import math
from typing import List, Dict, Any, Callable, Optional

# ─── Indicator helpers ────────────────────────────────────────────────

def calc_sma(data: List[Dict], period: int) -> List[float]:
    """Simple Moving Average (aligned to data index)."""
    closes = [d["close"] for d in data]
    result = []
    for i in range(period - 1, len(closes)):
        avg = sum(closes[i - period + 1:i + 1]) / period
        result.append(avg)
    return result


def calc_ema(data: List[Dict], period: int) -> List[float]:
    """Exponential Moving Average."""
    if len(data) < period:
        return []
    closes = [d["close"] for d in data]
    mult = 2 / (period + 1)
    ema = [sum(closes[:period]) / period]
    for i in range(period, len(closes)):
        ema.append((closes[i] - ema[-1]) * mult + ema[-1])
    return ema


def sma_crossover_signal(data: List[Dict], fast: int, slow: int) -> List[Dict]:
    """
    Returns list of {time, signal} where:
      1 = buy  (fast SMA crosses above slow SMA)
     -1 = sell (fast SMA crosses below slow SMA)
      0 = hold
    """
    if len(data) < slow:
        return []
    fast_sma = calc_sma(data, fast)
    slow_sma = calc_sma(data, slow)

    # fast_sma[i] aligns to data index (fast-1)+i
    # slow_sma[i] aligns to data index (slow-1)+i
    # Common range starts at max(fast, slow) - 1
    start = slow - 1
    signals = []
    prev_fast = None
    prev_slow = None

    for i in range(start, len(data)):
        f_idx = i - (fast - 1)
        s_idx = i - (slow - 1)
        if f_idx < 0 or s_idx < 0 or f_idx >= len(fast_sma) or s_idx >= len(slow_sma):
            continue
        curr_fast = fast_sma[f_idx]
        curr_slow = slow_sma[s_idx]
        if prev_fast is not None and prev_slow is not None:
            if prev_fast <= prev_slow and curr_fast > curr_slow:
                signals.append({"time": data[i]["time"], "signal": 1})
            elif prev_fast >= prev_slow and curr_fast < curr_slow:
                signals.append({"time": data[i]["time"], "signal": -1})
            else:
                signals.append({"time": data[i]["time"], "signal": 0})
        prev_fast = curr_fast
        prev_slow = curr_slow
    return signals


def rsi_signal(data: List[Dict], buy_th: float, sell_th: float) -> List[Dict]:
    """
    RSI-based signals: buy when RSI crosses below buy_th, sell when RSI crosses above sell_th.
    Returns {time, signal}.
    """
    if len(data) < 15:
        return []
    closes = [d["close"] for d in data]
    results = []
    prev_rsi = None

    for i in range(14, len(closes)):
        gains, losses = 0.0, 0.0
        for j in range(i - 14, i):
            diff = closes[j + 1] - closes[j]
            if diff > 0:
                gains += diff
            else:
                losses -= diff
        loss_avg = losses / 14
        gain_avg = gains / 14
        if loss_avg == 0:
            rsi = 100.0
        else:
            rs = gain_avg / loss_avg
            rsi = 100.0 - (100.0 / (1.0 + rs))

        if prev_rsi is not None:
            if prev_rsi > buy_th and rsi <= buy_th:
                results.append({"time": data[i]["time"], "signal": 1})
            elif prev_rsi < sell_th and rsi >= sell_th:
                results.append({"time": data[i]["time"], "signal": -1})
            else:
                results.append({"time": data[i]["time"], "signal": 0})
        prev_rsi = rsi
    return results


def macd_cross_signal(data: List[Dict]) -> List[Dict]:
    """
    MACD crossover: buy when MACD crosses above Signal, sell when below.
    Uses standard 12/26/9 parameters.
    """
    if len(data) < 35:
        return []

    closes = [d["close"] for d in data]
    ema_fast = calc_ema(data, 12)
    ema_slow = calc_ema(data, 26)

    # Build MACD aligned to data index (slow-1=25) onwards
    macd_vals = []
    for i in range(25, len(closes)):
        f_idx = i - 11
        s_idx = i - 25
        if 0 <= f_idx < len(ema_fast) and 0 <= s_idx < len(ema_slow):
            macd_vals.append(ema_fast[f_idx] - ema_slow[s_idx])
        else:
            macd_vals.append(0.0)

    # Signal = 9-period EMA of macd_vals
    sig_ema = calc_ema_from_vals(macd_vals, 9)

    # sig_ema aligned to index (slow-1)+(signal-1) = 25+8 = 33 in original data
    start = 33
    signals = []
    prev_macd, prev_sig = None, None

    for i in range(33, len(data)):
        m_idx = i - 33
        if m_idx >= len(sig_ema):
            break
        curr_macd = macd_vals[m_idx]
        curr_sig = sig_ema[m_idx]

        if prev_macd is not None and prev_sig is not None:
            if prev_macd <= prev_sig and curr_macd > curr_sig:
                signals.append({"time": data[i]["time"], "signal": 1})
            elif prev_macd >= prev_sig and curr_macd < curr_sig:
                signals.append({"time": data[i]["time"], "signal": -1})
            else:
                signals.append({"time": data[i]["time"], "signal": 0})
        prev_macd = curr_macd
        prev_sig = curr_sig
    return signals


def calc_ema_from_vals(vals: List[float], period: int) -> List[float]:
    """EMA on a list of floats."""
    if len(vals) < period:
        return []
    mult = 2 / (period + 1)
    ema = [sum(vals[:period]) / period]
    for i in range(period, len(vals)):
        ema.append((vals[i] - ema[-1]) * mult + ema[-1])
    return ema


def bb_signal(data: List[Dict], period: int, std_dev: float) -> List[Dict]:
    """
    Bollinger Breakout: buy when price crosses above upper band, sell when below lower band.
    Returns {time, signal}.
    """
    if len(data) < period + 1:
        return []
    closes = [d["close"] for d in data]
    signals = []
    prev_in_band = None  # None, 'above', 'below', 'inside'

    for i in range(period - 1, len(closes)):
        window = closes[i - period + 1:i + 1]
        mean = sum(window) / period
        variance = sum((x - mean) ** 2 for x in window) / period
        std = math.sqrt(variance) if variance > 0 else 0.0
        upper = mean + std_dev * std
        lower = mean - std_dev * std
        price = closes[i]

        if price > upper:
            in_band = 'above'
        elif price < lower:
            in_band = 'below'
        else:
            in_band = 'inside'

        if prev_in_band == 'inside' and in_band == 'above':
            signals.append({"time": data[i]["time"], "signal": 1})
        elif prev_in_band == 'inside' and in_band == 'below':
            signals.append({"time": data[i]["time"], "signal": -1})
        else:
            signals.append({"time": data[i]["time"], "signal": 0})
        prev_in_band = in_band
    return signals


# ─── Strategy definitions ────────────────────────────────────────────

STRATEGIES = {
    "sma_crossover": {
        "label": "SMA Crossover",
        "default_params": {"fast": 20, "slow": 60},
        "signal_fn": lambda data, p: sma_crossover_signal(data, int(p.get("fast", 20)), int(p.get("slow", 60))),
    },
    "rsi_threshold": {
        "label": "RSI Threshold",
        "default_params": {"buy_threshold": 30, "sell_threshold": 70},
        "signal_fn": lambda data, p: rsi_signal(data, float(p.get("buy_threshold", 30)), float(p.get("sell_threshold", 70))),
    },
    "macd_cross": {
        "label": "MACD Cross",
        "default_params": {},
        "signal_fn": lambda data, p: macd_cross_signal(data),
    },
    "bollinger_breakout": {
        "label": "Bollinger Breakout",
        "default_params": {"period": 20, "std_dev": 2},
        "signal_fn": lambda data, p: bb_signal(data, int(p.get("period", 20)), float(p.get("std_dev", 2))),
    },
}


# ─── Core backtest ───────────────────────────────────────────────────

def run_backtest(
    data: List[Dict],
    strategy: str,
    params: Optional[Dict] = None,
    initial_capital: float = 10000.0,
) -> Dict[str, Any]:
    """
    Run backtest on historical K-line data.

    Params:
      data: list of {time, open, high, low, close, volume}
      strategy: key in STRATEGIES
      params: dict of strategy parameters
      initial_capital: starting capital (default 10000)

    Returns:
      {
        trades: [...],
        equity_curve: [...],
        metrics: {...},
        signals: [...]   # markers for the chart
      }
    """
    params = params or {}
    if strategy not in STRATEGIES:
        strategy = "sma_crossover"
    strat = STRATEGIES[strategy]
    p = {**strat["default_params"], **params}
    signal_fn = strat["signal_fn"]

    signals = signal_fn(data, p)

    # Build a signal lookup: time → signal
    sig_map = {s["time"]: s["signal"] for s in signals}

    trades = []
    equity_curve = []

    position = 0   # 0 = flat, 1 = long, -1 = short
    entry_price = 0.0
    entry_time = 0
    equity = initial_capital

    for i, bar in enumerate(data):
        t = bar["time"]
        sig = sig_map.get(t, 0)

        if position == 0 and sig == 1:
            # Open long
            position = 1
            entry_price = bar["close"]
            entry_time = t
        elif position == 0 and sig == -1:
            # Open short (not implemented — skip for now, trade long only)
            pass
        elif position == 1 and sig == -1:
            # Close long
            exit_price = bar["close"]
            pnl = exit_price - entry_price
            pnl_pct = (pnl / entry_price) * 100
            trades.append({
                "entry_time": entry_time,
                "exit_time": t,
                "entry_price": round(entry_price, 4),
                "exit_price": round(exit_price, 4),
                "pnl": round(pnl, 4),
                "pnl_pct": round(pnl_pct, 2),
                "type": "long",
            })
            equity += pnl
            equity_curve.append({"time": t, "equity": round(equity, 4)})
            position = 0
        else:
            equity_curve.append({"time": t, "equity": round(equity, 4)})

    # Close any open position at last bar close
    if position == 1 and len(data) > 0:
        last = data[-1]
        exit_price = last["close"]
        pnl = exit_price - entry_price
        pnl_pct = (pnl / entry_price) * 100
        trades.append({
            "entry_time": entry_time,
            "exit_time": last["time"],
            "entry_price": round(entry_price, 4),
            "exit_price": round(exit_price, 4),
            "pnl": round(pnl, 4),
            "pnl_pct": round(pnl_pct, 2),
            "type": "long",
        })
        equity += pnl
        equity_curve.append({"time": last["time"], "equity": round(equity, 4)})

    # Build entry/exit markers for chart
    markers = []
    for t in trades:
        markers.append({
            "time": t["entry_time"],
            "color": "#00D9A5",
            "text": f"B @ {t['entry_price']:.2f}",
            "shape": "arrowUp",
            "text_color": "#00D9A5",
            "id": f"entry_{t['entry_time']}",
        })
        markers.append({
            "time": t["exit_time"],
            "color": "#FF5B79",
            "text": f"S @ {t['exit_price']:.2f} ({t['pnl_pct']:+.1f}%)",
            "text_color": "#FF5B79",
            "shape": "arrowDown",
            "id": f"exit_{t['exit_time']}",
        })

    metrics = calc_metrics(trades, equity_curve, initial_capital)

    return {
        "strategy": strategy,
        "params": p,
        "trades": trades,
        "equity_curve": equity_curve,
        "markers": markers,
        "metrics": metrics,
    }


def calc_metrics(
    trades: List[Dict],
    equity_curve: List[Dict],
    initial_capital: float = 10000.0,
) -> Dict[str, Any]:
    """Compute performance metrics from trades and equity curve."""
    total_return = (equity_curve[-1]["equity"] - initial_capital) / initial_capital if equity_curve else 0.0

    wins = [t for t in trades if t["pnl"] > 0]
    losses = [t for t in trades if t["pnl"] <= 0]
    win_rate = (len(wins) / len(trades) * 100) if trades else 0.0

    win_total = sum(w["pnl"] for w in wins)
    loss_total = abs(sum(l["pnl"] for l in losses)) if losses else 0.0
    profit_factor = win_total / loss_total if loss_total > 0 else 0.0

    # Max drawdown
    peak = initial_capital
    max_dd = 0.0
    for e in equity_curve:
        if e["equity"] > peak:
            peak = e["equity"]
        dd = (peak - e["equity"]) / peak
        if dd > max_dd:
            max_dd = dd

    # Annualised Sharpe (daily returns, 252 trading days)
    if len(equity_curve) > 1:
        rets = []
        for i in range(1, len(equity_curve)):
            r = (equity_curve[i]["equity"] - equity_curve[i - 1]["equity"]) / equity_curve[i - 1]["equity"]
            rets.append(r)
        mean_r = sum(rets) / len(rets) if rets else 0.0
        variance = sum((r - mean_r) ** 2 for r in rets) / len(rets) if rets else 0.0
        std_r = math.sqrt(variance)
        if std_r > 0:
            sharpe = (mean_r / std_r) * math.sqrt(252)
        else:
            sharpe = 0.0
    else:
        sharpe = 0.0

    return {
        "total_return": round(total_return * 100, 2),
        "win_rate": round(win_rate, 2),
        "profit_factor": round(profit_factor, 2),
        "max_drawdown": round(max_dd * 100, 2),
        "sharpe": round(sharpe, 2),
        "trade_count": len(trades),
        "win_count": len(wins),
        "loss_count": len(losses),
    }
