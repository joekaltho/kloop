// Transactional email via Resend. Fail-soft: a missing config or a provider error is logged and never breaks signup.
import { makeToken } from "./token.ts";

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function siteUrl(env: any): string {
  return (env.SITE_URL || "").trim().replace(/\/+$/, "");
}

export async function sendMail(env: any, fetchImpl: any, m: { to: string; subject: string; html: string; text: string }): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) { console.error("email not configured (RESEND_API_KEY / EMAIL_FROM)"); return false; }
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
    });
    if (!res.ok) { console.error("email provider rejected message", res.status); return false; }
    return true;
  } catch (e) {
    console.error("email send failed", e instanceof Error ? e.message : "unknown");
    return false;
  }
}

function layout(heading: string, bodyHtml: string, button: { label: string; url: string }, footer: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#F5F3EE;font-family:Helvetica,Arial,sans-serif;color:#14201B">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FDFCF9;border:2px solid #14201B;border-radius:14px">
<tr><td style="padding:32px">
<div style="font-size:26px;font-weight:800;letter-spacing:-.03em;margin-bottom:24px">KL<span style="color:#1B7F4B">∞</span>P</div>
<h1 style="font-size:24px;line-height:1.2;margin:0 0 16px">${esc(heading)}</h1>
${bodyHtml}
<p style="margin:28px 0"><a href="${esc(button.url)}" style="display:inline-block;background:#1B7F4B;color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:999px">${esc(button.label)}</a></p>
<p style="font-size:13px;color:#4A574F;margin:0">${esc(footer)}</p>
</td></tr></table></td></tr></table></body></html>`;
}

const FOOTER = "You are receiving this because this address was used to join the Kloop waitlist. If that was not you, you can ignore this email.";

// The email every member gets: their personal link + the confirm / dashboard button.
export async function sendMemberLink(env: any, fetchImpl: any, m: { memberId: string; email: string; code: string; verified: boolean }): Promise<boolean> {
  const site = siteUrl(env);
  if (!env.LINK_SECRET || !site) { console.error("LINK_SECRET or SITE_URL missing, member email skipped"); return false; }
  const dash = `${site}/referral.html#t=${await makeToken(env.LINK_SECRET, m.memberId)}`;
  const share = `${site}/?ref=${m.code}`;
  const heading = m.verified ? "Your Kloop referral link" : "Welcome to the Kloop waitlist";
  const intro = m.verified
    ? "Here is your personal referral link and your dashboard, where you can see your referrals, your leaderboard position and your reward progress."
    : "Confirm your email to activate your referral dashboard. Referrals only count once your email is confirmed.";
  const html = layout(
    heading,
    `<p style="font-size:16px;line-height:1.6;margin:0 0 16px">${esc(intro)}</p>
<p style="font-size:16px;line-height:1.6;margin:0 0 8px">Your personal link. Every friend who joins and confirms their email counts as a successful referral:</p>
<p style="font-size:16px;margin:0"><a href="${esc(share)}" style="color:#1B7F4B;font-weight:700">${esc(share)}</a></p>`,
    { label: m.verified ? "Open my dashboard" : "Confirm my email", url: dash },
    FOOTER,
  );
  const text = `${heading}\n\n${intro}\n\nYour personal link:\n${share}\n\n${m.verified ? "Open your dashboard" : "Confirm your email"}:\n${dash}\n\n${FOOTER}`;
  return sendMail(env, fetchImpl, { to: m.email, subject: m.verified ? "Your Kloop referral link" : "Confirm your email to lock in your Kloop spot", html, text });
}

// Sent to a (verified) referrer when one of their invites confirms their email.
export async function sendReferralNotice(env: any, fetchImpl: any, m: { memberId: string; email: string; referrals: number; rank: number | null }): Promise<boolean> {
  const site = siteUrl(env);
  if (!env.LINK_SECRET || !site) { console.error("LINK_SECRET or SITE_URL missing, referral notice skipped"); return false; }
  const dash = `${site}/referral.html#t=${await makeToken(env.LINK_SECRET, m.memberId)}`;
  const pos = m.rank ? `You are now #${m.rank} on the leaderboard.` : "Keep going to climb the leaderboard.";
  const line = `You now have ${m.referrals} successful referral${m.referrals === 1 ? "" : "s"}. ${pos}`;
  const html = layout("A friend just joined Kloop through your link", `<p style="font-size:16px;line-height:1.6;margin:0">${esc(line)}</p>`, { label: "See my progress", url: dash }, FOOTER);
  const text = `A friend just joined Kloop through your link.\n\n${line}\n\nSee your progress:\n${dash}\n\n${FOOTER}`;
  return sendMail(env, fetchImpl, { to: m.email, subject: "A friend just joined Kloop through your link", html, text });
}
