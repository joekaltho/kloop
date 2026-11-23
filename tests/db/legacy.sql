-- Pre-referral data as it exists in production today (inserted before 0002 runs), including an alias pair.
insert into public.waitlist_signups (email, created_at) values
  ('legacy1@example.com', now() - interval '10 days'),
  ('legacy2@example.com', now() - interval '9 days'),
  ('l.egacy3@gmail.com',  now() - interval '8 days'),
  ('legacy3+test@gmail.com', now() - interval '7 days');
