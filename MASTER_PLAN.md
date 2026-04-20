# 頂級個人版 TradingView 專案總覽（Project Master Plan）

> 全新重構專案。拋棄舊有負擔，從零打造具有頂級市佔平台水準的個人量化看盤工具。

## 1. 核心願景（Vision）

打造一個供個人使用的「高效、極致美觀、即時反應」的三市場（Crypto/TWSE/US）專屬 TradingView。
它不僅在功能上要滿足實時 WebSocket 報價與輕量級 K 線渲染，**視覺設計上必須達到「WOW（令人驚豔）」的頂級質感**。

---

## 2. 視覺與美學規範（CRITICAL）

本專案**極度重視畫面美觀與操作體驗**，絕不妥協於「隨便拼湊的工程師後台介面」。

### 視覺準則

1. **Premium Dark Mode（頂級深色模式）**：
   - 嚴禁用純黑（`#000000`）或死白
   - 採用 HSL 精心調配的深邃色系（深藍灰、炭灰）
   - 搭配恰到好處的玻璃擬物化（Glassmorphism）效果

2. **現代化字體（Modern Typography）**：
   - 全面載入 Google Fonts：`Inter`, `Roboto`, `Outfit`
   - 數字與報價使用等寬字體：`JetBrains Mono`

3. **微動畫與動態回饋（Micro-animations）**：
   - 滑鼠懸停（Hover）、資料跳動、切換 Tab 時有順滑過場
   - 價格上漲/下跌時有顏色漸變動畫

4. **細節打磨**：
   - K 線色彩選擇具有金融科技感的現代配色
   - 漲：青綠色、跌：亮玫瑰紅（非死板的原色紅綠）

---

## 3. 技術堆疊（Tech Stack）

### Frontend

| 層面 | 選擇 |
|------|------|
| Framework | SolidJS（Runes API）|
| Build | Vite 5 |
| Charts | lightweight-charts v4 |
| Styling | Tailwind CSS + 自訂 CSS 變數 |
| Fonts | Inter + JetBrains Mono（Google Fonts）|
| State | Zustand（SolidJS createStore）|

### Backend

| 層面 | 選擇 |
|------|------|
| Framework | FastAPI（Python）|
| HTTP Client | httpx（共享 AsyncClient）|
| Data Format | Parquet |
| WebSocket | Binance WS 串接 + 轉發 |

### 資料來源

| 市場 | 來源 |
|------|------|
| CRYPTO | Binance（ccxt）|
| TWSE | TWSE API + FinMind |
| US | Polygon.io |

---

## 4. 目錄結構

```
/backend          — FastAPI 與 WebSocket 服務
/frontend        — 絕美儀表板 UI
```

---

## 5. 驗收口號

> 「如果用戶看到畫面不說 WOW，就代表失敗。」

每一個 Iteration 都必須通過視覺和功能的雙重驗收。