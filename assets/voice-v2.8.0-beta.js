/* 606 情報局 v2.8.0 Beta | lazy LiveKit audio | opt-in only */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const panel = $('voicePanel');
  if (!panel) return;
  const joinBtn = $('voiceJoin'), micBtn = $('voiceMic'), leaveBtn = $('voiceLeave'),
    resumeBtn = $('voiceResume'), status = $('voiceConnectionStatus'), count = $('voiceCount'),
    people = $('voiceParticipants'), errorBox = $('voiceError'), audioHost = $('voiceAudioTracks'),
    turnNotice = $('voiceTurnNotice'), help = $('voiceHelp'),
    clueDoneWrap = $('voiceClueCompleteWrap'), clueDoneBtn = $('voiceClueDone');
  let gameRoom = null, client = null, voiceRoom = null;
  let joining = false, microphoneOn = false, generation = 0, sdkPromise = null;
  let connectedId = null, micOps = 0, micQueue = Promise.resolve(), usedMicOnTurn = null;

  const voiceAllowed = r => !!r && r.play_mode === 'remote' && r.remote_interaction_mode === 'voice' && (r.phase === 'clue' || r.phase === 'chat');
  const turnKey = r => r && r.phase === 'clue' ? `${r.room_id}:${r.round}:${r.clue_current_seat}` : null;
  const canUseMic = r => !!r && voiceAllowed(r) && (r.phase === 'chat' ||
    (r.phase === 'clue' && !r.clue_completed && Number.isInteger(Number(r.my_seat)) &&
      Number(r.my_seat) > 0 && Number(r.my_seat) === Number(r.clue_current_seat)));
  function updateTurnNotice() {
    if (!voiceAllowed(gameRoom)) return;
    const inClue = gameRoom.phase === 'clue';
    turnNotice.hidden = !inClue;
    if (inClue) {
      const current = Number(gameRoom.clue_current_seat);
      const finished = !!gameRoom.clue_completed || !current;
      const mine = canUseMic(gameRoom);
      turnNotice.textContent = finished ? '本輪線索已完成：可繼續收聽語音，等待自由討論開始。'
        : mine ? '🎙 現在輪到你：加入語音後可以開啟麥克風，口頭發言後請按「完成口頭發言」，系統才會輪到下一位。'
        : `🔈 目前輪到 ${String(current).padStart(2, '0')} 號玩家：你可以收聽，但須等待輪到自己才能使用麥克風。`;
      turnNotice.classList.toggle('is-my-turn', mine);
    }
    help.textContent = inClue
      ? '線索階段依座位順序發言；加入後先靜音收聽，只有輪到自己才能開麥克風。不錄音，也不自動轉寫。'
      : '自由討論階段可自由開麥克風；不錄音、不轉寫，也不使用遊戲文字聊天室。';
  }
  function setError(msg = '') { errorBox.textContent = msg; errorBox.hidden = !msg; }
  function stateLabel(value, kind = '') { status.textContent = value; status.className = 'voice-status' + (kind ? ` ${kind}` : ''); }
  function buttons() {
    const live = !!voiceRoom && voiceRoom.state === 'connected';
    joinBtn.disabled = joining || live || !voiceAllowed(gameRoom);
    joinBtn.textContent = joining ? '正在加入……' : '加入語音';
    micBtn.disabled = !live || micOps > 0 || (!microphoneOn && !canUseMic(gameRoom));
    micBtn.textContent = microphoneOn ? '🔇 關閉麥克風' : gameRoom?.phase === 'clue' && !canUseMic(gameRoom) ? '🎙 等待輪到你' : '🎙 開啟麥克風';
    const currentSpeaker = gameRoom?.phase === 'clue' && canUseMic(gameRoom);
    clueDoneWrap.hidden = !currentSpeaker;
    clueDoneBtn.disabled = !live || !currentSpeaker || usedMicOnTurn !== turnKey(gameRoom);
    leaveBtn.disabled = !live && !joining;
    resumeBtn.hidden = !live || !!voiceRoom?.canPlaybackAudio;
  }
  function participants() {
    people.replaceChildren();
    const live = voiceRoom && voiceRoom.state === 'connected';
    if (!live) { count.textContent = '目前 0 人連線'; buttons(); return; }
    const all = [voiceRoom.localParticipant, ...voiceRoom.remoteParticipants.values()];
    count.textContent = `目前 ${all.length} 人連線`;
    all.forEach(p => {
      const item = document.createElement('span');
      const isLocal = p === voiceRoom.localParticipant;
      item.className = 'voice-participant' + (p.isSpeaking ? ' speaking' : '') + (!p.isMicrophoneEnabled ? ' muted' : '');
      item.textContent = `${p.isSpeaking ? '◉ ' : '● '}${p.name || '參與者'}${isLocal ? '（我）' : ''}${p.isMicrophoneEnabled ? '' : ' · 靜音'}`;
      people.appendChild(item);
    });
    buttons();
  }
  async function loadSdk() {
    if (window.LivekitClient?.Room) return window.LivekitClient;
    if (!sdkPromise) sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      // This SDK is optional and loads only after the player taps Join.
      script.src = 'https://cdn.jsdelivr.net/npm/livekit-client@2.23.0/dist/livekit-client.umd.min.js';
      script.async = true;
      const timeout = setTimeout(() => { script.remove(); reject(new Error('語音套件載入逾時，請檢查網路連線。')); }, 20000);
      script.onload = () => { clearTimeout(timeout); window.LivekitClient?.Room ? resolve(window.LivekitClient) : reject(new Error('語音套件載入異常')); };
      script.onerror = () => { clearTimeout(timeout); reject(new Error('語音套件無法下載，請檢查網路或瀏覽器的阻擋設定。')); };
      document.head.appendChild(script);
    }).catch(error => { sdkPromise = null; throw error; });
    return sdkPromise;
  }
  function cleanTracks() {
    audioHost.querySelectorAll('audio').forEach(el => { el.pause(); el.srcObject = null; el.remove(); });
  }
  function leave() {
    ++generation; joining = false; microphoneOn = false; connectedId = null; usedMicOnTurn = null;
    const old = voiceRoom; voiceRoom = null;
    if (old) { try { old.disconnect(); } catch (_) { /* already disconnected */ } }
    cleanTracks(); setError(''); stateLabel('尚未加入'); participants();
  }
  async function join() {
    if (joining || voiceRoom || !client || !voiceAllowed(gameRoom)) return;
    if (!window.isSecureContext) { setError('語音需要 HTTPS 安全網頁環境。'); return; }
    const attempt = ++generation;
    joining = true; buttons(); setError(''); stateLabel('正在連線', 'busy');
    const expectedRoom = gameRoom.room_id;
    let newRoom = null;
    try {
      const sdk = await loadSdk();
      const { data, error } = await client.functions.invoke('intel606-voice-token', { body: { room_id: expectedRoom } });
      if (error) {
        let detail = '';
        try { detail = (await error.context?.json())?.error || ''; } catch (_) { /* may not be json */ }
        throw new Error(detail || error.message || '無法取得語音連線憑證');
      }
      if (!data?.serverUrl || !data?.token || !/^wss:\/\//i.test(data.serverUrl))
        throw new Error('語音伺服器回傳的資料不完整。');
      if (attempt !== generation || !voiceAllowed(gameRoom) || gameRoom.room_id !== expectedRoom) return;

      newRoom = new sdk.Room({ adaptiveStream: true, dynacast: true,
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const tracked = newRoom;
      const onSubscribed = (track) => {
        if (track.kind !== sdk.Track.Kind.Audio) return;
        const element = track.attach();
        element.autoplay = true;
        element.playsInline = true;
        audioHost.appendChild(element);
        buttons();
      };
      tracked.on(sdk.RoomEvent.TrackSubscribed, onSubscribed);
      tracked.on(sdk.RoomEvent.TrackUnsubscribed, track => {
        track.detach().forEach(el => el.remove());
        buttons();
      });
      for (const ev of [sdk.RoomEvent.ParticipantConnected, sdk.RoomEvent.ParticipantDisconnected,
        sdk.RoomEvent.ActiveSpeakersChanged, sdk.RoomEvent.TrackMuted, sdk.RoomEvent.TrackUnmuted,
        sdk.RoomEvent.LocalTrackPublished, sdk.RoomEvent.LocalTrackUnpublished]) {
        tracked.on(ev, () => { if (voiceRoom === tracked) participants(); });
      }
      tracked.on(sdk.RoomEvent.Reconnecting, () => { if (voiceRoom === tracked) stateLabel('重新連線中', 'busy'); });
      tracked.on(sdk.RoomEvent.Reconnected, () => { if (voiceRoom === tracked) {stateLabel('語音已連線', 'connected');participants();} });
      tracked.on(sdk.RoomEvent.AudioPlaybackStatusChanged, () => { if (voiceRoom === tracked) buttons(); });
      tracked.on(sdk.RoomEvent.Disconnected, () => {
        if (voiceRoom === tracked) {
          voiceRoom = null; microphoneOn = false; connectedId = null;
          cleanTracks(); stateLabel('語音已中斷'); participants();
        }
      });
      await tracked.connect(data.serverUrl, data.token);
      if (attempt !== generation || !voiceAllowed(gameRoom) || gameRoom.room_id !== expectedRoom) {
        tracked.disconnect(); return;
      }
      voiceRoom = tracked; connectedId = expectedRoom;
      microphoneOn = false; // A joined participant is listen-only until they choose to publish mic.
      stateLabel('語音已連線', 'connected');
      participants();
      try { await voiceRoom.startAudio(); } catch (_) { /* Safari may need an additional click */ }
      buttons();
    } catch (e) {
      if (newRoom && newRoom !== voiceRoom) newRoom.disconnect();
      if (attempt === generation) {
        setError(e?.message || '加入語音失敗，請稍後重試。');
        stateLabel('加入失敗');
      }
    } finally {
      if (attempt === generation) { joining = false; buttons(); }
    }
  }
  // Serialise all microphone changes. A turn can advance while permission prompts are open:
  // recheck the fresh room state after awaiting and mute immediately if the turn was lost.
  function setMicrophone(enabled, silent = false) {
    const r = voiceRoom;
    if (!r || r.state !== 'connected') return Promise.resolve();
    micOps++; buttons();
    const task = micQueue.catch(() => {}).then(async () => {
      if (r !== voiceRoom || r.state !== 'connected') return;
      if (enabled && !canUseMic(gameRoom)) return;
      try {
        await r.localParticipant.setMicrophoneEnabled(enabled);
        if (r !== voiceRoom) {
          if (enabled) await r.localParticipant.setMicrophoneEnabled(false);
          return;
        }
        microphoneOn = !!r.localParticipant.isMicrophoneEnabled;
        if (enabled && microphoneOn && gameRoom?.phase === 'clue' && canUseMic(gameRoom))
          usedMicOnTurn = turnKey(gameRoom);
        // Prevent a late mic-permission prompt from opening after our turn has ended.
        if (microphoneOn && !canUseMic(gameRoom)) {
          await r.localParticipant.setMicrophoneEnabled(false);
          microphoneOn = false;
        }
      } catch (e) {
        if (!silent && r === voiceRoom) {
          const denied = /notallowed|permission/i.test(e?.name || '');
          setError(denied ? '麥克風權限遭拒絕，請至瀏覽器設定允許此網站使用麥克風。'
            : `無法切換麥克風：${e?.message || e}`);
        }
      }
    });
    micQueue = task.catch(() => {});
    return task.finally(() => {
      micOps = Math.max(0, micOps - 1);
      if (r === voiceRoom) participants();
    });
  }
  function toggleMic() {
    if (micOps || !voiceRoom || voiceRoom.state !== 'connected') return;
    if (!microphoneOn && !canUseMic(gameRoom)) return;
    setError('');
    void setMicrophone(!microphoneOn);
  }
  function sync(state, supabaseClient) {
    client = supabaseClient;
    if (!voiceAllowed(state)) {
      gameRoom = state;
      panel.hidden = true;
      if (voiceRoom || joining) leave();
      return;
    }
    const wasClue = gameRoom?.phase === 'clue' && gameRoom?.room_id === state.room_id;
    if ((connectedId && connectedId !== state.room_id) ||
        (joining && gameRoom?.room_id && gameRoom.room_id !== state.room_id)) leave();
    gameRoom = state;
    panel.hidden = false;
    updateTurnNotice();
    // A turn change and the shift to free chat both start from a safe muted state.
    if (voiceRoom?.state === 'connected' && microphoneOn &&
        (!canUseMic(state) || (wasClue && state.phase === 'chat'))) void setMicrophone(false, true);
    buttons();
  }
  const spokeThisTurn = state => !!voiceRoom && voiceRoom.state === 'connected' &&
    canUseMic(state) && usedMicOnTurn === turnKey(state);
  joinBtn.addEventListener('click', join);
  micBtn.addEventListener('click', toggleMic);
  leaveBtn.addEventListener('click', leave);
  resumeBtn.addEventListener('click', () => {
    if (!voiceRoom) return;
    voiceRoom.startAudio().then(buttons).catch(err => setError(`無法啟用聲音播放：${err.message || err}`));
  });
  window.addEventListener('pagehide', leave);
  window.INTEL606_VOICE = { sync, leave, spokeThisTurn, stopMicrophone: () => setMicrophone(false, true) };
  buttons();
})();
