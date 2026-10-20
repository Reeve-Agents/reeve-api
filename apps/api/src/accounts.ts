import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Ledger } from "@reeve/receipts";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Persistence } from "./persistence";
import { newId, type Store } from "./store";

/**
 * Accounts on top of the single-owner app. A passkey is the account (Face ID or fingerprint, no
 * password); a Supabase magic link is the backup for a lost phone or a device without passkeys.
 * Every account gets its own workspace: a Store, a Ledger and a Composio user of its own. The
 * passkey that signs the owner in is the same one that approves rulebooks and payments, so its
 * public key and counter live in one place: the workspace's store.
 */

export interface Account {
  id: string;
  workspace: string;
  name?: string;
  email?: string;
  supabaseUserId?: string;
  /** Passkey credential ids that sign in to this account (their keys are in the workspace store). */
  credentials: string[];
  createdAt: string;
  lastSeenAt?: string;
}

interface AccountIndex {
  accounts: Record<string, Account>;
}

export interface Workspace {
  store: Store;
  ledger: Ledger;
  fetch: (req: Request) => Response | Promise<Response>;
}

export interface AccountDeps {
  persistence: Persistence;
  rp: { id: string; name: string; origin: string };
  /** Builds the API for one workspace (createApp with that workspace's store, ledger and connectors). */
  workspaceApp: (id: string, data: { store: Store; ledger: Ledger }, onPasskeyAdded: (credentialId: string) => void) => Workspace["fetch"];
  /** Public health when signed out (which parser and sandbox the server uses). */
  publicHealth: () => Record<string, unknown>;
  /** HMAC key for session cookies. Without one, a random key is used and sessions end on restart. */
  sessionSecret?: string;
  /** Supabase Auth for the magic-link backup (project URL and a secret or service-role key). */
  supabase?: { url: string; key: string } | null;
}

const COOKIE = "reeve_session";
const SESSION_DAYS = 30;
const CHALLENGE_TTL_MS = 5 * 60_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type RegistrationResponse = Parameters<typeof verifyRegistrationResponse>[0]["response"];
type AuthenticationResponse = Parameters<typeof verifyAuthenticationResponse>[0]["response"];

