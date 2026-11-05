# 606 情報局 v2.6.0 R2｜遠距輪流提供線索

以 R1.1 為基礎，新增依座位編號輪流傳送正式文字線索。3～8 位玩家各提交一次（1～80字），主控可略過目前玩家，所有結果在資料庫中保存並同步。完成後停留在 R2「線索已完成」狀態；自由討論預計 R3 接入。單機與連線近距模式沿用原本功能。

## 部署

**先結束正在進行的遊戲，並備份資料庫。** 將下列 SQL 二擇一在 Supabase SQL Editor 執行：

- 已使用 R1 或 R1.1：`supabase/606-intelligence-v2.6.0-R1-to-R2.sql`
- 新建 Supabase 專案：`supabase/606-intelligence-v2.6.0-R2-full.sql`

請勿連續執行這兩份 SQL。上傳 `index.html`、`online.html`、`online-config.js`、`assets/` 到 GitHub Pages。`Authentication → Providers` 必須開啟 Anonymous Sign-ins。使用者原本保存在瀏覽器的公開 Supabase 設定不會因更新清除。

R2 的線索資料保存在 `intelligence_private.intel606_clues`，玩家無法直接查表；只有通過權限驗證的 RPC 能傳送或取得公開線索。主控端按「略過目前玩家」會在資料庫寫入跳過紀錄。資料表不包含秘密代碼與臥底身分。原本既有情報卡及房間資料不會主動清除。

## 已完成與尚待驗證

已進行 JS 語法、SQL 靜態一致性、介面靜態檢查及開發測試。尚需在實際 Supabase 專案上驗證 RPC、Realtime、多人同步與 RLS。先以測試專案完成 3×3、4×4 多裝置驗收再正式使用。
