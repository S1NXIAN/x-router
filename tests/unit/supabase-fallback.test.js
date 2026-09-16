// Supabase dual-write verification, two modes:
// 1. "disabled" (no env): pure local SQLite, zero remote overhead — the
//    default every existing install runs. This is the fast regression net.
// 2. "unreachable" (dead endpoint + service key): proves fail-open — every
//    remote op must fall back to local SQLite with identical results.
// There is deliberately NO anon-key mode: under deny-all RLS an anon read
// returns 200 with [] instead of an error, which would mask local config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

let tempDir;
const OLD = { ...process.env };
let db;

const REMOTE_MODE = process.env.SUPABASE_TEST_REMOTE === "1";

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-supabase-smoke-"));
  process.env.DATA_DIR = tempDir;
  if (REMOTE_MODE) {
    // 127.0.0.1:9 (discard port, nothing listening) → ECONNREFUSED fast.
    // An unresolvable hostname was tried first; DNS retry slowness ate the
    // whole 5s budget per op even though fallback itself engaged correctly.
    process.env.SUPABASE_URL = "http://127.0.0.1:9";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "unused-service-key-for-offline-smoke";
    process.env.SUPABASE_TIMEOUT_MS = "1500";
  } else {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
  delete global._dbAdapter;
  vi.resetModules();
  const { __resetSupabaseForTests } = await import("@/lib/db/supabase.js");
  __resetSupabaseForTests();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  for (const [k, v] of Object.entries(OLD)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_TIMEOUT_MS"]) {
    if (!(k in OLD)) delete process.env[k];
  }
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Supabase offline fallback", () => {
  // Remote mode: mirror against a dead endpoint costs one timeout per write
  // (supabase-js retries internally; our 2.5s cap bounds it). Disabled mode:
  // no remote attempts at all — default 5s budget is plenty.
  const t = REMOTE_MODE ? { timeout: 60000 } : undefined;
  it("settings merge + alias round-trip (per-request hot read)", t, async () => {
    const s = await db.updateSettings({ smokeMarker: "supabase-1", cloudEnabled: false });
    expect(s.smokeMarker).toBe("supabase-1");
    expect(s.requireLogin).toBe(true);
    await db.setModelAlias("smoke-alias", "openai/gpt-4o");
    expect((await db.getModelAliases())["smoke-alias"]).toBe("openai/gpt-4o");
  });

  it("connections CRUD (dedup + update + delete)", t, async () => {
    const conn = await db.createProviderConnection({ provider: "smoke-prov", authType: "apikey", name: "smoke-key-1", apiKey: "k1" });
    expect((await db.getProviderConnectionById(conn.id))?.apiKey).toBe("k1");
    expect((await db.updateProviderConnection(conn.id, { testStatus: "active" }))?.testStatus).toBe("active");
    expect((await db.getProviderConnections({ provider: "smoke-prov" })).length).toBe(1);
    expect(await db.deleteProviderConnection(conn.id)).toBe(true);
  });

  it("nodes/pools/keys/combos round-trip + exportDb shape", t, async () => {
    const node = await db.createProviderNode({ type: "smoke", name: "n1", baseUrl: "http://x" });
    expect((await db.getProviderNodeById(node.id))?.name).toBe("n1");
    const pool = await db.createProxyPool({ name: "p1", proxyUrl: "http://proxy" });
    expect((await db.getProxyPoolById(pool.id))?.proxyUrl).toBe("http://proxy");
    const key = await db.createApiKey("smoke", "machine-smoke");
    expect(await db.validateApiKey(key.key)).toBe(true);
    const combo = await db.createCombo({ name: "smoke-combo", models: ["a/b"] });
    expect((await db.getComboByName("smoke-combo"))?.models?.[0]).toBe("a/b");

    const exported = await db.exportDb();
    for (const k of ["settings", "providerConnections", "providerNodes", "proxyPools", "apiKeys", "combos", "modelAliases"]) {
      expect(exported).toHaveProperty(k);
    }
    expect(exported.modelAliases["smoke-alias"]).toBe("openai/gpt-4o");

    await db.deleteApiKey(key.id);
    await db.deleteCombo(combo.id);
    await db.deleteProviderNode(node.id);
    await db.deleteProxyPool(pool.id);
    await db.deleteModelAlias("smoke-alias");
  });

  it("telemetry stays local (no network on the per-request write path)", t, async () => {
    await db.saveRequestUsage({ provider: "smoke", model: "m", tokens: { prompt_tokens: 5, completion_tokens: 7 }, status: "ok" });
    const hist = await db.getUsageHistory({ provider: "smoke" });
    expect(hist.length).toBeGreaterThan(0);
    expect(hist[hist.length - 1].model).toBe("m");
  });
});
