-- 管理者ページ（admin.html）用の関数。Supabase の SQL Editor に貼って実行する（何度実行しても壊れない）。
-- 先に schema.sql を実行しておくこと。
--
-- 守り方：管理者ページ自体は誰でも開けるが、データは下の関数からしか出ない。
-- どの関数も、呼び出した人が app_admins に載っていなければ 'forbidden' で失敗する。
-- 管理者でも見えるのは、メール・登録日・最終更新・授業数・容量まで。時間割の中身（授業名・成績・メモ）は返さない。

create table if not exists public.app_admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;     -- ポリシーを作らない＝アプリからは誰も直接読み書きできない
revoke all on public.app_admins from anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid());
$$;

create or replace function public.admin_overview()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'users_total',   (select count(*) from auth.users),
    'rows_total',    (select count(*) from public.campus_schedules),
    'active_7d',     (select count(*) from public.campus_schedules where updated_at > now() - interval '7 days'),
    'signups_7d',    (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'data_bytes',    (select coalesce(sum(pg_column_size(data)), 0) from public.campus_schedules),
    'db_bytes',      pg_database_size(current_database()),
    'last_activity', (select greatest(max(updated_at), (select max(last_sign_in_at) from auth.users)) from public.campus_schedules),
    'signups_daily', (select coalesce(jsonb_agg(jsonb_build_object('d', d::date, 'n', (select count(*) from auth.users u where u.created_at::date = d::date)) order by d), '[]'::jsonb)
                      from generate_series(current_date - 13, current_date, interval '1 day') d),
    'active_daily',  (select coalesce(jsonb_agg(jsonb_build_object('d', d::date, 'n', (select count(*) from public.campus_schedules s where s.updated_at::date = d::date)) order by d), '[]'::jsonb)
                      from generate_series(current_date - 13, current_date, interval '1 day') d)
  ) into result;
  return result;
end;
$$;

create or replace function public.admin_users()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', u.id,
      'email', u.email,
      'created_at', u.created_at,
      'last_sign_in_at', u.last_sign_in_at,
      'updated_at', s.updated_at,
      'rev', s.rev,
      'courses', case when jsonb_typeof(s.data->'courses') = 'array' then jsonb_array_length(s.data->'courses') else 0 end,
      'bytes', pg_column_size(s.data),
      'device', s.device,
      'is_admin', exists (select 1 from public.app_admins a where a.user_id = u.id)
    ) order by u.created_at desc), '[]'::jsonb)
  into result
  from auth.users u
  left join public.campus_schedules s on s.user_id = u.id;
  return result;
end;
$$;

create or replace function public.admin_delete_user(target uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if exists (select 1 from public.app_admins where user_id = target) then
    raise exception 'cannot delete an admin' using errcode = '42501';
  end if;
  delete from auth.users where id = target;   -- campus_schedules の行も on delete cascade で消える
end;
$$;

revoke all on function public.is_admin(), public.admin_overview(), public.admin_users(), public.admin_delete_user(uuid) from public, anon;
grant execute on function public.is_admin(), public.admin_overview(), public.admin_users(), public.admin_delete_user(uuid) to authenticated;

-- 管理者の登録。自分のメールアドレスに書き換えて実行する（ここだけは自分で書き換える）。
-- insert into public.app_admins (user_id) select id from auth.users where email = 'あなたのメールアドレス' on conflict do nothing;
