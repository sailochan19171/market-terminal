// Verifying a Firebase sign-in, without trusting the browser that sent it.
//
// The browser signs in with Google and receives an ID token - a JWT signed by Google. Anyone can post a string
// to our session endpoint, so the token is checked here properly: the signature against Google's published
// certificates, the issuer and audience against this project, and the expiry against the clock. Only then does
// a session exist. This is the same check firebase-admin performs; it is written out so the server needs no
// service-account key and no extra dependency.
import { createHmac, createVerify, timingSafeEqual, X509Certificate } from "node:crypto";
import { config } from "../config";

const CERTS = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

export interface FirebaseUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  provider: string;
}

export class AuthError extends Error {}

/** Sign-in is available only when a project is configured; the UI asks first and hides the button otherwise. */
export const configured = () => Boolean(config.FIREBASE_PROJECT_ID && config.SESSION_SECRET);

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

let certs: { at: number; keys: Record<string, string> } | null = null;

/** Google's signing certificates, cached for the hour they are valid for. */
async function signingKeys(): Promise<Record<string, string>> {
  if (certs && Date.now() - certs.at < 60 * 60_000) return certs.keys;
  const res = await fetch(CERTS, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new AuthError(`Could not fetch Google's signing certificates (HTTP ${res.status}).`);
  const keys = (await res.json()) as Record<string, string>;
  certs = { at: Date.now(), keys };
  return keys;
}

/** The user inside a Firebase ID token, once the token is proved genuine and current. */
export async function verifyIdToken(token: string): Promise<FirebaseUser> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("That sign-in token is malformed.");
  const [rawHeader, rawPayload, rawSignature] = parts;

  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(b64url(rawHeader).toString("utf8"));
    claims = JSON.parse(b64url(rawPayload).toString("utf8"));
  } catch {
    throw new AuthError("That sign-in token could not be read.");
  }
  if (header.alg !== "RS256" || !header.kid) throw new AuthError("That sign-in token is not signed the way Firebase signs one.");

  const project = config.FIREBASE_PROJECT_ID;
  if (claims.aud !== project) throw new AuthError("That sign-in token was issued for a different project.");
  if (claims.iss !== `https://securetoken.google.com/${project}`) throw new AuthError("That sign-in token was not issued by Firebase.");
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) throw new AuthError("That sign-in has expired. Sign in again.");
  if (typeof claims.iat === "number" && claims.iat > now + 300) throw new AuthError("That sign-in token is dated in the future.");
  if (typeof claims.sub !== "string" || !claims.sub) throw new AuthError("That sign-in token names no user.");

  const cert = (await signingKeys())[header.kid];
  if (!cert) throw new AuthError("That sign-in token was signed with a key Google no longer publishes.");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${rawHeader}.${rawPayload}`);
  if (!verifier.verify(new X509Certificate(cert).publicKey, b64url(rawSignature))) throw new AuthError("That sign-in token's signature does not check out.");

  const firebase = (claims.firebase ?? {}) as { sign_in_provider?: string };
  return {
    uid: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : null,
    picture: typeof claims.picture === "string" ? claims.picture : null,
    provider: firebase.sign_in_provider ?? "unknown",
  };
}

// --- our own session cookie ----------------------------------------------------------------
// The Firebase token lasts an hour; a reader should not be signed out every hour. After one verified sign-in we
// issue our own cookie, signed with SESSION_SECRET so it cannot be forged, and carrying nothing but the user id
// and an expiry.

export const COOKIE = "mt_session";
const DAYS = 30;

const sign = (body: string) => createHmac("sha256", config.SESSION_SECRET).update(body).digest("base64url");

export function issue(uid: string): { value: string; maxAge: number } {
  const expires = Math.floor(Date.now() / 1000) + DAYS * 86_400;
  const body = `${Buffer.from(uid).toString("base64url")}.${expires}`;
  return { value: `${body}.${sign(body)}`, maxAge: DAYS * 86_400 };
}

/** The user id inside a session cookie, or null when it is missing, altered or expired. */
export function readSession(cookie: string | undefined | null): string | null {
  if (!cookie || !config.SESSION_SECRET) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [uid64, expires, mac] = parts;
  const expected = sign(`${uid64}.${expires}`);
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expires) < Math.floor(Date.now() / 1000)) return null;
  return Buffer.from(uid64, "base64url").toString("utf8");
}
