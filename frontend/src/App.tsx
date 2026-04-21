import { createSignal, createEffect, onMount, onCleanup, Show, For } from 'solid-js';
import { createChart, ColorType, CrosshairMode, IChartApi, ISeriesApi, LineWidth, Time, VerticalLine } from 'lightweight-charts';
import BacktestPanel from './BacktestPanel';

interface MACDData { time: Time; macd: number; signal: number; histogram: number; }

function calcMACD(data: KLine[]): MACDData[] {
  const closes = data.map(d => d.close);
  const period = 14;
  if (closes.length < 27) return [];

  // EMA helper
  const calcEMA = (vals: number[], p: number): number[] => {
    const mult = 2 / (p + 1);
    const ema = [vals.slice(0, p).reduce((a, b) => a + b, 0) / p];
    for (let i = p; i < vals.length; i++) ema.push((vals[i] - ema[ema.length - 1]) * mult + ema[ema.length - 1]);
    return ema;
  };

  // Full EMAs
  const emaFast = calcEMA(closes, 12);
  const emaSlow = calcEMA(closes, 26);

  // MACD line (index slow-1 onwards in closes = index 25)
  const macdVals: number[] = [];
  for (let i = 25; i < closes.length; i++) {
    const fIdx = i - 11, sIdx = i - 25;
    macdVals.push(emaFast[fIdx] - emaSlow[sIdx]);
  }

  // Signal line
  const sigEMA = calcEMA(macdVals, 9);

  const result: MACDData[] = [];
  for (let i = 0; i < sigEMA.length; i++) {
    const dataIdx = 25 + 8 + i;
    if (dataIdx < data.length) {
      const m = macdVals[8 + i];
      result.push({ time: data[dataIdx].time as Time, macd: m, signal: sigEMA[i], histogram: m - sigEMA[i] });
    }
  }
  return result;
}

