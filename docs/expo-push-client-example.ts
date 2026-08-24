// ============================================================================
// REFERENCE ONLY — not wired into any app today.
// ============================================================================
// Rack Up's current client is a plain Next.js web app (app/page.jsx), which
// uses Web Push (see app/lib/push.js) instead of this. This file documents
// how a *future* Expo/React Native app would register for the Expo push
// channel that the backend (supabase/functions/notify-followers) already
// supports via the push_tokens table and the upsert_push_token RPC.
//
// It is not imported by anything, has no build step, and is safe to delete
// or promote into a real Expo project whenever one exists. Requires, in a
// real Expo app: `expo-notifications`, `expo-device`, and a configured
// EAS project id (app.json -> extra.eas.projectId) for push to work on a
// physical device/build.
// ============================================================================

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import type { SupabaseClient } from '@supabase/supabase-js';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Requests notification permission, grabs an Expo push token, and persists
 * it via the same `upsert_push_token` RPC the backend expects
 * (supabase/migrations/20260824_push_notification_backend.sql).
 */
export async function registerForPushNotificationsAsync(db: SupabaseClient) {
  if (!Device.isDevice) {
    return { ok: false, error: 'Push notifications require a physical device.' };
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('checkin-alerts', {
      name: 'Followed player check-ins',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    return { ok: false, error: 'Notification permission was not granted.' };
  }

  const tokenResponse = await Notifications.getExpoPushTokenAsync({
    projectId: 'YOUR_EAS_PROJECT_ID', // app.json -> extra.eas.projectId
  });

  const { error } = await db.rpc('upsert_push_token', {
    p_expo_push_token: tokenResponse.data,
    p_platform: Platform.OS === 'ios' ? 'ios' : 'android',
    p_device_id: Device.osInternalBuildId ?? Device.modelId ?? null,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true, token: tokenResponse.data };
}
