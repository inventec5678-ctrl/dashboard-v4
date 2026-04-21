import { createSignal, Show, For } from 'solid-js';
import { createChart, Time, IChartApi, ISeriesApi, LineWidth } from 'lightweight-charts';

interface Trade {
  entry_time: number;
  exit_time: number;
  entry_price: number;
  exit_price: number;
  pnl: number;
  pnl_pct: number;
  type: string;
}

interface EquityPoint {
  time: number;
  equity: number;
}

interface Metrics {
  total_return: number;
  win_rate: number;
  profit_factor: number;
  max_drawdown: number;
  sharpe: number;
  trade_count: number;
  win_count: number;
  loss_count: number;
}

interface BacktestResult {
  strategy: string;
  params: Record<string, any>;
  trades: Trade[];
  equity_curve: EquityPoint[];
  markers: any[];
  metrics: Metrics;
}

interface BacktestPanelProps {
  selectedSymbol: () => string;
  interval: () => string;
  market: () => string;
  chartRef: () => IChartApi | null;
  getAllMarkers: () => any[];
}

const STRATEGIES = [
  { key: 'sma_crossover', label: 'SMA Crossover' },
  { key: 'rsi_threshold', label: 'RSI Threshold' },
  { key: 'macd_cross', label: 'MACD Cross' },
  { key: 'bollinger_breakout', label: 'Bollinger Breakout' },
];

const STRATEGY_PARAMS: Record<string, { label: string; key: string; type: string; def: number }[]> = {
  sma_crossover: [
    { label: 'Fast SMA', key: 'fast', type: 'number', def: 20 },
    { label: 'Slow SMA', key: 'slow', type: 'number', def: 60 },
  ],
  rsi_threshold: [
    { label: 'Buy Threshold', key: 'buy_threshold', type: 'number', def: 30 },
    { label: 'Sell Threshold', key: 'sell_threshold', type: 'number', def: 70 },
  ],
  macd_cross: [],
  bollinger_breakout: [
    { label: 'Period', key: 'period', type: 'number', def: 20 },
    { label: 'Std Dev', key: 'std_dev', type: 'number', def: 2 },
  ],
};

