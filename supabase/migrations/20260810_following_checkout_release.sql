-- Rack Up: Following, check-out, rules, and automatic availability expiration.

alter table public.check_ins
  add column if not exists rules_type text,
  add column if not exists expires_at timestamptz;

update public.check_ins
set rules_type = 'APA'
where rules_type is null;

alter table public.check_ins
  alter column rules_type set default 'APA',
  alter column rules_type set not null;

alter table public.check_ins
  drop constraint if exists check_ins_rules_type_check;

alter table public.check_ins
  add constraint check_ins_rules_type_check
  check (rules_type in ('APA', 'BCA', 'Bar room rules'));

update public.check_ins
set expires_at = created_at + interval '2 hours'
where status = 'active' and expires_at is null;

create index if not exists check_ins_active_expires_idx
  on public.check_ins (status, expires_at);

create index if not exists check_ins_venue_active_idx
  on public.check_ins (venue_id, status);

create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  followed_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followed_id),
  constraint follows_no_self_follow check (follower_id <> followed_id)
);

create index if not exists follows_follower_idx on public.follows (follower_id, created_at desc);

alter table public.follows enable row level security;

drop policy if exists "users read their own follows" on public.follows;
create policy "users read their own follows"
on public.follows for select
using (auth.uid() = follower_id);

drop policy if exists "users create their own follows" on public.follows;
create policy "users create their own follows"
on public.follows for insert
with check (auth.uid() = follower_id and follower_id <> followed_id);

drop policy if exists "users delete their own follows" on public.follows;
create policy "users delete their own follows"
on public.follows for delete
using (auth.uid() = follower_id);