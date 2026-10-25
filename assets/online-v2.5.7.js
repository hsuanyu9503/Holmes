/* 606 情報局｜連線版 v2.5.7。公開 Supabase 設定由瀏覽器管理，私密資料仍僅來自經授權的 SQL RPC。 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const CONFIG_KEY = 'intel606_supabase_public_config_v1';
  const fileConfig = window.INTEL606_SUPABASE || {};
  function normalizeConfig(data) {
    if (!data || typeof data !== 'object') return null;
    const url = String(data.url || '').trim().replace(/\/$/, '');
    const publishableKey = String(data.publishableKey || '').trim();
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) return null;
    // Supabase publishable key 為公開用途。舊版 JWT 僅接受 payload.role = anon。
    if (/^sb_publishable_[a-z0-9_-]+$/i.test(publishableKey)) return {url,publishableKey};
    if (/^[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(publishableKey)) {
      try {
        const part = publishableKey.split('.')[1];
        const payload = JSON.parse(atob(part.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4-part.length%4)%4)));
        if (payload.role === 'anon') return {url,publishableKey};
      } catch { /* 拒絕無法判別角色的 JWT */ }
    }
    return null;
  }
  function storedConfig() {
    try { return normalizeConfig(JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null')); }
    catch { return null; }
  }
  let configOrigin = storedConfig() ? '本機設定' : '預設檔案';
  function applyInviteConfig() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (!params.has('sb_url') && !params.has('sb_key')) return;
    const incoming = normalizeConfig({url:params.get('sb_url'),publishableKey:params.get('sb_key')});
    // 公開金鑰不必保留在瀏覽器網址列；加入資訊在收到時清除 URL fragment。
    history.replaceState(history.state,'',location.pathname+location.search);
    if (!incoming) return;
    const current = storedConfig() || normalizeConfig(fileConfig);
    if (current && (current.url !== incoming.url || current.publishableKey !== incoming.publishableKey)) {
      if (!confirm('這份邀請連結使用另一個 Supabase 專案。要切換這台裝置的連線設定以加入房間嗎？')) return;
    }
    try {
      localStorage.setItem(CONFIG_KEY,JSON.stringify(incoming));
      if (!current || current.url !== incoming.url || current.publishableKey !== incoming.publishableKey) localStorage.removeItem('intel606_last_room');
      configOrigin = '邀請連結（已儲存在本機）';
    } catch { configOrigin = '無法儲存邀請設定'; }
  }
  applyInviteConfig();
  const conf = storedConfig() || normalizeConfig(window.INTEL606_SUPABASE || fileConfig);
  const configOK = Boolean(conf);
  // 供設定介面與遊戲核心查核是否使用同一份設定，不包含私人答案或伺服器密鑰。
  window.INTEL606_RUNTIME = {version:'2.5.7', configured:configOK, source: storedConfig() ? 'localStorage' : 'online-config.js'};
  const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const playerLabel = no => String(no).padStart(2,'0') + ' 號玩家';
  const show = (id, visible) => { $(id).hidden = !visible; };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const stages = {
    lobby:['等待玩家集合','主控端建立房間後，邀請 3～8 位玩家使用自己的裝置加入。'],
    identity:['機密身分分發','每位玩家在自己的裝置確認身分卡，只有情報員能看到共同的隨機代碼對照表。'],
    dossier:['公開雙色骰點數','雙色骰子已擲出公開點數，情報員可用自己的對照表查出機密代號。臥底只能看見點數。'],
    discussion:['情報卡已公開','所有玩家看到相同的情報卡；請口頭發言與討論，找出混入隊伍的臥底。'],
    undercover:['臥底已揭曉','請讓臥底根據場上線索，說出最後的猜測。'],
    answer:['正確答案揭曉','本局任務結束，可由主控端建立下一輪。'],
    closed:['任務已關閉','請返回首頁重新建立房間。']
  };
  let db = null, user = null, room = null, sub = null, poll = null;
  let currentMode = null;
  const guestRoomKey = 'intel606_last_guest_room';
  const hostRoomKey = 'intel606_last_room'; // 沿用舊版主控資料，不遺失原有情報卡身分。
  const clients = {};
  function clearSubscriptions() {
    if(sub && db) {db.removeChannel(sub);sub=null;}
    if(poll) {clearInterval(poll);poll=null;}
  }
  async function ensureIdentity(mode, verify = false) {
    // 主控繼續使用原本 localStorage 的 Supabase 身分；學生則以每分頁
    // sessionStorage 登入，避免同一個瀏覽器的多個學生佔用相同玩家身分。
    if(db && user && currentMode===mode && !verify) return;
    if(currentMode !== mode) clearSubscriptions();
    if(!clients[mode]) {
      const auth = {persistSession:true,autoRefreshToken:true,detectSessionInUrl:false};
      if(mode==='guest') {
        auth.storage = window.sessionStorage;
        auth.storageKey = 'intel606_guest_auth_' + new URL(conf.url).hostname;
      }
      clients[mode] = window.supabase.createClient(conf.url,conf.publishableKey,{auth});
    }
    const candidate = clients[mode];
    let result = await candidate.auth.getSession();
    if(result.error) throw result.error;
    let identity = null;
    if(result.data?.session) {
      const checked = await candidate.auth.getUser();
      if(checked.error) {
        const status = checked.error.status || 0;
        if(status === 401 || status === 403 || status === 404 || /user.*not found|does not exist|invalid.*token|session.*missing|jwt.*expired/i.test(checked.error.message||'')) {
          // 刪除 auth.users 後，舊 JWT 在到期前可能仍留在瀏覽器。
          await candidate.auth.signOut({scope:'local'}).catch(()=>{});
        } else throw checked.error;
      } else identity = checked.data?.user || null;
    }
    if(!identity) {
      result = await candidate.auth.signInAnonymously();
      if(result.error) throw result.error;
      identity = result.data.user;
    }
    if(!identity?.id) throw new Error('無法取得有效的連線身分');
    db = candidate; user = identity; currentMode = mode;
  }
  async function resetMissingIdentity() {
    if(!db) return;
    await db.auth.signOut({scope:'local'}).catch(()=>{});
    user = null;
    const mode = currentMode || 'host';
    if(mode==='host') localStorage.removeItem(hostRoomKey);
    else sessionStorage.removeItem(guestRoomKey);
    clearSubscriptions(); room=null; unlocked=false;
    await ensureIdentity(mode);
    setView('landing');
  }
  function isMissingIdentityError(message) {
    return /intel606_rooms_host_id_fkey|intel606_members_user_id_fkey|violates foreign key constraint.*(host_id|user_id)/i.test(message);
  }
  let unlocked = false, view = 'landing', drawingUntil = 0, rollingUntil = 0;
  let rollAnimationKey = '', rollTicker = null, rollRefreshTimer = null, animValueBlue=1, animValueRed=1;
  let localTimer = null, busy = false, cardRows = [], editCells = [];
  function alertBox(message, isInfo = false) {
    const box = $('alert'); box.textContent = message; box.hidden = !message;
    box.classList.toggle('info',isInfo);
  }
  function requestBusy(isBusy) {
    busy = isBusy;
    for (const b of document.querySelectorAll('button')) {
      if (!b.dataset.always) b.disabled = isBusy;
    }
  }
  async function rpc(name, args = {}) {
    const { data,error } = await db.rpc(name,args);
    if (error) {
      const message=error.message || '伺服器操作失敗';
      if (/主控裝置不能以玩家身分加入/.test(message)) throw new Error('目前使用主控帳號，請改以另一個學生分頁或手機加入。');
      throw new Error(message);
    }
    return data;
  }
  function setView(which) {
    view = which;
    show('landing',which === 'landing');show('room',which === 'room');show('library',which === 'library');
  }
  async function initialize() {
    $('loading').hidden = true; $('app').hidden = false;
    const urlRoom = new URLSearchParams(location.search).get('room');
    if (urlRoom) $('joinCode').value = urlRoom.toUpperCase().slice(0,6);
    $('joinName').value = localStorage.getItem('intel606_nickname') || '';
    if (!configOK) {
      alertBox('尚未設定 Supabase：請點選畫面右上角的「⚙ 連線設定」，填入 Project URL 與公開金鑰。');
      for (const id of ['createRoom','joinRoom','openLibrary']) $(id).disabled = true;
      return;
    }
    if (!window.supabase || !window.supabase.createClient) {
      alertBox('無法載入 Supabase SDK，請檢查網路連線或瀏覽器是否阻擋 CDN。'); return;
    }
    try {
      // 只有實際建立房間、加入房間或恢復舊房間時才建立匿名身分，避免
      // 學生點開首頁便消耗一次主控模式的匿名登入配額。
      const guestLast = sessionStorage.getItem(guestRoomKey);
      const hostLast = localStorage.getItem(hostRoomKey);
      const mode = urlRoom || guestLast ? 'guest' : 'host';
      const last = mode==='guest' ? guestLast : hostLast;
      if(urlRoom || last) await ensureIdentity(mode, true);
      if(last && !urlRoom) {
        try { await attachRoom(await rpc('intel606_room_state',{p_room:last}), false); }
        catch { mode==='guest' ? sessionStorage.removeItem(guestRoomKey) : localStorage.removeItem(hostRoomKey); }
      }
      alertBox('');
    } catch(e) {
      alertBox('登入連線身分失敗：' + e.message + '。請確認 Supabase Authentication 已啟用 Anonymous Sign-ins。');
    }
  }
  async function withAction(callback) {
    if (busy) return;
    requestBusy(true);
    try { alertBox(''); await callback(); }
    catch(e) {
      if(isMissingIdentityError(e.message)) {
        try {
          await resetMissingIdentity();
          alertBox('原本的 Supabase 匿名帳號已被刪除，已重新取得新的連線身分。舊主控帳號的房間可能已隨帳號刪除，請重新建立房間。');
        } catch(recoveryError) {alertBox('登入身分失效，重新登入也失敗：' + recoveryError.message);}
      } else alertBox(e.message);
    }
    finally { requestBusy(false); if(view==='room' && room) renderRoom(); }
  }
  async function attachRoom(value, fresh = true) {
    if (!value || !value.room_id) throw new Error('房間資料不正確');
    const idChanged = !room || room.room_id !== value.room_id;
    room = value;
    syncRollAnimation(room);
    if (fresh || idChanged) unlocked = false;
    if(room.is_host) localStorage.setItem(hostRoomKey,room.room_id);
    else sessionStorage.setItem(guestRoomKey,room.room_id);
    setView('room');
    if (idChanged) listenRoom(room.room_id);
    renderRoom();
  }
  function listenRoom(id) {
    if (sub) { db.removeChannel(sub); sub = null; }
    if (poll) { clearInterval(poll); poll = null; }
    sub = db.channel('intel606-watch-' + id)
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'intel606_rooms',filter:'id=eq.' + id}, () => { refreshRoom(); })
      .subscribe(status => { $('liveStatus').textContent = status === 'SUBSCRIBED' ? '● 即時同步中' : '◌ 定期同步中'; });
    // Realtime 暫斷時仍可同步；切回頁面會補讀最新狀態。
    poll = setInterval(() => { if (!document.hidden && view === 'room') refreshRoom(); }, 5000);
  }
  let fetching = false;
  async function refreshRoom() {
    if (!room || fetching || !db) return;
    fetching = true;
    try {
      const next = await rpc('intel606_room_state',{p_room:room.room_id});
      const old = room;
      if (old.phase === 'dossier' && next.phase === 'discussion') drawingUntil = Date.now() + 1800;
      if (old.phase !== next.phase && ['identity','lobby'].includes(next.phase)) unlocked = false;
      room = next;
      syncRollAnimation(room);
      renderRoom();
    } catch(e) {
      if (/無權讀取此房間|找不到房間/.test(e.message)) {
        leaveRoom();alertBox('你已離開這個房間，或被主控端移除。');
      } else $('liveStatus').textContent = '◌ 重新連線中';
    }
    finally { fetching = false; }
  }
  // 依伺服器的擲骰起始時間同步所有裝置，而非讓每台手機獨立決定答案。
  function syncRollAnimation(state) {
    if (!state || state.phase !== 'dossier' || !state.roll_started_at) {
      rollingUntil = 0; rollAnimationKey = ''; stopDiceTicker(); return;
    }
    const nextKey = state.room_id + ':' + state.round + ':' + state.roll_started_at;
    if (rollAnimationKey === nextKey) return;
    rollAnimationKey = nextKey;
    const serverNow = Date.parse(state.server_now);
    const started = Date.parse(state.roll_started_at);
    const elapsed = Number.isFinite(serverNow) && Number.isFinite(started) ? Math.max(0,serverNow-started) : 3000;
    rollingUntil = Date.now() + Math.max(0,3000-elapsed);
    if (rollingUntil>Date.now()) {
      startDiceTicker();
      if (rollRefreshTimer) clearTimeout(rollRefreshTimer);
      rollRefreshTimer=setTimeout(()=>{stopDiceTicker(); if(room && room.phase==='dossier') refreshRoom();},Math.max(50,rollingUntil-Date.now()+130));
    } else stopDiceTicker();
  }
  function stopDiceTicker() {
    if (rollTicker) {clearInterval(rollTicker);rollTicker=null;}
  }
  function startDiceTicker() {
    stopDiceTicker();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const maxBlue=room?.size===4?8:6, maxRed=room?.size===4?6:3;
    rollTicker=setInterval(()=>{
      if(Date.now()>=rollingUntil || document.hidden){stopDiceTicker();return;}
      animValueBlue=1+Math.floor(Math.random()*maxBlue);
      animValueRed=1+Math.floor(Math.random()*maxRed);
      document.querySelectorAll('.rolling-die.blue .die-value').forEach(el=>el.textContent=animValueBlue);
      document.querySelectorAll('.rolling-die.red .die-value').forEach(el=>el.textContent=animValueRed);
    },88);
  }
  function diceRollingMarkup() {
    const blueFace=room.size===4?'d8':'d6';
    return `<section class="dice-showcase" aria-live="polite"><span class="kicker">CLASSIFIED DICE · 雙色骰子</span>
      <div class="dice-stage"><div class="rolling-die blue ${blueFace}"><span class="die-face-label">藍色 · ${blueFace.toUpperCase()}</span><span class="die-value">${animValueBlue}</span></div>
      <div class="rolling-die red d6"><span class="die-face-label">紅色 · D6</span><span class="die-value">${animValueRed}</span></div></div>
      <p class="dice-action-message">雙色骰子正在滾動……</p>
      <p class="dice-detail">${room.size===3?'藍色 1～6 × 紅色 1～3（各兩面）':'藍色 1～8 × 紅色 1～6'} · 結果由 Supabase 統一抽取</p></section>`;
  }
  function diceIsRolling() {return room?.phase==='dossier' && Date.now()<rollingUntil;}
  function buildInviteLink() {
    if(!room || !conf?.url || !conf?.publishableKey) return '';
    const link=new URL('online.html',location.href);
    link.searchParams.set('room',room.code);
    const inviteConfig = new URLSearchParams({sb_url:conf.url,sb_key:conf.publishableKey});
    link.hash = inviteConfig.toString();
    return link.href;
  }
  function qrImageURL(text,size=280){
    if(!text) return '';
    if(!window.INTEL606_QR) throw new Error('無法載入本機 QR code 模組');
    return window.INTEL606_QR.toSvgDataUri(text);
  }
  function renderInvitePanel(isHost) {
    const panel=$('hostInvitePanel'); if(!panel) return;
    const shouldShow=Boolean(isHost && room && room.phase!=='closed');
    show('hostInvitePanel', shouldShow);
    if(!shouldShow) return;
    const href=buildInviteLink();
    $('inviteLinkField').value = href || '';
    const img=$('inviteQrImage'), fallback=$('inviteQrFallback');
    if(href && window.INTEL606_QR){
      try {
        const target=qrImageURL(href, 280);
        if(img.src !== target) img.src = target;
        img.hidden = false;fallback.hidden = true;
        $('inviteQrStatus').textContent = 'QR code 已產生（本機）';
      } catch(e) {
        img.hidden=true;fallback.hidden=false;fallback.textContent='QR code 暫時無法產生，請使用邀請連結。';
        $('inviteQrStatus').textContent = 'QR code 產生失敗';
      }
    } else {
      img.hidden = true;img.removeAttribute('src');fallback.hidden = false;
      $('inviteQrStatus').textContent = href ? '本機 QR code 模組未載入' : '尚未取得邀請資訊';
    }
  }
  function renderRoom() {
    if (!room || view !== 'room') return;
    const isHost = room.is_host;
    const phase = stages[room.phase] || stages.lobby;
    $('roomHeading').textContent = `第 ${String(room.round).padStart(2,'0')} 輪 · ${room.size} × ${room.size} 情報任務`;
    $('roomSub').textContent = isHost ? '主控端 · 教師操作畫面' : `${playerLabel(room.my_seat)} · 個人機密畫面`;
    $('roomCode').textContent = room.code;
    show('hostArea',isHost);show('playerArea',!isHost);
    renderInvitePanel(isHost);
    if (isHost) {renderHost(phase);renderManagement();}
    else renderPlayer(phase);
  }
  function renderRoster() {
    $('rosterTotal').textContent = `${room.members.length} / 8`;
    $('roster').innerHTML = room.members.length ? room.members.map(p =>
      `<div class="roster-item ${p.ready?'ready':''}"><strong>${esc(playerLabel(p.seat))} · ${esc(p.name)}</strong><span>${room.phase==='identity' ? (p.ready?'已確認身分':'待確認') : '已加入'}</span></div>`
    ).join('') : '<p>目前尚未有玩家加入，請分享房間代碼。</p>';
  }
  function renderManagement() {
    const panel=$('roomManagement'); if (!panel) return;
    const closed=room.phase==='closed';
    show('roomManagement',!closed);
    $('managePhase').textContent='目前階段：'+(stages[room.phase]?.[0]||room.phase);
    $('manageRound').textContent=`第 ${room.round} 輪 · ${room.size} × ${room.size}`;
    const canRemove = room.phase==='lobby';
    $('managePlayerTip').textContent=canRemove?'等待玩家階段，可以在下方移除誤加入的玩家，不必刪除 Supabase 使用者。':
      '遊戲開始後暫停移除玩家，避免影響這輪的身分與骰子資料。';
    $('managePlayerList').innerHTML=canRemove
      ? (room.members.length ? room.members.map(p=>`<div class="manage-player-row"><span>${esc(playerLabel(p.seat))} · ${esc(p.name)}</span><button type="button" class="remove-player" data-remove-seat="${p.seat}" aria-label="移除${esc(playerLabel(p.seat))}">移除玩家</button></div>`).join('') : '<p class="manage-empty">尚無玩家加入</p>')
      : '<p class="manage-empty">本輪遊戲進行中，請在下一輪等待階段管理玩家。</p>';
  }
  function btn(label, action, {disabled=false, cls='primary'} = {}) {
    return `<button class="${cls}" data-action="${action}" ${disabled?'disabled':''}>${esc(label)}</button>`;
  }
  function drawAnimation() {
    return '<div class="draw-box"><div class="draw-stack" aria-hidden="true"><span>606</span><span>✦</span><span>機密</span></div><div class="draw-caption">正在從情報資料庫抽取本輪情報卡……</div></div>';
  }
  function diceMarkup() {
    // 兩顆骰子的顏色與點數是公開資訊；查表後的機密代號絕不公開。
    if (!Number.isInteger(room.dice_first) || !Number.isInteger(room.dice_second)) return '';
    const blue = room.size === 3 ? '藍色六面骰（1～6）' : '藍色八面骰（1～8）';
    const red = room.size === 3 ? '紅色六面骰（1～3，各兩面）' : '紅色六面骰（1～6）';
    return `<div class="dice-area finalized" aria-label="公開骰子結果：藍色 ${room.dice_first}、紅色 ${room.dice_second}">
      <div class="die blue ${room.size===4?'d8-finish':''}"><small>${blue}</small><strong>${room.dice_first}</strong></div>
      <div class="die red"><small>${red}</small><strong>${room.dice_second}</strong></div>
    </div><div class="status-note dice-result-note">本輪公開骰子點數：<strong>藍 ${room.dice_first}　／　紅 ${room.dice_second}</strong><p class="hint">情報員請私下查詢共同的代號對照表，勿向臥底透露機密代號。</p></div>`;
  }
  function renderHost([heading,desc]) {
    $('hostPhaseTitle').textContent = heading;
    $('hostPhaseDesc').textContent = desc;
    renderRoster();
    const n = room.members.length, ready = room.members.filter(p => p.ready).length;
    let html = '';
    const isRolling = diceIsRolling();
    switch(room.phase) {
      case 'lobby':
        html = `<p class="status-note">人數：${n} 位；每局固定 1 名臥底。</p>`+
          btn('全員到齊 · 分配身分卡','start',{disabled:n<3})+
          btn('管理情報卡資料庫','library',{cls:'outline'});break;
      case 'identity':
        html = `<p class="status-note">身分已確認：${ready}／${n} 位</p>`+
          btn('全員確認完成 · 公開抽骰','roll',{disabled:ready!==n});break;
      case 'dossier':
        if (isRolling) html = diceRollingMarkup();
        else html = (room.dice_first === null ? '<p class="status-note">正在驗證正式骰點結果……</p>' : diceMarkup() + btn('抽取本輪情報卡','draw') + btn('管理情報卡','library',{cls:'outline'}));
        break;
      case 'discussion':
        if (Date.now() < drawingUntil) html = drawAnimation();
        else html = diceMarkup()+btn('✦ 投影情報卡','projection')+btn('討論與投票結束 · 揭曉臥底','unmask',{cls:'outline'});
        break;
      case 'undercover': html = `<div class="status-note">本輪臥底是 <strong>${esc(playerLabel(room.undercover_seat))}</strong></div>`+
        btn('臥底猜測完畢 · 公布答案','answer');break;
      case 'answer': html = `<div class="status-note">機密代號：${esc(room.drawn_code)} ／ 正確情報：<strong>${esc(room.answer_word || '—')}</strong></div>`+
        btn('建立下一輪任務','next');break;
      case 'closed': html = '<p>本房間已結束。</p>';break;
    }
    $('hostControls').innerHTML = html;
    const showCard = room.card && ['discussion','undercover','answer'].includes(room.phase) && Date.now() >= drawingUntil;
    show('hostCardPreview',showCard);
    if (showCard) $('hostCardPreview').innerHTML = cardHTML(room.card,room.size) +
      (room.phase==='answer'? `<p class="status-note">正確情報：<strong>${esc(room.answer_word)}</strong></p>`:'');
    if (Date.now() < drawingUntil) {
      if (localTimer) clearTimeout(localTimer);
      localTimer = setTimeout(renderRoom, Math.max(120, drawingUntil-Date.now()+100));
    }
  }
  function gridMap(codeMap, size, first = null, second = null) {
    const columns = size === 3 ? 3 : 6;
    const rows = size === 3 ? 6 : 8;
    if (!Array.isArray(codeMap) || codeMap.length !== columns * rows) {
      return '<p class="map-error">本輪對照表尚未建立完整，請重新建立任務房間。</p>';
    }
    const cell = (code,i,j) => {
      const selected = first === i + 1 && second === j + 1;
      return `<div class="code-cell ${selected?'highlight':''}" ${selected?'aria-current="true"':''} title="藍色 ${i+1}、紅色 ${j+1}"><strong>${esc(code)}</strong></div>`;
    };
    let result = '<div class="code-map-caption">🔵 藍色骰子選列　·　🔴 紅色骰子選欄</div>'+
      `<div class="code-grid" style="--columns:${columns}">`+
      '<div class="code-corner" aria-hidden="true">藍＼紅</div>';
    for (let j = 1; j <= columns; j++) result += `<div class="code-axis red-axis">${j}</div>`;
    for (let i = 0; i < rows; i++) {
      result += `<div class="code-axis blue-axis">${i+1}</div>`;
      for (let j = 0; j < columns; j++) result += cell(codeMap[i*columns+j],i,j);
    }
    return result + '</div>';
  }
  function cardHTML(card,size) {
    if (!card || !Array.isArray(card.cells)) return '';
    return `<div class="intel-wrap"><span class="intel-tag">✦ ${esc(card.category)} · ${size} × ${size} ✦</span><h3 class="intel-title">${esc(card.title)}</h3><div class="intel-grid" style="--size:${size}">${card.cells.map((word,i)=>`<div class="intel-cell"><small>${String(i+1).padStart(2,'0')}</small>${esc(word)}</div>`).join('')}</div></div>`;
  }
  function renderPlayer([heading,desc]) {
    $('playerPhaseTitle').textContent = heading;
    $('playerPhaseDesc').textContent = desc;
    const isUndercover = room.my_role === 'undercover';
    const isAgent = room.my_role === 'agent';
    let html = '';
    if (room.phase === 'lobby') html = '<div class="status-note">已成功加入房間，等待主控端分配身分卡。</div>';
    else if (room.phase === 'closed') html = '<div class="status-note">本房間已關閉。</div>';
    else {
      html += `<div class="personal-wrap"><div class="private-tools">${btn(unlocked ? '🔒 隱藏私人情報' : (isAgent ? '🔓 查看角色卡與共用代碼表' : '🔓 查看我的角色卡'),'toggleIdentity',{cls:'outline'})}${isAgent ? `<span class="map-access-hint">${unlocked?'✓ 代碼對照表已展開':'🔐 本輪共用代碼對照表 · 點左側按鈕查看'}</span>` : ''}</div>`;
      if (unlocked) {
        html += `<div class="identity-card ${isUndercover?'undercover':''}"><p>${esc(playerLabel(room.my_seat))}</p><h3>${isUndercover ? '你／妳是臥底' : '你／妳是情報員'}</h3>`;
        if (isUndercover) html += '<p class="hint">從其他情報員的線索中，努力推測出正確代碼吧！</p>';
        else {
          html += '<div class="map-head"><h4>本輪共用代碼對照表</h4><p class="hint">由資料庫為本輪隨機生成；所有情報員看到相同的表格。藍骰選列、紅骰選欄，請勿向臥底展示。</p></div>'+
            gridMap(room.code_map,room.size,room.dice_first,room.dice_second);
          if (room.drawn_code) {
            // 代碼對照表有重複代號；情報卡本身僅有 size² 格，依代號的字母／數字定位。
            const col = room.drawn_code.charCodeAt(0) - 65;
            const row = Number(room.drawn_code.slice(1)) - 1;
            const position = row * room.size + col;
            const valid = row >= 0 && row < room.size && col >= 0 && col < room.size;
            const word = valid && room.card?.cells ? room.card.cells[position] : null;
            html += `<div class="status-note">機密代號：<strong>${esc(room.drawn_code)}</strong>${valid ? ` · 情報卡第 ${position+1} 格` : ''}${word ? ` · 機密情報：<strong>${esc(word)}</strong>` : ''}</div>`;
          }
        }
        html += '</div>';
      } else html += '<p class="status-note">為避免其他人偷看到身分卡，私人資訊目前已遮蔽。</p>';
      html += '</div>';
      if (room.phase==='identity') {
        const mine = room.members.find(p => p.seat === room.my_seat);
        if (!mine?.ready) html += unlocked ? btn('已閱讀身分卡 · 確認收妥','ready') : '<p class="status-note">請先私下查看身分卡，再點選確認收妥。</p>';
        else html += '<p class="status-note">✓ 已確認身分卡，等待其他玩家完成。</p>';
      }
      if (diceIsRolling()) html += diceRollingMarkup();
      else if (Number.isInteger(room.dice_first) && Number.isInteger(room.dice_second)) html += diceMarkup();
      else if(room.phase==='dossier') html += '<p class="status-note">正在取得公開骰點結果……</p>';
      if (room.phase==='discussion' && Date.now()<drawingUntil) html += drawAnimation();
      else if (room.card) html += cardHTML(room.card,room.size);
      if (room.undercover_seat) html += `<p class="status-note">本局臥底揭曉：<strong>${esc(playerLabel(room.undercover_seat))}</strong></p>`;
      if (room.phase==='answer') html += `<p class="status-note">本輪正確情報：<strong>${esc(room.answer_word || '—')}</strong></p>`;
      if (Date.now()<drawingUntil) { if(localTimer)clearTimeout(localTimer); localTimer=setTimeout(renderRoom,drawingUntil-Date.now()+100); }
    }
    $('playerContents').innerHTML = html;
  }
  async function runHostAction(action) {
    if (action==='unmask' && !confirm('請確認已完成所有口頭討論與投票，確定公布臥底？')) return;
    if (action==='answer' && !confirm('確認臥底已猜測完畢，現在公開正確情報？')) return;
    const prev = room.phase;
    const next = await rpc('intel606_host_action',{p_room:room.room_id,p_action:action});
    if (prev==='dossier' && next.phase==='discussion') drawingUntil = Date.now()+1800;
    if (next.phase==='lobby' || next.phase==='identity' || next.phase==='closed') unlocked = false;
    room = next;
    syncRollAnimation(room);
    renderRoom();
  }
  async function closeCurrentRoom() {
    if (!room?.is_host || room.phase==='closed') return;
    const message=`確定結束房間 ${room.code} 嗎？\n\n所有玩家都將收到關閉狀態，這個房間不能再繼續遊戲。`;
    if (!confirm(message)) return;
    await withAction(async()=>{
      room=await rpc('intel606_host_action',{p_room:room.room_id,p_action:'close'});
      unlocked=false; renderRoom();
      alertBox('房間已結束。可以返回首頁再建立新房間。',true);
    });
  }
  async function removeRoomMember(seat) {
    if (!room?.is_host || room.phase!=='lobby') return;
    const member=room.members.find(p=>p.seat===seat);
    if(!member || !confirm(`確定要將 ${playerLabel(seat)}（${member.name}）移出等待房間嗎？`)) return;
    await withAction(async()=>{room=await rpc('intel606_remove_member',{p_room:room.room_id,p_seat:seat});renderRoom();});
  }
  async function openLibrary() {
    await ensureIdentity('host',true);
    setView('library');
    await loadCards();
    renderEditor();
  }
  async function loadCards() {
    const {data,error} = await db.from('intel606_cards').select('*').order('created_at',{ascending:false});
    if (error) throw error;
    cardRows = data || [];
    $('libraryCount').textContent = `${cardRows.length} 張`;
    $('cardList').innerHTML = cardRows.length ? cardRows.map(c =>
      `<div class="card-row"><strong>${esc(c.title)}</strong><small>${esc(c.category)} · ${c.board_size} × ${c.board_size} · ${c.active?'已啟用':'已停用'}</small><div class="card-buttons"><button class="outline" data-card-edit="${esc(c.id)}">編輯</button><button class="outline" data-card-switch="${esc(c.id)}">${c.active?'停用':'啟用'}</button><button class="outline" data-card-delete="${esc(c.id)}">刪除</button></div></div>`).join('') : '<p>目前沒有情報卡，請先新增至少一張啟用的情報卡。</p>';
  }
  function renderEditor(c = null) {
    $('editTitle').textContent = c ? '編輯情報卡' : '新增情報卡';
    $('cardId').value = c?.id || '';
    $('cardSize').value = String(c?.board_size || $('cardSize').value || 3);
    $('cardCategory').value = c?.category || '';
    $('cardTitle').value = c?.title || '';
    $('cardActive').checked = c ? c.active : true;
    const size = Number($('cardSize').value);
    editCells = c?.cells && c.cells.length===size*size ? [...c.cells] : Array(size*size).fill('');
    $('cellEditor').style.setProperty('--size',size);
    $('cellEditor').innerHTML = editCells.map((word,i) => `<label>${String(i+1).padStart(2,'0')}<input data-cell="${i}" maxlength="80" value="${esc(word)}" placeholder="${i+1} 格" required></label>`).join('');
  }
  async function saveCard(event) {
    event.preventDefault();
    await withAction(async () => {
      const board_size = Number($('cardSize').value), id = $('cardId').value;
      const cells = Array.from(document.querySelectorAll('[data-cell]')).map(el => el.value.trim());
      if (cells.length!==board_size*board_size || cells.some(v=>!v)) throw new Error('請完整填寫所有格子的情報內容。');
      const payload={owner_id:user.id,board_size,category:$('cardCategory').value.trim(),title:$('cardTitle').value.trim(),active:$('cardActive').checked,cells};
      if (!payload.category || !payload.title) throw new Error('請填寫類型與名稱。');
      const operation = id ? db.from('intel606_cards').update(payload).eq('id',id) : db.from('intel606_cards').insert(payload);
      const {error} = await operation;
      if (error) throw error;
      await loadCards(); renderEditor();
      alertBox('情報卡已儲存。',true);
    });
  }
  async function cardOperation(id,kind) {
    const card = cardRows.find(c=>c.id===id);if(!card)return;
    if(kind==='edit'){renderEditor(card);window.scrollTo({top:0,behavior:'smooth'});return;}
    if(kind==='delete' && !confirm(`確定刪除「${card.title}」嗎？`)) return;
    await withAction(async()=>{
      const op = kind==='delete'?db.from('intel606_cards').delete().eq('id',id):db.from('intel606_cards').update({active:!card.active}).eq('id',id);
      const {error}=await op;if(error)throw error;
      await loadCards();
    });
  }
  function projector(open) {
    if (!open) { $('projection').hidden=true; return; }
    if (!room?.is_host || !room.card) return;
    $('projectionContent').innerHTML=cardHTML(room.card,room.size);
    $('projection').hidden=false;
  }
  function updateSettingsIndicator() {
    $('settingsDot').classList.toggle('configured',configOK);
    $('openSupabaseSettings').title = configOK ? 'Supabase 已設定 · 點此檢視或修改' : '尚未設定 Supabase · 點此設定';
  }
  // 設定表單由 online.html 內的獨立控制器處理，避免 CDN 或 JS 快取造成按鈕無法開啟。
  updateSettingsIndicator();
  document.addEventListener('click', e => {
    const act = e.target.closest('[data-action]')?.dataset.action;
    if (act) {
      if(act==='toggleIdentity'){unlocked=!unlocked;renderRoom();}
      else if(act==='projection')projector(true);
      else if(act==='library')withAction(openLibrary);
      else if(act==='ready')withAction(async()=>{room=await rpc('intel606_ready',{p_room:room.room_id});renderRoom();});
      else withAction(()=>runHostAction(act));
    }
    const edit=e.target.closest('[data-card-edit]')?.dataset.cardEdit;
    const toggle=e.target.closest('[data-card-switch]')?.dataset.cardSwitch;
    const del=e.target.closest('[data-card-delete]')?.dataset.cardDelete;
    if(edit) cardOperation(edit,'edit');
    if(toggle) cardOperation(toggle,'switch');
    if(del) cardOperation(del,'delete');
  });
  $('closeRoomButton').addEventListener('click',closeCurrentRoom);
  document.addEventListener('click',e=>{const el=e.target.closest('[data-remove-seat]');if(el)removeRoomMember(Number(el.dataset.removeSeat));});
  $('createRoom').addEventListener('click',()=>withAction(async()=>{
    await ensureIdentity('host',true);
    const value=await rpc('intel606_create_room',{p_size:Number($('createSize').value)});
    await attachRoom(value);
  }));
  $('joinRoom').addEventListener('click',()=>withAction(async()=>{
    await ensureIdentity('guest',true);
    const code=$('joinCode').value.trim().toUpperCase(), name=$('joinName').value.trim();
    if(code.length!==6)throw new Error('請填寫六碼房間代碼。');
    if(!name)throw new Error('請填寫玩家代稱。');
    const value=await rpc('intel606_join_room',{p_code:code,p_name:name});
    localStorage.setItem('intel606_nickname',name);
    await attachRoom(value);
  }));
  $('joinCode').addEventListener('input',e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''));
  $('openLibrary').addEventListener('click',()=>withAction(openLibrary));
  $('closeLibrary').addEventListener('click',()=>setView(room?'room':'landing'));
  function leaveRoom() {
    if(room?.is_host) localStorage.removeItem(hostRoomKey);
    else sessionStorage.removeItem(guestRoomKey);
    clearSubscriptions();
    if(rollRefreshTimer){clearTimeout(rollRefreshTimer);rollRefreshTimer=null;}
    stopDiceTicker(); rollingUntil=0; rollAnimationKey='';
    room=null;unlocked=false;setView('landing');
  }
  $('homeButton').addEventListener('click',()=>{
    if(room?.phase!=='closed'&&!confirm('返回首頁不會結束房間。要離開目前畫面嗎？'))return;
    leaveRoom();
  });
  async function copyInviteLink() {
    if(!room)return;
    const href=buildInviteLink();
    if(!href) throw new Error('目前尚未取得完整的邀請連結，請先確認 Supabase 設定。');
    try{await navigator.clipboard.writeText(href);alertBox('已複製包含公開連線設定的邀請連結。',true);}
    catch{alertBox('請手動分享這個連結：'+href,true);}
  }
  $('copyInvite').addEventListener('click',()=>withAction(copyInviteLink));
  $('copyInviteSecondary').addEventListener('click',()=>withAction(copyInviteLink));
  $('cardForm').addEventListener('submit',saveCard);
  $('cardSize').addEventListener('change',()=>renderEditor());
  $('clearCard').addEventListener('click',()=>renderEditor());
  $('closeProjection').addEventListener('click',()=>projector(false));
  document.addEventListener('keydown',e=>{if(e.key==='Escape')projector(false);});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){unlocked=false;projector(false);}
    else if(room)refreshRoom();
  });
  window.addEventListener('pageshow',()=>{if(room)refreshRoom();});
  initialize();
})();