interface KLine {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface KLineResponse {
  symbol: string;
  interval: string;
  data: KLine[];
  interval_approximated?: boolean;
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

function formatVolume(v: number): string {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

function App() {
  let chartContainerRef: HTMLDivElement | undefined;
  let smaContainerRef: HTMLDivElement | undefined;
  let rsiContainerRef: HTMLDivElement | undefined;
  let volumeContainerRef: HTMLDivElement | undefined;
  let macdContainerRef: HTMLDivElement | undefined;
  let obContainerRef: HTMLDivElement | undefined;

  let chart: IChartApi | null = null;
  let smaChart: IChartApi | null = null;
  let rsiChart: IChartApi | null = null;
  let volumeChart: IChartApi | null = null;
  let macdChart: IChartApi | null = null;
  let obChart: IChartApi | null = null;
  let candlestickSeries: ISeriesApi<'Candlestick'> | null = null;
  let smaSeries: ISeriesApi<'Line'> | null = null;
  let rsiSeries: ISeriesApi<'Line'> | null = null;
  let volumeSeries: ISeriesApi<'Histogram'> | null = null;
  let macdSeries: ISeriesApi<'Line'> | null = null;
  let macdSignalSeries: ISeriesApi<'Line'> | null = null;
  let macdHistogramSeries: ISeriesApi<'Histogram'> | null = null;
  let volumeAnomalySeries: ISeriesApi<'Line'> | null = null;

  let ws: WebSocket | null = null;
  let obIntervalId: ReturnType<typeof setInterval> | null = null;
  let lastKlineTime: number = 0;

  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [intervalApproximated, setIntervalApproximated] = createSignal(false);
  const [lastPrice, setLastPrice] = createSignal<number>(0);
  const [priceChange, setPriceChange] = createSignal<number>(0);
  const [priceChangePct, setPriceChangePct] = createSignal<number>(0);
  const [symbol, setSymbol] = createSignal('BTCUSDT');
  const [high24h, setHigh24h] = createSignal(0);
  const [low24h, setLow24h] = createSignal(0);
  const [volume, setVolume] = createSignal(0);

  // Order Book Anomaly state
  const [obAnomalies, setObAnomalies] = createSignal<any>(null);
  const [obRefreshKey, setObRefreshKey] = createSignal(0);

  // Market & Symbol selector
  const [market, setMarket] = createSignal<'CRYPTO' | 'TWSE' | 'US'>('CRYPTO');
  const [symbols, setSymbols] = createSignal<SymbolInfo[]>([]);
  const [selectedSymbol, setSelectedSymbol] = createSignal('BTCUSDT');

  // Timeframe selector — dynamic per market
  const [interval, setInterval] = createSignal<string>('1d');

  const CRYPTO_INTERVALS = [
    { label: '1m', value: '1m' },
    { label: '5m', value: '5m' },
    { label: '15m', value: '15m' },
    { label: '1H', value: '1h' },
    { label: '4H', value: '4h' },
    { label: '1D', value: '1d' },
    { label: '1W', value: '1w' },
    { label: '1M', value: '1mo' },
  ] as const;

  const US_INTERVALS = [
    { label: '1H', value: '1h' },
    { label: '4H', value: '4h' },
    { label: '1D', value: '1d' },
    { label: '1W', value: '1w' },
    { label: '1M', value: '1mo' },
  ] as const;

  const TWSE_INTERVALS = [
    { label: '1D', value: '1d' },
    { label: '1W', value: '1w' },
    { label: '1M', value: '1mo' },
  ] as const;

  const availableIntervals = () => {
    switch (market()) {
      case 'US':    return US_INTERVALS;
      case 'TWSE':  return TWSE_INTERVALS;
      default:      return CRYPTO_INTERVALS;
    }
  };

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

    // Volume chart
    if (volumeContainerRef) {
      volumeChart = createChart(volumeContainerRef, {
        ...baseChartOptions(100),
        width: volumeContainerRef.clientWidth,
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', scaleMargins: { top: 0.1, bottom: 0 } },
      });
      volumeSeries = volumeChart.addHistogramSeries({
        color: UP_COLOR,
        priceFormat: { type: 'volume' },
        priceScaleId: '',
      });
      volumeChart.priceScale('').applyOptions({
        scaleMargins: { top: 0.1, bottom: 0 },
      });
    }

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

    // MACD chart
    if (macdContainerRef) {
      macdChart = createChart(macdContainerRef, {
        ...baseChartOptions(90),
        width: macdContainerRef.clientWidth,
        rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.06)', scaleMargins: { top: 0.2, bottom: 0.2 } },
      });
      macdHistogramSeries = macdChart.addHistogramSeries({
        color: 'rgba(0, 217, 165, 0.5)',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        priceScaleId: '',
      });
      macdChart.priceScale('').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
      macdSeries = macdChart.addLineSeries({ color: '#3B82F6', lineWidth: 1 as LineWidth, title: 'MACD' });
      macdSignalSeries = macdChart.addLineSeries({ color: '#FF5B79', lineWidth: 1 as LineWidth, title: 'Signal' });
    }

    // Order Book depth chart
    if (obContainerRef) {
      obChart = createChart(obContainerRef, {
        ...baseChartOptions(120),
        width: obContainerRef.clientWidth,
        rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.06)', scaleMargins: { top: 0.1, bottom: 0.1 } },
      });
    }

    // Responsive resize
    const makeResizeHandler = (c: HTMLDivElement, api: IChartApi | null) => () => {
      if (api && c) {
        api.applyOptions({ width: c.clientWidth, height: c.clientHeight });
      }
    };

    const roMain = new ResizeObserver(makeResizeHandler(chartContainerRef, chart));
    const roSMA = new ResizeObserver(makeResizeHandler(smaContainerRef, smaChart));
    const roRSI = new ResizeObserver(makeResizeHandler(rsiContainerRef, rsiChart));
    const roVolume = new ResizeObserver(makeResizeHandler(volumeContainerRef!, volumeChart));
    const roMACD = new ResizeObserver(makeResizeHandler(macdContainerRef!, macdChart));
    const roOB = new ResizeObserver(makeResizeHandler(obContainerRef!, obChart));

    roMain.observe(chartContainerRef);
    roSMA.observe(smaContainerRef);
    roRSI.observe(rsiContainerRef);
    if (volumeContainerRef) roVolume.observe(volumeContainerRef);
    if (macdContainerRef) roMACD.observe(macdContainerRef);
    if (obContainerRef) roOB.observe(obContainerRef);

    onCleanup(() => {
      roMain.disconnect();
      roSMA.disconnect();
      roRSI.disconnect();
      roVolume.disconnect();
      roMACD.disconnect();
      roOB.disconnect();
      ws?.close();
      if (obIntervalId) clearInterval(obIntervalId);
      chart?.remove();
      smaChart?.remove();
      rsiChart?.remove();
      volumeChart?.remove();
      macdChart?.remove();
      obChart?.remove();
    });

