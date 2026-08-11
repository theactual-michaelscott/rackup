# Rack Up

Rack Up helps pool players check into venues, share what they want to play, follow other players, and coordinate a game.

## Current release scope

- Active check-ins with game type, rules, note, and availability window
- Manual checkout and automatic expiration
- Public one-way following
- A Following feed that shows only active followed players
- Player messages and prefilled challenges
- Venue grouping and mobile-first UI

## Backend

The app uses Supabase tables: `profiles`, `venues`, `check_ins`, `messages`, and `follows`.

The migration in `supabase/migrations/20260810_following_checkout_release.sql` is already applied to the live Supabase project. Keep this file in the repository so future database changes have a version-controlled history.
