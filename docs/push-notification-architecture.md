# Rack Up — Following List & Push Notification Backend

This is the complete Supabase backend for the "notify a follower when someone
they follow checks in" loop: schema + Row Level Security for relationships
and check-ins, a database webhook that fires on new check-ins, and an Edge
Function that fans out Expo push notifications to iOS and Android devices.

It was designed against, and cross-checked with, the live **Rack Up Staging**
Supabase project — `profiles`, `venues`, `follows`, and `check_ins` already
exist there with matching shapes and RLS, so the first migration is a no-op
there and only documents the baseline. `push_tokens`, `checkin_notifications`,
and the webhook trigger are genuinely new.

## Files

```
supabase/
  migrations/
    0001_follow_checkin_schema.sql        -- profiles, venues, follows, check_ins (+RLS)
    0002_push_tokens_and_notification_log.sql -- push_tokens, checkin_notifications (+RLS)
    0003_checkin_webhook_trigger.sql      -- pg_net + trigger -> Edge Function
  functions/
    notify-followers/index.ts             -- follower lookup + Expo push dispatch
```

## Data model

| Table | Purpose | Key constraints |
|---|---|---|
| `profiles` | Player identity + notification prefs | `notify_on_followed_checkin boolean default true` |
| `venues` | Where players check in | public read |
| `follows` | Who follows whom | `primary key (follower_id, followed_id)`, `check (follower_id <> followed_id)` |
| `check_ins` | Active/past table sessions | `status in ('active','ended')`, `expires_at` |
| `push_tokens` | One row per registered device | `expo_push_token` unique, cascade-deletes with the profile |
| `checkin_notifications` | Audit + dedupe log | `unique (check_in_id, recipient_id)` |

### Row Level Security summary

- `follows`: a user can read/insert/delete only their own outgoing edges
  (`auth.uid() = follower_id`), plus a separate read policy so a followed
  player can see who follows them (for removing followers/blocking).
- `check_ins`: active, unexpired check-ins are readable by any signed-in
  user (venue/player discovery); a user can always read, insert, and update
  only their own row.
- `push_tokens`: fully owner-scoped (select/insert/update/delete all require
  `auth.uid() = user_id`). The Edge Function reads this table with the
  `service_role` key, which bypasses RLS, so no extra "service" policy exists.
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
   - Skips anyone already logged in `checkin_notifications` for this
     `check_in_id` (dedupes retries).
   - Loads `push_tokens` for the remaining followers (a follower can have
     several devices, e.g. a phone and a tablet — each gets its own message).
   - Sends the messages to Expo's push API in batches of 100, the documented
     hard limit per request
     ([Expo push notification docs](https://docs.expo.dev/push-notifications/sending-notifications/)).
   - Writes one `checkin_notifications` row per (check-in, follower) with
     `sent` / `failed` / `skipped_no_token`, and deletes any token Expo
     reports back as `DeviceNotRegistered`.
4. The follower's device receives the push and can deep-link into the
   check-in via the `data.checkInId` / `data.venueId` payload.

## Why a webhook + Edge Function instead of client-side sends

Doing this server-side means the follower graph is never exposed to the
client, one check-in cannot produce more than one push per follower, and a
modified client build can't be used to spam or spoof notifications — all of
which a client-triggered "send push to my followers" call would risk.

## Secrets and deployment

The Edge Function needs no manual secrets beyond what Supabase injects
automatically (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). Optionally set
`EXPO_ACCESS_TOKEN` if Expo push security is enabled for the project:

```
supabase secrets set EXPO_ACCESS_TOKEN=xxxxx
```

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

## Client-side pieces this backend expects (not included here)

- On login / token refresh, the app calls `select upsert_push_token($1, $2, $3)`
  (defined in `0002_push_tokens_and_notification_log.sql`) with the Expo push
  token, platform, and device id obtained from
  `expo-notifications` / `Notifications.getExpoPushTokenAsync()`.
- An Android notification channel named `checkin-alerts` should be created
  client-side (`Notifications.setNotificationChannelAsync`) to match the
  `channelId` set in the Edge Function's messages.
- A settings toggle bound to `profiles.notify_on_followed_checkin`.