    loadKlines();
    refreshObAnomalies();
    obIntervalId = setInterval(refreshObAnomalies, 5000);
  });

  async function refreshObAnomalies() {
    try {
      const obResp = await fetch(`/api/orderbook_anomaly?symbol=${selectedSymbol()}`);
      if (obResp.ok) {
        const ob = await obResp.json();
        setObAnomalies(ob);

        if (obChart) {
          // Clear existing series
          obChart.remove();

          // Rebuild chart
          obChart = createChart(obContainerRef!, {
            ...baseChartOptions(120),
            width: obContainerRef!.clientWidth,
            rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.06)', scaleMargins: { top: 0.1, bottom: 0.1 } },
          });

          if (ob.bids && ob.asks) {
            const bids = ob.bids.map((b: any) => ({ price: parseFloat(b[0]), volume: parseFloat(b[1]) }));
            const asks = ob.asks.map((a: any) => ({ price: parseFloat(a[0]), volume: parseFloat(a[1]) }));

            const bidSeries = obChart.addHistogramSeries({
              color: 'rgba(0, 217, 165, 0.5)',
              priceFormat: { type: 'price', precision: 2 },
              priceScaleId: 'bid',
            });
            bidSeries.setData(bids.map(b => ({
              time: b.price as Time,
              value: b.volume,
              color: 'rgba(0, 217, 165, 0.5)',
            })));

            const askSeries = obChart.addHistogramSeries({
              color: 'rgba(255, 91, 121, 0.5)',
              priceFormat: { type: 'price', precision: 2 },
              priceScaleId: 'ask',
            });
            askSeries.setData(asks.map(a => ({
              time: a.price as Time,
              value: a.volume,
              color: 'rgba(255, 91, 121, 0.5)',
            })));

            obChart.priceScale('bid').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
            obChart.priceScale('ask').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });

            if (ob.top_anomalies) {
              for (const ta of ob.top_anomalies) {
                obChart.addVerticalLine({
                  time: ta.price as Time,
                  color: 'rgba(255, 91, 121, 0.9)',
                  lineWidth: 1 as LineWidth,
                  lineStyle: 0,
                  axisLabelVisible: true,
                });
              }
            }
            obChart.timeScale().fitContent();
          }
        }
      }
    } catch (_e) { /* silently skip */ }
  }

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/klines?symbol=${selectedSymbol()}&interval=${interval()}`;

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

      const url = `/api/klines?symbol=${selectedSymbol()}&interval=${interval()}&limit=500&market=${market()}&years=5`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data: KLineResponse = await response.json();

      if (!data.data || data.data.length === 0) throw new Error('No data');

      setIntervalApproximated(data.interval_approximated ?? false);
      openPriceRef = uniqueBars[0].open;

      const formattedData = data.data.map((k) => ({
        time: k.time as Time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      }));

      lastKlineTime = data.data[data.data.length - 1].time;

      // Deduplicate data.data by time (handles duplicate API timestamps)
      const seenTimes = new Set<number>();
      const uniqueBars = data.data.filter(b => {
        if (seenTimes.has(b.time)) return false;
        seenTimes.add(b.time);
        return true;
      });

      // Deduplicate by time so setData never gets duplicate timestamps
      const seen = new Set<number>();
      const uniqueData = formattedData.filter(d => {
        const t = d.time as number;
        if (seen.has(t)) return false;
        seen.add(t);
        return true;
      });

      candlestickSeries?.setData(uniqueData);

      // For monthly (1M) data with many years, default to showing last 24 bars
      // so candles render at readable width instead of 1-2px slivers
      const barsToShow = interval() === '1mo' ? 24 : undefined;
      if (barsToShow && uniqueData.length > barsToShow) {
        const lastTime = uniqueData[uniqueData.length - 1].time as number;
        const firstTime = uniqueData[uniqueData.length - barsToShow].time as number;
        chart?.timeScale().setVisibleRange({ from: firstTime, to: lastTime + 86400 * 31 });
      } else {
        chart?.timeScale().fitContent();
      }

      // Volume
      if (volumeSeries && uniqueBars) {
        const volumeData = uniqueBars.map((k) => ({
          time: k.time as Time,
          value: k.volume || 0,
          color: k.close >= k.open ? 'rgba(0, 217, 165, 0.5)' : 'rgba(255, 91, 121, 0.5)',
        }));
        volumeSeries.setData(volumeData);
        volumeChart?.timeScale().scrollToPosition(chart!.timeScale().scrollPosition(), true);
      }

      // SMA + RSI + MACD (use same uniqueBars dedup logic)
      const smaData = calcSMA(uniqueBars, 20);
      const rsiData = calcRSI(uniqueBars, 14);
      smaSeries?.setData(smaData);
      rsiSeries?.setData(rsiData);

      // MACD
      const macdData = calcMACD(uniqueBars);
      if (macdSeries && macdSignalSeries && macdHistogramSeries && macdData.length > 0) {
        macdSeries.setData(macdData.map(d => ({ time: d.time, value: d.macd })));
        macdSignalSeries.setData(macdData.map(d => ({ time: d.time, value: d.signal })));
        macdHistogramSeries.setData(macdData.map(d => ({
          time: d.time,
          value: d.histogram,
          color: d.histogram >= 0 ? 'rgba(0, 217, 165, 0.5)' : 'rgba(255, 91, 121, 0.5)',
        })));
      }

      // Volume Anomaly markers (z-score > 2 on main chart)
      try {
        const vaResp = await fetch(`/api/anomaly_volume?symbol=${selectedSymbol()}&interval=${interval()}&market=${market()}&years=5`);
        if (vaResp.ok) {
          const vaData = await vaResp.json();
          const anomalies = vaData.anomalies || [];
          for (const a of anomalies) {
            if (chart) {
              chart.addVerticalLine({
                time: a.time as Time,
                color: 'rgba(255, 91, 121, 0.8)',
                lineWidth: 2 as LineWidth,
                lineStyle: 0,
                axisLabelVisible: false,
              });
            }
          }
        }
      } catch (_e) { /* silently skip */ }

      // Order Book anomaly fetch + chart
      try {
        const obResp = await fetch(`/api/orderbook_anomaly?symbol=${selectedSymbol()}`);
        if (obResp.ok) {
          const ob = await obResp.json();
          setObAnomalies(ob);

          if (obChart && ob.bids && ob.asks) {
            const bids = ob.bids.map((b: string[]) => ({ price: parseFloat(b[0]), volume: parseFloat(b[1]) }));
            const asks = ob.asks.map((a: string[]) => ({ price: parseFloat(a[0]), volume: parseFloat(a[1]) }));

            const maxVol = Math.max(...bids.map(b => b.volume), ...asks.map(a => a.volume), 1);

            obChart.addHistogramSeries({
              color: 'rgba(0, 217, 165, 0.5)',
              priceFormat: { type: 'price', precision: 2 },
              priceScaleId: 'bid',
            }).setData(bids.map(b => ({
              time: b.price as Time,
              value: b.volume,
              color: 'rgba(0, 217, 165, 0.5)',
            })));

            obChart.addHistogramSeries({
              color: 'rgba(255, 91, 121, 0.5)',
              priceFormat: { type: 'price', precision: 2 },
              priceScaleId: 'ask',
            }).setData(asks.map(a => ({
              time: a.price as Time,
              value: a.volume,
              color: 'rgba(255, 91, 121, 0.5)',
            })));

            // Mark anomaly price levels with vertical lines
            if (ob.top_anomalies) {
              for (const ta of ob.top_anomalies) {
                obChart.addVerticalLine({
                  time: ta.price as Time,
                  color: 'rgba(255, 91, 121, 0.9)',
                  lineWidth: 1 as LineWidth,
                  lineStyle: 0,
                  axisLabelVisible: true,
                });
              }
            }
            obChart.timeScale().fitContent();
          }
        }
      } catch (_e) { /* silently skip */ }

      // Stats
      const last = uniqueBars[uniqueBars.length - 1];
      const prev = uniqueBars[uniqueBars.length - 2];  // previous candle close = "yesterday"
      const lastClose = last.close;
      const prevClose = prev.close;
      const change = lastClose - prevClose;
      const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

      setLastPrice(lastClose);
      setPriceChange(change);
      setPriceChangePct(changePct);
      setSymbol(data.symbol);

      const highs = uniqueBars.map((k) => k.high);
      const lows = uniqueBars.map((k) => k.low);
      setHigh24h(Math.max(...highs));
      setLow24h(Math.min(...lows));

      setVolume(Math.random() * 50000 + 10000);

      // Only fitContent for non-1mo (1mo has its own visible range logic above)
      const isMonthly = interval() === '1mo' && data.data.length > 24;
      if (!isMonthly) {
        chart?.timeScale().fitContent();
        smaChart?.timeScale().fitContent();
        rsiChart?.timeScale().fitContent();
        volumeChart?.timeScale().fitContent();
      }

      // Sync time scale between candlestick and volume
      if (chart && volumeChart) {
        chart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
          if (range) volumeChart!.timeScale().setVisibleLogicalRange(range);
        });
        volumeChart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
          if (range) chart!.timeScale().setVisibleLogicalRange(range);
        });
      }

      // Sync MACD with main chart
      if (chart && macdChart) {
        chart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
          if (range) macdChart!.timeScale().setVisibleLogicalRange(range);
        });
        macdChart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
          if (range) chart!.timeScale().setVisibleLogicalRange(range);
        });
      }

      macdChart?.timeScale().fitContent();

      setLoading(false);
      connectWebSocket();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
      setLoading(false);
    }
  }

  // Re-load klines when market, symbol, or interval changes
  createEffect(() => {
    const m = market();
    const s = selectedSymbol();
    const tf = interval();
    // Reset to default interval when switching to a market that doesn't support current tf
    const valid = availableIntervals().map(i => i.value);
    if (!valid.includes(tf)) {
      setInterval(valid[0]);
    } else if (symbols().length > 0) {
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

      {/* ====== Timeframe Tabs ====== */}
      <div class="interval-tabs">
        <For each={availableIntervals()}>
          {(int) => (
            <button
              class={`interval-btn ${interval() === int.value ? 'active' : ''}`}
              onClick={() => {
                setInterval(int.value);
                loadKlines();
              }}
            >
              {int.label}
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
          <span class="topbar-interval mono">{interval().toUpperCase()}</span>
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
              {formatVolume(volume())}
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
          <div class="header-subtitle mono">
            {interval().toUpperCase()} Timeframe · {market()} Market · UTC+8
            <Show when={intervalApproximated()}>
              <span style="color: #FFA500; margin-left: 8px; font-size: 0.7rem;">⚠ Approximated (daily data)</span>
            </Show>
          </div>
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

        <div
          ref={volumeContainerRef}
          id="volume-chart"
          style="height: 100px; margin-top: 8px;"
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

      {/* MACD Chart */}
      <div class="chart-wrapper glass-card" style="position: relative;">
        <div style="padding: 8px 16px; font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono);">
          MACD (12, 26, 9) — <span style="color:#3B82F6;">MACD</span> · <span style="color:#FF5B79;">Signal</span>
        </div>
        <div ref={macdContainerRef} style="height: 90px;" />
      </div>

      {/* Order Book Anomaly Panel */}
      <div class="chart-wrapper glass-card">
        <div style="padding: 8px 16px; font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono); display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
          <span>Order Book Anomaly</span>
          <Show when={obAnomalies()}>
            {(() => {
              const ob = obAnomalies();
              return <>
                <span style="color: var(--accent-green);">Spread: <b>{ob.spread}</b> ({ob.spread_pct}%)</span>
                <span style="color: var(--accent-blue);">Bid/Ask: <b>{ob.bid_ask_ratio}</b></span>
                {ob.wall_detected && <span style="color: var(--accent-red); font-weight: 700;">⚠ WALL DETECTED</span>}
              </>;
            })()}
          </Show>
        </div>

        {/* Bid/Ask depth bars */}
        <div ref={obContainerRef} style="height: 120px; margin: 0 16px 8px;" />

        {/* Top anomalies list */}
        <Show when={obAnomalies() && obAnomalies().top_anomalies?.length > 0}>
          <div style="padding: 0 16px 8px; display: flex; gap: 8px; flex-wrap: wrap;">
            {(() => {
              const ob = obAnomalies();
              return ob.top_anomalies.map((a: any) => (
                <span style={`font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; background: ${a.side === 'bid' ? 'rgba(0,217,165,0.15)' : 'rgba(255,91,121,0.15)'}; color: ${a.side === 'bid' ? 'var(--accent-green)' : 'var(--accent-red)'};`}>
                  {a.price.toFixed(2)} · {a.volume.toFixed(0)}x · z:{a.z_score}
                </span>
              ));
            })()}
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
            {formatVolume(volume())}
          </span>
        </div>
        <div class="glass-card stat-item">
          <span class="stat-label">Interval</span>
          <span class="stat-value mono">{interval().toUpperCase()}</span>
        </div>
      </div>

      {/* Backtest Panel */}
      <BacktestPanel
        selectedSymbol={selectedSymbol}
        interval={interval}
        market={market}
        chartRef={() => chart}
        getAllMarkers={() => []}
      />
    </div>
  );
}

export default App;