# 垂直切片開發計畫（Vertical Slicing Plan）

> 採用漸進式的端對端開發，每個階段產出的都必須是「具有極致美學、功能可運作」的區塊。

---

## Iteration 1：絕美基礎與靜態 K 線（Premium MVP K-Line）

**目標**：搭建深色系美學框架，並渲染第一張 BTC/USDT K 線圖。

### Backend
- 建立 FastAPI 骨架
- 實作能回傳 K 線假資料或單次資料的 API 介面
- 路由：`GET /api/klines`

### Frontend
- 套用精心挑選的深色背景與 Google Fonts（`Inter`）
- 整合 `lightweight-charts`，客製化圖表的背景網格、K 線顏色
- 讓它看起來極具高階金融軟體質感

**驗收標準**：啟動後，用戶看到畫面會覺得「WOW，這質感真好」，圖表顯示無誤。

---

## Iteration 2：生命力注入 — 報價與即時資料（Real-time Pulse）

**目標**：串接 WebSocket，讓畫面「活」起來。

### Backend
- 連線真實交易所（Binance），建立 WebSocket Server
- 實時廣播價格

### Frontend
- 接上 WebSocket，使 K 線即時跳動
- 實作頂部報價列（TopBar）
- 當價格跳動變更時，加上流暢的字體顏色漸變
  - 上漲：數字變大閃綠
  - 下跌：數字變小閃紅

**驗收標準**：頁面充滿活力的動態感，即時運作順暢無卡頓。

---

## Iteration 3：專業化 — 多市場與技術指標（Markets & Pro Tools）

**目標**：加入技術指標與市場切換。

### Full-Stack
- 新增 SMA、RSI 指標副圖
- 實作 Sidebar 或下拉選單供市場切換（CRYPTO / TWSE / US）
- UX/UI：指標面板的開關必須有順滑的折疊展開動畫

**驗收標準**：三市場都能正常顯示，指標面板動畫流暢。

---

## Iteration 4：全功能聚合 — 選股與策略儀表板（Watchlist & Strategy）

**目標**：將看盤系統升級為量化儀表板。

### Full-Stack
- 實作 Watchlist 自選列表（使用高質感的玻璃擬物化卡片展示）
- 實作策略觸發通知與列表
- 確保在不同的資料區塊間取得絕佳的版面留白與視覺平衡

**驗收標準**：功能完整且視覺驚豔，符合「頂級金融 Dashboard」的定位。

---

## 迭代順序

```
Iteration 1 → Iteration 2 → Iteration 3 → Iteration 4
```

每個 Iteration 完成後才能開始下一個。