import { createSignal, createEffect, onMount, onCleanup, Show, For } from 'solid-js';
import { createChart, ColorType, CrosshairMode, IChartApi, ISeriesApi, LineWidth, Time } from 'lightweight-charts';

interface KLine {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface KLineResponse {
  symbol: string;
  interval: string;
  data: KLine[];
}

interface PriceUpdate {
  type: 'price_update';
  symbol: string;
  price: number;
  changePct: number;
}

interface SymbolInfo {
  symbol: string;
  display: string;
  name: string;
}

// --- Indicator helpers ---
function calcSMA(data: KLine[], period: number = 20): { time: Time; value: number }[] {
  const closes = data.map(d => d.close);
  const result: { time: Time; value: number }[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    const avg = closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    result.push({ time: data[i].time as Time, value: avg });
  }
  return result;
}

function calcRSI(data: KLine[], period: number = 14): { time: Time; value: number }[] {
  const closes = data.map(d => d.close);
  const result: { time: Time; value: number }[] = [];
  for (let i = period; i < closes.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - period; j < i; j++) {
      const diff = closes[j + 1] - closes[j];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    const rs = gains / losses || 0;
    const rsi = 100 - (100 / (1 + rs));
    result.push({ time: data[i].time as Time, value: rsi });
  }
  return result;
}

function App() {
  let chartContainerRef: HTMLDivElement | undefined;
  let smaContainerRef: HTMLDivElement | undefined;
  let rsiContainerRef: HTMLDivElement | undefined;

  let chart: IChartApi | null = null;
  let smaChart: IChartApi | null = null;
  let rsiChart: IChartApi | null = null;
  let candlestickSeries: ISeriesApi<'Candlestick'> | null = null;
  let smaSeries: ISeriesApi<'Line'> | null = null;
  let rsiSeries: ISeriesApi<'Line'> | null = null;

  let ws: WebSocket | null = null;
  let lastKlineTime: number = 0;

  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [lastPrice, setLastPrice] = createSignal<number>(0);
  const [priceChange, setPriceChange] = createSignal<number>(0);
  const [priceChangePct, setPriceChangePct] = createSignal<number>(0);
  const [symbol, setSymbol] = createSignal('BTCUSDT');
  const [high24h, setHigh24h] = createSignal(0);
  const [low24h, setLow24h] = createSignal(0);
  const [volume, setVolume] = createSignal(0);

  // Market & Symbol selector
  const [market, setMarket] = createSignal<'CRYPTO' | 'TWSE' | 'US'>('CRYPTO');
  const [symbols, setSymbols] = createSignal<SymbolInfo[]>([]);
  const [selectedSymbol, setSelectedSymbol] = createSignal('BTCUSDT');

  // Price animation state
  const [priceFlashClass, setPriceFlashClass] = createSignal('');

  const UP_COLOR = '#00D9A5';
  const DOWN_COLOR = '#FF5B79';
  const UP_WICK_COLOR = 'rgba(0, 217, 165, 0.8)';
  const DOWN_WICK_COLOR = 'rgba(255, 91, 121, 0.8)';

  let openPriceRef = 0;

  // Fetch symbols when market changes
  createEffect(() => {
    const m = market();
    fetch(`/api/symbols?market=${m}`)
      .then(r => r.json())
      .then(d => {
        setSymbols(d.data as SymbolInfo[]);
        if (d.data.length > 0) setSelectedSymbol(d.data[0].symbol);
      });
  });

  const baseChartOptions = (height: number) => ({
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: '#8B95A8',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: 'rgba(255, 255, 255, 0.03)' },
      horzLines: { color: 'rgba(255, 255, 255, 0.03)' },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: 'rgba(139, 149, 168, 0.4)',
        width: 1 as LineWidth,
        style: 0,
        labelBackgroundColor: '#1E2433',
      },
      horzLine: {
        color: 'rgba(139, 149, 168, 0.4)',
        width: 1 as LineWidth,
        style: 0,
        labelBackgroundColor: '#1E2433',
      },
    },
    rightPriceScale: {
      borderColor: 'rgba(255, 255, 255, 0.06)',
      scaleMargins: { top: 0.1, bottom: 0.1 },
    },
    timeScale: {
      borderColor: 'rgba(255, 255, 255, 0.06)',
      timeVisible: true,
      secondsVisible: false,
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true },
    handleScale: { mouseWheel: true, pinch: true },
    height,
  });

  onMount(() => {
    if (!chartContainerRef || !smaContainerRef || !rsiContainerRef) return;

    // Main candlestick chart
    chart = createChart(chartContainerRef, {
      ...baseChartOptions(400),
      width: chartContainerRef.clientWidth,
    });

    candlestickSeries = chart.addCandlestickSeries({
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderUpColor: UP_COLOR,
      borderDownColor: DOWN_COLOR,
      wickUpColor: UP_WICK_COLOR,
      wickDownColor: DOWN_WICK_COLOR,
    });

    // SMA chart
    smaChart = createChart(smaContainerRef, {
      ...baseChartOptions(120),
      width: smaContainerRef.clientWidth,
      rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.06)', scaleMargins: { top: 0.2, bottom: 0.2 } },
    });
    smaSeries = smaChart.addLineSeries({ color: '#FFA500', lineWidth: 1 as LineWidth, title: 'SMA20' });

    // RSI chart
    rsiChart = createChart(rsiContainerRef, {
      ...baseChartOptions(120),
      width: rsiContainerRef.clientWidth,
      rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.06)', scaleMargins: { top: 0.2, bottom: 0.2 } },
    });
    rsiSeries = rsiChart.addLineSeries({ color: '#9B59B6', lineWidth: 1 as LineWidth, title: 'RSI14' });
    // RSI reference lines at 70/30
    rsiChart.addLineSeries({ color: 'rgba(255,0,0,0.3)', lineWidth: 1 as LineWidth, lineStyle: 2 });
    rsiChart.addLineSeries({ color: 'rgba(0,255,0,0.3)', lineWidth: 1 as LineWidth, lineStyle: 2 });

    // Responsive resize
    const makeResizeHandler = (c: HTMLDivElement, api: IChartApi | null) => () => {
      if (api && c) {
        api.applyOptions({ width: c.clientWidth, height: c.clientHeight });
      }
    };

    const roMain = new ResizeObserver(makeResizeHandler(chartContainerRef, chart));
    const roSMA = new ResizeObserver(makeResizeHandler(smaContainerRef, smaChart));
    const roRSI = new ResizeObserver(makeResizeHandler(rsiContainerRef, rsiChart));

    roMain.observe(chartContainerRef);
    roSMA.observe(smaContainerRef);
    roRSI.observe(rsiContainerRef);

    onCleanup(() => {
      roMain.disconnect();
      roSMA.disconnect();
      roRSI.disconnect();
      ws?.close();
      chart?.remove();
      smaChart?.remove();
      rsiChart?.remove();
    });

    loadKlines();
  });

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      const data: PriceUpdate = JSON.parse(event.data);
      if (data.type !== 'price_update') return;

      const newPrice = data.price;
      const prevPrice = lastPrice();
      const direction = newPrice > prevPrice ? 'up' : newPrice < prevPrice ? 'down' : null;

      if (direction && prevPrice > 0) {
        setPriceFlashClass(direction === 'up' ? 'flash-up' : 'flash-down');
        setTimeout(() => setPriceFlashClass(''), 500);
      }

      if (candlestickSeries && lastKlineTime > 0) {
        candlestickSeries.update({
          time: lastKlineTime as Time,
          open: newPrice,
          high: Math.max(newPrice, lastPrice()),
          low: Math.min(newPrice, lastPrice()),
          close: newPrice,
        });
      }

      setLastPrice(newPrice);
      setPriceChangePct(data.changePct);
      if (openPriceRef > 0) {
        setPriceChange(newPrice - openPriceRef);
      }
    };

    ws.onerror = () => { };

    ws.onclose = () => {
      setTimeout(connectWebSocket, 3000);
    };
  }

  async function loadKlines() {
    try {
      setLoading(true);
      setError(null);

      const url = `/api/klines?symbol=${selectedSymbol()}&interval=1h&limit=100&market=${market()}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data: KLineResponse = await response.json();

      if (!data.data || data.data.length === 0) throw new Error('No data');

      openPriceRef = data.data[0].open;

      const formattedData = data.data.map((k) => ({
        time: k.time as Time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      }));

      lastKlineTime = data.data[data.data.length - 1].time;

      candlestickSeries?.setData(formattedData);

      // SMA + RSI
      const smaData = calcSMA(data.data, 20);
      const rsiData = calcRSI(data.data, 14);
      smaSeries?.setData(smaData);
      rsiSeries?.setData(rsiData);

      // Stats
      const last = data.data[data.data.length - 1];
      const first = data.data[0];
      const lastClose = last.close;
      const firstOpen = first.open;
      const change = lastClose - firstOpen;
      const changePct = (change / firstOpen) * 100;

      setLastPrice(lastClose);
      setPriceChange(change);
      setPriceChangePct(changePct);
      setSymbol(data.symbol);

      const highs = data.data.map((k) => k.high);
      const lows = data.data.map((k) => k.low);
      setHigh24h(Math.max(...highs));
      setLow24h(Math.min(...lows));

      setVolume(Math.random() * 50000 + 10000);

      chart?.timeScale().fitContent();
      smaChart?.timeScale().fitContent();
      rsiChart?.timeScale().fitContent();

      setLoading(false);
      connectWebSocket();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
      setLoading(false);
    }
  }

  // Re-load klines when market or selected symbol changes
  createEffect(() => {
    const m = market();
    const s = selectedSymbol();
    if (symbols().length > 0) {
      loadKlines();
    }
  });

  return (
    <div class="app-container">
      {/* ====== Market Tabs ====== */}
      <div class="market-tabs">
        <For each={['CRYPTO', 'TWSE', 'US'] as const}>
          {(m) => (
            <button
              class={`tab-btn ${market() === m ? 'active' : ''}`}
              onClick={() => setMarket(m)}
            >
              {m}
            </button>
          )}
        </For>
      </div>

      {/* ====== TOP BAR ====== */}
      <div class="topbar glass-card">
        <div class="topbar-left">
          <select
            class="symbol-select"
            value={selectedSymbol()}
            onChange={e => setSelectedSymbol(e.target.value)}
          >
            <For each={symbols()}>
              {(s) => (
                <option value={s.symbol}>{s.display} — {s.name}</option>
              )}
            </For>
          </select>
          <span class="topbar-interval mono">1H</span>
        </div>

        <div class="topbar-price-group">
          <span class={`topbar-price mono ${priceFlashClass()}`}>
            {lastPrice().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <span
            class={`topbar-change mono ${priceChangePct() >= 0 ? 'text-green' : 'text-red'}`}
          >
            {priceChangePct() >= 0 ? '+' : ''}
            {priceChangePct().toFixed(2)}%
          </span>
        </div>

        <div class="topbar-right">
          <div class="topbar-stat">
            <span class="topbar-stat-label">24h High</span>
            <span class="topbar-stat-value mono text-green">
              {high24h().toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </span>
          </div>
          <div class="topbar-stat">
            <span class="topbar-stat-label">24h Low</span>
            <span class="topbar-stat-value mono text-red">
              {low24h().toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </span>
          </div>
          <div class="topbar-stat">
            <span class="topbar-stat-label">Volume</span>
            <span class="topbar-stat-value mono text-blue">
              {(volume() / 1000).toFixed(1)}K
            </span>
          </div>
        </div>
      </div>

      {/* Header */}
      <header class="header glass-card" style="padding: 20px 24px;">
        <div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="symbol-badge">
              <span class="dot" />
              {symbol()}
            </span>
            <span class="header-title">K-Line Chart</span>
          </div>
          <div class="header-subtitle mono">1H Timeframe · {market()} Market</div>
        </div>

        <div style="display: flex; align-items: center; gap: 16px;">
          <button class="btn btn-secondary" onClick={loadKlines} title="Refresh">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
            Refresh
          </button>
        </div>
      </header>

      {/* Candlestick Chart */}
      <div class="chart-wrapper glass-card" style="position: relative;">
        <div class="chart-overlay">
          <div class={`chart-price mono ${priceFlashClass()}`}>
            {lastPrice().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div
            class="chart-change mono"
            style={{ color: priceChange() >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}
          >
            {priceChange() >= 0 ? '+' : ''}
            {priceChange().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            {' '}
            ({priceChangePct() >= 0 ? '+' : ''}
            {priceChangePct().toFixed(2)}%)
          </div>
        </div>

        <div
          ref={chartContainerRef}
          class="chart-container"
          style={{ opacity: loading() ? 0 : 1, transition: 'opacity 0.3s ease', height: '400px' }}
        />

        <Show when={loading()}>
          <div class="loading-overlay">
            <div class="loading-spinner" />
            <div class="loading-text">Loading market data...</div>
          </div>
        </Show>

        <Show when={error()}>
          <div class="loading-overlay">
            <div class="loading-text" style="color: var(--accent-red);">
              Error: {error()}
            </div>
            <button class="btn btn-primary" onClick={loadKlines}>
              Retry
            </button>
          </div>
        </Show>
      </div>

      {/* SMA Chart */}
      <div class="chart-wrapper glass-card" style="position: relative;">
        <div style="padding: 8px 16px; font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono);">
          SMA20
        </div>
        <div ref={smaContainerRef} style="height: 120px;" />
      </div>

      {/* RSI Chart */}
      <div class="chart-wrapper glass-card" style="position: relative;">
        <div style="padding: 8px 16px; font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono);">
          RSI14 (overbought &gt;70, oversold &lt;30)
        </div>
        <div ref={rsiContainerRef} style="height: 120px;" />
      </div>

      {/* Stats Bar */}
      <div class="stats-bar">
        <div class="glass-card stat-item">
          <span class="stat-label">24h High</span>
          <span class="stat-value mono text-green">
            {high24h().toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </span>
        </div>
        <div class="glass-card stat-item">
          <span class="stat-label">24h Low</span>
          <span class="stat-value mono text-red">
            {low24h().toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </span>
        </div>
        <div class="glass-card stat-item">
          <span class="stat-label">Volume</span>
          <span class="stat-value mono text-blue">
            {(volume() / 1000).toFixed(1)}K
          </span>
        </div>
        <div class="glass-card stat-item">
          <span class="stat-label">Interval</span>
          <span class="stat-value mono">1H</span>
        </div>
      </div>
    </div>
  );
}

export default App;