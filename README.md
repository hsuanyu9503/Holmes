# 606 情報局 v2.6.0 R4｜遠距秘密投票與平票處理

本版以已通過實際驗收的 **v2.6.0 R3** 為基礎，保留單機模式、近距連線模式、R2 輪流線索及 R3 聊天與倒數規則。

## R4 功能

- 遠距 `vote_pending`：主控按「開始第一輪秘密投票」。
- `vote_1`：全部正式玩家（包含臥底）可投其他玩家一票；不得投自己；提交後不可更改。伺服器按房間列鎖序列化投票，並以私密資料表儲存。
- 投票期間，主控及學生只看 **已投票人數／總人數**，不看任何候選人票數或個別投票。全員投畢自動結算。
- 主控可以提前結束當前輪投票，未投票者視為棄權。該操作有確認視窗。
- 若第一輪有唯一最高票者：前進 `vote_result`。若最高票平手：前進 `vote_2`，候選人僅限並列最高票者，所有正式玩家再次投票（仍不能投自己）。
- 第二輪只有一位最高票者，判定有一個被指認對象；第二輪再次平手、或該輪零有效票，則判定未成功指認。
- `vote_result`：公開統計與被指認者，但不公開真正臥底與正確機密代號；**R5 再接續揭曉、臥底猜測與勝負結算**。
- 3×3 與 4×4 均支援；近距原流程不受影響。

## 部署

**請先完成當前房間並備份 Supabase。** 升級 SQL 對進行中的房間設有中止保護，不會清空玩家或情報卡。

- 原有資料庫已部署 R3：執行 `supabase/606-intelligence-v2.6.0-R3-to-R4.sql`。
- 全新 Supabase 專案：改用 `supabase/606-intelligence-v2.6.0-R4-full.sql`，兩份擇一。
- 更新 GitHub Pages 的 `online.html`、`assets/online-v2.6.0-R4.js`、`assets/online-v2.6.0-R4.css`，完整包亦包含其餘靜態資源。
- 不必更換既有 Supabase 公開金鑰，也不必建立新的匿名帳號。請勿將 Secret/Service Role Key 放到網頁。
- 部署後重新整理確認頁尾顯示 `v2.6.0 R4`，依 `TESTING.md` 驗收。

## 安全性與資料模型

新增私密表 `intelligence_private.intel606_votes`（帶 RLS，對 anon/authenticated/public 不授予表存取）；只有具房間成員資格的使用者才能透過 `public.intel606_cast_vote` 提交，其它動作由主控透過 `public.intel606_vote_control` 操作。投票計算由內部 `intelligence_private.intel606_finalize_vote_locked` 完成，直接執行權限已撤銷。投票狀態由 `intel606_room_state` 對合法房間成員提供，個人選票內容永不傳回前端。

新增房間欄位：`vote_round`、`vote_candidates`、`vote_result_type`、`vote_result_seat`、`vote_finished_at`。新版 SQL 持續採明確 `GRANT EXECUTE` 設定，不仰賴新表的預設 Data API 授權。

**此版本沒有在實際 Supabase 專案執行。** 已進行 JavaScript 語法、SQL 靜態與模擬瀏覽器驗收，但真實 RPC、RLS、Realtime、跨裝置同步仍需於測試專案進行驗收。R4 的 `vote_result` 為階段性終點，暫時無法直接建立下一輪；R5 將接上揭曉流程。

## 回退注意事項

如果需要暫時回到 R3，先關閉任何已進入 R4 投票階段的房間。**只退回網站檔案不會回復 SQL 結構；** 既有資料庫的新欄位與函式會繼續存在。應避免在投票進行中混用前後端版本。
