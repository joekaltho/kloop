-- Kloop referral competition. Extends the existing waitlist table; Supabase stays the single source of truth.
-- Everything is private: only the Edge Functions (service_role) can call the functions below.
-- The old waitlist_join() is left in place so the currently deployed Edge Function keeps working while you roll out.
-- Once the new waitlist-signup function is live, it is unused and can be dropped.

-- 1. Helpers --------------------------------------------------------------------------------------------------------

-- Same-mailbox detection: lowercases, drops "+tag", and for Gmail also drops dots. Stops alias farming (a+1@gmail.com).
create function public.canonical_email(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when s.d in ('gmail.com', 'googlemail.com')
      then replace(coalesce(nullif(split_part(s.l, '+', 1), ''), s.l), '.', '') || '@gmail.com'
    else coalesce(nullif(split_part(s.l, '+', 1), ''), s.l) || '@' || s.d
  end
  from (select lower(split_part(p, '@', 1)) as l, lower(split_part(p, '@', 2)) as d) s
$$;

-- Short, unambiguous, public referral code: klp_ + 6 chars (no i, l, o, 0, 1).
create function public.gen_referral_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  code text;
  bytes bytea;
  i int;
begin
  loop
    bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    code := 'klp_';
    for i in 0..5 loop
      code := code || substr(alphabet, (get_byte(bytes, i) % 31) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.waitlist_signups where referral_code = code);
  end loop;
  return code;
end $$;

-- 2. Waitlist table: new columns -------------------------------------------------------------------------------------

alter table public.waitlist_signups
  add column referral_code text,
  add column canonical_email text,
  add column verified_at timestamptz,          -- set when the member opens the link emailed to them (proves mailbox ownership)
  add column excluded boolean not null default false,  -- admin lever: hides a member from the leaderboard/rewards and stops their referrals counting
  add column signup_ip_hash text,              -- HMAC of the signup IP, for abuse review only
  add column link_emailed_at timestamptz;      -- throttles how often we email a member their link

-- Backfill existing signups. Later duplicates of the same mailbox (alias signups) keep working but are excluded.
with ranked as (
  select id, public.canonical_email(email) as c,
         row_number() over (partition by public.canonical_email(email) order by created_at, id) as rn
  from public.waitlist_signups
)
update public.waitlist_signups s
set canonical_email = case when r.rn = 1 then r.c else 'legacy-duplicate:' || s.id::text end,
    excluded = (r.rn > 1)
from ranked r
where r.id = s.id;

do $$
declare r record;
begin
  for r in select id from public.waitlist_signups where referral_code is null loop
    update public.waitlist_signups set referral_code = public.gen_referral_code() where id = r.id;
  end loop;
end $$;

alter table public.waitlist_signups
  alter column referral_code set default public.gen_referral_code(),
  alter column referral_code set not null,
  alter column canonical_email set not null,
  add constraint waitlist_signups_referral_code_key unique (referral_code),
  add constraint waitlist_signups_referral_code_valid check (referral_code ~ '^klp_[a-z0-9]{6}$');

create unique index waitlist_signups_canonical_email_key on public.waitlist_signups (canonical_email);

-- Fills canonical_email for every insert (including the old waitlist_join()).
create function public.waitlist_signups_set_canonical()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.canonical_email := public.canonical_email(new.email);
  return new;
end $$;

create trigger waitlist_signups_set_canonical
  before insert on public.waitlist_signups
  for each row execute function public.waitlist_signups_set_canonical();

-- 3. Referral records (the one source for counts, rankings and reward eligibility) -----------------------------------

create table public.referrals (
  id bigint generated always as identity primary key,
  referrer_id uuid not null references public.waitlist_signups (id) on delete cascade,
  referee_id uuid not null references public.waitlist_signups (id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  constraint referrals_one_referrer_per_signup unique (referee_id),          -- a signup is attributed to one referrer only
  constraint referrals_no_self check (referrer_id <> referee_id),
  constraint referrals_status_valid check (status in ('pending', 'verified')),
  constraint referrals_verified_consistent check ((status = 'verified') = (verified_at is not null))
);
create index referrals_referrer_idx on public.referrals (referrer_id, status);

-- Backstop for any writer, not just our functions: referrals start pending, parties never change,
-- verified is final, and a referral can only be verified once the invited person's email is verified.
create function public.referrals_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.verified_at is not null then
      raise exception 'referrals must start pending';
    end if;
  else
    if new.referrer_id <> old.referrer_id or new.referee_id <> old.referee_id then
      raise exception 'referral parties are immutable';
    end if;
    if old.status = 'verified' and (new.status <> 'verified' or new.verified_at is distinct from old.verified_at) then
      raise exception 'verified referrals are final';
    end if;
    if new.status = 'verified' and not exists (
      select 1 from public.waitlist_signups where id = new.referee_id and verified_at is not null
    ) then
      raise exception 'invited email is not verified';
    end if;
  end if;
  return new;
end $$;

create trigger referrals_guard
  before insert or update on public.referrals
  for each row execute function public.referrals_guard();

-- 4. Reward structure (configurable, nothing is seeded) -------------------------------------------------------------
-- kind 'rank'      : members ranked 1..rank_limit on the leaderboard (with at least min_referrals) qualify.
-- kind 'threshold' : any verified member with at least min_referrals verified referrals qualifies.

create table public.referral_rewards (
  id bigint generated always as identity primary key,
  slug text not null unique check (slug ~ '^[a-z0-9-]{1,40}$'),
  title text not null check (length(title) between 1 and 80),
  description text not null default '' check (length(description) <= 400),
  kind text not null check (kind in ('rank', 'threshold')),
  rank_limit int check (rank_limit > 0),
  min_referrals int not null default 1 check (min_referrals > 0),
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint referral_rewards_kind_fields check ((kind = 'rank') = (rank_limit is not null))
);

-- 5. Standings: counts + rank derived only from verified referral records --------------------------------------------
-- Ranked = verified, not excluded, 1+ verified referrals. Order: most referrals, then who reached that count first.
-- Referrals from excluded (e.g. fake) invitees do not count.

create view public.referral_standings with (security_invoker = true) as
with counts as (
  select m.id, m.referral_code, m.verified_at, m.excluded,
    count(r.id) filter (where r.status = 'verified' and not coalesce(e.excluded, false)) as verified_referrals,
    count(r.id) filter (where r.status = 'pending') as pending_referrals,
    max(r.verified_at) filter (where r.status = 'verified' and not coalesce(e.excluded, false)) as reached_at
  from public.waitlist_signups m
  left join public.referrals r on r.referrer_id = m.id
  left join public.waitlist_signups e on e.id = r.referee_id
  group by m.id
),
flagged as (
  select *, (verified_at is not null and not excluded and verified_referrals > 0) as ranked from counts
)
select
  id,
  referral_code,
  upper(substr(md5(id::text), 1, 6)) as handle,   -- privacy-safe public identifier
  (verified_at is not null) as verified,
  excluded,
  verified_referrals,
  pending_referrals,
  (case when ranked then row_number() over (partition by ranked order by verified_referrals desc, reached_at asc, verified_at asc, id) end)::int as rank
from flagged;

-- 6. Functions (service_role only) -----------------------------------------------------------------------------------

-- Reward eligibility + "how many more referrals" for one member, from the standings above.
create function public.referral_rewards_for(p_refs int, p_rank int, p_verified boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', r.slug, 'title', r.title, 'description', r.description, 'kind', r.kind,
    'rank_limit', r.rank_limit, 'min_referrals', r.min_referrals,
    'qualified', q.ok,
    'needed', case when q.ok then 0 else greatest(t.target - p_refs, 0) end
  ) order by r.sort_order, r.id), '[]'::jsonb)
  from public.referral_rewards r
  cross join lateral (
    select case r.kind
      when 'rank' then greatest((select s.verified_referrals from public.referral_standings s where s.rank = r.rank_limit) + 1, r.min_referrals)
      else r.min_referrals
    end as target
  ) t
  cross join lateral (
    select p_verified and case r.kind
      when 'rank' then p_rank is not null and p_rank <= r.rank_limit and p_refs >= r.min_referrals
      else p_refs >= r.min_referrals
    end as ok
  ) q
  where r.active
