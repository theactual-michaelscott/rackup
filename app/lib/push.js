// Rack Up — Web Push subscription helper for the Next.js app.
//
// Flow: registerServiceWorker() -> subscribe(db) which asks for Notification
// permission, subscribes the browser via the Push API using
// NEXT_PUBLIC_VAPID_PUBLIC_KEY, then hands the subscription to Supabase via
// the upsert_web_push_subscription RPC (see
// supabase/migrations/20260824b_web_push_support.sql). The backend
// (supabase/functions/notify-followers) reads rows from web_push_subscriptions
// to deliver "someone you follow checked in" alerts to this browser.

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function registerServiceWorker() {
  if (!pushSupported()) return null;
  return navigator.serviceWorker.register('/sw.js');
}

export async function getExistingSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

// Web Push VAPID keys are base64url; PushManager wants a Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

// Requests permission (if needed), subscribes the browser, and persists the
// subscription server-side via RPC. Returns { ok: true } or { ok: false, error }.
export async function subscribeToPush(db) {
  if (!pushSupported()) {
    return { ok: false, error: 'This browser does not support push notifications.' };
  }

  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidPublicKey) {
    return { ok: false, error: 'Push notifications are not configured for this environment.' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, error: 'Notification permission was not granted.' };
  }

  try {
    await registerServiceWorker();
    const registration = await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
    }

    const key = subscription.getKey ? subscription.getKey('p256dh') : null;
    const authSecret = subscription.getKey ? subscription.getKey('auth') : null;
    const subJson = subscription.toJSON();

    const p256dh = subJson.keys?.p256dh || (key ? bufferToBase64Url(key) : null);
    const auth = subJson.keys?.auth || (authSecret ? bufferToBase64Url(authSecret) : null);

    const { error } = await db.rpc('upsert_web_push_subscription', {
      p_endpoint: subscription.endpoint,
      p_p256dh: p256dh,
      p_auth: auth,
      p_user_agent: navigator.userAgent,
    });

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not subscribe to push notifications.' };
  }
}

function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  const binary = bytes.reduce((acc, byte) => acc + String.fromCharCode(byte), '');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function unsubscribeFromPush() {
  const subscription = await getExistingSubscription();
  if (subscription) await subscription.unsubscribe();
}
