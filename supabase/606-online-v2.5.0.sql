-- 606 情報局｜連線模式 v2.5.0
-- 適用：Supabase 2026-10-30 Data API 新規則（明確 GRANT + RLS）
-- 請先在 Authentication -> Providers 啟用 Anonymous Sign-ins。
-- 全部 SQL 可一次執行；與單機模式完全獨立。首次部署請使用空白測試專案。

begin;

create schema if not exists intelligence_private;
revoke all on schema intelligence_private from public, anon, authenticated;

create table if not exists public.intel606_cards (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  board_size integer not null check (board_size in (3,4)),
  category text not null check (char_length(btrim(category)) between 1 and 40),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  cells jsonb not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint intel606_cells_shape check (
    case when jsonb_typeof(cells) = 'array'
      then jsonb_array_length(cells) = board_size * board_size and octet_length(cells::text) <= 8000
      else false end
  )
);
create index if not exists intel606_cards_owner_idx on public.intel606_cards(owner_id, board_size, active);

create table if not exists public.intel606_rooms (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique check (char_length(room_code) = 6),
  host_id uuid not null references auth.users(id) on delete cascade,
  board_size integer not null check (board_size in (3,4)),
  phase text not null default 'lobby' check (phase in ('lobby','identity','dossier','discussion','undercover','answer','closed')),
  round_no integer not null default 1 check (round_no > 0),
  current_card_id uuid references public.intel606_cards(id) on delete set null,
  current_card_snapshot jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists intel606_rooms_host_idx on public.intel606_rooms(host_id, updated_at desc);

create table if not exists public.intel606_members (
  room_id uuid not null references public.intel606_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seat_no integer not null check (seat_no between 1 and 8),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 24),
  is_ready boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id),
  unique (room_id, seat_no)
);

create table if not exists intelligence_private.intel606_secrets (
  room_id uuid primary key references public.intel606_rooms(id) on delete cascade,
  undercover_seat integer not null check (undercover_seat between 1 and 8),
  code_map jsonb not null,
  secret_code text,
  dice_first integer,
  dice_second integer,
  rerolls integer not null default 0
);

-- 不允許前端直接對房間、成員或機密資料進行寫入。
revoke all on public.intel606_rooms, public.intel606_members, public.intel606_cards from public, anon, authenticated;
revoke all on intelligence_private.intel606_secrets from public, anon, authenticated;
-- 明確 GRANT：避免 2026/10/30 後新表無法使用 Data API。
grant select on public.intel606_rooms to authenticated;
grant select, insert, update, delete on public.intel606_cards to authenticated;

alter table public.intel606_rooms enable row level security;
alter table public.intel606_members enable row level security;
alter table public.intel606_cards enable row level security;
alter table intelligence_private.intel606_secrets enable row level security;

-- 情報卡只開放本人管理；其他人只能透過受檢查的 RPC 取得當輪公開題卡。
create policy intel606_card_select on public.intel606_cards for select to authenticated using (owner_id = (select auth.uid()));
create policy intel606_card_insert on public.intel606_cards for insert to authenticated with check (owner_id = (select auth.uid()));
create policy intel606_card_update on public.intel606_cards for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy intel606_card_delete on public.intel606_cards for delete to authenticated using (owner_id = (select auth.uid()));

-- 防止非房間成員透過 REST 或 Realtime 讀取房間列。
create or replace function public.intel606_can_read_room(p_room uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.intel606_rooms r where r.id = p_room and r.host_id = auth.uid())
      or exists (select 1 from public.intel606_members m where m.room_id = p_room and m.user_id = auth.uid());
$$;
revoke all on function public.intel606_can_read_room(uuid) from public, anon, authenticated;
grant execute on function public.intel606_can_read_room(uuid) to authenticated;
create policy intel606_room_select on public.intel606_rooms for select to authenticated
  using (public.intel606_can_read_room(id));

-- 使用核心 UUID 隨機來源，每次抽 0..n-1，丟棄不能公平整除的尾段值。
create or replace function intelligence_private.intel606_rand(p_n integer)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v integer; v_max integer;
begin
  if p_n < 1 or p_n > 32 then raise exception 'invalid random range'; end if;
  v_max := 256 - (256 % p_n);
  loop
    v := get_byte(decode(substr(replace(gen_random_uuid()::text, '-', ''), 1, 2), 'hex'), 0);
    if v < v_max then return v % p_n; end if;
  end loop;
end;
$$;
revoke all on function intelligence_private.intel606_rand(integer) from public, anon, authenticated;

