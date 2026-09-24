"use client";

// Signing in, from the header.
//
// Google is one click. An email address and a password are there for anyone who would rather not use a Google
// account. Either way the browser ends up with a token from Firebase, the server checks it, and the account is
// recorded - nothing here trusts what the page says about who you are.
import clsx from "clsx";
import { LogIn, LogOut, User as UserIcon, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { firebaseReady, readableAuthError, signInWithEmail, signInWithGoogle, signOut, signUpWithEmail } from "@/lib/firebase";

interface Account { uid: string; email: string | null; name: string | null; picture: string | null; provider: string | null; signIns: number; since: string }
interface SessionState { configured: boolean; user: Account | null }

/** Google's mark, drawn rather than fetched so the button works offline and in dark mode. */
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden className="shrink-0">
      <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.7-.4-3.9H24v7.1h12.1c-.2 1.8-1.6 4.6-4.5 6.4l6.9 5.3c4.1-3.8 6.6-9.4 6.6-15z" />
      <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.3c-1.9 1.3-4.4 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-7.1 5.5C8.1 41.1 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.5 28.5c-.5-1.4-.7-2.9-.7-4.5s.3-3.1.7-4.5l-7.1-5.5C2.9 16.9 2 20.3 2 24s.9 7.1 2.4 10l7.1-5.5z" />
      <path fill="#EA4335" d="M24 10.7c4.1 0 6.9 1.8 8.5 3.2l6.2-6C34.9 4.5 29.9 2 24 2 15.4 2 8.1 6.9 4.4 14l7.1 5.5c1.8-5.3 6.7-8.8 12.5-8.8z" />
    </svg>
  );
}

export function SignIn() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"in" | "up">("in");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    // Every write happens after an await: a state change made synchronously inside an effect cascades renders.
    const res = await fetch("/api/v2/auth/session").catch(() => null);
    const said = res?.ok ? await res.json().catch(() => null) : null;
    setSession((said as SessionState | null) ?? { configured: false, user: null });
  }, []);

  // Reading the session is exactly what an effect is for: ask an external system, then record what it said.
  // Every write inside load() happens after an await, so no render cascades from this.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
      await load();
      setOpen(false);
      setForm({ name: "", email: "", password: "" });
    } catch (e) {
      setProblem(readableAuthError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!session?.configured && !firebaseReady) return null; // nothing to offer until a project is configured

  const user = session?.user ?? null;

  return (
    <div className="relative" ref={box}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-2.5 py-1.5 text-sm font-medium text-slate-600 transition hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:text-slate-300">
        {user?.picture
          // eslint-disable-next-line @next/next/no-img-element -- a Google avatar on an arbitrary CDN host
          ? <img src={user.picture} alt="" className="h-5 w-5 rounded-full" referrerPolicy="no-referrer" />
          : user ? <UserIcon size={16} /> : <LogIn size={16} />}
        <span className="hidden sm:inline">{user ? (user.name ?? user.email ?? "Account").split(" ")[0] : "Sign in"}</span>
      </button>

      {open && (
        <div role="dialog" aria-label="Account"
          className="absolute right-0 z-50 mt-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-start justify-between">
            <p className="text-sm font-semibold">{user ? "Signed in" : mode === "in" ? "Sign in" : "Create an account"}</p>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="text-slate-400 hover:text-slate-600"><X size={15} /></button>
          </div>

          {user ? (
            <div className="mt-3 space-y-3">
              <div className="flex items-center gap-3">
                {user.picture
                  // eslint-disable-next-line @next/next/no-img-element -- a Google avatar on an arbitrary CDN host
                  ? <img src={user.picture} alt="" className="h-10 w-10 rounded-full" referrerPolicy="no-referrer" />
                  : <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800"><UserIcon size={18} /></span>}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{user.name ?? "Account"}</p>
                  <p className="truncate text-xs text-slate-500">{user.email}</p>
                </div>
              </div>
              <p className="text-xs text-slate-500">Your watchlist, portfolio and alerts stay on this device for now; signing in records the account so they can follow you across devices.</p>
              <button type="button" disabled={busy} onClick={() => run(signOut)}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium transition hover:border-rose-300 hover:text-rose-600 disabled:opacity-60 dark:border-slate-700">
                <LogOut size={15} /> Sign out
              </button>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <button type="button" disabled={busy} onClick={() => run(signInWithGoogle)}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-indigo-300 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">
                <GoogleMark /> Continue with Google
              </button>

              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-400">
                <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />or<span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
              </div>

              <form className="space-y-2" onSubmit={(e) => {
                e.preventDefault();
                void run(() => (mode === "up" ? signUpWithEmail(form.email, form.password, form.name) : signInWithEmail(form.email, form.password)));
              }}>
                {mode === "up" && (
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Your name" autoComplete="name"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950" />
                )}
                <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} type="email" required placeholder="you@example.com" autoComplete="email"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950" />
                <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} type="password" required minLength={6} placeholder="Password"
                  autoComplete={mode === "up" ? "new-password" : "current-password"}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950" />
                <button type="submit" disabled={busy}
                  className={clsx("w-full rounded-xl px-3 py-2 text-sm font-semibold text-white transition disabled:opacity-60", busy ? "bg-slate-400" : "bg-indigo-600 hover:bg-indigo-700")}>
                  {busy ? "Working…" : mode === "up" ? "Create account" : "Sign in"}
                </button>
              </form>

              <button type="button" onClick={() => { setMode(mode === "in" ? "up" : "in"); setProblem(null); }}
                className="w-full text-center text-xs text-indigo-700 hover:underline dark:text-indigo-300">
                {mode === "in" ? "No account yet? Create one" : "Already have an account? Sign in"}
              </button>
            </div>
          )}

          {problem && <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{problem}</p>}
          {!firebaseReady && <p className="mt-3 text-xs text-slate-500">Sign-in is not configured for this site yet.</p>}
        </div>
      )}
    </div>
  );
}
