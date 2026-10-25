-- 606 情報局 v2.5.6 → v2.5.7 補丁。可以重複執行。
-- 不清空情報卡、房間或玩家；保留既有 RLS / GRANT。
-- 修正 4×4 共 48 個代碼位置打亂時，rand(48) 原先被錯誤限制為最大 32。
begin;
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
