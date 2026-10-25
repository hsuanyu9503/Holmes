-- 606 情報局統一升級 v2.5.4／v2.5.5／v2.5.6 → v2.5.7
-- 可重複執行，保留房間、玩家與情報卡現有資料。請暫停遊戲後執行。
begin;
-- 606 情報局 v2.5.4 → v2.5.5 現有資料安全升級
-- 只新增擲骰時間欄位、更新受控 RPC，保留既有情報卡/玩家/房間。
-- 建議在未進行擲骰的時間執行。可重複執行。

create schema if not exists intelligence_private;
alter table public.intel606_rooms add column if not exists dice_rolled_at timestamptz;

create or replace function public.intel606_room_state(p_room uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.intel606_rooms%rowtype;
  v_secret intelligence_private.intel606_secrets%rowtype;
  v_member public.intel606_members%rowtype;
  v_host boolean;
  v_people jsonb;
  v_card jsonb := null;
  v_role text := null;
  v_map jsonb := null;
  v_code text := null;
  v_unmasked integer := null;
  v_drawn_code text := null;
  v_die1 integer := null;
  v_die2 integer := null;
  v_position integer := null;
  v_answer_word text := null;
begin
  if auth.uid() is null then raise exception '請先登入連線身分'; end if;
  select * into v_room from public.intel606_rooms where id = p_room;
  if not found then raise exception '找不到房間'; end if;
  v_host := v_room.host_id = auth.uid();
  select * into v_member from public.intel606_members where room_id = p_room and user_id = auth.uid();
  if not v_host and v_member.user_id is null then raise exception '無權讀取此房間'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('seat', seat_no, 'name', display_name, 'ready', is_ready) order by seat_no),'[]'::jsonb)
    into v_people from public.intel606_members where room_id = p_room;
  if v_room.phase not in ('lobby','closed') then
    select * into v_secret from intelligence_private.intel606_secrets where room_id = p_room;
    if v_member.user_id is not null then
      if v_secret.undercover_seat = v_member.seat_no then
        v_role := 'undercover';
      else
        v_role := 'agent';
        v_map := v_secret.code_map;
        if v_room.phase in ('discussion','undercover','answer')
          or (v_room.phase = 'dossier' and
              (v_room.dice_rolled_at is null or clock_timestamp() >= v_room.dice_rolled_at + interval '3 seconds')) then
          v_code := v_secret.secret_code;
          v_drawn_code := v_secret.secret_code;
        end if;
      end if;
    end if;
    if v_room.phase in ('dossier','discussion','undercover','answer') then
      -- 開骰時刻由資料庫記錄；動畫的3秒內不送出最終骰值，避免動畫提前洩露結果。
      if v_room.dice_rolled_at is null or clock_timestamp() >= v_room.dice_rolled_at + interval '3 seconds' then
        v_die1 := v_secret.dice_first;
        v_die2 := v_secret.dice_second;
      end if;
    end if;
    if v_room.phase in ('undercover','answer') then v_unmasked := v_secret.undercover_seat; end if;
    if v_room.phase = 'answer' then
      v_code := v_secret.secret_code;
      v_drawn_code := v_secret.secret_code;
    end if;
  end if;
  if v_room.phase in ('discussion','undercover','answer') then
    v_card := v_room.current_card_snapshot;
  end if;
  if v_room.phase = 'answer' and v_card is not null and v_secret.secret_code is not null then
    -- 同一代號在對照表出現2或3次；但在情報卡上只能對應一格。
    -- 因此依代號 A1..C3 / A1..D4 定位，而不是使用 code_map 首次出現的位置。
    v_position := (ascii(left(v_secret.secret_code,1)) - ascii('A'))
                + (substring(v_secret.secret_code from 2)::integer - 1) * v_room.board_size;
    if v_position between 0 and v_room.board_size*v_room.board_size - 1 then
      v_answer_word := v_card->'cells'->>v_position;
    end if;
  end if;
  return jsonb_build_object(
    'room_id', v_room.id, 'code', v_room.room_code, 'phase', v_room.phase,
    'round', v_room.round_no, 'size', v_room.board_size, 'version', v_room.version,
    'roll_started_at', v_room.dice_rolled_at, 'server_now', clock_timestamp(),
    'is_host', v_host, 'my_seat', v_member.seat_no, 'my_role', v_role,
    'members', v_people, 'code_map', v_map, 'secret_code', v_code,
    'undercover_seat', v_unmasked, 'card', v_card,
    'drawn_code', v_drawn_code, 'dice_first', v_die1, 'dice_second', v_die2,
    'answer_word', v_answer_word
  );
