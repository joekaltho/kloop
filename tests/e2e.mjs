// Full journey against a REAL Postgres (migrations applied) through the REAL Edge Function code.
// A tiny PostgREST stand-in forwards /rest/v1/rpc/<fn> to Postgres; Resend is captured in memory.
//   npm i --no-save pg      then      node --experimental-strip-types --no-warnings tests/e2e.mjs
// Uses standard PG* env vars. Creates and drops its own database.
import http from 'node:http';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const pg = require('pg');
import { handle as signup } from '../supabase/functions/waitlist-signup/index.ts';
import { handle as referral } from '../supabase/functions/referral/index.ts';

const DB = 'kloop_e2e';
const admin = new pg.Client({ database: 'postgres' }); await admin.connect();
await admin.query(`drop database if exists ${DB}`); await admin.query(`create database ${DB}`);
const db = new pg.Client({ database: DB }); await db.connect();
for (const f of ['tests/db/bootstrap.sql', 'supabase/migrations/0001_waitlist.sql', 'supabase/migrations/0002_referrals.sql'])
  await db.query(fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8'));

// --- PostgREST stand-in (service-role bearer required, like the real thing) ---
const KEY = 'service-role-key-for-tests';
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(req.url);
  if (!m || req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401).end('{}'); return; }
  const params = JSON.parse(raw || '{}'); const keys = Object.keys(params);
  try {
    const r = await db.query(`select public.${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => params[k]));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r.rows[0].r));
  } catch (e) { res.writeHead(400).end(JSON.stringify({ message: e.message })); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const env = { SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_SERVICE_ROLE_KEY: KEY,
  LINK_SECRET: 'e2e-link-secret', SITE_URL: 'https://kloop.test', RESEND_API_KEY: 're_test', EMAIL_FROM: 'Kloop <hi@kloop.test>' };

const outbox = [];
const fetchImpl = async (u, o) => {
  if (u.startsWith('https://api.resend.com')) { outbox.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ id: 'x' }) }; }
  return fetch(u, o);
};
let fail = 0; const check = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : extra); if (!cond) fail++; };
let ipn = 0;
const post = (fn, body, ip) => fn(new Request('http://x/', { method: 'POST', body: JSON.stringify(body), headers: { 'x-forwarded-for': ip || `10.0.0.${++ipn}` } }), env, fetchImpl).then(async (r) => ({ status: r.status, json: await r.json() }));
const get = () => referral(new Request('http://x/?action=leaderboard'), env, fetchImpl).then(async (r) => ({ status: r.status, json: await r.json(), cache: r.headers.get('cache-control') }));
const tokenFrom = (mail) => /referral\.html#t=([\w-]{22}\.[\w-]{32})/.exec(mail.text)[1];
const me = (token) => post(referral, { action: 'me', token });

// Admin configures rewards (values are test-only; nothing is seeded by the migration)
await db.query(`insert into public.referral_rewards (slug,title,description,kind,rank_limit,min_referrals,sort_order) values ('founding','Founding spot','Top of the board','rank',1,1,1)`);
await db.query(`insert into public.referral_rewards (slug,title,description,kind,min_referrals,sort_order) values ('early','Early access','Bring 2 friends','threshold',2,2)`);

// 1. Alice joins -> gets a link immediately + an email
let r = await post(signup, { email: 'Alice@Example.com' });
const aliceCode = r.json.referral_code;
check('1 alice joins and sees her referral code immediately', r.status === 200 && /^klp_[a-z0-9]{6}$/.test(aliceCode), JSON.stringify(r));
check('1 alice is emailed her link (confirm email)', outbox.length === 1 && outbox[0].to[0] === 'alice@example.com' && outbox[0].html.includes(`https://kloop.test/?ref=${aliceCode}`) && outbox[0].subject.startsWith('Confirm'));
check('1 signup response never includes the member token', !/[\w-]{22}\.[\w-]{32}/.test(JSON.stringify(r.json)));
const aliceToken = tokenFrom(outbox[0]);

// 2. Alice opens her email link: verified, nothing counted yet
r = await me(aliceToken);
check('2 alice opens link: verified, 0 referrals, not ranked yet', r.status === 200 && r.json.verified_now && r.json.verified_referrals === 0 && r.json.rank === null && r.json.referral_code === aliceCode, JSON.stringify(r));
check('2 reward progress shown (early access needs 2)', r.json.rewards.find((x) => x.slug === 'early').needed === 2 && !r.json.rewards.find((x) => x.slug === 'early').qualified);
r = await me(aliceToken);
check('2 reopening the link is harmless', r.json.verified_now === false && r.json.verified);

// 3. Bob joins through Alice's link: pending only
r = await post(signup, { email: 'bob@example.com', ref: aliceCode });
const bobCode = r.json.referral_code; const bobToken = tokenFrom(outbox.at(-1));
check('3 bob joins via alice link and gets his own code + email', r.status === 200 && bobCode !== aliceCode && outbox.at(-1).to[0] === 'bob@example.com');
r = await me(aliceToken);
check('3 referral is pending, not counted', r.json.pending_referrals === 1 && r.json.verified_referrals === 0 && r.json.rank === null, JSON.stringify(r.json));
check('3 leaderboard still empty', (await get()).json.entries.length === 0);
const mailsBefore = outbox.length;

// 4. Bob verifies -> referral counts, Alice is notified
r = await me(bobToken);
check('4 bob verifies', r.json.verified_now === true && r.json.verified_referrals === 0);
check('4 alice gets a notification email', outbox.length === mailsBefore + 1 && outbox.at(-1).to[0] === 'alice@example.com' && /1 successful referral/.test(outbox.at(-1).text) && /#1/.test(outbox.at(-1).text), outbox.at(-1)?.text);
r = await me(bobToken);
check('4 re-opening bob link does not notify again or double count', outbox.length === mailsBefore + 1);

// 5. Counts, leaderboard and rewards all update from the same records
r = await me(aliceToken);
check('5 alice: 1 verified referral, rank 1 of 1, founding spot qualified', r.json.verified_referrals === 1 && r.json.rank === 1 && r.json.total_ranked === 1 && r.json.rewards.find((x) => x.slug === 'founding').qualified, JSON.stringify(r.json));
check('5 alice needs 1 more for early access', r.json.rewards.find((x) => x.slug === 'early').needed === 1);
const lb = await get();
check('5 public leaderboard shows rank, handle, count', lb.status === 200 && lb.json.entries.length === 1 && lb.json.entries[0].rank === 1 && lb.json.entries[0].referrals === 1 && /^[0-9A-F]{6}$/.test(lb.json.entries[0].handle), JSON.stringify(lb.json));
check('5 leaderboard is cacheable', /max-age=30/.test(lb.cache));
check('5 leaderboard exposes no email / ids / codes', !/@|klp_|[0-9a-f]{8}-[0-9a-f]{4}/.test(JSON.stringify(lb.json)));
check('5 leaderboard lists reward definitions', lb.json.rewards.length === 2);
check('5 alice handle matches her leaderboard row', lb.json.entries[0].handle === r.json.handle);

// 6. Fraud / integrity through the real endpoints
let n = outbox.length;
r = await post(signup, { email: 'alice+again@example.com', ref: aliceCode });
check('6 self-referral via +alias is just a duplicate (no code leaked)', r.status === 200 && r.json.referral_code === undefined);
r = await post(signup, { email: 'bob@example.com', ref: aliceCode });
check('6 existing member cannot be re-attributed', r.json.referral_code === undefined);
r = await post(signup, { email: 'carol@example.com', ref: 'klp_zzzzzz' });
check('6 unknown code still signs up, nobody credited', r.status === 200 && !!r.json.referral_code);
r = await post(signup, { email: 'dan@example.com', ref: 'not-a-code' });
check('6 malformed code still signs up', r.status === 200 && !!r.json.referral_code);
r = await me(aliceToken);
check('6 alice still has exactly 1', r.json.verified_referrals === 1 && r.json.pending_referrals === 0);
check('6 duplicates inside cooldown send no extra email', outbox.slice(n).filter((m) => m.to[0] === 'alice@example.com' || m.to[0] === 'bob@example.com').length === 0);
r = await me(aliceToken.slice(0, -1) + (aliceToken.endsWith('A') ? 'B' : 'A'));
check('6 tampered token rejected', r.status === 401);
r = await me('x'); check('6 garbage token rejected', r.status === 401);
check('6 valid token still fine', (await me(aliceToken)).status === 200);

// 7. Retrieve link by email (no accounts)
n = outbox.length;
r = await post(referral, { action: 'request_link', email: 'nobody@example.com' });
check('7 unknown email: same answer, no email', r.status === 200 && r.json.ok && outbox.length === n && Object.keys(r.json).length === 1);
r = await post(referral, { action: 'request_link', email: 'alice@example.com' });
check('7 inside cooldown: same answer, no spam', r.status === 200 && outbox.length === n);
await db.query(`update public.waitlist_signups set link_emailed_at = now() - interval '10 minutes'`);
r = await post(referral, { action: 'request_link', email: 'ALICE+x@example.com' });
check('7 after cooldown the link is emailed to the registered address', outbox.length === n + 1 && outbox.at(-1).to[0] === 'alice@example.com' && outbox.at(-1).subject.startsWith('Your Kloop referral link'));
check('7 emailed link works', (await me(tokenFrom(outbox.at(-1)))).json.verified_referrals === 1);

// 8. Second referral: Alice reaches early access; ranking by count
r = await post(signup, { email: 'erin@example.com', ref: aliceCode }); const erinToken = tokenFrom(outbox.at(-1));
await me(erinToken);
r = await me(aliceToken);
check('8 alice at 2 referrals qualifies for early access too', r.json.verified_referrals === 2 && r.json.rewards.every((x) => x.qualified), JSON.stringify(r.json.rewards));
// Bob (verified) brings Frank: bob is rank 2
r = await post(signup, { email: 'frank@example.com', ref: bobCode }); await me(tokenFrom(outbox.at(-1)));
const lb2 = (await get()).json;
check('8 leaderboard ranks by verified referrals', lb2.entries.map((e) => `${e.rank}:${e.referrals}`).join() === '1:2,2:1' && lb2.total_ranked === 2, JSON.stringify(lb2.entries));
r = await me(bobToken);
check('8 bob: rank 2, needs 2 to take the founding spot', r.json.rank === 2 && r.json.rewards.find((x) => x.slug === 'founding').needed === 2, JSON.stringify(r.json.rewards));

// 9. Protection
r = await referral(new Request('http://x/?action=members'), env, fetchImpl); check('9 unknown GET action rejected', r.status === 400);
r = await post(referral, { action: 'drop tables' }); check('9 unknown action rejected', r.status === 400);
r = await post(referral, { action: 'request_link', email: 'nope' }); check('9 invalid email rejected', r.status === 400);
for (let i = 0; i < 5; i++) await post(signup, { email: `rl${i}@example.com` }, '9.9.9.9');
r = await post(signup, { email: 'rl9@example.com' }, '9.9.9.9'); check('9 per-IP rate limit', r.status === 429);
r = await post(referral, { action: 'request_link', email: 'alice@example.com' }, '9.9.9.9'); check('9 request_link shares the limit', r.status === 429);
const direct = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/referral_leaderboard`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('9 RPC without service key is refused', direct.status === 401);
check('9 service key never appears in any response or email', !JSON.stringify(outbox).includes(KEY) && !JSON.stringify(lb2).includes(KEY));

// 10. Existing landing-page contract still holds
r = await post(signup, { email: 'plain@example.com' });
check('10 plain signup (no ref) keeps working', r.status === 200 && r.json.ok === true);
r = await post(signup, { email: 'plain@example.com' });
check('10 duplicate looks like success', r.status === 200 && Object.keys(r.json).join() === 'ok');

server.close(); await db.end(); await admin.query(`drop database ${DB}`); await admin.end();
console.log(fail ? `\n${fail} FAILED` : '\nALL E2E CHECKS PASSED'); process.exit(fail ? 1 : 0);
