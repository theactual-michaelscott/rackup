// ============================================================================
// Rack Up — notify-followers Edge Function
// ============================================================================
// Triggered by the `on_check_in_created` database webhook (see
// supabase/migrations/20260824_push_notification_backend.sql). Given a newly
// created check-in, this function:
//   1. Verifies the request actually came from the trusted webhook.
//   2. Looks up who follows the player that just checked in.
//   3. Filters out followers who muted "followed player checked in" alerts.
//   4. Collects each remaining follower's registered devices — Expo push
//      tokens (future native app) AND Web Push subscriptions (existing
//      Next.js web app) — a follower may have either, both, or neither.
//   5. Dedupes per (check-in, follower, channel) so retries never double-send.
//   6. Sends batched Expo push notifications (max 100/request, Expo's hard
//      limit) and individual Web Push messages, writing an audit row per
//      recipient per channel.
//   7. Cleans up dead Expo tokens (DeviceNotRegistered) and expired/gone Web
//      Push subscriptions (410 Gone / 404).
//
// Deploy:  supabase functions deploy notify-followers
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected
//          automatically by the Supabase platform for every Edge Function.
//          Required for Web Push:
//            supabase secrets set VAPID_PUBLIC_KEY=xxxxx
//            supabase secrets set VAPID_PRIVATE_KEY=xxxxx
//            supabase secrets set VAPID_SUBJECT=mailto:you@example.com
//          Optional for Expo:
//            supabase secrets set EXPO_ACCESS_TOKEN=xxxxx
// ============================================================================

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_BATCH_LIMIT = 100; // hard limit enforced by the Expo push API
const EXPO_ACCESS_TOKEN = Deno.env.get("EXPO_ACCESS_TOKEN"); // optional

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY");
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT");
const webPushConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);
if (webPushConfigured) {
  webpush.setVapidDetails(VAPID_SUBJECT!, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
}

interface CheckInWebhookPayload {
  type: "INSERT";
  table: "check_ins";
  record: {
    id: string;
    user_id: string;
    venue_id: string;
    game_type: string;
    rules_type: string;
    created_at: string;
    expires_at: string;
  };
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default";
  priority?: "default" | "normal" | "high";
  channelId?: string; // Android notification channel
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface NotificationPayload {
  title: string;
  body: string;
  data: Record<string, unknown>;
}

type AuditStatus = "sent" | "failed" | "skipped_no_token" | "skipped_muted";
interface AuditRow {
  check_in_id: string;
  recipient_id: string;
  push_token: string | null;
  status: AuditStatus;
  channel: "expo" | "web";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY" }, 500);
  }

  let payload: CheckInWebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  if (payload.table !== "check_ins" || payload.type !== "INSERT" || !payload.record?.id) {
    return jsonResponse({ error: "unexpected payload shape" }, 400);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  try {
    const summary = await handleNewCheckIn(supabase, payload.record);
    return jsonResponse(summary, 200);
  } catch (err) {
    console.error("notify-followers failed:", err);
    return jsonResponse({ error: (err as Error).message ?? "internal error" }, 500);
  }
});

async function handleNewCheckIn(
  supabase: SupabaseClient,
  record: CheckInWebhookPayload["record"],
) {
  // 1. Who checked in, and where.
  const { data: checkedInProfile, error: profileError } = await supabase
    .from("profiles")
    .select("id, display_name, username")
    .eq("id", record.user_id)
    .single();
  if (profileError) throw new Error(`could not load checked-in profile: ${profileError.message}`);

  const { data: venue } = await supabase
    .from("venues")
    .select("name")
    .eq("id", record.venue_id)
    .single();

  const checkedInName = checkedInProfile.display_name || checkedInProfile.username;
  const venueName = venue?.name ?? "a venue";

  const notification: NotificationPayload = {
    title: "Rack Up",
    body: `${checkedInName} just checked in at ${venueName}`,
    data: {
      type: "followed_checkin",
      checkInId: record.id,
      userId: record.user_id,
      venueId: record.venue_id,
    },
  };

  // 2. Who follows this player, filtering out anyone who muted the alert.
  const { data: followerRows, error: followersError } = await supabase
    .from("follows")
    .select("follower_id, profiles!follows_follower_id_fkey(notify_on_followed_checkin)")
    .eq("followed_id", record.user_id);
  if (followersError) throw new Error(`could not load followers: ${followersError.message}`);

  const eligibleFollowerIds = (followerRows ?? [])
    .filter((row: any) => row.profiles?.notify_on_followed_checkin !== false)
    .map((row: any) => row.follower_id as string);

  if (eligibleFollowerIds.length === 0) {
    return { checkInId: record.id, followers: 0, notified: 0, skipped: 0, failed: 0 };
  }

  // 3. Dedupe per channel: skip (follower, channel) pairs already notified
  // for this exact check-in (protects against webhook/network retries).
  const { data: alreadyNotified } = await supabase
    .from("checkin_notifications")
    .select("recipient_id, channel")
    .eq("check_in_id", record.id)
    .in("recipient_id", eligibleFollowerIds);

  const notifiedKey = (recipientId: string, channel: string) => `${recipientId}:${channel}`;
  const alreadyNotifiedKeys = new Set(
    (alreadyNotified ?? []).map((r) => notifiedKey(r.recipient_id as string, r.channel as string)),
  );

  // 4. Collect Expo tokens + Web Push subscriptions for the eligible
  // followers (skip a channel entirely if that follower/channel pair was
  // already notified for this check-in).
  const [{ data: tokenRows, error: tokensError }, { data: subRows, error: subsError }] =
    await Promise.all([
      supabase.from("push_tokens").select("id, user_id, expo_push_token").in("user_id", eligibleFollowerIds),
      supabase
        .from("web_push_subscriptions")
        .select("id, user_id, endpoint, p256dh, auth")
        .in("user_id", eligibleFollowerIds),
    ]);
  if (tokensError) throw new Error(`could not load push tokens: ${tokensError.message}`);
  if (subsError) throw new Error(`could not load web push subscriptions: ${subsError.message}`);

  const auditRows: AuditRow[] = [];
  const deadTokenIds: string[] = [];
  const deadSubscriptionIds: string[] = [];
  let sent = 0;
  let failed = 0;

  // 5a. Expo channel — batch send.
  const expoJobs = (tokenRows ?? []).filter(
    (t) => !alreadyNotifiedKeys.has(notifiedKey(t.user_id, "expo")),
  );
  const expoMessages = expoJobs.map((t) => ({
    to: t.expo_push_token as string,
    title: notification.title,
    body: notification.body,
    sound: "default" as const,
    priority: "high" as const,
    channelId: "checkin-alerts", // Android; must match a channel created client-side
    data: notification.data,
    __followerId: t.user_id as string,
    __tokenRowId: t.id as string,
  }));

  for (let i = 0; i < expoMessages.length; i += EXPO_BATCH_LIMIT) {
    const batch = expoMessages.slice(i, i + EXPO_BATCH_LIMIT);
    const tickets = await sendExpoBatch(batch);
    tickets.forEach((ticket, idx) => {
      const message = batch[idx];
      if (ticket.status === "ok") {
        sent++;
        auditRows.push({
          check_in_id: record.id,
          recipient_id: message.__followerId,
          push_token: message.to,
          status: "sent",
          channel: "expo",
        });
      } else {
        failed++;
        if (ticket.details?.error === "DeviceNotRegistered") {
          deadTokenIds.push(message.__tokenRowId);
        }
        auditRows.push({
          check_in_id: record.id,
          recipient_id: message.__followerId,
          push_token: message.to,
          status: "failed",
          channel: "expo",
        });
      }
    });
  }

  // 5b. Web Push channel — one HTTP request per subscription.
  const webJobs = (subRows ?? []).filter(
    (s) => !alreadyNotifiedKeys.has(notifiedKey(s.user_id, "web")),
  );
  if (webJobs.length > 0 && !webPushConfigured) {
    console.warn("Web Push subscriptions exist but VAPID_* secrets are not set; skipping web channel.");
  }
  if (webPushConfigured) {
    await Promise.all(
      webJobs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint as string,
              keys: { p256dh: sub.p256dh as string, auth: sub.auth as string },
            },
            JSON.stringify(notification),
          );
          sent++;
          auditRows.push({
            check_in_id: record.id,
            recipient_id: sub.user_id as string,
            push_token: sub.endpoint as string,
            status: "sent",
            channel: "web",
          });
        } catch (err) {
          failed++;
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            deadSubscriptionIds.push(sub.id as string);
          }
          auditRows.push({
            check_in_id: record.id,
            recipient_id: sub.user_id as string,
            push_token: sub.endpoint as string,
            status: "failed",
            channel: "web",
          });
        }
      }),
    );
  }

  // 5c. Anyone eligible with zero devices on either channel: log once for
  // observability (does not participate in per-channel dedupe above).
  const notifiedFollowerIds = new Set([
    ...expoJobs.map((t) => t.user_id as string),
    ...webJobs.map((s) => s.user_id as string),
  ]);
  const alreadyNotifiedFollowerIds = new Set((alreadyNotified ?? []).map((r) => r.recipient_id as string));
  for (const followerId of eligibleFollowerIds) {
    if (!notifiedFollowerIds.has(followerId) && !alreadyNotifiedFollowerIds.has(followerId)) {
      auditRows.push({
        check_in_id: record.id,
        recipient_id: followerId,
        push_token: null,
        status: "skipped_no_token",
        channel: "expo",
      });
    }
  }

  // 6. Persist the audit/dedupe log. Conflicts on
  // (check_in_id, recipient_id, channel) are ignored — guards cross-run
  // retries only, since within a single run each channel is only attempted
  // once per follower.
  if (auditRows.length > 0) {
    await supabase.from("checkin_notifications").upsert(auditRows, {
      onConflict: "check_in_id,recipient_id,channel",
      ignoreDuplicates: true,
    });
  }

  // Drop tokens/subscriptions the provider says are permanently dead.
  if (deadTokenIds.length > 0) {
    await supabase.from("push_tokens").delete().in("id", deadTokenIds);
  }
  if (deadSubscriptionIds.length > 0) {
    await supabase.from("web_push_subscriptions").delete().in("id", deadSubscriptionIds);
  }

  return {
    checkInId: record.id,
    followers: eligibleFollowerIds.length,
    notified: sent,
    skipped: auditRows.filter((r) => r.status === "skipped_no_token").length,
    failed,
  };
}

async function sendExpoBatch(
  messages: ExpoPushMessage[],
): Promise<ExpoPushTicket[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
  };
  if (EXPO_ACCESS_TOKEN) {
    headers["Authorization"] = `Bearer ${EXPO_ACCESS_TOKEN}`;
  }

  const response = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(messages),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Expo push API returned ${response.status}: ${text}`);
  }

  const body = (await response.json()) as { data: ExpoPushTicket[] };
  return body.data;
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