-- 所有敏感欄位只會經過此函式，依照呼叫者與遊戲階段分流。
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
  v_rerolls integer := 0;
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
        if v_room.phase in ('dossier','discussion','undercover','answer') then v_code := v_secret.secret_code; end if;
      end if;
    end if;
    if v_room.phase in ('dossier','discussion','undercover','answer') then
      v_drawn_code := v_secret.secret_code;
      v_die1 := v_secret.dice_first;
      v_die2 := v_secret.dice_second;
      v_rerolls := v_secret.rerolls;
    end if;
    if v_room.phase in ('undercover','answer') then v_unmasked := v_secret.undercover_seat; end if;
    if v_room.phase = 'answer' then v_code := v_secret.secret_code; end if;
  end if;
  if v_room.phase in ('discussion','undercover','answer') then
    v_card := v_room.current_card_snapshot;
  end if;
  if v_room.phase = 'answer' and v_card is not null then
    select (t.ord - 1)::integer into v_position
      from jsonb_array_elements_text(v_secret.code_map) with ordinality as t(code,ord)
      where t.code = v_secret.secret_code limit 1;
    if v_position is not null then v_answer_word := v_card->'cells'->>v_position; end if;
  end if;
  return jsonb_build_object(
    'room_id', v_room.id, 'code', v_room.room_code, 'phase', v_room.phase,
    'round', v_room.round_no, 'size', v_room.board_size, 'version', v_room.version,
    'is_host', v_host, 'my_seat', v_member.seat_no, 'my_role', v_role,
    'members', v_people, 'code_map', v_map, 'secret_code', v_code,
    'undercover_seat', v_unmasked, 'card', v_card,
    'drawn_code', v_drawn_code, 'dice_first', v_die1, 'dice_second', v_die2, 'rerolls', v_rerolls,
    'answer_word', v_answer_word
  );
end;
$$;

