/* 606 情報局｜連線版 v2.5.0。私密資料僅來自經授權的 SQL RPC。 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const conf = window.INTEL606_SUPABASE || {};
  const configOK = /^https:\/\/[-a-z0-9.]+\.supabase\.co\/?$/i.test(conf.url || '') && /\S/.test(conf.publishableKey || '');
  const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const playerLabel = no => String(no).padStart(2,'0') + ' 號玩家';
  const show = (id, visible) => { $(id).hidden = !visible; };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const stages = {
    lobby:['等待玩家集合','主控端建立房間後，邀請 3～8 位玩家使用自己的裝置加入。'],
    identity:['機密身分分發','每位玩家在自己的裝置確認身分卡，只有情報員能看到共同的隨機代碼對照表。'],
    dossier:['公開抽骰結果','雙色骰子已產生本局公開代碼。情報員可以用代碼對照表找出情報卡的正確位置。'],
    discussion:['情報卡已公開','所有玩家看到相同的情報卡；請口頭發言與討論，找出混入隊伍的臥底。'],
    undercover:['臥底已揭曉','請讓臥底根據場上線索，說出最後的猜測。'],
    answer:['正確答案揭曉','本局任務結束，可由主控端建立下一輪。'],
    closed:['任務已關閉','請返回首頁重新建立房間。']
  };
  let db = null, user = null, room = null, sub = null, poll = null;
  let unlocked = false, view = 'landing', drawingUntil = 0, rollingUntil = 0;
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
    if (error) throw new Error(error.message || '伺服器操作失敗');
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
      alertBox('尚未設定 Supabase：請先編輯線上部署檔 online-config.js，填入 Project URL 與 publishable key。');
      for (const id of ['createRoom','joinRoom','openLibrary']) $(id).disabled = true;
      return;
    }
    if (!window.supabase || !window.supabase.createClient) {
      alertBox('無法載入 Supabase SDK，請檢查網路連線或瀏覽器是否阻擋 CDN。'); return;
    }
    db = window.supabase.createClient(conf.url.replace(/\/$/,''), conf.publishableKey, {
      auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}
    });
    try {
      const {data:{session},error} = await db.auth.getSession();
      if (error) throw error;
      if (session) user = session.user;
      else {
        const result = await db.auth.signInAnonymously();
        if (result.error) throw result.error;
        user = result.data.user;
      }
      alertBox('');
      const last = localStorage.getItem('intel606_last_room');
      if (last && !urlRoom) {
        try { await attachRoom(await rpc('intel606_room_state',{p_room:last}), false); }
        catch { localStorage.removeItem('intel606_last_room'); }
      }
    } catch(e) {
      alertBox('登入連線身分失敗：' + e.message + '。請確認 Supabase Authentication 已啟用 Anonymous Sign-ins。');
    }
  }
  async function withAction(callback) {
    if (busy || !db || !user) return;
    requestBusy(true);
    try { alertBox(''); await callback(); }
    catch(e) { alertBox(e.message); }
    finally { requestBusy(false); if(view==='room' && room) renderRoom(); }
  }
  async function attachRoom(value, fresh = true) {
    if (!value || !value.room_id) throw new Error('房間資料不正確');
    const idChanged = !room || room.room_id !== value.room_id;
    room = value;
    if (fresh || idChanged) unlocked = false;
    localStorage.setItem('intel606_last_room', room.room_id);
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
      renderRoom();
    } catch(e) { $('liveStatus').textContent = '◌ 重新連線中'; }
    finally { fetching = false; }
  }
  function renderRoom() {
    if (!room || view !== 'room') return;
    const isHost = room.is_host;
    const phase = stages[room.phase] || stages.lobby;
    $('roomHeading').textContent = `第 ${String(room.round).padStart(2,'0')} 輪 · ${room.size} × ${room.size} 情報任務`;
    $('roomSub').textContent = isHost ? '主控端 · 教師操作畫面' : `${playerLabel(room.my_seat)} · 個人機密畫面`;
    $('roomCode').textContent = room.code;
    show('hostArea',isHost);show('playerArea',!isHost);
    if (isHost) renderHost(phase);
    else renderPlayer(phase);
  }
  function renderRoster() {
    $('rosterTotal').textContent = `${room.members.length} / 8`;
    $('roster').innerHTML = room.members.length ? room.members.map(p =>
      `<div class="roster-item ${p.ready?'ready':''}"><strong>${esc(playerLabel(p.seat))} · ${esc(p.name)}</strong><span>${room.phase==='identity' ? (p.ready?'已確認身分':'待確認') : '已加入'}</span></div>`
    ).join('') : '<p>目前尚未有玩家加入，請分享房間代碼。</p>';
  }
  function btn(label, action, {disabled=false, cls='primary'} = {}) {
    return `<button class="${cls}" data-action="${action}" ${disabled?'disabled':''}>${esc(label)}</button>`;
  }
  function drawAnimation() {
    return '<div class="draw-box"><div class="draw-stack" aria-hidden="true"><span>606</span><span>✦</span><span>機密</span></div><div class="draw-caption">正在從情報資料庫抽取本輪情報卡……</div></div>';
  }
  function diceMarkup() {
    if (!room.drawn_code) return '';
    const a = room.size === 3 ? '六面骰' : '八面骰';
    const b = room.size === 3 ? '三種點數六面骰' : '六面骰';
    const guide = room.size === 3 ? '第一顆：1／4→A、2／5→B、3／6→C；第二顆：1～3。' : '第一顆：1／5→A、2／6→B、3／7→C、4／8→D；第二顆：1～4。';
    const rerolls = room.size === 4 ? (room.rerolls ? `第二顆骰子擲出 5／6，已重擲 ${room.rerolls} 次以確保公平。` : '第二顆骰子只接受 1～4，若出現 5／6 就重擲。') : '';
    return `<div class="dice-area"><div class="die"><small>${a}</small>${room.dice_first}</div><div class="die red"><small>${b}</small>${room.dice_second}</div></div><div class="status-note">本輪公開任務代碼：<strong style="font-size:29px;color:#f1d7a3">${esc(room.drawn_code)}</strong><p class="hint">${guide} · ${rerolls}</p></div>`;
  }
  function renderHost([heading,desc]) {
    $('hostPhaseTitle').textContent = heading;
    $('hostPhaseDesc').textContent = desc;
    renderRoster();
    const n = room.members.length, ready = room.members.filter(p => p.ready).length;
    let html = '';
    const isRolling = Date.now() < rollingUntil;
    switch(room.phase) {
      case 'lobby':
        html = `<p class="status-note">人數：${n} 位；每局固定 1 名臥底。</p>`+
          btn('全員到齊 · 分配身分卡','start',{disabled:n<3})+
          btn('管理情報卡資料庫','library',{cls:'outline'});break;
      case 'identity':
        html = `<p class="status-note">身分已確認：${ready}／${n} 位</p>`+
          btn('全員確認完成 · 公開抽骰','roll',{disabled:ready!==n});break;
      case 'dossier':
        if (isRolling) html = '<div class="draw-box"><div class="dice-area"><div class="die rolling">✦</div><div class="die red rolling">✦</div></div><div class="draw-caption">機密代碼抽取中……</div></div>';
        else html = diceMarkup() + btn('抽取本輪情報卡','draw') + btn('管理情報卡','library',{cls:'outline'});
        break;
      case 'discussion':
        if (Date.now() < drawingUntil) html = drawAnimation();
        else html = diceMarkup()+btn('✦ 投影情報卡','projection')+btn('討論與投票結束 · 揭曉臥底','unmask',{cls:'outline'});
        break;
      case 'undercover': html = `<div class="status-note">本輪臥底是 <strong>${esc(playerLabel(room.undercover_seat))}</strong></div>`+
        btn('臥底猜測完畢 · 公布答案','answer');break;
      case 'answer': html = `<div class="status-note">機密代碼：${esc(room.drawn_code)} ／ 正確情報：<strong>${esc(room.answer_word || '—')}</strong></div>`+
        btn('建立下一輪任務','next');break;
      case 'closed': html = '<p>本房間已結束。</p>';break;
    }
    $('hostControls').innerHTML = html;
    const showCard = room.card && ['discussion','undercover','answer'].includes(room.phase) && Date.now() >= drawingUntil;
    show('hostCardPreview',showCard);
    if (showCard) $('hostCardPreview').innerHTML = cardHTML(room.card,room.size) +
      (room.phase==='answer'? `<p class="status-note">正確情報：<strong>${esc(room.answer_word)}</strong></p>`:'');
    if (Date.now() < drawingUntil || Date.now() < rollingUntil) {
      if (localTimer) clearTimeout(localTimer);
      localTimer = setTimeout(renderRoom, Math.max(120, Math.max(drawingUntil,rollingUntil)-Date.now()+100));
    }
  }
  function gridMap(codeMap, size, selected = '') {
    if (!Array.isArray(codeMap)) return '';
    return `<div class="code-grid" style="--size:${size}">${codeMap.map((code,i) =>
      `<div class="code-cell ${selected===code?'highlight':''}"><strong>${esc(code)}</strong><small>情報格 ${i+1}</small></div>`).join('')}</div>`;
  }
  function cardHTML(card,size) {
    if (!card || !Array.isArray(card.cells)) return '';
    return `<div class="intel-wrap"><span class="intel-tag">✦ ${esc(card.category)} · ${size} × ${size} ✦</span><h3 class="intel-title">${esc(card.title)}</h3><div class="intel-grid" style="--size:${size}">${card.cells.map((word,i)=>`<div class="intel-cell"><small>${String(i+1).padStart(2,'0')}</small>${esc(word)}</div>`).join('')}</div></div>`;
  }
  function renderPlayer([heading,desc]) {
    $('playerPhaseTitle').textContent = heading;
    $('playerPhaseDesc').textContent = desc;
    const isUndercover = room.my_role === 'undercover';
    let html = '';
    if (room.phase === 'lobby') html = '<div class="status-note">已成功加入房間，等待主控端分配身分卡。</div>';
    else if (room.phase === 'closed') html = '<div class="status-note">本房間已關閉。</div>';
    else {
      html += `<div class="personal-wrap">${btn(unlocked ? '🔒 暫時隱藏私人身分卡' : '🔓 私下查看我的角色卡','toggleIdentity',{cls:'outline'})}`;
      if (unlocked) {
        html += `<div class="identity-card ${isUndercover?'undercover':''}"><p>${esc(playerLabel(room.my_seat))}</p><h3>${isUndercover ? '你／妳是臥底' : '你／妳是情報員'}</h3>`;
        if (isUndercover) html += '<p class="hint">從其他情報員的線索中，努力推測出正確代碼吧！</p>';
        else {
          html += '<p class="hint">這是本輪所有情報員共用的隨機代碼對照表。請依公開骰子代碼找到對應情報格，勿讓臥底看見。</p>'+
            gridMap(room.code_map,room.size,room.drawn_code);
          if (room.drawn_code) {
            const position = (room.code_map||[]).indexOf(room.drawn_code);
            const word = position>=0 && room.card?.cells ? room.card.cells[position] : null;
            html += `<div class="status-note">本輪代碼：<strong>${esc(room.drawn_code)}</strong> · 第 ${position+1} 格${word ? ` · 機密情報：<strong>${esc(word)}</strong>` : ''}</div>`;
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
      if (room.drawn_code) html += diceMarkup();
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
    if (action==='roll') {rollingUntil = Date.now()+1700;renderRoom();}
    const prev = room.phase;
    const next = await rpc('intel606_host_action',{p_room:room.room_id,p_action:action});
    if (prev==='dossier' && next.phase==='discussion') drawingUntil = Date.now()+1800;
    if (next.phase==='lobby' || next.phase==='identity') unlocked = false;
    room = next;
    renderRoom();
  }
  async function openLibrary() {
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
  document.addEventListener('click', e => {
    const act = e.target.closest('[data-action]')?.dataset.action;
    if (act) {
      if(act==='toggleIdentity'){unlocked=!unlocked;renderRoom();}
      else if(act==='projection')projector(true);
      else if(act==='library')withAction(openLibrary);
      else if(act==='ready')withAction(async()=>{room=await rpc('intel606_ready',{p_room:room.room_id});unlocked=false;renderRoom();});
      else withAction(()=>runHostAction(act));
    }
    const edit=e.target.closest('[data-card-edit]')?.dataset.cardEdit;
    const toggle=e.target.closest('[data-card-switch]')?.dataset.cardSwitch;
    const del=e.target.closest('[data-card-delete]')?.dataset.cardDelete;
    if(edit) cardOperation(edit,'edit');
    if(toggle) cardOperation(toggle,'switch');
    if(del) cardOperation(del,'delete');
  });
  $('createRoom').addEventListener('click',()=>withAction(async()=>{
    const value=await rpc('intel606_create_room',{p_size:Number($('createSize').value)});
    await attachRoom(value);
  }));
  $('joinRoom').addEventListener('click',()=>withAction(async()=>{
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
  $('homeButton').addEventListener('click',()=>{
    if(room?.phase!=='closed'&&!confirm('返回首頁不會結束房間。要離開目前畫面嗎？'))return;
    localStorage.removeItem('intel606_last_room');
    if(sub){db.removeChannel(sub);sub=null;}if(poll){clearInterval(poll);poll=null;}
    room=null;unlocked=false;setView('landing');
  });
  $('copyInvite').addEventListener('click',async()=>{
    if(!room)return;
    const link=new URL('online.html',location.href);link.searchParams.set('room',room.code);
    try{await navigator.clipboard.writeText(link.href);alertBox('已複製加入房間的連結。',true);}
    catch{alertBox('請手動分享這個連結：'+link.href,true);}
  });
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
