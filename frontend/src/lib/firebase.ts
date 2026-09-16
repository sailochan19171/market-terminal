"use client";

// Firebase in the browser, loaded only when someone actually signs in.
//
// The SDK is a large download, so it is imported on the click rather than on every page load. The configuration
// below is public by design - Firebase keys identify a project, they do not authorise anything; what protects
// the account is Google's sign-in and the server's verification of the token that comes back.
const CONFIG = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
};

export const firebaseReady = Boolean(CONFIG.apiKey && CONFIG.projectId && CONFIG.authDomain);

async function auth() {
  const [{ initializeApp, getApps }, authModule] = await Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
  ]);
  const app = getApps()[0] ?? initializeApp(CONFIG);
  return { ...authModule, instance: authModule.getAuth(app) };
}

/** Sign in with Google and hand the resulting token to our server, which decides whether to trust it. */
export async function signInWithGoogle(): Promise<void> {
  if (!firebaseReady) throw new Error("Sign-in is not configured for this site yet.");
  const a = await auth();
  const provider = new a.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const credential = await a.signInWithPopup(a.instance, provider);
  await exchange(await credential.user.getIdToken());
}

/** Create an account with an email address and a password, or sign in to one that exists. */
export async function signUpWithEmail(email: string, password: string, name?: string): Promise<void> {
  if (!firebaseReady) throw new Error("Sign-in is not configured for this site yet.");
  const a = await auth();
  const credential = await a.createUserWithEmailAndPassword(a.instance, email, password);
  if (name) await a.updateProfile(credential.user, { displayName: name });
  await exchange(await credential.user.getIdToken(true));
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  if (!firebaseReady) throw new Error("Sign-in is not configured for this site yet.");
  const a = await auth();
  const credential = await a.signInWithEmailAndPassword(a.instance, email, password);
  await exchange(await credential.user.getIdToken());
}

export async function signOut(): Promise<void> {
  await fetch("/api/v2/auth/session", { method: "DELETE" });
  if (firebaseReady) {
    const a = await auth().catch(() => null);
    if (a) await a.signOut(a.instance).catch(() => undefined);
  }
}

/** Trade a Firebase token for a session on this site. The server verifies it before anything is recorded. */
async function exchange(idToken: string): Promise<void> {
  const res = await fetch("/api/v2/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) {
    const said = await res.json().catch(() => ({}));
    throw new Error((said as { message?: string }).message ?? `Sign-in failed (${res.status}).`);
  }
}

/** Firebase's own error codes are not sentences; these are. */
export function readableAuthError(e: unknown): string {
  const code = (e as { code?: string })?.code ?? "";
  const known: Record<string, string> = {
    "auth/popup-closed-by-user": "The sign-in window was closed before it finished.",
    "auth/popup-blocked": "Your browser blocked the sign-in window. Allow pop-ups for this site and try again.",
    "auth/cancelled-popup-request": "Another sign-in window is already open.",
    "auth/unauthorized-domain": "This site's address is not on the Firebase project's list of authorised domains.",
    "auth/email-already-in-use": "There is already an account with that email address. Sign in instead.",
    "auth/invalid-email": "That does not look like an email address.",
    "auth/weak-password": "Choose a password of at least six characters.",
    "auth/invalid-credential": "That email address and password do not match an account.",
    "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
    "auth/operation-not-allowed": "That sign-in method is not enabled on the Firebase project.",
    "auth/network-request-failed": "The network did not reach Google. Check the connection and try again.",
  };
  return known[code] ?? (e as Error)?.message ?? "Sign-in failed.";
}
