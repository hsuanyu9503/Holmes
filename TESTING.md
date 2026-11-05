# 606 情報局 v2.6.0 R3｜實機驗收清單

## 0. 升級前
- [ ] 備份資料庫，確認 R2 線索功能已完成驗收。
- [ ] 結束所有進行中的房間（必須處於 lobby 或 closed）。
- [ ] 在測試專案執行 **R2-to-R3 升級 SQL**，或新專案執行 **R3-full 整合 SQL**，二擇一。
- [ ] 更新網站後，頁尾顯示 `v2.6.0 R3`，沒有快取舊版 JS。

## 1. 遠距手動討論
- [ ] 以一台主控加三台不同裝置加入遠距3×3房間，選手動結束。
- [ ] 在身分、骰子、情報卡、R2輪流文字線索階段均可正常操作。
- [ ] 線索全員提交後，主控出現「開始自由討論」，未完成時無法啟動。
- [ ] 進入聊天後三位玩家能互相看到訊息，主控也能看，但主控無法送出訊息。
- [ ] 玩家不能假冒別人發言或修改已送出的訊息。
- [ ] 重新整理或斷線後能恢復聊天室歷史；聊天時打字不因5秒輪詢被清空。
- [ ] 主控結束後進入 `vote_pending`，玩家端停止輸入並保留紀錄，不能提前揭曉臥底。

## 2. 遠距限時討論
- [ ] 以4×4房間建立限時3分鐘討論，所有玩家倒數一致（容忍正常網路延遲）。
- [ ] 主控暫停討論後，倒數停止、玩家不能傳送；繼續後恢復。
- [ ] 延長1分鐘與3分鐘後所有裝置的截止時間同步更新。
- [ ] 主控提前結束，所有端同步進入等待投票畫面。
- [ ] 第二輪測試讓主控關閉網頁，但玩家保持在線；時間結束後，玩家端仍能觸發 `vote_pending`。
- [ ] 模擬裝置時間錯誤，資料庫仍拒絕截止時間後送出的訊息。
- [ ] 全部人離線超過截止時間後重新進房，第一個讀取狀態者可觸發封存，不會延長原時間。

## 3. 訊息安全性
- [ ] 空訊息／201字訊息被拒絕。
- [ ] 同一玩家在2秒內連送兩則時，第二則被拒絕；第一則不會重複。
- [ ] 重新整理或重新送出舊請求時，不能繞過聊天階段或截止時間。
- [ ] 臥底從網頁與 RPC 回應中都無法讀到真實碼表或正確代碼。
- [ ] 身分卡尚未開啟時，情報員／臥底仍呈現相同的提示與按鈕。
- [ ] 只有房內成員與主控可經房間 RPC 取得聊天紀錄，房外帳號無權讀取。

## 4. 回歸檢查
- [ ] 近距3×3：抽身分→骰子→情報卡→現場討論→揭曉→下一輪，全部正常。
- [ ] 近距4×4：48格代碼對照、雙色骰子及答案揭曉正常。
- [ ] 遠距R2正式線索依座位順序、略過及同步保持正常。
- [ ] QR code、複製邀請連結、房間管理與結束房間功能保持正常。

## 5. 只讀 SQL 驗證（可貼 SQL Editor）

```sql
select
  to_regclass('intelligence_private.intel606_messages') is not null as messages_table_exists,
  to_regprocedure('public.intel606_chat_control(uuid,text,integer)') is not null as chat_control_exists,
  to_regprocedure('public.intel606_send_chat(uuid,text)') is not null as send_chat_exists,
  has_function_privilege('authenticated','public.intel606_chat_control(uuid,text,integer)','EXECUTE') as host_control_rpc_granted,
  has_function_privilege('authenticated','public.intel606_send_chat(uuid,text)','EXECUTE') as send_chat_rpc_granted,
  not has_table_privilege('authenticated','intelligence_private.intel606_messages','SELECT') as messages_private;
```

預期均為 `true`。實機必須另外測試 RPC 身分權限、聊天室同步與截止時間；上述 SQL 不能取代這些驗收。
