# Rack Up — Following List & Push Notification Backend

This is the complete Supabase backend for the "notify a follower when someone
they follow checks in" loop: schema + Row Level Security for relationships
and check-ins, a database webhook that fires on new check-ins, and an Edge
Function that fans out push notifications on **two channels**:

- **Web Push** — the browser Push API, for the existing Next.js web app
  (`app/page.jsx`, `app/lib/push.js`, `public/sw.js`). This is live today.
- **Expo push** — for a future native iOS/Android app. The backend and
  schema support it now; no Expo app exists yet (see
  `docs/expo-push-client-example.ts` for a reference implementation to start
  from when one is built).

A follower can have devices on either channel, both, or neither — the
backend fans out to whatever is registered and logs each channel separately.

It was designed against, and cross-checked with, the live **Rack Up Staging**
Supabase project — `profiles`, `venues`, `follows`, and `check_ins` already
exist there with matching shapes and RLS, so the first migration is a no-op
there and only documents the baseline. `push_tokens`, `web_push_subscriptions`,
`checkin_notifications`, and the webhook trigger are genuinely new.

## Files

```
supabase/
  migrations/
    0001_follow_checkin_schema.sql        -- profiles, venues, follows, check_ins (+RLS)
    0002_push_tokens_and_notification_log.sql -- push_tokens, checkin_notifications (+RLS)
    0003_checkin_webhook_trigger.sql      -- pg_net + trigger -> Edge Function
    20260824b_web_push_support.sql        -- web_push_subscriptions (+RLS), channel column
  functions/
    notify-followers/index.ts             -- follower lookup + Expo + Web Push dispatch
app/
  lib/push.js                             -- browser subscribe/unsubscribe helper
public/
  sw.js                                   -- service worker (push + notificationclick)
docs/
  expo-push-client-example.ts             -- reference only; future native app
```

## Data model

| Table | Purpose | Key constraints |
|---|---|---|
| `profiles` | Player identity + notification prefs | `notify_on_followed_checkin boolean default true` |
| `venues` | Where players check in | public read |
| `follows` | Who follows whom | `primary key (follower_id, followed_id)`, `check (follower_id <> followed_id)` |
| `check_ins` | Active/past table sessions | `status in ('active','ended')`, `expires_at` |
| `push_tokens` | One row per registered Expo device (future native app) | `expo_push_token` unique, cascade-deletes with the profile |
| `web_push_subscriptions` | One row per browser subscription (current web app) | `endpoint` unique, cascade-deletes with the profile |
| `checkin_notifications` | Audit + dedupe log, per channel | `unique (check_in_id, recipient_id, channel)`, `channel in ('expo','web')` |

### Row Level Security summary

- `follows`: a user can read/insert/delete only their own outgoing edges
  (`auth.uid() = follower_id`), plus a separate read policy so a followed
  player can see who follows them (for removing followers/blocking).
- `check_ins`: active, unexpired check-ins are readable by any signed-in
  user (venue/player discovery); a user can always read, insert, and update
  only their own row.
- `push_tokens` and `web_push_subscriptions`: fully owner-scoped (select/
  insert/update/delete all require `auth.uid() = user_id`). The Edge
  Function reads both tables with the `service_role` key, which bypasses
  RLS, so no extra "service" policy exists on either.
- `checkin_notifications`: recipients can read their own notification
  history; all writes come only from the Edge Function's service-role
  client — no client-facing insert/update policy exists on purpose.

## Notification flow

