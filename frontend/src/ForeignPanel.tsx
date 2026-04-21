import { createSignal, createEffect, Show, For, onMount } from 'solid-js';

interface ForeignHistory {
  date: string;
  buy: number;
  sell: number;
  net: number;
  net_positive: boolean;
}

interface ForeignResponse {
  stock_id: string;
  streak_days: number;
  streak_net_total: number;
  signaled: boolean;
  history: ForeignHistory[];
}

function formatVolume(v: number): string {
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

function formatDate(dateStr: string): string {
  // "2026-04-07" -> "04/07"
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[1].slice(1)}/${parts[2]}`;
}

interface ForeignPanelProps {
  symbol: () => string;
}

export function ForeignPanel(props: ForeignPanelProps) {
  const [data, setData] = createSignal<ForeignResponse | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    const sym = props.symbol();
    if (!sym) return;
    fetchForeign(sym);
  });

  async function fetchForeign(symbol: string) {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/foreign_investor?symbol=${symbol}&days=30&streak_threshold=5`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json: ForeignResponse = await resp.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div class="chart-wrapper glass-card">
      <div style="padding: 8px 16px; font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono); display: flex; align-items: center; gap: 12px;">
        <span>🇹🇼 外資法人買賣超</span>
        <Show when={loading()}>
          <span style="color: var(--accent-yellow);">載入中...</span>
        </Show>
        <Show when={error()}>
          <span style="color: var(--accent-red);">⚠ {error()}</span>
        </Show>
      </div>

      <Show when={!loading() && data()}>
        {(() => {
          const d = data()!;
          // Show last 10 entries (most recent first)
          const rows = d.history.slice(-10).reverse();
          return (
            <>
              <div style="padding: 0 16px 8px; overflow-x: auto;">
                <table style="width: 100%; border-collapse: collapse; font-size: 0.72rem; font-family: var(--font-mono);">
                  <thead>
                    <tr style="color: var(--text-muted); border-bottom: 1px solid rgba(255,255,255,0.05);">
                      <th style="text-align: left; padding: 4px 8px;">日期</th>
                      <th style="text-align: right; padding: 4px 8px;">買超</th>
                      <th style="text-align: right; padding: 4px 8px;">賣超</th>
                      <th style="text-align: right; padding: 4px 8px;">淨買</th>
                      <th style="text-align: center; padding: 4px 8px;">狀態</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={rows}>
                      {(row) => (
                        <tr style={`border-bottom: 1px solid rgba(255,255,255,0.03);`}>
                          <td style="padding: 5px 8px; color: var(--text-secondary);">{formatDate(row.date)}</td>
                          <td style={`padding: 5px 8px; text-align: right; color: var(--accent-green);`}>+{formatVolume(row.buy)}</td>
                          <td style={`padding: 5px 8px; text-align: right; color: var(--accent-red);`}>-{formatVolume(row.sell)}</td>
                          <td style={`padding: 5px 8px; text-align: right; font-weight: 600; color: ${row.net >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'};`}>
                            {row.net >= 0 ? '+' : ''}{formatVolume(row.net)}
                          </td>
                          <td style="padding: 5px 8px; text-align: center; font-size: 0.9rem;">
                            {row.net >= 0 ? '✅' : '⚠️'}
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>

              {/* Streak Alert */}
              <Show when={d.signaled}>
                <div style="margin: 0 16px 12px; padding: 10px 16px; border-radius: 8px; background: rgba(0, 217, 165, 0.12); border: 1px solid rgba(0, 217, 165, 0.3); display: flex; align-items: center; gap: 10px;">
                  <span style="font-size: 1.1rem;">🔥</span>
                  <span style="color: var(--accent-green); font-family: var(--font-mono); font-size: 0.82rem; font-weight: 600;">
                    外資連續 {d.streak_days} 天買超（+{formatVolume(d.streak_net_total)}）
                  </span>
                </div>
              </Show>
            </>
          );
        })()}
      </Show>
    </div>
  );
}