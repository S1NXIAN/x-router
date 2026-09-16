import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "./jsonCol.js";
import { cachedRead, dualWrite, fromRemote } from "../supabase.js";

// Remote row shapes differ from SQLite (TEXT) only in jsonb decoding:
// PostgREST returns objects natively, SQLite returns TEXT. fromRemote covers both.
function toOut(rows) {
  const out = {};
  for (const r of rows || []) out[r.key] = fromRemote(r.value);
  return out;
}
// High-frequency session data stays local-only: pushing it remote would put a
// network round-trip on the translation hot path (this scope is fail-open by design).
const LOCAL_ONLY_SCOPES = new Set(["gemini_thought_signatures"]);

async function localGetAll(scope) {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [scope]);
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value);
  return out;
}

async function localSet(scope, key, value) {
  const db = await getAdapter();
  db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [scope, key, stringifyJson(value)]);
}

async function localSetMany(scope, entries) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [k, v] of entries) {
      db.run(`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [scope, k, stringifyJson(v)]);
    }
  });
}

async function localRemove(scope, key) {
  const db = await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [scope, key]);
}

async function localClear(scope) {
  const db = await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = ?`, [scope]);
}

export function makeKv(scope) {
  return {
    async get(key, fallback = null) {
      if (LOCAL_ONLY_SCOPES.has(scope)) {
        const db = await getAdapter();
        const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [scope, key]);
        return row ? parseJson(row.value, fallback) : fallback;
      }
      return cachedRead(
        `kv:${scope}:${key}`,
        undefined,
        async (sb) => {
          const { data, error } = await sb.from("kv").select("value").eq("scope", scope).eq("key", key).maybeSingle();
          if (error) throw error;
          return data ? fromRemote(data.value, fallback) : fallback;
        },
        async () => {
          const db = await getAdapter();
          const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [scope, key]);
          return row ? parseJson(row.value, fallback) : fallback;
        },
      );
    },
    async getAll() {
      if (LOCAL_ONLY_SCOPES.has(scope)) return localGetAll(scope);
      return cachedRead(
        `kv:${scope}`,
        undefined,
        async (sb) => {
          const { data, error } = await sb.from("kv").select("key,value").eq("scope", scope);
          if (error) throw error;
          return toOut(data);
        },
        async () => localGetAll(scope),
      );
    },
    async set(key, value) {
      if (LOCAL_ONLY_SCOPES.has(scope)) return localSet(scope, key, value);
      await dualWrite(
        `kv:${scope}`,
        async (sb) => {
          const { error } = await sb.from("kv").upsert({ scope, key, value });
          if (error) throw error;
        },
        async () => localSet(scope, key, value),
      );
    },
    async setMany(obj) {
      const entries = Object.entries(obj);
      if (LOCAL_ONLY_SCOPES.has(scope)) return localSetMany(scope, entries);
      await dualWrite(
        `kv:${scope}`,
        async (sb) => {
          const { error } = await sb.from("kv").upsert(entries.map(([k, v]) => ({ scope, key: k, value: v })));
          if (error) throw error;
        },
        async () => localSetMany(scope, entries),
      );
    },
    async remove(key) {
      if (LOCAL_ONLY_SCOPES.has(scope)) return localRemove(scope, key);
      await dualWrite(
        `kv:${scope}`,
        async (sb) => {
          const { error } = await sb.from("kv").delete().eq("scope", scope).eq("key", key);
          if (error) throw error;
        },
        async () => localRemove(scope, key),
      );
    },
    async clear() {
      if (LOCAL_ONLY_SCOPES.has(scope)) return localClear(scope);
      await dualWrite(
        `kv:${scope}`,
        async (sb) => {
          const { error } = await sb.from("kv").delete().eq("scope", scope);
          if (error) throw error;
        },
        async () => localClear(scope),
      );
    },
  };
}
