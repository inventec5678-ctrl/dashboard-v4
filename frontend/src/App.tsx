import { createSignal, createEffect, onMount, onCleanup, Show } from 'solid-js';
import { createChart, ColorType, CrosshairMode, IChartApi, ISeriesApi } from 'lightweight-charts';

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

function App() {
  let chartContainerRef: HTMLDivElement | undefined;
  let chart: IChartApi | null = null;
  let candlestickSeries: ISeriesApi<'Candlestick'> | null = null;
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

  // Price animation state
  const [priceFlashClass, setPriceFlashClass] = createSignal('');

  const UP_COLOR = '#00D9A5';
  const DOWN_COLOR = '#FF5B79';
  const UP_WICK_COLOR = 'rgba(0, 217, 165, 0.8)';
  const DOWN_WICK_COLOR = 'rgba(255, 91, 121, 0.8)';

  let openPriceRef = 0;

  onMount(async () => {
    if (!chartContainerRef) return;

    chart = createChart(chartContainerRef, {
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
          width: 1,
          style: 0,
          labelBackgroundColor: '#1E2433',
        },
        horzLine: {
          color: 'rgba(139, 149, 168, 0.4)',
          width: 1,
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
    });

    candlestickSeries = chart.addCandlestickSeries({
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderUpColor: UP_COLOR,
      borderDownColor: DOWN_COLOR,
      wickUpColor: UP_WICK_COLOR,
      wickDownColor: DOWN_WICK_COLOR,
    });

    // Responsive resize
    const resizeObserver = new ResizeObserver(() => {
      if (chart && chartContainerRef) {
        chart.applyOptions({
          width: chartContainerRef.clientWidth,
          height: chartContainerRef.clientHeight,
        });
      }
    });
    resizeObserver.observe(chartContainerRef);

    onCleanup(() => {
      resizeObserver.disconnect();
      ws?.close();
      chart?.remove();
    });

    // Load initial data
    await loadKlines();
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

      // Trigger flash animation
      if (direction && prevPrice > 0) {
        setPriceFlashClass(direction === 'up' ? 'flash-up' : 'flash-down');
        setTimeout(() => setPriceFlashClass(''), 500);
      }

      // Update last K-line close price on chart
      if (candlestickSeries && lastKlineTime > 0) {
        candlestickSeries.update({
          time: lastKlineTime as any,
          open: newPrice,
          high: Math.max(newPrice, lastPrice()),
          low: Math.min(newPrice, lastPrice()),
          close: newPrice,
        });
      }

      setLastPrice(newPrice);
      setPriceChangePct(data.changePct);
      // Calc absolute change from open price
      if (openPriceRef > 0) {
        setPriceChange(newPrice - openPriceRef);
      }
    };

    ws.onerror = () => {
      // Silently handle — will retry on next interval if needed
    };

    ws.onclose = () => {
      // Auto-reconnect after 3s
      setTimeout(connectWebSocket, 3000);
    };
  }

  async function loadKlines() {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch('/api/klines?symbol=BTCUSDT&interval=1h&limit=100');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data: KLineResponse = await response.json();

      if (!data.data || data.data.length === 0) throw new Error('No data');

      // Store the first bar's open for changePct reference
      openPriceRef = data.data[0].open;

      const formattedData = data.data.map((k) => ({
        time: k.time as any,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      }));

      // Track last K-line timestamp for updates
      lastKlineTime = data.data[data.data.length - 1].time;

      candlestickSeries?.setData(formattedData);

      // Calculate stats
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

      // 24h high/low from all data
      const highs = data.data.map((k) => k.high);
      const lows = data.data.map((k) => k.low);
      setHigh24h(Math.max(...highs));
      setLow24h(Math.min(...lows));

      // Fake volume
      setVolume(Math.random() * 50000 + 10000);

      // Fit content
      chart?.timeScale().fitContent();

      setLoading(false);

      // Connect WebSocket after data loads
      connectWebSocket();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
      setLoading(false);
    }
  }

  return (
    <div class="app-container">
      {/* ====== TOP BAR — Real-time Price ====== */}
      <div class="topbar glass-card">
        <div class="topbar-left">
          <span class="symbol-badge">
            <span class="dot" />
            {symbol()}
          </span>
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
          <div class="header-subtitle mono">1H Timeframe · Live Data</div>
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

      {/* Price Overlay */}
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

        {/* Chart */}
        <div
          ref={chartContainerRef}
          class="chart-container"
          style={{ opacity: loading() ? 0 : 1, transition: 'opacity 0.3s ease' }}
        />

        {/* Loading Overlay */}
        <Show when={loading()}>
          <div class="loading-overlay">
            <div class="loading-spinner" />
            <div class="loading-text">Loading market data...</div>
          </div>
        </Show>

        {/* Error State */}
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
