-- Kloop waitlist: private signups table + per-IP rate limit. No public access; only the edge function (service_role) can call waitlist_join.
create table public.waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now(),
  constraint waitlist_signups_email_key unique (email),
  constraint waitlist_signups_email_valid check (
    length(email) <= 254 and email = lower(email) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  )
);

create table public.waitlist_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index waitlist_attempts_ip_time_idx on public.waitlist_attempts (ip_hash, created_at);

alter table public.waitlist_signups enable row level security;
alter table public.waitlist_attempts enable row level security;
revoke all on public.waitlist_signups, public.waitlist_attempts from anon, authenticated;

create function public.waitlist_join(p_email text, p_ip_hash text, p_limit int default 5)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare n int;
begin
  delete from public.waitlist_attempts where created_at < now() - interval '1 day';
  select count(*) into n from public.waitlist_attempts
    where ip_hash = p_ip_hash and created_at > now() - interval '1 hour';
  if n >= p_limit then return 'rate_limited'; end if;
  insert into public.waitlist_attempts (ip_hash) values (p_ip_hash);
  insert into public.waitlist_signups (email) values (p_email) on conflict (email) do nothing;
  if found then return 'created'; end if;
  return 'duplicate';
end $$;

revoke all on function public.waitlist_join(text, text, int) from public, anon, authenticated;
grant execute on function public.waitlist_join(text, text, int) to service_role;