/** The challenge a WebAuthn response answers, read from its clientDataJSON. */
const challengeOf = (response: { response: { clientDataJSON: string } }) =>
  (JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")) as { challenge: string }).challenge;

export async function createAccountsApp(deps: AccountDeps) {
  const { persistence, rp } = deps;
  const index: AccountIndex = ((await persistence.loadAccounts()) as AccountIndex | null) ?? { accounts: {} };
  const saveIndex = () => persistence.saveAccounts(index);
  const secret = deps.sessionSecret ? Buffer.from(deps.sessionSecret) : randomBytes(32);
  if (!deps.sessionSecret) console.warn("REEVE_SESSION_SECRET is not set: sessions end when the server restarts.");
  const secure = rp.origin.startsWith("https://");

  // ── Sessions: a signed cookie that names the account and when it expires. ──
  const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");
  const startSession = (c: Context, account: Account) => {
    const payload = Buffer.from(JSON.stringify({ a: account.id, e: Date.now() + SESSION_DAYS * 86_400_000 })).toString("base64url");
    setCookie(c, COOKIE, `${payload}.${sign(payload)}`, { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86_400 });
    account.lastSeenAt = new Date().toISOString();
    saveIndex();
  };
  const sessionAccount = (c: Context): Account | null => {
    const [payload, mac] = (getCookie(c, COOKIE) ?? "").split(".");
    if (!payload || !mac) return null;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const { a, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { a: string; e: number };
    return e > Date.now() ? (index.accounts[a] ?? null) : null;
  };

  // ── Workspaces, opened on their first request and kept in memory. ──
  const open = new Map<string, Promise<Workspace>>();
  const workspace = (account: Account) => {
    let ws = open.get(account.workspace);
    if (!ws) {
      ws = persistence.openWorkspace(account.workspace).then((data) => ({
        ...data,
        fetch: deps.workspaceApp(account.workspace, data, (credentialId) => {
          if (!account.credentials.includes(credentialId)) account.credentials.push(credentialId);
          saveIndex();
        }),
      }));
      open.set(account.workspace, ws);
    }
    return ws;
  };

  // The first account adopts the workspace from before accounts existed, with its passkeys.
  const newAccount = async (fields: Partial<Account>): Promise<Account> => {
    const first = Object.keys(index.accounts).length === 0;
    const adopt = first && !Object.values(index.accounts).some((a) => a.workspace === "main") && (await persistence.hasLegacy());
    const id = newId("acct");
    const account: Account = { id, workspace: adopt ? "main" : id, credentials: [], createdAt: new Date().toISOString(), ...fields };
    if (adopt) account.credentials.push(...(await workspace(account)).store.data.passkeys.map((p) => p.id));
    index.accounts[id] = account;
    saveIndex();
    return account;
  };
  const byCredential = (credentialId: string) => Object.values(index.accounts).find((a) => a.credentials.includes(credentialId)) ?? null;
  const me = (account: Account, ws: Workspace) => ({
    id: account.id,
    name: account.name ?? null,
    email: account.email ?? null,
    passkeys: ws.store.data.passkeys.length,
  });

  const registrations = new Map<string, { accountId: string | null; name?: string; userId: string; at: number }>();
  const logins = new Map<string, number>();
  const fresh = (at: number | undefined) => at !== undefined && Date.now() - at < CHALLENGE_TTL_MS;

  const app = new Hono().basePath("/api");
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  // ── Who is signed in ──
  app.get("/auth/me", async (c) => {
    const account = sessionAccount(c);
    if (!account) return c.json({ account: null, emailLogin: Boolean(deps.supabase) });
    return c.json({ account: me(account, await workspace(account)), emailLogin: Boolean(deps.supabase) });
  });

  app.post("/auth/logout", (c) => {
    deleteCookie(c, COOKIE, { path: "/", secure });
    return c.json({ ok: true });
  });

  // ── Passkey: create an account, or add this device's passkey to the signed-in account ──
  app.post("/auth/passkey/register/options", async (c) => {
    const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
    const current = sessionAccount(c);
    const name = (body.name ?? "").trim().slice(0, 60) || undefined;
    const existing = current ? (await workspace(current)).store : null;
    const userId = existing ? existing.data.ownerUserId : randomBytes(16).toString("base64url");
    const options = await generateRegistrationOptions({
      rpName: rp.name,
      rpID: rp.id,
      userName: current?.email ?? current?.name ?? name ?? "Pemilik usaha",
      userDisplayName: current?.name ?? name ?? "Pemilik usaha",
      userID: Buffer.from(userId, "base64url"),
      attestationType: "none",
      excludeCredentials: existing?.data.passkeys.map((p) => ({ id: p.id, transports: p.transports })) ?? [],
      // Discoverable, so the owner signs in later without typing anything.
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    registrations.set(options.challenge, { accountId: current?.id ?? null, name, userId, at: Date.now() });
    return c.json(options);
  });

  app.post("/auth/passkey/register/verify", async (c) => {
    const { response } = await c.req.json<{ response: RegistrationResponse }>();
    const challenge = challengeOf(response);
    const pending = registrations.get(challenge);
    registrations.delete(challenge);
    if (!pending || !fresh(pending.at)) return c.json({ error: "Waktunya habis. Coba lagi." }, 400);
    const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true });
    if (!result.verified) return c.json({ error: "Passkey tidak bisa diverifikasi." }, 400);

    const account = (pending.accountId && index.accounts[pending.accountId]) || (await newAccount({ name: pending.name }));
    const ws = await workspace(account);
    // A brand-new workspace takes the passkey's user handle as its WebAuthn owner id.
    if (!pending.accountId && ws.store.data.passkeys.length === 0) ws.store.data.ownerUserId = pending.userId;
    const cred = result.registrationInfo.credential;
    ws.store.data.passkeys.push({ id: cred.id, publicKey: Buffer.from(cred.publicKey).toString("base64url"), counter: cred.counter, transports: cred.transports, createdAt: new Date().toISOString() });
    ws.store.save();
    if (!account.credentials.includes(cred.id)) account.credentials.push(cred.id);
    startSession(c, account);
    return c.json({ account: me(account, ws) });
  });

  // ── Passkey: sign in (no username: the passkey says which account it belongs to) ──
  app.post("/auth/passkey/login/options", async (c) => {
    const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: "required", allowCredentials: [] });
    logins.set(options.challenge, Date.now());
    return c.json(options);
  });

  app.post("/auth/passkey/login/verify", async (c) => {
    const { response } = await c.req.json<{ response: AuthenticationResponse }>();
    const challenge = challengeOf(response);
    const at = logins.get(challenge);
    logins.delete(challenge);
    if (!fresh(at)) return c.json({ error: "Waktunya habis. Coba lagi." }, 400);
    const account = byCredential(response.id);
    if (!account) return c.json({ error: "Passkey ini belum terdaftar di Reeve. Buat akun dulu." }, 404);
    const ws = await workspace(account);
    const passkey = ws.store.data.passkeys.find((p) => p.id === response.id);
    if (!passkey) return c.json({ error: "Passkey ini belum terdaftar di Reeve. Buat akun dulu." }, 404);
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: { id: passkey.id, publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")), counter: passkey.counter, transports: passkey.transports },
      requireUserVerification: true,
    });
    if (!result.verified) return c.json({ error: "Passkey tidak bisa diverifikasi." }, 400);
    passkey.counter = result.authenticationInfo.newCounter;
    ws.store.save();
    startSession(c, account);
    return c.json({ account: me(account, ws) });
  });

  // ── Email magic link (Supabase Auth): the backup way in, or a recovery email for a passkey account ──
  app.post("/auth/email/start", async (c) => {
    if (!deps.supabase) return c.json({ error: "Masuk lewat email belum disiapkan di server ini." }, 501);
    const { email } = await c.req.json<{ email?: string }>();
    const address = (email ?? "").trim().toLowerCase();
    if (!EMAIL.test(address)) return c.json({ error: "Alamat email belum benar." }, 400);
    const redirect = `${rp.origin}/?view=masuk`;
    const res = await fetch(`${deps.supabase.url}/auth/v1/otp?redirect_to=${encodeURIComponent(redirect)}`, {
      method: "POST",
      headers: { apikey: deps.supabase.key, "content-type": "application/json" },
      body: JSON.stringify({ email: address, create_user: true }),
    });
    if (res.status === 429) return c.json({ error: "Terlalu sering. Tunggu sebentar lalu coba lagi." }, 429);
    if (!res.ok) return c.json({ error: `Email tidak terkirim (Supabase ${res.status}).` }, 502);
    return c.json({ sent: true });
  });

  app.post("/auth/email/verify", async (c) => {
    if (!deps.supabase) return c.json({ error: "Masuk lewat email belum disiapkan di server ini." }, 501);
    const { access_token } = await c.req.json<{ access_token?: string }>();
    if (!access_token) return c.json({ error: "Link masuk tidak lengkap." }, 400);
    const res = await fetch(`${deps.supabase.url}/auth/v1/user`, { headers: { apikey: deps.supabase.key, authorization: `Bearer ${access_token}` } });
    if (!res.ok) return c.json({ error: "Link masuk sudah kedaluwarsa. Kirim ulang." }, 401);
    const user = (await res.json()) as { id: string; email?: string };
    const email = user.email?.toLowerCase();
    const current = sessionAccount(c);
    const owner = Object.values(index.accounts).find((a) => a.supabaseUserId === user.id || (email && a.email === email));
    if (current && owner && owner.id !== current.id) return c.json({ error: "Email ini sudah dipakai akun Reeve lain." }, 409);
    const account =
      current ??
      Object.values(index.accounts).find((a) => a.supabaseUserId === user.id || (email && a.email === email)) ??
      (await newAccount({}));
    // Signed in already: this links the email to the account as its recovery way in.
    account.supabaseUserId = user.id;
    if (email) account.email = email;
    startSession(c, account);
    return c.json({ account: me(account, await workspace(account)) });
  });

  // ── Everything else belongs to the signed-in account's workspace ──
  app.all("/*", async (c) => {
    const account = sessionAccount(c);
    if (!account) {
      if (c.req.path === "/api/health") return c.json({ ...deps.publicHealth(), signedIn: false });
      return c.json({ error: "Masuk dulu untuk memakai Reeve." }, 401);
    }
    return (await workspace(account)).fetch(c.req.raw);
  });

  return { app, accounts: () => Object.values(index.accounts) };
}
