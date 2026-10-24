// 選填：全站共用的公開預設值。一般使用者可直接從網頁右上角「連線設定」輸入。
// 僅可使用 Supabase publishable key 或 legacy anon key；不得放入 secret/service_role。
// 玩家透過主控分享的邀請連結加入時，也可以自動取得公開連線設定。
window.INTEL606_SUPABASE = {
  url: '',
  publishableKey: ''
};
