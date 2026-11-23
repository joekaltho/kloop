-- SQL assertions for 0002_referrals.sql. Any failed assert aborts the run (ON_ERROR_STOP).
create function pg_temp.signup(p_email text, p_ref text default null, p_ip text default null) returns jsonb language sql as $$
  select public.waitlist_signup(p_email, coalesce(p_ip, 'ip-' || gen_random_uuid()::text), p_ref) $$;
create function pg_temp.mid(j jsonb) returns uuid language sql as $$ select (j->>'member_id')::uuid $$;
create function pg_temp.pass(t text) returns void language plpgsql as $$ begin raise notice 'PASS %', t; end $$;

do $$
declare j jsonb; a jsonb; b jsonb; c jsonb; d jsonb; e jsonb; x jsonb; n int; st jsonb;
begin
  -- canonical_email
  assert public.canonical_email('A.l.I.c.e+promo@GMail.com') = 'alice@gmail.com', 'gmail dots/plus/case';
  assert public.canonical_email('alice@googlemail.com') = 'alice@gmail.com', 'googlemail';
  assert public.canonical_email('Bob+x@Example.com') = 'bob@example.com', 'plus on other domains';
  assert public.canonical_email('b.ob@example.com') = 'b.ob@example.com', 'dots kept on other domains';
  assert public.canonical_email('+x@example.com') = '+x@example.com', 'empty local part after plus is kept';
  perform pg_temp.pass('canonical_email');

  -- migration on legacy data
  assert (select count(*) from public.waitlist_signups where referral_code is null) = 0, 'legacy codes';
  assert (select count(distinct referral_code) from public.waitlist_signups) = 4, 'legacy codes unique';
  assert (select excluded from public.waitlist_signups where email = 'legacy3+test@gmail.com'), 'legacy alias duplicate excluded';
  assert not (select excluded from public.waitlist_signups where email = 'l.egacy3@gmail.com'), 'first legacy alias kept';
  perform pg_temp.pass('migration backfill');

  -- old function still works and rows get a code
  assert public.waitlist_join('old@example.com', 'iph-old') = 'created', 'old waitlist_join';
  assert (select referral_code ~ '^klp_[a-z0-9]{6}$' from public.waitlist_signups where email = 'old@example.com'), 'old join code';
  perform pg_temp.pass('old waitlist_join unaffected');

  -- signup basics
  a := pg_temp.signup('alice@gmail.com');
  assert a->>'status' = 'created' and a->>'referral_code' ~ '^klp_[a-z0-9]{6}$' and (a->>'send')::boolean and not (a->>'verified')::boolean, 'alice created';
  j := pg_temp.signup('alice@gmail.com');
  assert j->>'status' = 'duplicate' and j->>'referral_code' = a->>'referral_code', 'duplicate keeps code';
  assert not (j->>'send')::boolean, 'cooldown blocks immediate resend';
  j := pg_temp.signup('A.L.ice+spam@googlemail.com');
  assert j->>'status' = 'duplicate' and pg_temp.mid(j) = pg_temp.mid(a), 'alias is a duplicate';
  update public.waitlist_signups set link_emailed_at = now() - interval '6 minutes' where id = pg_temp.mid(a);
  assert (pg_temp.signup('alice@gmail.com')->>'send')::boolean, 'resend allowed after cooldown';
  perform pg_temp.pass('signup, duplicates, aliases, cooldown');

  -- self-referral: alice (or her alias) re-signing up with her own code creates nothing
  j := pg_temp.signup('alice+me@gmail.com', a->>'referral_code');
  assert j->>'status' = 'duplicate', 'self referral is duplicate';
  assert (select count(*) from public.referrals) = 0, 'no referral rows from self referral';
  begin
    insert into public.referrals (referrer_id, referee_id) values (pg_temp.mid(a), pg_temp.mid(a));
    assert false, 'direct self referral must fail';
  exception when check_violation then null; end;
  perform pg_temp.pass('self referral blocked (function + table)');

  -- invalid / unknown / junk codes never block signup and never attribute
  j := pg_temp.signup('inv1@example.com', 'klp_zzzzzz');   assert j->>'status' = 'created', 'unknown code still signs up';
  j := pg_temp.signup('inv2@example.com', 'garbage; drop'); assert j->>'status' = 'created', 'junk code still signs up';
  j := pg_temp.signup('inv3@example.com', '');              assert j->>'status' = 'created', 'empty code';
  assert (select count(*) from public.referrals) = 0, 'no attribution for invalid codes';
  perform pg_temp.pass('invalid referral codes');

  -- pending referral
  b := pg_temp.signup('bob@example.com', upper(a->>'referral_code'));   -- case-insensitive
  assert b->>'status' = 'created', 'bob created';
  assert (select status from public.referrals where referee_id = pg_temp.mid(b)) = 'pending', 'pending';
  st := public.referral_member_status(pg_temp.mid(a));
  assert (st->>'pending_referrals')::int = 1 and (st->>'verified_referrals')::int = 0 and st->'rank' = 'null'::jsonb, 'alice pending only';
  assert public.referral_leaderboard()->'entries' = '[]'::jsonb, 'pending does not rank';
  perform pg_temp.pass('referral stays pending until the invitee verifies');

  -- one referrer per signup
  c := pg_temp.signup('carol@example.com');
  begin
    insert into public.referrals (referrer_id, referee_id) values (pg_temp.mid(c), pg_temp.mid(b));
    assert false, 'second referrer must fail';
  exception when unique_violation then null; end;
  -- an existing member signing up through someone else's link is not re-attributed
  j := pg_temp.signup('bob@example.com', c->>'referral_code');
  assert j->>'status' = 'duplicate' and (select referrer_id from public.referrals where referee_id = pg_temp.mid(b)) = pg_temp.mid(a), 'no re-attribution';
  perform pg_temp.pass('single attribution');

  -- guard trigger
  begin update public.referrals set status = 'verified', verified_at = now() where referee_id = pg_temp.mid(b);
    assert false, 'cannot verify while invitee unverified'; exception when raise_exception then null; end;
  begin update public.referrals set referrer_id = pg_temp.mid(c) where referee_id = pg_temp.mid(b);
    assert false, 'parties immutable'; exception when raise_exception then null; end;
  begin insert into public.referrals (referrer_id, referee_id, status, verified_at) values (pg_temp.mid(a), pg_temp.mid(c), 'verified', now());
    assert false, 'must start pending'; exception when raise_exception or check_violation then null; end;
  perform pg_temp.pass('referral integrity trigger');

  -- verify invitee: referral verified, referrer unverified so not ranked and not notified
  x := public.referral_verify_member(pg_temp.mid(b));
  assert (x->>'verified_now')::boolean and x->'referrer' = 'null'::jsonb, 'bob verified, alice unverified -> no notification';
  st := public.referral_member_status(pg_temp.mid(a));
  assert (st->>'verified_referrals')::int = 1 and (st->>'pending_referrals')::int = 0 and st->'rank' = 'null'::jsonb, 'count updated, still unranked';
  -- verifying again is a no-op
  x := public.referral_verify_member(pg_temp.mid(b));
  assert not (x->>'verified_now')::boolean and x->'referrer' = 'null'::jsonb, 'idempotent';
  -- verify alice -> ranked #1
  perform public.referral_verify_member(pg_temp.mid(a));
  st := public.referral_member_status(pg_temp.mid(a));
  assert (st->>'rank')::int = 1 and (st->>'total_ranked')::int = 1 and (st->>'verified')::boolean, 'alice rank 1';
  assert public.referral_verify_member('00000000-0000-0000-0000-000000000000')->>'found' = 'false', 'unknown member';
  perform pg_temp.pass('verification flips referral, count and rank follow');

  -- notification payload when a verified referrer gets a new verified referral
  d := pg_temp.signup('dave@example.com', a->>'referral_code');
  x := public.referral_verify_member(pg_temp.mid(d));
  assert x->'referrer'->>'email' = 'alice@gmail.com' and (x->'referrer'->>'verified_referrals')::int = 2 and (x->'referrer'->>'rank')::int = 1, 'notify payload';
  perform pg_temp.pass('referrer notification payload');

  -- ranking + tie-break (earlier to reach the count wins) + ignoring unverified referrers
  e := pg_temp.signup('erin@example.com');   perform public.referral_verify_member(pg_temp.mid(e));
  perform public.referral_verify_member(pg_temp.mid(c));
  declare f jsonb; g jsonb; h jsonb; begin
    f := pg_temp.signup('f1@example.com', c->>'referral_code'); perform public.referral_verify_member(pg_temp.mid(f));
    g := pg_temp.signup('f2@example.com', e->>'referral_code'); perform public.referral_verify_member(pg_temp.mid(g));
    h := pg_temp.signup('f3@example.com', c->>'referral_code'); perform public.referral_verify_member(pg_temp.mid(h));
    h := pg_temp.signup('f4@example.com', e->>'referral_code'); perform public.referral_verify_member(pg_temp.mid(h));
  end;
  -- alice 2, carol 2 (reached later than alice), erin 2 (reached last)
  select jsonb_agg(l.handle order by l.rank) into st from public.referral_standings l where l.rank is not null;
  assert (select rank from public.referral_standings where id = pg_temp.mid(a)) = 1, 'alice first (reached 2 first)';
  assert (select rank from public.referral_standings where id = pg_temp.mid(c)) = 2, 'carol second';
  assert (select rank from public.referral_standings where id = pg_temp.mid(e)) = 3, 'erin third';
  assert (select count(distinct rank) from public.referral_standings where rank is not null) = 3, 'ranks unique';
  perform pg_temp.pass('ranking and tie-break');

  -- excluded invitee stops counting; excluded referrer disappears
  update public.waitlist_signups set excluded = true where id = pg_temp.mid(d);
  assert (public.referral_member_status(pg_temp.mid(a))->>'verified_referrals')::int = 1, 'excluded invitee not counted';
  update public.waitlist_signups set excluded = true where id = pg_temp.mid(e);
  assert (select rank from public.referral_standings where id = pg_temp.mid(e)) is null, 'excluded referrer unranked';
  update public.waitlist_signups set excluded = false where id in (pg_temp.mid(d), pg_temp.mid(e));
  perform pg_temp.pass('exclusion lever');

  -- rewards: configurable, derived from the same standings
  assert public.referral_leaderboard()->'rewards' = '[]'::jsonb, 'no rewards seeded';
  assert public.referral_member_status(pg_temp.mid(a))->'rewards' = '[]'::jsonb, 'no rewards seeded (member view)';
  insert into public.referral_rewards (slug, title, kind, rank_limit, min_referrals, sort_order) values ('spot', 'Spot', 'rank', 1, 1, 1);
  insert into public.referral_rewards (slug, title, kind, min_referrals, sort_order) values ('early', 'Early', 'threshold', 3, 2);
  insert into public.referral_rewards (slug, title, kind, min_referrals, active) values ('off', 'Off', 'threshold', 1, false);
  st := public.referral_member_status(pg_temp.mid(a))->'rewards';
  assert jsonb_array_length(st) = 2, 'inactive hidden';
  assert (st->0->>'qualified')::boolean and (st->0->>'needed')::int = 0, 'alice qualifies for rank 1';
  assert not (st->1->>'qualified')::boolean and (st->1->>'needed')::int = 1, 'alice needs 1 more for threshold 3';
  st := public.referral_member_status(pg_temp.mid(c))->'rewards';    -- carol rank 2 with 2 refs; cutoff holder has 2 -> needs 3
  assert not (st->0->>'qualified')::boolean and (st->0->>'needed')::int = 1, 'carol needs 1 more to take the spot';
  -- verified but zero-referral member
  st := public.referral_member_status(pg_temp.mid(e))->'rewards';
  assert not (st->0->>'qualified')::boolean, 'erin (rank 3) not in top 1';
  -- raising the number of spots needs no code change
  update public.referral_rewards set rank_limit = 3 where slug = 'spot';
  assert (public.referral_member_status(pg_temp.mid(e))->'rewards'->0->>'qualified')::boolean, 'erin now qualifies after config change';
  -- unverified members never qualify
  perform public.referral_verify_member(pg_temp.mid(pg_temp.signup('zed@example.com', a->>'referral_code')));
  begin insert into public.referral_rewards (slug, title, kind) values ('bad', 'Bad', 'rank'); assert false, 'rank needs rank_limit';
  exception when check_violation then null; end;
  perform pg_temp.pass('rewards configurable and derived');

  -- public output never contains an email
  assert public.referral_leaderboard()::text !~ '@', 'leaderboard has no emails';
  assert public.referral_member_status(pg_temp.mid(a))::text !~ '@', 'member status has no emails';
  assert (select count(*) from jsonb_array_elements(public.referral_leaderboard()->'entries') ent where ent ? 'email' or ent ? 'id' or ent ? 'referral_code') = 0, 'no private keys';
  perform pg_temp.pass('no private data in public payloads');

  -- request link
  assert public.referral_request_link('nobody@example.com', 'iph-r1')->>'send' = 'false', 'unknown email sends nothing';
  update public.waitlist_signups set link_emailed_at = null where id = pg_temp.mid(a);
  j := public.referral_request_link('ALICE+x@gmail.com', 'iph-r2');
  assert (j->>'send')::boolean and j->>'email' = 'alice@gmail.com', 'alias request goes to the registered address';
  assert not (public.referral_request_link('alice@gmail.com', 'iph-r3')->>'send')::boolean, 'cooldown on request';
  perform pg_temp.pass('request link');

  -- rate limit
  for n in 1..5 loop perform public.waitlist_signup('rl' || n || '@example.com', 'iph-rl'); end loop;
  assert public.waitlist_signup('rl9@example.com', 'iph-rl')->>'status' = 'rate_limited', 'signup rate limited';
  assert public.referral_request_link('alice@gmail.com', 'iph-rl')->>'status' = 'rate_limited', 'request rate limited (shared)';
  assert not exists (select 1 from public.waitlist_signups where email = 'rl9@example.com'), 'rate-limited signup not stored';
  perform pg_temp.pass('rate limiting');
