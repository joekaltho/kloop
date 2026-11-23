// Shared plumbing for the public Edge Functions. No secrets are ever returned to callers.
const enc = new TextEncoder();

export function makeHttp(req: any, env: any, methods: string) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s: string) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") || "";
  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": allowed.length === 0 ? "*" : allowed.includes(origin) ? origin : allowed[0],
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
  const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", ...extra } });
  return { cors, json };
}

export function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacBytes(key: string, value: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(value));
}

export async function hmac(key: string, value: string): Promise<string> {
  return toHex(await hmacBytes(key, value));
}

export async function clientIpHash(req: any, env: any): Promise<string> {
  const ip = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  return hmac(env.SUPABASE_SERVICE_ROLE_KEY, ip);
}

// Reads a small JSON object body. Returns an error code instead of throwing.
export async function readBody(req: any, max = 2048): Promise<{ body?: any; status?: number; error?: string }> {
  const raw = await req.text();
  if (raw.length > max) return { status: 413, error: "too_large" };
  let body: any;
  try { body = JSON.parse(raw); } catch { return { status: 400, error: "invalid_json" }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, error: "invalid_json" };
  return { body };
}

// Calls a Postgres function through PostgREST with the service-role key (server side only).
export async function rpc(env: any, fetchImpl: any, fn: string, params: Record<string, unknown>): Promise<any> {
  const res = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`${fn} failed ${res.status}`);
  return res.json();
}

// Runs slow side effects (sending email) after the response when the runtime supports it; otherwise awaits them.
export async function defer(p: Promise<unknown>): Promise<void> {
  const safe = p.catch((e) => console.error("deferred task failed", e instanceof Error ? e.message : "unknown"));
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(safe);
  else await safe;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const REF_RE = /^klp_[a-z0-9]{6}$/;
