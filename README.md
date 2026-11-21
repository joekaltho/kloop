# Kloop waitlist

Static page (index.html) -> Supabase Edge Function `waitlist-signup` -> private `waitlist_signups` table.

Setup (after the Supabase project exists):
1. Run supabase/migrations/0001_waitlist.sql.
2. Deploy supabase/functions/waitlist-signup with verify_jwt = false.
3. Optional secret ALLOWED_ORIGINS=https://yourdomain (comma-separated). Unset = any origin.
4. In the HTML, set ENDPOINT to https://<project-ref>.supabase.co/functions/v1/waitlist-signup.

No keys are in the page. The service-role key exists only inside the function's server environment.
View/export signups: Supabase dashboard > Table Editor > waitlist_signups > Export CSV (needs your Supabase login).
Rate limit: 5 attempts per IP per hour (edit p_limit default in waitlist_join).

Smoke test: curl -X POST <ENDPOINT> -H 'content-type: application/json' -d '{"email":"you@example.com"}'
Tests: node --experimental-strip-types tests/test-fn.mjs ; npm i jsdom && node tests/test-ui.mjs
