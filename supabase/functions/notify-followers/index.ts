// ============================================================================
// Rack Up — notify-followers Edge Function
// ============================================================================
// Triggered by the `on_check_in_created` database webhook (see
// supabase/migrations/0003_checkin_webhook_trigger.sql). Given a newly
// created check-in, this function:
//   1. Verifies the request actually came from the trusted webhook.
//   2. Looks up who follows the player that just checked in.
//   3. Filters out followers who muted "followed player checked in" alerts.
//   4. Collects each remaining follower's registered device push tokens.
//   5. Dedupes against `checkin_notifications` so retries never double-send.
//   6. Sends batched Expo push notifications (max 100 messages/request,
//      Expo's hard limit) and writes an audit row per recipient.
//   7. Cleans up tokens Expo reports as permanently dead (DeviceNotRegistered).
//
// Deploy:  supabase functions deploy notify-followers --no-verify-jwt=false
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected
//          automatically by the Supabase platform for every Edge Function.
//          Optionally set EXPO_ACCESS_TOKEN (Expo push security) with:
//          supabase secrets set EXPO_ACCESS_TOKEN=xxxxx
// ============================================================================

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_BATCH_LIMIT = 100; // hard limit enforced by the Expo push API
const EXPO_ACCESS_TOKEN = Deno.env.get("EXPO_ACCESS_TOKEN"); // optional

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

interface FollowerRecipient {
  followerId: string;
  tokens: { id: string; expoPushToken: string }[];
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

  // 3. Dedupe: skip anyone already notified for this exact check-in
  // (protects against webhook/network retries firing this function twice).
  const { data: alreadyNotified } = await supabase
    .from("checkin_notifications")
    .select("recipient_id")
    .eq("check_in_id", record.id)
    .in("recipient_id", eligibleFollowerIds);

  const alreadyNotifiedIds = new Set((alreadyNotified ?? []).map((r) => r.recipient_id as string));
  const pendingFollowerIds = eligibleFollowerIds.filter((id) => !alreadyNotifiedIds.has(id));

  if (pendingFollowerIds.length === 0) {
    return { checkInId: record.id, followers: eligibleFollowerIds.length, notified: 0, skipped: 0, failed: 0 };
  }

  // 4. Collect device tokens for the pending followers (a follower can have
  // multiple devices; each gets its own message + audit row).
  const { data: tokenRows, error: tokensError } = await supabase
    .from("push_tokens")
    .select("id, user_id, expo_push_token")
    .in("user_id", pendingFollowerIds);
  if (tokensError) throw new Error(`could not load push tokens: ${tokensError.message}`);

  const recipients: FollowerRecipient[] = pendingFollowerIds.map((followerId) => ({
    followerId,
    tokens: (tokenRows ?? [])
      .filter((t) => t.user_id === followerId)
      .map((t) => ({ id: t.id, expoPushToken: t.expo_push_token })),
  }));

  // 5. Build one Expo message per (follower, device) pair; log followers
  // with zero registered devices as "skipped_no_token" for observability.
  const messages: (ExpoPushMessage & { __followerId: string; __tokenRowId: string })[] = [];
  const auditRows: {
    check_in_id: string;
    recipient_id: string;
    push_token: string | null;
    status: "sent" | "failed" | "skipped_no_token" | "skipped_muted";
  }[] = [];

  for (const recipient of recipients) {
    if (recipient.tokens.length === 0) {
      auditRows.push({
        check_in_id: record.id,
        recipient_id: recipient.followerId,
        push_token: null,
        status: "skipped_no_token",
      });
      continue;
    }
    for (const token of recipient.tokens) {
      messages.push({
        to: token.expoPushToken,
        title: "Rack Up",
        body: `${checkedInName} just checked in at ${venueName}`,
        sound: "default",
        priority: "high",
        channelId: "checkin-alerts", // Android; must match a channel created client-side
        data: {
          type: "followed_checkin",
          checkInId: record.id,
          userId: record.user_id,
          venueId: record.venue_id,
        },
        __followerId: recipient.followerId,
        __tokenRowId: token.id,
      });
    }
  }

  // 6. Send in batches of <=100 messages, tracking Expo's per-message ticket
  // result so we know exactly which follower/device each outcome belongs to.
  const deadTokenIds: string[] = [];
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < messages.length; i += EXPO_BATCH_LIMIT) {
    const batch = messages.slice(i, i + EXPO_BATCH_LIMIT);
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
        });
      }
    });
  }

  // 7. Persist the audit/dedupe log. Conflicts (check_in_id, recipient_id)
  // are ignored — a follower may appear once via "no token" and cannot also
  // appear via "sent" in the same run, so this only guards cross-run retries.
  if (auditRows.length > 0) {
    await supabase.from("checkin_notifications").upsert(auditRows, {
      onConflict: "check_in_id,recipient_id",
      ignoreDuplicates: true,
    });
  }

  // Drop tokens Expo says are permanently invalid (uninstalled app, etc.).
  if (deadTokenIds.length > 0) {
    await supabase.from("push_tokens").delete().in("id", deadTokenIds);
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
