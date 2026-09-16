// Who has signed in, kept in the same database as everything else.
//
// Only what the sign-in itself provides is stored - the account id, the address, the display name and picture -
// with when they first arrived and when they were last seen. No password ever reaches this server: Google holds
// the credential and Firebase vouches for it.
import type { Db } from "../db";
import { now } from "../db";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_user (
    uid         TEXT PRIMARY KEY,       -- the Firebase account id
    email       TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    name        TEXT,
    picture     TEXT,
    provider    TEXT,                   -- google.com, password, ...
    sign_ins    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_app_user_email ON app_user(email);
`;

export interface User {
  uid: string; email: string | null; email_verified: number; name: string | null; picture: string | null;
  provider: string | null; sign_ins: number; created_at: string; last_seen_at: string;
}

let ready = false;
export function ensureSchema(db: Db) {
  if (ready) return;
  db.exec(SCHEMA);
  ready = true;
}

export interface Identity {
  uid: string; email: string | null; emailVerified: boolean; name: string | null; picture: string | null; provider: string;
}

/** Record a sign-in: the first creates the account, the rest update what the provider now says about it. */
export function signIn(db: Db, who: Identity): User {
  ensureSchema(db);
  const stamp = now();
  const existing = db.get<User>("SELECT * FROM app_user WHERE uid = ?", [who.uid]);
  if (existing) {
    db.run(
      "UPDATE app_user SET email = ?, email_verified = ?, name = ?, picture = ?, provider = ?, sign_ins = sign_ins + 1, last_seen_at = ? WHERE uid = ?",
      [who.email, who.emailVerified ? 1 : 0, who.name, who.picture, who.provider, stamp, who.uid]);
  } else {
    db.run(
      "INSERT INTO app_user (uid, email, email_verified, name, picture, provider, sign_ins, created_at, last_seen_at) VALUES (?,?,?,?,?,?,1,?,?)",
      [who.uid, who.email, who.emailVerified ? 1 : 0, who.name, who.picture, who.provider, stamp, stamp]);
  }
  return db.get<User>("SELECT * FROM app_user WHERE uid = ?", [who.uid])!;
}

export function find(db: Db, uid: string): User | null {
  ensureSchema(db);
  return db.get<User>("SELECT * FROM app_user WHERE uid = ?", [uid]) ?? null;
}

export function touch(db: Db, uid: string) {
  ensureSchema(db);
  db.run("UPDATE app_user SET last_seen_at = ? WHERE uid = ?", [now(), uid]);
}

/** What the browser is allowed to see about the signed-in reader. */
export const publicUser = (u: User) => ({
  uid: u.uid, email: u.email, name: u.name, picture: u.picture, provider: u.provider,
  signIns: u.sign_ins, since: u.created_at,
});
