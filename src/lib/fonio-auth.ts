const SECRET = process.env.FONIO_WEBHOOK_SECRET?.trim();

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function presentedSecret(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const header = req.headers.get("x-fonio-secret");
  if (header) return header.trim();
  const url = new URL(req.url);
  const q = url.searchParams.get("secret");
  if (q) return q.trim();
  return null;
}

export function verifyFonioRequest(req: Request): boolean {
  if (!SECRET) {
    console.warn("[fonio-auth] FONIO_WEBHOOK_SECRET is unset — accepting request UNVERIFIED.");
    return true;
  }
  const given = presentedSecret(req);
  return !!given && safeEqual(given, SECRET);
}
