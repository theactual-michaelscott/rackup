-- Rack Up: Following-list push notifications.
-- Adds push token storage, a notification audit/dedupe log, a mute
-- preference, and a database webhook that fires the notify-followers Edge
-- Function whenever someone a player follows checks in.

alter table public.profiles
  add column if not exists notify_on_followed_checkin boolean not null default true;

-- A followed player can see who follows them (remove a follower / block).
-- Additive select policy alongside "users read their own follows".
drop policy if exists "followed players read their followers" on public.follows;
create policy "followed players read their followers"
on public.follows for select
using (auth.uid() = followed_id);

-- ----------------------------------------------------------------------------
-- push_tokens — one row per registered device (Expo push token)
-- ----------------------------------------------------------------------------
create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  expo_push_token text not null unique,
  platform text not null check (platform in ('ios', 'android')),
  device_id text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists push_tokens_user_id_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

drop policy if exists "push_tokens owner read" on public.push_tokens;
create policy "push_tokens owner read"
on public.push_tokens for select
using (auth.uid() = user_id);

drop policy if exists "push_tokens owner insert" on public.push_tokens;
create policy "push_tokens owner insert"
on public.push_tokens for insert
with check (auth.uid() = user_id);

drop policy if exists "push_tokens owner update" on public.push_tokens;
create policy "push_tokens owner update"
on public.push_tokens for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "push_tokens owner delete" on public.push_tokens;
create policy "push_tokens owner delete"
on public.push_tokens for delete
using (auth.uid() = user_id);

-- Client calls this on login / token refresh with the Expo push token.
create or replace function public.upsert_push_token(
  p_expo_push_token text,
  p_platform text,
  p_device_id text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.push_tokens (user_id, expo_push_token, platform, device_id, last_seen_at)
  values (auth.uid(), p_expo_push_token, p_platform, p_device_id, now())
  on conflict (expo_push_token)
  do update set
    user_id = excluded.user_id,
    platform = excluded.platform,
    device_id = excluded.device_id,
    last_seen_at = now();
end;
$$;

-- ----------------------------------------------------------------------------
-- checkin_notifications — audit + dedupe log (at most one alert per
-- follower per check-in, even across webhook/network retries)
-- ----------------------------------------------------------------------------
create table if not exists public.checkin_notifications (
  id uuid primary key default gen_random_uuid(),
  check_in_id uuid not null references public.check_ins(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  push_token text,
  status text not null check (status in ('sent', 'failed', 'skipped_no_token', 'skipped_muted')),
  expo_ticket_id text,
  error text,
  created_at timestamptz not null default now(),
  unique (check_in_id, recipient_id)
);

create index if not exists checkin_notifications_recipient_idx on public.checkin_notifications (recipient_id);

alter table public.checkin_notifications enable row level security;

drop policy if exists "checkin_notifications recipient read" on public.checkin_notifications;
create policy "checkin_notifications recipient read"
on public.checkin_notifications for select
using (auth.uid() = recipient_id);

-- ----------------------------------------------------------------------------
-- Database webhook: new active check-in -> notify-followers Edge Function
-- ----------------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;

-- One-time secret setup (run manually with real values, not part of this
-- migration since secrets should never live in a file committed to git):
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/notify-followers', 'notify_followers_url');
--   select vault.create_secret('<anon_or_publishable_key>', 'notify_followers_auth_key');

create or replace function public.handle_new_checkin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  function_url text;
  auth_key text;
begin
  if new.status is distinct from 'active' then
    return new;
  end if;

  select decrypted_secret into function_url
    from vault.decrypted_secrets where name = 'notify_followers_url';

  select decrypted_secret into auth_key
    from vault.decrypted_secrets where name = 'notify_followers_auth_key';

  if function_url is null or auth_key is null then
    raise warning 'notify_followers_url / notify_followers_auth_key not set in Vault; skipping push webhook';
    return new;
  end if;

  perform net.http_post(
    url := function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || auth_key
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'check_ins',
      'record', jsonb_build_object(
        'id', new.id,
        'user_id', new.user_id,
        'venue_id', new.venue_id,
        'game_type', new.game_type,
        'rules_type', new.rules_type,
        'created_at', new.created_at,
        'expires_at', new.expires_at
      )
    ),
    timeout_milliseconds := 5000
  );

  return new;
end;
$$;

drop trigger if exists on_check_in_created on public.check_ins;

create trigger on_check_in_created
after insert on public.check_ins
for each row
execute function public.handle_new_checkin();

-- This function must only ever run in trigger context, never as a directly
-- callable RPC via PostgREST.
revoke execute on function public.handle_new_checkin() from public, anon, authenticated;