1. Client inserts a row into `check_ins` (a player checks in).
2. The `on_check_in_created` trigger fires **after insert**, and — only for
   `status = 'active'` rows — makes an async `net.http_post` call to the
   `notify-followers` Edge Function with a minimal payload (check-in id,
   user id, venue id, game type). `pg_net` makes this non-blocking, so a slow
   or failing notification path never delays the check-in write itself
   ([Supabase Database Webhooks docs](https://supabase.com/docs/guides/database/webhooks)).
3. The Edge Function, running with the `service_role` key:
   - Loads the checked-in player's name and the venue's name.
   - Queries `follows` for everyone following that player, excluding anyone
     who set `notify_on_followed_checkin = false`.
   - Skips any (follower, channel) pair already logged in
     `checkin_notifications` for this `check_in_id` (dedupes retries,
     per channel).
   - Loads `push_tokens` (Expo) and `web_push_subscriptions` (browser) for
     the remaining followers in parallel — a follower can have several
     devices on either or both channels; each gets its own message.
   - **Expo channel:** sends messages to Expo's push API in batches of 100,
     the documented hard limit per request
     ([Expo push notification docs](https://docs.expo.dev/push-notifications/sending-notifications/)).
   - **Web Push channel:** sends one HTTPS request per subscription via
     `npm:web-push`, signed with the project's VAPID key pair
     ([Web Push protocol / RFC 8291](https://datatracker.ietf.org/doc/html/rfc8291),
     [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)).
   - Writes one `checkin_notifications` row per (check-in, follower, channel)
     with `sent` / `failed` / `skipped_no_token`; deletes any Expo token
     reported back as `DeviceNotRegistered`, and any Web Push subscription
     that returns HTTP 404/410 (browser unsubscribed or expired).
4. The follower receives the notification and can deep-link into the
   check-in via the `data.checkInId` / `data.venueId` payload — a service
   worker `notificationclick` handler for Web Push, or the OS notification
   tray for Expo.

## Why a webhook + Edge Function instead of client-side sends

Doing this server-side means the follower graph is never exposed to the
client, one check-in cannot produce more than one push per follower, and a
modified client build can't be used to spam or spoof notifications — all of
which a client-triggered "send push to my followers" call would risk.

## Secrets and deployment

The Edge Function always gets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
automatically from Supabase. Beyond that:

- **Web Push (required to actually send on that channel):** generate a
  VAPID key pair once with `npx web-push generate-vapid-keys` and set it as
  Edge Function secrets — these are read by `notify-followers` via
  `Deno.env.get(...)`, not stored in the database or Vault:

  ```
  supabase secrets set VAPID_PUBLIC_KEY=xxxxx
  supabase secrets set VAPID_PRIVATE_KEY=xxxxx
  supabase secrets set VAPID_SUBJECT=mailto:you@example.com
  ```

  The matching public key also needs to reach the browser, as
  `NEXT_PUBLIC_VAPID_PUBLIC_KEY` in the Next.js app's environment (see
  `.env.example`) — `app/lib/push.js` passes it to
  `pushManager.subscribe({ applicationServerKey: ... })`. Until these three
  secrets are set, the function silently skips the Web Push channel (logs a
  warning) rather than failing the whole run.

- **Expo (optional):** set `EXPO_ACCESS_TOKEN` only if Expo push security is
  enabled for the project:

  ```
  supabase secrets set EXPO_ACCESS_TOKEN=xxxxx
  ```

> No Supabase CLI session is available in this environment, so the three
> `VAPID_*` secrets above have been generated but **not yet set** — run the
> three `supabase secrets set` commands from a machine with
> `supabase login` completed before Web Push will actually deliver.

The trigger itself calls the Edge Function over HTTPS and needs a bearer
token to satisfy Supabase's default JWT check on Edge Functions. The
project's **anon/publishable key** (public by design — safe to store as-is)
is enough for that; the function switches to the service-role key internally
for all data access. Store the function URL and that key in Vault once,
after deploying:

```sql
select vault.create_secret(
  'https://<project-ref>.supabase.co/functions/v1/notify-followers',
  'notify_followers_url'
);
select vault.create_secret('<anon_or_publishable_key>', 'notify_followers_auth_key');
```

## Client-side pieces

### Web (implemented, in this repo)

- `public/sw.js` — service worker; handles the `push` event (shows the
  notification) and `notificationclick` (focuses or opens the app).
- `app/lib/push.js` — `subscribeToPush(db)` requests Notification
  permission, registers the service worker, calls
  `pushManager.subscribe({ applicationServerKey: <VAPID public key> })`, and
  persists the subscription via `db.rpc('upsert_web_push_subscription', ...)`.
- `app/page.jsx` wires an "Enable browser alerts" button to
  `subscribeToPush` and a checkbox to `profiles.notify_on_followed_checkin`.

### Native / Expo (not implemented — reference only)

No Expo or React Native app exists yet. When one is built:

- On login / token refresh, call `select upsert_push_token($1, $2, $3)`
  (defined in `0002_push_tokens_and_notification_log.sql`) with the Expo push
  token, platform, and device id obtained from
  `expo-notifications` / `Notifications.getExpoPushTokenAsync()`.
- Create an Android notification channel named `checkin-alerts` client-side
  (`Notifications.setNotificationChannelAsync`) to match the `channelId` set
  in the Edge Function's Expo messages.
- `docs/expo-push-client-example.ts` in this repo shows the full
  registration flow end-to-end — copy it into the real app once one exists;
  it is not imported or built by anything today.
