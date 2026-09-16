// Regression: settings dual-write must not clobber remote keys missing locally.
// Render free tier has an ephemeral filesystem: after a redeploy the local
// SQLite is fresh/empty, so the first PATCH merges into {} locally and used to
// upsert that partial object over the full remote row, wiping keys saved from
// the previous instance (provider round-robins vs global /settings toggles).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterAll, vi } from "vitest";

const OLD = { ...process.env };
const dirs = [];
let store;
let bootCount = 0;

// In-memory PostgREST stub: only the settings calls getSettings/updateSettings make.
function makeRemoteStub() {
  return {
    from(table) {
      if (table !== "settings") throw new Error(`unexpected table ${table}`);
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { data: store.settings ? { data: store.settings } : null, error: null };
                },
              };
            },
          };
        },
        async upsert(row) {
          store.settings = row.data;
          return { error: null };
        },
      };
    },
  };
}

// Simulate one instance boot (fresh local SQLite, same remote).
async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `9router-settings-merge-${bootCount++}-`));
  dirs.push(dir);
  process.env.DATA_DIR = dir;
  process.env.SUPABASE_URL = "http://stub.local";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-key";
  delete global._dbAdapter;
  vi.resetModules();
  const supa = await import("@/lib/db/supabase.js");
  supa.__resetSupabaseForTests();
  const g = global._supabaseConfig;
  g.client = makeRemoteStub();
  g.url = process.env.SUPABASE_URL;
  g.key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  return db;
}

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  for (const [k, v] of Object.entries(OLD)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!(k in OLD)) delete process.env[k];
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("settings remote merge across ephemeral redeploys", () => {
  it("partial PATCH on fresh local keeps remote-only keys", async () => {
    store = {};
    const db1 = await boot();
    await db1.updateSettings({
      providerStrategies: { openrouter: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 } },
    });
    expect(store.settings.providerStrategies.openrouter.fallbackStrategy).toBe("round-robin");

    // Redeploy: fresh local SQLite, same remote.
    const db2 = await boot();
    await db2.updateSettings({ fallbackStrategy: "round-robin" });

    expect(store.settings.fallbackStrategy).toBe("round-robin");
    expect(store.settings.providerStrategies.openrouter.fallbackStrategy).toBe("round-robin");
    const s = await db2.getSettings();
    expect(s.fallbackStrategy).toBe("round-robin");
    expect(s.providerStrategies.openrouter.fallbackStrategy).toBe("round-robin");
  });
});