create or replace function public.intel606_create_room(p_size integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room uuid; v_code text; v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v_i integer; v_tries integer;
begin
  if auth.uid() is null then raise exception '請先登入連線身分'; end if;
  if p_size not in (3,4) then raise exception '只支援 3×3 與 4×4'; end if;
  for v_tries in 1..10 loop
    v_code := '';
    for v_i in 1..6 loop
      v_code := v_code || substr(v_alphabet, intelligence_private.intel606_rand(length(v_alphabet)) + 1, 1);
    end loop;
    begin
      insert into public.intel606_rooms(room_code,host_id,board_size) values(v_code,auth.uid(),p_size) returning id into v_room;
      return public.intel606_room_state(v_room);
    exception when unique_violation then null;
    end;
  end loop;
  raise exception '無法分配房間代碼，請再試一次';
end;
$$;

create or replace function public.intel606_join_room(p_code text, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_room public.intel606_rooms%rowtype; v_number integer; v_used integer[];
begin
  if auth.uid() is null then raise exception '請先登入連線身分'; end if;
  if char_length(btrim(coalesce(p_name,''))) not between 1 and 24 then raise exception '暱稱需為 1～24 字'; end if;
  select * into v_room from public.intel606_rooms where room_code = upper(btrim(p_code)) for update;
  if not found then raise exception '查無此房間，請檢查代碼'; end if;
  if v_room.host_id = auth.uid() then raise exception '主控裝置不能以玩家身分加入自己的房間'; end if;
  if exists(select 1 from public.intel606_members where room_id=v_room.id and user_id=auth.uid()) then
    return public.intel606_room_state(v_room.id);
  end if;
  if v_room.phase <> 'lobby' then raise exception '遊戲已開始，暫時無法加入'; end if;
  select coalesce(array_agg(seat_no), '{}'::integer[]) into v_used from public.intel606_members where room_id=v_room.id;
  select g.seat into v_number from generate_series(1,8) as g(seat)
    where not (g.seat = any(v_used)) order by g.seat limit 1;
  if v_number is null then raise exception '房間已滿（最多 8 位）'; end if;
  insert into public.intel606_members(room_id,user_id,seat_no,display_name)
    values(v_room.id,auth.uid(),v_number,btrim(p_name));
  update public.intel606_rooms set version=version+1,updated_at=now() where id=v_room.id;
  return public.intel606_room_state(v_room.id);
end;
$$;

create or replace function public.intel606_ready(p_room uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_phase text;
begin
  if auth.uid() is null then raise exception '請先登入連線身分'; end if;
  select phase into v_phase from public.intel606_rooms where id=p_room for update;
  if not found or v_phase <> 'identity' then raise exception '目前不能確認身分'; end if;
  update public.intel606_members set is_ready=true where room_id=p_room and user_id=auth.uid();
  if not found then raise exception '只有本房間玩家可確認'; end if;
  update public.intel606_rooms set version=version+1, updated_at=now() where id=p_room;
  return public.intel606_room_state(p_room);
end;
$$;

-- 主控端唯一可以推進的階段。所有抽籤結果都在資料庫建立，不信任前端傳入答案。
create or replace function public.intel606_host_action(p_room uuid, p_action text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_room public.intel606_rooms%rowtype;
  v_total integer; v_ready integer;
  v_codes text[] := '{}'::text[]; v_temp text; v_j integer; v_i integer;
  v_spy integer; v_first integer; v_second integer; v_rerolls integer := 0;
  v_secret text; v_card uuid; v_snapshot jsonb;
begin
  if auth.uid() is null then raise exception '請先登入連線身分'; end if;
  select * into v_room from public.intel606_rooms where id=p_room for update;
  if not found or v_room.host_id <> auth.uid() then raise exception '只有主控端可以執行此操作'; end if;
  select count(*),count(*) filter (where is_ready) into v_total,v_ready from public.intel606_members where room_id=p_room;
  if p_action = 'start' and v_room.phase = 'lobby' then
    if v_total < 3 or v_total > 8 then raise exception '需有 3～8 位玩家才能開始'; end if;
    delete from intelligence_private.intel606_secrets where room_id=p_room;
    for v_i in 0..(v_room.board_size*v_room.board_size-1) loop
      v_codes := array_append(v_codes, substr('ABCD', (v_i % v_room.board_size)+1, 1) || ((v_i/v_room.board_size)+1)::text);
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
    update public.intel606_rooms set phase='identity',current_card_id=null,current_card_snapshot=null where id=p_room;
  elsif p_action = 'roll' and v_room.phase = 'identity' then
    if v_ready <> v_total then raise exception '請等所有玩家確認身分卡後再擲骰'; end if;
    if v_room.board_size = 3 then
      v_first := intelligence_private.intel606_rand(6) + 1;
      v_second := intelligence_private.intel606_rand(3) + 1;
    else
      v_first := intelligence_private.intel606_rand(8) + 1;
      loop
        v_second := intelligence_private.intel606_rand(6) + 1;
        exit when v_second <= 4;
        v_rerolls := v_rerolls + 1;
      end loop;
    end if;
    v_secret := substr('ABCD', ((v_first - 1) % v_room.board_size)+1, 1) || v_second::text;
    update intelligence_private.intel606_secrets
       set secret_code=v_secret,dice_first=v_first,dice_second=v_second,rerolls=v_rerolls
      where room_id=p_room;
    update public.intel606_rooms set phase='dossier' where id=p_room;
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
    update public.intel606_rooms set phase='lobby',round_no=round_no+1,current_card_id=null,current_card_snapshot=null where id=p_room;
  elsif p_action = 'close' and v_room.phase <> 'closed' then
    update public.intel606_rooms set phase='closed' where id=p_room;
  else
    raise exception '目前階段不允許執行這個操作';
  end if;
  update public.intel606_rooms set version=version+1,updated_at=now() where id=p_room;
  return public.intel606_room_state(p_room);
end;
$$;

-- RPC 函式除了 authenticated 外都不可呼叫（明確 GRANT）。
revoke all on function public.intel606_room_state(uuid) from public, anon, authenticated;
revoke all on function public.intel606_create_room(integer) from public, anon, authenticated;
revoke all on function public.intel606_join_room(text,text) from public, anon, authenticated;
revoke all on function public.intel606_ready(uuid) from public, anon, authenticated;
revoke all on function public.intel606_host_action(uuid,text) from public, anon, authenticated;
grant execute on function public.intel606_room_state(uuid) to authenticated;
grant execute on function public.intel606_create_room(integer) to authenticated;
grant execute on function public.intel606_join_room(text,text) to authenticated;
grant execute on function public.intel606_ready(uuid) to authenticated;
grant execute on function public.intel606_host_action(uuid,text) to authenticated;

-- 僅公開「房間進度」變動，絕不把私密身分／秘密代碼放進 Realtime publication。
do $$
begin
  if exists(select 1 from pg_publication where pubname = 'supabase_realtime') and
     not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='intel606_rooms') then
    alter publication supabase_realtime add table public.intel606_rooms;
  end if;
end $$;

commit;