$$;

-- New waitlist signup (optionally via a referral code). Returns jsonb; never raises for bad referral codes.
create function public.waitlist_signup(
  p_email text, p_ip_hash text, p_ref_code text default null, p_limit int default 5, p_cooldown interval default '5 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
  tries int := 0;
  v_id uuid;
  v_code text;
  v_email text;
  v_verified timestamptz;
  v_referrer uuid;
  v_created boolean := false;
  v_send boolean := false;
begin
  p_email := lower(trim(p_email));   -- the table only accepts normalised emails; do not rely on the caller
  delete from public.waitlist_attempts where created_at < now() - interval '1 day';
  select count(*) into n from public.waitlist_attempts
    where ip_hash = p_ip_hash and created_at > now() - interval '1 hour';
  if n >= p_limit then return jsonb_build_object('status', 'rate_limited'); end if;
  insert into public.waitlist_attempts (ip_hash) values (p_ip_hash);

  if p_ref_code is not null then
    select id into v_referrer from public.waitlist_signups
      where referral_code = lower(trim(p_ref_code)) and not excluded;
  end if;

  loop
    insert into public.waitlist_signups (email, signup_ip_hash) values (p_email, p_ip_hash)
      on conflict do nothing
      returning id, referral_code, email, verified_at into v_id, v_code, v_email, v_verified;
    if v_id is not null then v_created := true; exit; end if;

    -- Conflict: either this mailbox is already a member (normal), or a one-in-a-billion code collision (retry).
    select id, referral_code, email, verified_at into v_id, v_code, v_email, v_verified
      from public.waitlist_signups where canonical_email = public.canonical_email(p_email);
    exit when v_id is not null;
    tries := tries + 1;
    if tries >= 3 then raise exception 'could not allocate member'; end if;
  end loop;

  -- Only a brand-new signup can be attributed, and only once (unique referee). Existing members are never re-attributed.
  if v_created and v_referrer is not null and v_referrer <> v_id then
    insert into public.referrals (referrer_id, referee_id) values (v_referrer, v_id);
  end if;

  update public.waitlist_signups set link_emailed_at = now()
    where id = v_id and (link_emailed_at is null or link_emailed_at < now() - p_cooldown)
    returning true into v_send;

  return jsonb_build_object(
    'status', case when v_created then 'created' else 'duplicate' end,
    'member_id', v_id, 'email', v_email, 'referral_code', v_code,
    'verified', v_verified is not null, 'send', coalesce(v_send, false)
  );
end $$;

-- "Email me my link": only acts if the mailbox is already a member; callers must answer identically either way.
create function public.referral_request_link(
  p_email text, p_ip_hash text, p_limit int default 5, p_cooldown interval default '5 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
  m record;
  v_send boolean := false;
begin
  delete from public.waitlist_attempts where created_at < now() - interval '1 day';
  select count(*) into n from public.waitlist_attempts
    where ip_hash = p_ip_hash and created_at > now() - interval '1 hour';
  if n >= p_limit then return jsonb_build_object('status', 'rate_limited'); end if;
  insert into public.waitlist_attempts (ip_hash) values (p_ip_hash);

  select id, email, referral_code, verified_at into m
    from public.waitlist_signups where canonical_email = public.canonical_email(p_email);
  if not found then return jsonb_build_object('status', 'ok', 'send', false); end if;

  update public.waitlist_signups set link_emailed_at = now()
    where id = m.id and (link_emailed_at is null or link_emailed_at < now() - p_cooldown)
    returning true into v_send;

  return jsonb_build_object(
    'status', 'ok', 'send', coalesce(v_send, false),
    'member_id', m.id, 'email', m.email, 'referral_code', m.referral_code, 'verified', m.verified_at is not null
  );
end $$;

-- Called when a member opens the link we emailed them. Idempotent. Uses clock_timestamp() so tie-breaks follow real order. Verifies the member and settles their pending referral.
create function public.referral_verify_member(p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now boolean;
  v_referrer uuid;
  r record;
  v_notify jsonb;
begin
  update public.waitlist_signups set verified_at = clock_timestamp() where id = p_member_id and verified_at is null;
  v_now := found;
  if not v_now and not exists (select 1 from public.waitlist_signups where id = p_member_id) then
    return jsonb_build_object('found', false);
  end if;

  if v_now then
    update public.referrals set status = 'verified', verified_at = clock_timestamp()
      where referee_id = p_member_id and status = 'pending'
      returning referrer_id into v_referrer;
    if v_referrer is not null then
      select m.id, m.email, s.verified_referrals, s.rank into r
        from public.referral_standings s join public.waitlist_signups m on m.id = s.id
        where s.id = v_referrer and s.verified and not s.excluded;
      if found then
        v_notify := jsonb_build_object('member_id', r.id, 'email', r.email, 'verified_referrals', r.verified_referrals, 'rank', r.rank);
      end if;
    end if;
  end if;

  return jsonb_build_object('found', true, 'verified_now', v_now, 'referrer', v_notify);
end $$;

-- Everything a member sees about themselves. No email, no other member's data.
create function public.referral_member_status(p_member_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s record;
  total int;
begin
  select * into s from public.referral_standings where id = p_member_id;
  if not found then return jsonb_build_object('found', false); end if;
  select count(*) into total from public.referral_standings where rank is not null;
  return jsonb_build_object(
    'found', true, 'handle', s.handle, 'referral_code', s.referral_code, 'verified', s.verified,
    'verified_referrals', s.verified_referrals, 'pending_referrals', s.pending_referrals,
    'rank', s.rank, 'total_ranked', total,
    'rewards', public.referral_rewards_for(s.verified_referrals::int, s.rank, s.verified and not s.excluded)
  );
end $$;

-- Public leaderboard + reward definitions. Only rank, a hashed handle and a count leave the database.
create function public.referral_leaderboard(p_limit int default 50)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('rank', s.rank, 'handle', s.handle, 'referrals', s.verified_referrals) order by s.rank)
      from public.referral_standings s where s.rank <= least(greatest(p_limit, 1), 100)
    ), '[]'::jsonb),
    'total_ranked', (select count(*) from public.referral_standings where rank is not null),
    'rewards', coalesce((
      select jsonb_agg(jsonb_build_object('slug', slug, 'title', title, 'description', description, 'kind', kind,
                                          'rank_limit', rank_limit, 'min_referrals', min_referrals) order by sort_order, id)
      from public.referral_rewards where active
    ), '[]'::jsonb)
  )
$$;

-- 7. Lock everything down --------------------------------------------------------------------------------------------

alter table public.referrals enable row level security;
alter table public.referral_rewards enable row level security;
revoke all on public.referrals, public.referral_rewards, public.referral_standings from public, anon, authenticated;

revoke all on function
  public.canonical_email(text),
  public.gen_referral_code(),
  public.waitlist_signups_set_canonical(),
  public.referrals_guard(),
  public.referral_rewards_for(int, int, boolean),
  public.waitlist_signup(text, text, text, int, interval),
  public.referral_request_link(text, text, int, interval),
  public.referral_verify_member(uuid),
  public.referral_member_status(uuid),
  public.referral_leaderboard(int)
from public, anon, authenticated;

grant execute on function
  public.canonical_email(text),
  public.gen_referral_code(),
  public.waitlist_signups_set_canonical(),
  public.referrals_guard(),
  public.referral_rewards_for(int, int, boolean),
  public.waitlist_signup(text, text, text, int, interval),
  public.referral_request_link(text, text, int, interval),
  public.referral_verify_member(uuid),
  public.referral_member_status(uuid),
  public.referral_leaderboard(int)
to service_role;
