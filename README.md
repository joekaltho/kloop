# Kloop waitlist + referral competition

Static pages (`index.html`, `referral.html`) -> Supabase Edge Functions (`waitlist-signup`, `referral`) -> private tables.
Supabase is the single source of truth: counts, leaderboard and reward eligibility all derive from `referrals` rows.

## Deploy (in this order)
1. Run `supabase/migrations/0002_referrals.sql` (after 0001). The old `waitlist_join()` stays, so the live function keeps working until step 3.
2. Set secrets (`supabase secrets set ...`):
   - `LINK_SECRET`  random string, 32+ bytes (e.g. `openssl rand -hex 32`). Signs the emailed member links. Rotating it invalidates every emailed link.
   - `SITE_URL`     public site origin, no trailing slash (e.g. `https://kloop-nine.vercel.app`, later `https://kloop.io`). Used in emails.
   - `RESEND_API_KEY` and `EMAIL_FROM` (e.g. `Kloop <hello@yourdomain>`). The sending domain must be verified in Resend (SPF/DKIM), otherwise Resend only delivers to your own account email.
   - Optional `ALLOWED_ORIGINS=https://yourdomain` (comma-separated). Unset = any origin.
3. Deploy both functions with JWT verification off:
   `supabase functions deploy waitlist-signup --no-verify-jwt` and `supabase functions deploy referral --no-verify-jwt`
4. `referral.html` has its own `API` constant (`.../functions/v1/referral`); `index.html` derives it from `ENDPOINT`. Both already point at the existing project.
5. Push to Vercel.

Signups are always saved first. If email is not configured or the provider fails, the signup still succeeds and the error is logged.

## Rewards (nothing is seeded)
Add rows to `referral_rewards` in the Table Editor or SQL. Change or deactivate them any time; the site and the member dashboards update on their own.
- `kind = 'rank'`: members ranked 1..`rank_limit` (with at least `min_referrals`) qualify. Founding spots.
- `kind = 'threshold'`: any verified member with at least `min_referrals` verified referrals qualifies. Early access / extra tiers.
Template (choose your own numbers):
```sql
-- insert into public.referral_rewards (slug, title, description, kind, rank_limit, min_referrals, sort_order)
-- values ('founding-spot', 'Founding spot', '...', 'rank', <how many spots>, 1, 1),
--        ('early-access',  'Early access',  '...', 'threshold', null, <referrals needed>, 2);
```
Standings are live. Actual awarding is manual: read the winners from `referral_standings` (service role / SQL editor).

## How the rules are enforced (database level)
- A member's code is `klp_xxxxxx`. A referral is created only when a brand-new signup arrives with a valid code, and only once (`referee_id` unique).
- Self-referral and duplicates: emails are canonicalised (`a.b+x@gmail.com` = `ab@gmail.com`) with a unique index, so aliases cannot be used to farm referrals. `referrer_id <> referee_id` is a table check.
- A referral counts only after the invited person opens the emailed link (that proves the mailbox). A trigger blocks verifying a referral for an unverified invitee, changing parties, or reverting a verified referral.
- Only verified members with 1+ verified referral appear on the leaderboard. Rank = most referrals, ties go to who reached the count first.
- Fraud lever: set `excluded = true` on a member in `waitlist_signups` to hide them and stop their referrals counting. Legacy alias duplicates were auto-excluded by the migration.
- `signup_ip_hash` (HMAC of IP) is stored for abuse review only.
- Everything private is locked from `anon`/`authenticated`; only the Edge Functions (service role) reach it.

## Endpoints
- `POST waitlist-signup {email, ref?}` -> `{ok, referral_code}` for new members, `{ok}` for existing ones (nothing about existing members leaks).
- `GET referral?action=leaderboard` -> top 50 (`rank`, hashed `handle`, `referrals`) + reward definitions. Cached 30s.
- `POST referral {action:"me", token}` -> dashboard data. Opening the emailed link verifies the email.
- `POST referral {action:"request_link", email}` -> always `{ok}`; emails the link if the address is a member (5 min cooldown per member).
Rate limit: 5 attempts per IP per hour, shared by signup and request_link (edit `p_limit` defaults in 0002). Shared mobile networks can hit this; raise it if you see 429s.

## Tests
```
# SQL (real Postgres; needs CREATEDB/CREATEROLE, uses PG* env vars)
bash tests/db/run.sh
# Edge Functions with mocks
node --experimental-strip-types --no-warnings tests/test-fn.mjs
# Full journey: real Postgres + real function code + captured emails
npm i --no-save pg jsdom
node --experimental-strip-types --no-warnings tests/e2e.mjs
# Pages (jsdom)
node tests/test-ui.mjs && node tests/test-ref-ui.mjs
```
Smoke test: `curl -X POST <ENDPOINT> -H 'content-type: application/json' -d '{"email":"you@example.com"}'`
