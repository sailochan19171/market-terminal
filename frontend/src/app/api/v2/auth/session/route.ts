// The sign-in session: who is signed in, signing in, and signing out.
//
// POST takes the ID token the browser received from Firebase, proves it, records the account and sets a signed
// cookie of our own. GET says who that cookie belongs to. DELETE ends it. The cookie is httpOnly, so page
// scripts cannot read it, and SameSite=Lax, so another site cannot use it.
import { AuthError, COOKIE, configured, issue, readSession, verifyIdToken } from "@/server/auth/firebase";
import { find, publicUser, signIn, touch } from "@/server/auth/users";
import { ApiError, body, db, handle, json } from "@/server/api/common";

const cookieOf = (req: Request): string | undefined =>
  req.headers.get("cookie")?.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);

const secure = (req: Request) => new URL(req.url).protocol === "https:";

export const GET = handle(async (req: Request) => {
  if (!configured()) return json({ configured: false, user: null }, { shared: false });
  const uid = readSession(cookieOf(req));
  if (!uid) return json({ configured: true, user: null }, { shared: false });
  const user = find(db(), uid);
  if (!user) return json({ configured: true, user: null }, { shared: false });
  touch(db(), uid);
  return json({ configured: true, user: publicUser(user) }, { shared: false });
});

export const POST = handle(async (req: Request) => {
  if (!configured()) throw new ApiError(503, "Sign-in is not configured on this deployment.", { error: "not_configured" });
  const idToken = String((await body<{ idToken?: string }>(req)).idToken ?? "");
  if (!idToken) throw new ApiError(400, "No sign-in token was sent.", { error: "bad_request" });

  let who;
  try {
    who = await verifyIdToken(idToken);
  } catch (e) {
    if (e instanceof AuthError) throw new ApiError(401, e.message, { error: "unauthorised" });
    throw e;
  }
  const user = signIn(db(), who);
  const session = issue(who.uid);
  return json({ configured: true, user: publicUser(user) }, {
    shared: false,
    headers: { "Set-Cookie": `${COOKIE}=${session.value}; Path=/; Max-Age=${session.maxAge}; HttpOnly; SameSite=Lax${secure(req) ? "; Secure" : ""}` },
  });
});

export const DELETE = handle(async (req: Request) => json({ configured: configured(), user: null }, {
  shared: false,
  headers: { "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure(req) ? "; Secure" : ""}` },
}));