end $$;

-- Privileges: the public API roles can reach nothing.
do $$
declare r text; t text; f text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach t in array array['waitlist_signups', 'waitlist_attempts', 'referrals', 'referral_rewards', 'referral_standings'] loop
      execute format('set local role %I', r);
      begin
        execute format('select 1 from public.%I limit 1', t);
        reset role; raise exception 'FAIL % can read %', r, t;
      exception when insufficient_privilege then reset role; end;
    end loop;
    foreach f in array array[
      'public.referral_leaderboard()', 'public.waitlist_signup(''a@b.co'', ''x'')', 'public.referral_request_link(''a@b.co'', ''x'')',
      'public.referral_verify_member(gen_random_uuid())', 'public.referral_member_status(gen_random_uuid())', 'public.gen_referral_code()',
      'public.canonical_email(''a@b.co'')', 'public.waitlist_join(''a@b.co'', ''x'')'] loop
      execute format('set local role %I', r);
      begin
        execute format('select %s', f);
        reset role; raise exception 'FAIL % can call %', r, f;
      exception when insufficient_privilege then reset role; end;
    end loop;
  end loop;
  set local role service_role;
  perform public.referral_leaderboard();
  reset role;
  raise notice 'PASS anon/authenticated locked out, service_role allowed';
end $$;
