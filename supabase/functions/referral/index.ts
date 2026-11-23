// Referral API. Deploy with verify_jwt = false. Same env as waitlist-signup (LINK_SECRET is required here).
//   GET  ?action=leaderboard          public leaderboard + reward definitions (no private data)
//   POST {action:"me", token}         member dashboard; opening the emailed link also verifies the email
//   POST {action:"request_link", email}  emails the member their link; always answers the same way
import { EMAIL_RE, clientIpHash, defer, makeHttp, readBody, rpc } from "../_shared/http.ts";
import { sendMemberLink, sendReferralNotice } from "../_shared/mail.ts";
import { readToken } from "../_shared/token.ts";

export async function handle(req: any, env: any, fetchImpl: any = fetch): Promise<Response> {
  const { cors, json } = makeHttp(req, env, "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  try {
    if (req.method === "GET") {
      if (new URL(req.url).searchParams.get("action") !== "leaderboard") return json(400, { error: "invalid_action" });
      const data = await rpc(env, fetchImpl, "referral_leaderboard", { p_limit: 50 });
      return json(200, { ok: true, ...data }, { "Cache-Control": "public, max-age=30" });
    }
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

    const parsed = await readBody(req);
    if (parsed.error) return json(parsed.status!, { error: parsed.error });
    const body = parsed.body;

    if (body.action === "me") {
      if (!env.LINK_SECRET) { console.error("LINK_SECRET missing"); return json(500, { error: "server_error" }); }
      const id = await readToken(env.LINK_SECRET, body.token);
      if (!id) return json(401, { error: "invalid_link" });

      const v = await rpc(env, fetchImpl, "referral_verify_member", { p_member_id: id });
      if (!v?.found) return json(401, { error: "invalid_link" });

      // The first time an invited person confirms, tell their referrer (only verified referrers are returned).
      if (v.verified_now && v.referrer) {
        await defer(sendReferralNotice(env, fetchImpl, {
          memberId: v.referrer.member_id, email: v.referrer.email, referrals: v.referrer.verified_referrals, rank: v.referrer.rank ?? null,
        }));
      }

      const s = await rpc(env, fetchImpl, "referral_member_status", { p_member_id: id });
      if (!s?.found) return json(401, { error: "invalid_link" });
      return json(200, {
        ok: true, verified_now: !!v.verified_now, handle: s.handle, referral_code: s.referral_code, verified: s.verified,
        verified_referrals: s.verified_referrals, pending_referrals: s.pending_referrals, rank: s.rank, total_ranked: s.total_ranked, rewards: s.rewards,
      }, { "Cache-Control": "no-store" });
    }

    if (body.action === "request_link") {
      if (typeof body.company === "string" && body.company.trim() !== "") return json(200, { ok: true }); // honeypot
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!email || email.length > 254 || !EMAIL_RE.test(email)) return json(400, { error: "invalid_email" });

      const r = await rpc(env, fetchImpl, "referral_request_link", { p_email: email, p_ip_hash: await clientIpHash(req, env) });
      if (r?.status === "rate_limited") return json(429, { error: "rate_limited" });
      if (r?.status !== "ok") return json(500, { error: "server_error" });
      if (r.send) {
        await defer(sendMemberLink(env, fetchImpl, { memberId: r.member_id, email: r.email, code: r.referral_code, verified: !!r.verified }));
      }
      return json(200, { ok: true }); // identical whether or not the email is on the list
    }

    return json(400, { error: "invalid_action" });
  } catch (e) {
    console.error("referral error", e instanceof Error ? e.message : "unknown");
    return json(500, { error: "server_error" });
  }
}

const D = (globalThis as any).Deno;
if (D) D.serve((req: Request) => handle(req, D.env.toObject()));
