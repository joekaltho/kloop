// Public waitlist endpoint. Deploy with verify_jwt = false. Built-in env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server-side only).
// Optional secrets: ALLOWED_ORIGINS (comma-separated), and for referral emails: LINK_SECRET, SITE_URL, RESEND_API_KEY, EMAIL_FROM.
// A signup is always saved first; if email is not configured or fails, the signup still succeeds.
import { EMAIL_RE, REF_RE, clientIpHash, defer, makeHttp, readBody, rpc } from "../_shared/http.ts";
import { sendMemberLink } from "../_shared/mail.ts";

export async function handle(req: any, env: any, fetchImpl: any = fetch): Promise<Response> {
  const { cors, json } = makeHttp(req, env, "POST, OPTIONS");

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  try {
    const parsed = await readBody(req);
    if (parsed.error) return json(parsed.status!, { error: parsed.error });
    const body = parsed.body;

    if (typeof body.company === "string" && body.company.trim() !== "") return json(200, { ok: true }); // honeypot: bots

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) return json(400, { error: "invalid_email" });

    // Malformed referral codes are ignored (never an error) so a bad link cannot block a signup.
    const refRaw = typeof body.ref === "string" ? body.ref.trim().toLowerCase() : "";
    const ref = REF_RE.test(refRaw) ? refRaw : null;

    const result = await rpc(env, fetchImpl, "waitlist_signup", {
      p_email: email,
      p_ip_hash: await clientIpHash(req, env),
      p_ref_code: ref,
    });
    if (result?.status === "rate_limited") return json(429, { error: "rate_limited" });
    if (result?.status !== "created" && result?.status !== "duplicate") return json(500, { error: "server_error" });

    if (result.send) {
      await defer(sendMemberLink(env, fetchImpl, { memberId: result.member_id, email: result.email, code: result.referral_code, verified: !!result.verified }));
    }

    // Only a brand-new signup gets its code back; duplicates look identical to before (nothing about existing members leaks).
    return json(200, result.status === "created" ? { ok: true, referral_code: result.referral_code } : { ok: true });
  } catch (e) {
    console.error("waitlist-signup error", e instanceof Error ? e.message : "unknown");
    return json(500, { error: "server_error" });
  }
}

const D = (globalThis as any).Deno;
if (D) D.serve((req: Request) => handle(req, D.env.toObject()));