end;
$$;

create or replace function public.intel606_host_action(p_room uuid, p_action text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.intel606_rooms%rowtype;
  v_total integer; v_ready integer;
  v_codes text[] := '{}'::text[]; v_temp text; v_j integer; v_i integer; v_repeat integer;
  v_spy integer; v_first integer; v_second integer; v_offset integer;
  v_secret text; v_card uuid; v_snapshot jsonb;
begin
  if auth.uid() is null then raise exception '請先登入連線身分'; end if;
  select * into v_room from public.intel606_rooms where id=p_room for update;
  if not found or v_room.host_id <> auth.uid() then raise exception '只有主控端可以執行此操作'; end if;
  select count(*),count(*) filter (where is_ready) into v_total,v_ready from public.intel606_members where room_id=p_room;
  if p_action = 'start' and v_room.phase = 'lobby' then
    if v_total < 3 or v_total > 8 then raise exception '需有 3～8 位玩家才能開始'; end if;
    delete from intelligence_private.intel606_secrets where room_id=p_room;
    -- 3×3：九組代號各兩次，共18位置（6×3）。
    -- 4×4：十六組代號各三次，共48位置（8×6）。
    for v_i in 0..(v_room.board_size*v_room.board_size-1) loop
      for v_repeat in 1..(case when v_room.board_size = 3 then 2 else 3 end) loop
        v_codes := array_append(v_codes,
          substr('ABCD', (v_i % v_room.board_size)+1, 1) || ((v_i/v_room.board_size)+1)::text);
      end loop;
    end loop;
    for v_i in reverse array_length(v_codes,1)..2 loop
      v_j := intelligence_private.intel606_rand(v_i) + 1;
      v_temp := v_codes[v_i]; v_codes[v_i] := v_codes[v_j]; v_codes[v_j] := v_temp;
    end loop;
    v_spy := intelligence_private.intel606_rand(v_total) + 1;
    -- 下一輪如果編號不連續，不直接假設有 1..N，從實際成員隨機選。
    select seat_no into v_spy from public.intel606_members where room_id=p_room order by seat_no offset (v_spy-1) limit 1;
    insert into intelligence_private.intel606_secrets(room_id,undercover_seat,code_map)
      values(p_room,v_spy,to_jsonb(v_codes));
    update public.intel606_members set is_ready=false where room_id=p_room;
    update public.intel606_rooms set phase='identity',current_card_id=null,current_card_snapshot=null,dice_rolled_at=null where id=p_room;
  elsif p_action = 'roll' and v_room.phase = 'identity' then
    if v_ready <> v_total then raise exception '請等所有玩家確認身分卡後再擲骰'; end if;
    if v_room.board_size = 3 then
      v_first := intelligence_private.intel606_rand(6) + 1;  -- 藍：1～6
      v_second := intelligence_private.intel606_rand(3) + 1; -- 紅：1/1/2/2/3/3
      v_offset := (v_first - 1) * 3 + (v_second - 1);
    else
      v_first := intelligence_private.intel606_rand(8) + 1;  -- 藍：1～8
      v_second := intelligence_private.intel606_rand(6) + 1; -- 紅：1～6，永不重擲
      v_offset := (v_first - 1) * 6 + (v_second - 1);
    end if;
    -- 以雙色骰子定位對照表的唯一位置，再由該位置讀取機密代號。
    select code_map->>v_offset into v_secret
      from intelligence_private.intel606_secrets where room_id=p_room;
    if v_secret is null then raise exception '代號對照表資料不完整，請建立新一輪任務'; end if;
    update intelligence_private.intel606_secrets
       set secret_code=v_secret,dice_first=v_first,dice_second=v_second
      where room_id=p_room;
    update public.intel606_rooms set phase='dossier',dice_rolled_at=clock_timestamp() where id=p_room;
  elsif p_action = 'draw' and v_room.phase = 'dossier' then
    select id into v_card from public.intel606_cards
       where owner_id=auth.uid() and board_size=v_room.board_size and active=true order by random() limit 1;
    if v_card is null then raise exception '沒有符合此宮格的啟用情報卡，請先建立'; end if;
    select jsonb_build_object('id',id,'title',title,'category',category,'cells',cells)
      into v_snapshot from public.intel606_cards where id=v_card;
    update public.intel606_rooms set phase='discussion',current_card_id=v_card,current_card_snapshot=v_snapshot where id=p_room;
  elsif p_action = 'unmask' and v_room.phase = 'discussion' then
    update public.intel606_rooms set phase='undercover' where id=p_room;
  elsif p_action = 'answer' and v_room.phase = 'undercover' then
    update public.intel606_rooms set phase='answer' where id=p_room;
  elsif p_action = 'next' and v_room.phase = 'answer' then
    delete from intelligence_private.intel606_secrets where room_id=p_room;
    update public.intel606_members set is_ready=false where room_id=p_room;
    update public.intel606_rooms set phase='lobby',round_no=round_no+1,current_card_id=null,current_card_snapshot=null,dice_rolled_at=null where id=p_room;
  elsif p_action = 'close' and v_room.phase <> 'closed' then
    update public.intel606_rooms set phase='closed' where id=p_room;
  else
    raise exception '目前階段不允許執行這個操作';
  end if;
  update public.intel606_rooms set version=version+1,updated_at=now() where id=p_room;
  return public.intel606_room_state(p_room);
end;
$$;

create or replace function public.intel606_remove_member(p_room uuid, p_seat integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room public.intel606_rooms%rowtype;
begin
  if auth.uid() is null then raise exception '請先登入連線身分'; end if;
  select * into v_room from public.intel606_rooms where id=p_room for update;
  if not found or v_room.host_id <> auth.uid() then raise exception '只有主控端可以管理房間玩家'; end if;
  if v_room.phase <> 'lobby' then raise exception '只有等待玩家階段可移除玩家'; end if;
  if p_seat not between 1 and 8 then raise exception '無效的座位編號'; end if;
  delete from public.intel606_members where room_id=p_room and seat_no=p_seat;
  if not found then raise exception '找不到此玩家'; end if;
  update public.intel606_rooms set version=version+1,updated_at=now() where id=p_room;
  return public.intel606_room_state(p_room);
end;
$$;

revoke all on function public.intel606_room_state(uuid) from public, anon, authenticated;
revoke all on function public.intel606_host_action(uuid,text) from public, anon, authenticated;
revoke all on function public.intel606_remove_member(uuid,integer) from public, anon, authenticated;
grant execute on function public.intel606_room_state(uuid) to authenticated;
grant execute on function public.intel606_host_action(uuid,text) to authenticated;
grant execute on function public.intel606_remove_member(uuid,integer) to authenticated;

-- 606 情報局 v2.5.6 → v2.5.7 補丁。可以重複執行。
-- 不清空情報卡、房間或玩家；保留既有 RLS / GRANT。
-- 修正 4×4 共 48 個代碼位置打亂時，rand(48) 原先被錯誤限制為最大 32。

create or replace function intelligence_private.intel606_rand(p_n integer)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v integer; v_max integer;
begin
  if p_n < 1 or p_n > 256 then raise exception 'invalid random range'; end if;
  v_max := 256 - (256 % p_n);
  loop
    v := get_byte(decode(substr(replace(gen_random_uuid()::text, '-', ''), 1, 2), 'hex'), 0);
    if v < v_max then return v % p_n; end if;
  end loop;
end;
$$;
revoke all on function intelligence_private.intel606_rand(integer) from public, anon, authenticated;

commit;
