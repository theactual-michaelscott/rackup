-- Rack Up: Web Push support alongside Expo (native) push.
--
-- The existing push_tokens table stores Expo push tokens for a future
-- native iOS/Android app (built with Expo). This migration adds a parallel
-- path for the existing Next.js web app using the standard Web Push API
-- (Push API + Service Worker + VAPID), so browser/PWA users can get the
-- same "someone you follow just checked in" alerts today, without waiting
-- on a native app.

-- ----------------------------------------------------------------------------
-- web_push_subscriptions — one row per browser subscription
-- ----------------------------------------------------------------------------
create table if not exists public.web_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists web_push_subscriptions_user_id_idx on public.web_push_subscriptions (user_id);

alter table public.web_push_subscriptions enable row level security;

drop policy if exists "web_push_subscriptions owner read" on public.web_push_subscriptions;
create policy "web_push_subscriptions owner read"
on public.web_push_subscriptions for select
using (auth.uid() = user_id);

drop policy if exists "web_push_subscriptions owner insert" on public.web_push_subscriptions;
create policy "web_push_subscriptions owner insert"
on public.web_push_subscriptions for insert
with check (auth.uid() = user_id);

drop policy if exists "web_push_subscriptions owner update" on public.web_push_subscriptions;
create policy "web_push_subscriptions owner update"
on public.web_push_subscriptions for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "web_push_subscriptions owner delete" on public.web_push_subscriptions;
create policy "web_push_subscriptions owner delete"
on public.web_push_subscriptions for delete
using (auth.uid() = user_id);

-- Client calls this after `pushManager.subscribe(...)` succeeds.
create or replace function public.upsert_web_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.web_push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, last_seen_at)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, p_user_agent, now())
  on conflict (endpoint)
  do update set
    user_id = excluded.user_id,
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    user_agent = excluded.user_agent,
    last_seen_at = now();
end;
$$;

-- ----------------------------------------------------------------------------
-- checkin_notifications needs a channel column: a follower can now be
-- notified via Expo *and* Web Push independently, so the old
-- unique(check_in_id, recipient_id) would block logging the second channel.
-- ----------------------------------------------------------------------------
alter table public.checkin_notifications
  add column if not exists channel text not null default 'expo' check (channel in ('expo', 'web'));

alter table public.checkin_notifications
  drop constraint if exists checkin_notifications_check_in_id_recipient_id_key;

alter table public.checkin_notifications
  drop constraint if exists checkin_notifications_check_in_id_recipient_id_channel_key;

alter table public.checkin_notifications
  add constraint checkin_notifications_check_in_id_recipient_id_channel_key
  unique (check_in_id, recipient_id, channel);

-- ----------------------------------------------------------------------------
-- VAPID keys for Web Push live as Edge Function secrets (not Vault, since
-- they're only ever read inside notify-followers, not from SQL):
--   supabase secrets set VAPID_PUBLIC_KEY=<public_key>
--   supabase secrets set VAPID_PRIVATE_KEY=<private_key>
--   supabase secrets set VAPID_SUBJECT=mailto:you@example.com
-- The public key must also be exposed to the browser client as
-- NEXT_PUBLIC_VAPID_PUBLIC_KEY so it can call pushManager.subscribe(...).
-- ----------------------------------------------------------------------------
