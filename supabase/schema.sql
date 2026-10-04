-- 時間割アプリ（Campus Schedule）のクラウド保存用テーブル。
-- Supabase の SQL Editor に貼って、そのまま実行する（何度実行しても壊れない）。
--
-- 利用者ごとに 1 行。時間割・成績・試験・設定が data（jsonb）に丸ごと入る。
-- 行レベルセキュリティで「自分の行だけ」読み書きできる。他人の行は存在しないのと同じになる。

create table if not exists public.campus_schedules (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb        not null,
  rev        bigint       not null default 0,     -- 楽観ロック用の版番号
  updated_at timestamptz  not null default now(),
  device     text
);

alter table public.campus_schedules enable row level security;

drop policy if exists "read own schedule"   on public.campus_schedules;
drop policy if exists "insert own schedule" on public.campus_schedules;
drop policy if exists "update own schedule" on public.campus_schedules;
drop policy if exists "delete own schedule" on public.campus_schedules;

create policy "read own schedule"   on public.campus_schedules for select using (auth.uid() = user_id);
create policy "insert own schedule" on public.campus_schedules for insert with check (auth.uid() = user_id);
create policy "update own schedule" on public.campus_schedules for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own schedule" on public.campus_schedules for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.campus_schedules to authenticated;
revoke all on public.campus_schedules from anon;

-- 利用者が自分のアカウントを自分で削除するための関数（アプリの「アカウントを削除」）。
-- auth.users の行を消すと、上のテーブルの行も on delete cascade で一緒に消える。
create or replace function public.delete_my_account()
returns void
language sql
security definer
set search_path = public, auth
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
