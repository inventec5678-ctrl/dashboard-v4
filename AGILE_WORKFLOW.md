# Dashboard V4 敏捷雙 Agent 開發流程 (Agile Workflow)

> 這是專為「從零開始重構」的新專案設計的極速 AI 協作流程。

## 兩大核心 Agent

此全新目錄只依靠兩個高智慧 Agent 來完成所有工作：

1. **Lead Reviewer（主理人與架構師）**：負責分發垂直切片任務、驗收成果、並對「美觀度」與「架構健康度」進行最嚴格的把關。
2. **Full-Stack Dev（全端與視覺工程師）**：負責寫碼，不僅要串接資料，還要刻出讓用戶驚豔的 UI/UX。**必須具備自我除錯與本地執行測試的權限。**

---

## 開發迴圈（The Inner-Loop）

1. **Lead Reviewer 分發任務**：根據 `VERTICAL_SLICING_PLAN.md` 提取下一個迭代功能。
2. **Full-Stack 實作與自測**：
   - 建立或修改代碼。
   - **（重點）** 在本地啟動 `npm run dev` 或 API server 進行功能驗證。
   - 確認終端機無報錯，且畫面精緻符合視覺要求。
3. **內部修正**：如遇錯誤，Full-Stack 必須就地解決，不丟回給 Reviewer。
4. **驗收與展示**：
   - Full-Stack 完成並確認美觀與功能後，向 Lead Reviewer 報告。
   - Reviewer 確認後向 Gino 回報進度，推進下個階段。

---

## 驗收標準

每個 Iteration 交付時，Full-Stack 必須確認：
- 終端機無編譯錯誤
- 頁面正常載入（不白屏）
- Console 無 Error
- 視覺符合「Premium Dark Mode + Micro-animations」標準
- 功能邏輯正確

Reviewer 驗收不通過，直接退件，不將就看。

---

## 禁止事項

- Full-Stack 不准提交看起來像「工程師後台」的介面
- 不准用純黑（`#000000`）或死白色碼
- 不准沒有微動畫
- 不准不通過本地測試就上交
- Reviewer 不准碰程式碼，只退件