function BacktestPanel(props: BacktestPanelProps) {
  const [expanded, setExpanded] = createSignal(false);
  const [running, setRunning] = createSignal(false);
  const [strategy, setStrategy] = createSignal('sma_crossover');
  const [params, setParams] = createSignal<Record<string, number>>({});
  const [result, setResult] = createSignal<BacktestResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  let equityChartRef: HTMLDivElement | undefined;
  let equityChart: IChartApi | null = null;
  let equitySeries: ISeriesApi<'Line'> | null = null;

  const paramDefs = () => STRATEGY_PARAMS[strategy()] || [];

  // Sync params when strategy changes
  const onStrategyChange = (key: string) => {
    setStrategy(key);
    const defs = STRATEGY_PARAMS[key] || [];
    const newParams: Record<string, number> = {};
    for (const d of defs) {
      newParams[d.key] = d.def;
    }
    setParams(newParams);
  };

  const onParamChange = (key: string, val: string) => {
    setParams(p => ({ ...p, [key]: parseFloat(val) || 0 }));
  };

  const buildEquityChart = () => {
    if (!equityChartRef) return;
    if (equityChart) { equityChart.remove(); equityChart = null; }

    equityChart = createChart(equityChartRef, {
      layout: {
        background: { type: 'Solid' as any, color: 'transparent' },
        textColor: '#8B95A8',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.03)' },
        horzLines: { color: 'rgba(255,255,255,0.03)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.06)',
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.06)',
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: false },
      handleScale: { mouseWheel: true, pinch: false },
      width: equityChartRef.clientWidth,
      height: 120,
    });

    equitySeries = equityChart.addLineSeries({
      color: '#3B82F6',
      lineWidth: 1 as LineWidth,
      title: 'Equity',
    });
  };

  const renderEquity = (res: BacktestResult) => {
    if (!equitySeries || !res.equity_curve) return;
    const points = res.equity_curve.map(e => ({
      time: e.time as Time,
      value: e.equity,
    }));
    equitySeries.setData(points);
    equityChart?.timeScale().fitContent();
  };

  const runBacktest = async () => {
    setRunning(true);
    setError(null);

    try {
      const body = new URLSearchParams({
        symbol: props.selectedSymbol(),
        interval: props.interval(),
        market: props.market(),
        strategy: strategy(),
        params: JSON.stringify(params()),
      });

      const resp = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const res: BacktestResult = await resp.json();

      if (res.error) {
        setError(res.error);
        setRunning(false);
        return;
      }

      setResult(res);

      // Mark entry/exit on main chart
      const chart = props.chartRef();
      if (chart && res.markers && res.markers.length > 0) {
        for (const m of res.markers) {
          try {
            chart.addTextMarker(m);
          } catch (_) {
            try {
              chart.addVerticalLine({
                time: m.time as Time,
                color: m.color,
                lineWidth: 1 as LineWidth,
                lineStyle: 0,
                axisLabelVisible: false,
                text: m.text,
                textColor: m.text_color,
              });
            } catch (__) { /* skip bad markers */ }
          }
        }
      }

      // Equity curve
      buildEquityChart();
      renderEquity(res);

    } catch (e: any) {
      setError(e.message || 'Backtest failed');
    } finally {
      setRunning(false);
    }
  };

  const resetBacktest = () => {
    setResult(null);
    setError(null);
    if (equityChart) { equityChart.remove(); equityChart = null; }
    // Remove backtest markers from chart
    const chart = props.chartRef();
    if (chart) {
      try { chart.removeTextMarker?.('*'); } catch (_) {}
    }
  };

  return (
    <div class="glass-card" style="margin-top: 12px; overflow: hidden;">
      {/* Header */}
      <div
        class="backtest-header"
        onClick={() => setExpanded(e => !e)}
        style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; cursor: pointer; user-select: none;"
      >
        <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); letter-spacing: 0.05em;">
          BACKTEST
        </span>
        <div style="display: flex; align-items: center; gap: 8px;">
          <Show when={result()}>
            <span style={`font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; background: ${(result()?.metrics.total_return ?? 0) >= 0 ? 'rgba(0,217,165,0.15)' : 'rgba(255,91,121,0.15)'}; color: ${(result()?.metrics.total_return ?? 0) >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'};`}>
              {(result()?.metrics.total_return ?? 0) >= 0 ? '+' : ''}{result()?.metrics.total_return}%
            </span>
          </Show>
          <span style="color: var(--text-muted); font-size: 0.7rem;">{expanded() ? '▲' : '▼'}</span>
        </div>
      </div>

      <Show when={expanded()}>
        <div style="padding: 0 16px 16px;">

          {/* Strategy selector */}
          <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px;">
            <select
              class="symbol-select"
              value={strategy()}
              onChange={e => onStrategyChange(e.target.value)}
              style="font-size: 0.75rem; padding: 4px 8px;"
            >
              <For each={STRATEGIES}>
                {(s) => <option value={s.key}>{s.label}</option>}
              </For>
            </select>

            {/* Dynamic params */}
            <For each={paramDefs()}>
              {(def) => (
                <div style="display: flex; align-items: center; gap: 4px;">
                  <label style="font-size: 0.7rem; color: var(--text-muted);">{def.label}</label>
                  <input
                    type="number"
                    class="symbol-select"
                    value={params()[def.key] ?? def.def}
                    onInput={e => onParamChange(def.key, e.target.value)}
                    style="width: 70px; font-size: 0.75rem; padding: 3px 6px;"
                  />
                </div>
              )}
            </For>

            <Show when={!running()}>
              <button class="btn btn-primary" onClick={runBacktest} style="padding: 4px 12px; font-size: 0.75rem;">
                ▶ Run
              </button>
            </Show>
            <Show when={running()}>
              <button class="btn" disabled style="padding: 4px 12px; font-size: 0.75rem; opacity: 0.6;">
                Running...
              </button>
            </Show>
            <button class="btn btn-secondary" onClick={resetBacktest} style="padding: 4px 12px; font-size: 0.75rem;">
              Reset
            </button>
          </div>

          <Show when={error()}>
            <div style="color: var(--accent-red); font-size: 0.75rem; margin-bottom: 8px;">{error()}</div>
          </Show>

          <Show when={result()}>
            {(() => {
              const res = result()!;
              const m = res.metrics;
              return <>
                {/* Metrics cards */}
                <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; margin-bottom: 12px;">
                  <div class="glass-card" style="padding: 8px 12px;">
                    <div style="font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase;">Total Return</div>
                    <div style={`font-size: 1.1rem; font-weight: 700; color: ${m.total_return >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'};`}>
                      {m.total_return >= 0 ? '+' : ''}{m.total_return}%
                    </div>
                  </div>
                  <div class="glass-card" style="padding: 8px 12px;">
                    <div style="font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase;">Win Rate</div>
                    <div style="font-size: 1.1rem; font-weight: 700; color: var(--text-primary);">{m.win_rate}%</div>
                  </div>
                  <div class="glass-card" style="padding: 8px 12px;">
                    <div style="font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase;">Profit Factor</div>
                    <div style="font-size: 1.1rem; font-weight: 700; color: var(--text-primary);">{m.profit_factor}x</div>
                  </div>
                  <div class="glass-card" style="padding: 8px 12px;">
                    <div style="font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase;">Max Drawdown</div>
                    <div style="font-size: 1.1rem; font-weight: 700; color: var(--accent-red);">{m.max_drawdown}%</div>
                  </div>
                  <div class="glass-card" style="padding: 8px 12px;">
                    <div style="font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase;">Sharpe</div>
                    <div style="font-size: 1.1rem; font-weight: 700; color: var(--text-primary);">{m.sharpe}</div>
                  </div>
                  <div class="glass-card" style="padding: 8px 12px;">
                    <div style="font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase;">Trades</div>
                    <div style="font-size: 1.1rem; font-weight: 700; color: var(--text-primary);">{m.trade_count}</div>
                  </div>
                </div>

                {/* Equity curve */}
                <div style="margin-bottom: 12px;">
                  <div style="font-size: 0.7rem; color: var(--text-muted); margin-bottom: 4px; font-family: var(--font-mono);">Equity Curve</div>
                  <div ref={equityChartRef} style="height: 120px; border-radius: 8px; overflow: hidden;" />
                </div>

                {/* Trade list */}
                <Show when={res.trades && res.trades.length > 0}>
                  <div style="max-height: 180px; overflow-y: auto;">
                    <div style="font-size: 0.7rem; color: var(--text-muted); margin-bottom: 6px; font-family: var(--font-mono);">
                      Trade History ({m.win_count}W / {m.loss_count}L)
                    </div>
                    <table style="width: 100%; font-size: 0.7rem; border-collapse: collapse;">
                      <thead>
                        <tr style="color: var(--text-muted); border-bottom: 1px solid rgba(255,255,255,0.06);">
                          <th style="text-align: left; padding: 3px 6px;">#</th>
                          <th style="text-align: left; padding: 3px 6px;">Entry</th>
                          <th style="text-align: left; padding: 3px 6px;">Exit</th>
                          <th style="text-align: right; padding: 3px 6px;">P&L</th>
                          <th style="text-align: right; padding: 3px 6px;">P&L%</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={res.trades}>
                          {(t: Trade, i) => (
                            <tr style={`border-bottom: 1px solid rgba(255,255,255,0.03); color: ${t.pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'};`}>
                              <td style="padding: 3px 6px; color: var(--text-muted);">{i() + 1}</td>
                              <td style="padding: 3px 6px;">{new Date(t.entry_time * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</td>
                              <td style="padding: 3px 6px;">{new Date(t.exit_time * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</td>
                              <td style="text-align: right; padding: 3px 6px;">{t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}</td>
                              <td style="text-align: right; padding: 3px 6px;">{t.pnl_pct >= 0 ? '+' : ''}{t.pnl_pct}%</td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </>;
            })()}
          </Show>
        </div>
      </Show>
    </div>
  );
}

export default BacktestPanel;
