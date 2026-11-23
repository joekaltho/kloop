// Stateless member link token: <member id>.<HMAC of the id with LINK_SECRET>. It is only ever delivered by email,
// so opening it proves control of the mailbox. Nothing is stored; rotate LINK_SECRET to revoke every link.
import { hmacBytes } from "./http.ts";

const TOKEN_RE = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{32}$/;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  return Uint8Array.from(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
}

function bytesToUuid(b: Uint8Array): string {
  const h = Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function mac(secret: string, uuid: string): Promise<string> {
  return b64url(new Uint8Array(await hmacBytes(secret, "kloop-member-v1:" + uuid))).slice(0, 32);
}

export async function makeToken(secret: string, memberId: string): Promise<string> {
  return `${b64url(uuidToBytes(memberId))}.${await mac(secret, memberId)}`;
}

// Returns the member id for a valid token, otherwise null.
export async function readToken(secret: string, token: unknown): Promise<string | null> {
  if (!secret || typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const [idPart, macPart] = token.split(".");
  const idBytes = fromB64url(idPart);
  if (idBytes.length !== 16) return null;
  const id = bytesToUuid(idBytes);
  const expected = await mac(secret, id);
  let diff = expected.length ^ macPart.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (macPart.charCodeAt(i) || 0);
  return diff === 0 ? id : null;
}
