// Public waitlist endpoint. Deploy with verify_jwt = false. Uses only built-in env vars:
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-side only). Optional secret: ALLOWED_ORIGINS (comma-separated).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function hmac(key: string, value: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handle(req: any, env: any, fetchImpl: any = fetch): Promise<Response> {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s: string) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") || "";
  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": allowed.length === 0 ? "*" : allowed.includes(origin) ? origin : allowed[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  try {
    const raw = await req.text();
    if (raw.length > 2048) return json(413, { error: "too_large" });
    let body: any;
    try { body = JSON.parse(raw); } catch { return json(400, { error: "invalid_json" }); }
    if (!body || typeof body !== "object") return json(400, { error: "invalid_json" });

    if (typeof body.company === "string" && body.company.trim() !== "") return json(200, { ok: true }); // honeypot: bots

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) return json(400, { error: "invalid_email" });

    const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
    const ipHash = await hmac(env.SUPABASE_SERVICE_ROLE_KEY, ip);

    const res = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/waitlist_join`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ p_email: email, p_ip_hash: ipHash }),
    });
    if (!res.ok) { console.error("waitlist_join failed", res.status); return json(500, { error: "server_error" }); }
    const result = await res.json();
    if (result === "rate_limited") return json(429, { error: "rate_limited" });
    if (result === "created" || result === "duplicate") return json(200, { ok: true }); // duplicates look identical
    return json(500, { error: "server_error" });
  } catch (e) {
    console.error("waitlist-signup error", e instanceof Error ? e.message : "unknown");
    return json(500, { error: "server_error" });
  }
}

const D = (globalThis as any).Deno;
if (D) D.serve((req: Request) => handle(req, D.env.toObject()));
