import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountsApp } from "../src/accounts";
import { filePersistence } from "../src/persistence";

const SUPABASE = "https://example.supabase.co";

/** A tiny stand-in for createApp: says which workspace answered and keeps notes in its store. */
async function setup(home = mkdtempSync(join(tmpdir(), "reeve-accounts-"))) {
  const { app } = await createAccountsApp({
    persistence: filePersistence(home),
    rp: { id: "localhost", name: "Reeve", origin: "http://localhost:5173" },
    sessionSecret: "test-secret",
    supabase: { url: SUPABASE, key: "sb_secret_test" },
    publicHealth: () => ({ llm: "fixture", sandbox: "local" }),
    workspaceApp: (id, { store }) => {
      const ws = new Hono().basePath("/api");
      ws.get("/health", (c) => c.json({ workspace: id }));
      ws.get("/notes", (c) => c.json(Object.keys(store.data.datasets)));
      ws.post("/notes/:name", (c) => {
        store.data.datasets[c.req.param("name")] = { id: c.req.param("name"), name: "note", records: [], fields: [], createdAt: "" };
        store.save();
        return c.json({ ok: true });
      });
      return ws.fetch;
    },
  });
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown, jar = true) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(jar && cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return { status: res.status, json: (await res.json()) as Record<string, unknown>, setCookie: set };
  };
  return { call, home, signOut: () => (cookie = ""), setCookie: (c: string) => (cookie = c), getCookie: () => cookie };
}

/** Supabase Auth stub: every access token "token-<email>" belongs to that email. */
function stubSupabase() {
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.startsWith(`${SUPABASE}/auth/v1/otp`)) {
      sent.push((JSON.parse(String(init?.body)) as { email: string }).email);
      return new Response("{}", { status: 200 });
    }
    if (url === `${SUPABASE}/auth/v1/user`) {
      const token = new Headers(init?.headers).get("authorization")?.replace("Bearer token-", "");
      return token ? new Response(JSON.stringify({ id: `user-${token}`, email: token }), { status: 200 }) : new Response("{}", { status: 401 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe("accounts", () => {
  it("keeps the workspace behind a session but leaves health public", async () => {
    const { call } = await setup();
    expect((await call("GET", "/notes")).status).toBe(401);
    expect((await call("GET", "/health")).json).toEqual({ llm: "fixture", sandbox: "local", signedIn: false });
    expect((await call("GET", "/auth/me")).json).toEqual({ account: null, emailLogin: true });
  });

  it("signs in with an email link and gives every account its own workspace", async () => {
    const sent = stubSupabase();
    const { call, signOut } = await setup();
    expect((await call("POST", "/auth/email/start", { email: "Ani@Example.com" })).json).toEqual({ sent: true });
    expect(sent).toEqual(["ani@example.com"]);

    const ani = await call("POST", "/auth/email/verify", { access_token: "token-ani@example.com" });
    expect(ani.setCookie).toMatch(/reeve_session=.*HttpOnly/i);
    await call("POST", "/notes/ani-only");
    expect((await call("GET", "/notes")).json).toContain("ani-only");

    signOut();
    await call("POST", "/auth/email/verify", { access_token: "token-budi@example.com" });
    expect((await call("GET", "/notes")).json).not.toContain("ani-only");
    expect((await call("GET", "/auth/me")).json).toMatchObject({ account: { email: "budi@example.com" } });

    // The same email signs back in to the same account.
    signOut();
    await call("POST", "/auth/email/verify", { access_token: "token-ani@example.com" });
    expect((await call("GET", "/notes")).json).toContain("ani-only");
  });

  it("rejects a tampered cookie and an email that belongs to another account", async () => {
    stubSupabase();
    const { call, getCookie, setCookie, signOut } = await setup();
    await call("POST", "/auth/email/verify", { access_token: "token-ani@example.com" });
    signOut();
    await call("POST", "/auth/email/verify", { access_token: "token-budi@example.com" });
    expect((await call("POST", "/auth/email/verify", { access_token: "token-ani@example.com" })).status).toBe(409);

    const [payload, mac] = getCookie().replace("reeve_session=", "").split(".");
    const forged = Buffer.from(JSON.stringify({ a: "acct_someone", e: Date.now() + 1e9 })).toString("base64url");
    setCookie(`reeve_session=${forged}.${mac}`);
    expect((await call("GET", "/notes")).status).toBe(401);
    setCookie(`reeve_session=${payload}.${mac}`);
    expect((await call("GET", "/notes")).status).toBe(200);
  });

  it("lets the first account adopt the data from before accounts existed", async () => {
    stubSupabase();
    const home = mkdtempSync(join(tmpdir(), "reeve-legacy-"));
    const legacy = { ownerUserId: "owner", rulebooks: {}, runs: {}, operations: {}, genericOperations: {}, passkeys: [], challenges: { approvals: {}, refunds: {} }, datasets: { old: { id: "old", name: "old", records: [], fields: [], createdAt: "" } } };
    writeFileSync(join(home, "db.json"), JSON.stringify(legacy));
    const { call, signOut } = await setup(home);
    await call("POST", "/auth/email/verify", { access_token: "token-owner@example.com" });
    expect((await call("GET", "/notes")).json).toContain("old");
    signOut();
    await call("POST", "/auth/email/verify", { access_token: "token-new@example.com" });
    expect((await call("GET", "/notes")).json).not.toContain("old");
  });

  it("signs out", async () => {
    stubSupabase();
    const { call } = await setup();
    await call("POST", "/auth/email/verify", { access_token: "token-ani@example.com" });
    const out = await call("POST", "/auth/logout");
    expect(out.setCookie).toMatch(/reeve_session=;/);
    expect((await call("GET", "/notes")).status).toBe(401);
  });
});
