'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { getExistingSubscription, pushSupported, subscribeToPush } from './lib/push';

const db =
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ? createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      )
    : null;

const games = ['8-ball', '9-ball', '10-ball'];
const rules = ['APA', 'BCA', 'Bar room rules'];
const durations = [
  ['30 min', 30],
  ['1 hour', 60],
  ['2 hours', 120],
  ['4 hours', 240],
  ['All night', 360],
];

const name = (profile) => profile?.display_name || profile?.username || 'Pool player';

const remaining = (expiresAt) => {
  const minutes = Math.max(0, Math.ceil((new Date(expiresAt) - Date.now()) / 60000));
  return minutes < 60 ? `${minutes} min left` : `${Math.ceil(minutes / 60)} hr left`;
};

export default function App() {
  const [user, setUser] = useState();
  const [venues, setVenues] = useState([]);
  const [live, setLive] = useState([]);
  const [profile, setProfile] = useState();
  const [form, setForm] = useState({
    venue_id: '',
    game_type: '8-ball',
    rules_type: 'APA',
    minutes: 120,
    note: '',
  });
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [pushState, setPushState] = useState('unsupported'); // unsupported | off | on | busy
  const [notifyToggleBusy, setNotifyToggleBusy] = useState(false);

  const mine = useMemo(() => live.find((checkIn) => checkIn.user_id === user?.id), [live, user]);

  useEffect(() => {
    if (!db) return;

    db.auth.getUser().then(({ data }) => {
      setUser(data.user);
      load(data.user?.id);
    });
  }, []);

  useEffect(() => {
    if (!pushSupported()) {
      setPushState('unsupported');
      return;
    }

    getExistingSubscription().then((subscription) => {
      setPushState(subscription ? 'on' : 'off');
    });
  }, [user]);

  async function enableBrowserAlerts() {
    setPushState('busy');
    const result = await subscribeToPush(db);

    if (result.ok) {
      setPushState('on');
      setNotice('Browser alerts are on. You will be notified when someone you follow checks in.');
    } else {
      setPushState('off');
      setNotice(result.error || 'Could not enable browser alerts.');
    }
  }

  async function toggleFollowedCheckinAlerts(nextValue) {
    if (!profile || notifyToggleBusy) return;

    setNotifyToggleBusy(true);
    const result = await db
      .from('profiles')
      .update({ notify_on_followed_checkin: nextValue })
      .eq('id', profile.id);
    setNotifyToggleBusy(false);

    if (result.error) {
      setNotice(result.error.message);
    } else {
      setProfile((current) => ({ ...current, notify_on_followed_checkin: nextValue }));
    }
  }

  async function load(id = user?.id) {
    if (!db) return;

    const [venuesResult, checkInsResult] = await Promise.all([
      db.from('venues').select('*').order('city').order('name'),
      db
        .from('check_ins')
        .select('*,profiles!check_ins_user_id_fkey(*),venues!check_ins_venue_id_fkey(*)')
        .eq('status', 'active')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }),
    ]);

    if (venuesResult.error) {
      setNotice(venuesResult.error.message);
    } else {
      setVenues(venuesResult.data || []);
      setForm((current) => ({
        ...current,
        venue_id: current.venue_id || venuesResult.data?.[0]?.id || '',
      }));
    }

    if (checkInsResult.error) {
      setNotice(checkInsResult.error.message);
    } else {
      setLive(checkInsResult.data || []);
    }

    if (id) {
      const profileResult = await db.from('profiles').select('*').eq('id', id).maybeSingle();
      if (profileResult.error) {
        setNotice(profileResult.error.message);
      } else {
        setProfile(profileResult.data);
      }
    }
  }

  async function auth(event) {
    event.preventDefault();

    const data = new FormData(event.currentTarget);
    const credentials = {
      email: data.get('email'),
      password: data.get('password'),
    };

    const result = await db.auth.signInWithPassword(credentials);
    if (result.error) return setNotice(result.error.message);

    setUser(result.data.user);
    load(result.data.user.id);
  }

  async function ensureProfile() {
    const {
      data: { user: currentUser },
      error: userError,
    } = await db.auth.getUser();

    if (userError || !currentUser) {
      setNotice('Your sign-in session has expired. Please sign out and sign in again.');
      return false;
    }

    const username = `player${currentUser.id.slice(0, 6)}`;

    const result = await db
      .from('profiles')
      .upsert(
        {
          id: currentUser.id,
          username,
          display_name: username,
        },
        { onConflict: 'id' }
      );

    if (result.error) {
      setNotice(result.error.message);
      return false;
    }

    setUser(currentUser);
    setProfile({
      id: currentUser.id,
      username,
      display_name: username,
    });

    return true;
  }

  async function goLive() {
    if (busy) return;

    setBusy(true);
    setNotice('');

    if (!(await ensureProfile())) {
      setBusy(false);
      return;
    }

    if (mine) {
      setNotice('You are already checked in. Check out before starting another session.');
      setBusy(false);
      return;
    }

    const result = await db.from('check_ins').insert({
      user_id: user.id,
      venue_id: form.venue_id,
      game_type: form.game_type,
      rules_type: form.rules_type,
      note: form.note.trim() || null,
      status: 'active',
      expires_at: new Date(Date.now() + form.minutes * 60000).toISOString(),
    });

    setBusy(false);

    if (result.error) {
      setNotice(result.error.message);
    } else {
      setNotice('You are live.');
      setForm((current) => ({ ...current, note: '' }));
      load();
    }
  }

  async function checkout() {
    if (!mine || busy) return;

    setBusy(true);

    const result = await db
      .from('check_ins')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('id', mine.id)
      .eq('user_id', user.id);

    setBusy(false);

    if (result.error) {
      setNotice(result.error.message);
    } else {
      setNotice('You are checked out.');
      load();
    }
  }

  if (!db) {
    return (
      <main>
        <h1>Rack Up needs staging configuration.</h1>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="auth">
        <section>
          <b>△ Rack Up · STAGING</b>
          <h1>Find a game tonight.</h1>
          <form onSubmit={auth}>
            <input name="email" type="email" placeholder="Email" required />
            <input name="password" type="password" minLength="6" placeholder="Password" required />
            <button>Sign in or create test account</button>
          </form>
          {notice && <p className="notice">{notice}</p>}
        </section>
      </main>
    );
  }

  return (
    <main>
      <header>
        <b>
          △ Rack Up <small>STAGING</small>
        </b>
        <button
          className="link"
          onClick={() =>
            db.auth.signOut().then(() => {
              setUser();
              setProfile();
              setLive([]);
            })
          }
        >
          Sign out
        </button>
      </header>

      <section className="hero">
        <p>GREATER BOSTON · {live.length} LIVE</p>
        <h1>Find your next set.</h1>
      </section>

      {notice && <p className="notice">{notice}</p>}

      <section className="checkin">
        <p>YOUR AVAILABILITY</p>
        <h2>{mine ? `You are live at ${mine.venues?.name}.` : 'Ready to play?'}</h2>

        {mine ? (
          <>
            <p>
              {mine.game_type} · {mine.rules_type} · {remaining(mine.expires_at)}
            </p>
            <button className="checkout" disabled={busy} onClick={checkout}>
              {busy ? 'Working…' : 'Check out'}
            </button>
          </>
        ) : (
          <div className="form">
            <label>
              Venue
              <select
                value={form.venue_id}
                onChange={(event) => setForm({ ...form, venue_id: event.target.value })}
              >
                {venues.map((venue) => (
                  <option value={venue.id} key={venue.id}>
                    {venue.name} — {venue.city}
                  </option>
                ))}
              </select>
            </label>

            <Picker
              label="Game"
              items={games}
              value={form.game_type}
              choose={(game_type) => setForm({ ...form, game_type })}
            />

            <Picker
              label="Rules"
              items={rules}
              value={form.rules_type}
              choose={(rules_type) => setForm({ ...form, rules_type })}
            />

            <label>
              Staying for
              <select
                value={form.minutes}
                onChange={(event) => setForm({ ...form, minutes: +event.target.value })}
              >
                {durations.map(([label, minutes]) => (
                  <option value={minutes} key={minutes}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Optional note
              <input
                maxLength="240"
                value={form.note}
                onChange={(event) => setForm({ ...form, note: event.target.value })}
                placeholder="Looking for a race to 3."
              />
            </label>

            <button disabled={busy || !form.venue_id} onClick={goLive}>
              {busy ? 'Going live…' : 'Go live'}
            </button>
          </div>
        )}
      </section>

      <section className="notifications">
        <p>ALERTS</p>
        <h2>Get notified when a follow checks in.</h2>

        {pushState === 'unsupported' && (
          <p className="empty">Browser alerts aren&apos;t supported here yet — Rack Up&apos;s native app will cover this device.</p>
        )}

        {pushState !== 'unsupported' && (
          <button
            className="link"
            disabled={pushState === 'busy' || pushState === 'on'}
            onClick={enableBrowserAlerts}
          >
            {pushState === 'on' && 'Browser alerts are on'}
            {pushState === 'off' && 'Enable browser alerts'}
            {pushState === 'busy' && 'Enabling…'}
          </button>
        )}

        {profile && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={profile.notify_on_followed_checkin !== false}
              disabled={notifyToggleBusy}
              onChange={(event) => toggleFollowedCheckinAlerts(event.target.checked)}
            />
            Notify me when someone I follow checks in
          </label>
        )}
      </section>

      <h2>Players checked in nearby</h2>
      <div className="cards">
        {live.length ? (
          live.map((checkIn) => (
            <article key={checkIn.id}>
              <b>{name(checkIn.profiles)}</b>
              <span>{remaining(checkIn.expires_at)}</span>
              <p>
                {checkIn.venues?.name} · {checkIn.venues?.city}
              </p>
              <i>{checkIn.game_type}</i> <i>{checkIn.rules_type}</i>
              {checkIn.note && <p>“{checkIn.note}”</p>}
            </article>
          ))
        ) : (
          <p className="empty">No active players yet.</p>
        )}
      </div>

      <nav>
        <button className="active">Home</button>
        <button>Following</button>
        <button>Messages</button>
        <button>Profile</button>
      </nav>
    </main>
  );
}

function Picker({ label, items, value, choose }) {
  return (
    <div className="picker">
      <b>{label}</b>
      <div>
        {items.map((item) => (
          <button
            type="button"
            className={item === value ? 'selected' : ''}
            onClick={() => choose(item)}
            key={item}
          >
            {item}
          </button>
        ))}
      </div>
    </div>
  );
}
