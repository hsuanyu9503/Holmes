# 606 情報局 v2.6.0 R5｜臥底揭曉、代號猜測、勝負結算

**基準**：已由使用者驗收的 v2.6.0 R4。遠距遊戲現在能完整從建立房間、發言、討論、秘密投票，到揭曉勝負並開啟下一輪。原有單機及近距連線流程未改寫。

## 檔案

- `online.html`、`index.html`、`assets/`：GitHub Pages 可直接部署的網站。
- `supabase/606-intelligence-v2.6.0-R4-to-R5.sql`：**已部署 R4 的專案**，只執行此檔。
- `supabase/606-intelligence-v2.6.0-R5-full.sql`：**全新 Supabase 專案**，只執行此檔，內含 R4 全部歷史必要建置與 R5 修正。
- `TESTING.md`：R5 多裝置實際驗收指南。

## 從 R4 升級

1. **先結束所有進行中的房間**，備份 Supabase 資料庫；有房間處於非 `lobby`、非 `closed` 的階段，升級檔會中止並回滾。
2. Supabase SQL Editor 執行 `606-intelligence-v2.6.0-R4-to-R5.sql`。
3. 將新版網站檔案部署到 GitHub Pages，特別要更新 `online.html`、`assets/online-v2.6.0-R5.js`、`assets/online-v2.6.0-R5.css`。
4. 重新整理網頁，確認頁尾顯示 `v2.6.0 R5`。原有 Supabase 網頁設定保持不變。
5. 建立**全新遠距房間**，按 `TESTING.md` 驗收。資料庫層的功能無法僅靠本地模擬視為正式通過。

**不要同時執行兩份 SQL**。升級不會主動刪除情報卡、成員、房間、歷史選票或匿名使用者。也不需要新增 Supabase Secret/Service Role 金鑰至網站。

## 本輪流程

`vote_result`（結果已封存、尚未公開臥底） → 主控點「揭曉真正臥底」 → `reveal`（公開真臥底） → 主控點「開放臥底最後猜測」 → `guess`（真正臥底本人選代號） → 送出後進入 `answer`（公開正確代碼、情報詞彙與勝負） → 主控「建立下一輪任務」回到 `lobby`。

- 3×3 支援 A1～C3 的9個選項；4×4 支援 A1～D4 的16個選項。
- 代碼表仍是 3×3 對應18格、4×4 對應48格，由情報員私下持有；臥底在答案公開前不能讀到對照表。
- 最後猜測只接受真正臥底的 Supabase 匿名使用者身分。由 RPC 原子性提交、鎖定房間；不能重複猜測、修改或跨階段送出。
- 若臥底離線，主控可經二次確認「略過猜測」，視為未猜中並進入結果；如果情報員原本就未指認成功，仍由臥底獲勝。
- 只有當**指認對象是實際臥底，而且臥底未猜中代號**，情報員才獲勝；其他情況由臥底獲勝。
- 近距房間繼續沿用原本 `discussion → undercover → answer`，不經過新增的 `reveal` 或 `guess`。

## 資料庫新增

- `intel606_rooms.guess_status`, `guess_finished_at`：回合猜測狀態。
- `intelligence_private.intel606_guesses`：每個房間／回合至多一筆最後猜測紀錄；私有表，未授權前端直接查詢。
- `public.intel606_r5_control(uuid,text)`：主控依序切換揭曉、猜測，以及略過未回應者。
- `public.intel606_submit_guess(uuid,text)`：僅真正臥底可提交，驗證宮格、房間身分、回合及提交一次限制。
- `public.intel606_room_state(uuid)`：在適當階段向授權成員公開臥底、猜測及最終答案，真正答案不會在 `vote_result`、`reveal`、`guess` 提前公開給臥底或主控。

R5 保留 R4 的 RLS 與明確 `GRANT` 模式，適用於 Supabase 2026-10-30 之後的 Data API 預設權限。

## 尚未包含

- 主控兼任玩家／自動主持（後續獨立階段）。
- 語音討論（另行評估 WebRTC＋SFU，避免干擾已穩定的 Supabase 遊戲狀態）。
- 課堂觀察者模式（維持獨立的實驗分支）。
