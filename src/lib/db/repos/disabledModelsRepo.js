import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { cachedRead, fromRemote, getSupabase, invalidateCache } from "../supabase.js";

const SCOPE = "disabledModels";

function toOut(rows) {
  const out = {};
  for (const r of rows || []) out[r.key] = Array.isArray(r.value) ? r.value : fromRemote(r.value, []);
  return out;
}

export async function getDisabledModels() {
  return cachedRead(
    `kv:${SCOPE}`,
    undefined,
    async (sb) => {
      const { data, error } = await sb.from("kv").select("key,value").eq("scope", SCOPE);
      if (error) throw error;
      return toOut(data);
    },
    async () => {
      const db = await getAdapter();
      const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
      const out = {};
      for (const r of rows) out[r.key] = parseJson(r.value, []);
      return out;
    },
  );
}

export async function getDisabledByProvider(providerAlias) {
  return cachedRead(
    `kv:${SCOPE}:${providerAlias}`,
    undefined,
    async (sb) => {
      const { data, error } = await sb.from("kv").select("value").eq("scope", SCOPE).eq("key", providerAlias).maybeSingle();
      if (error) throw error;
      return data ? (fromRemote(data.value, []) || []) : [];
    },
    async () => {
      const db = await getAdapter();
      const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
      return row ? (parseJson(row.value, []) || []) : [];
    },
  );
}

async function mirror(providerAlias, next) {
  const sb = getSupabase();
  if (sb) {
    try {
      if (next === null) {
        const { error } = await sb.from("kv").delete().eq("scope", SCOPE).eq("key", providerAlias);
        if (error) throw error;
      } else {
        const { error } = await sb.from("kv").upsert({ scope: SCOPE, key: providerAlias, value: next });
        if (error) throw error;
      }
    } catch (err) {
      console.warn(`[supabase] kv:${SCOPE} failed, using local SQLite fallback: ${err?.message || err}`);
    }
    invalidateCache(`kv:${SCOPE}`);
  }
}

// Atomic read-merge-write inside a transaction (no JS yield mid-transaction).
// Dual-write: local tx is the atomicity boundary; merged payload mirrors remote.
export async function disableModels(providerAlias, ids) {
  if (!providerAlias || !Array.isArray(ids)) return;
  const db = await getAdapter();
  let merged = null;
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
    const current = row ? (parseJson(row.value, []) || []) : [];
    merged = [...new Set([...current, ...ids])];
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [SCOPE, providerAlias, stringifyJson(merged)]
    );
  });
  await mirror(providerAlias, merged);
}

export async function enableModels(providerAlias, ids) {
  if (!providerAlias) return;
  const db = await getAdapter();
  let next = null;
  let deleted = false;
  db.transaction(() => {
    if (!Array.isArray(ids) || ids.length === 0) {
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
      deleted = true;
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
    const current = row ? (parseJson(row.value, []) || []) : [];
    const removeSet = new Set(ids);
    next = current.filter((id) => !removeSet.has(id));
    if (next.length === 0) {
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
      deleted = true;
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [SCOPE, providerAlias, stringifyJson(next)]
      );
    }
  });
  await mirror(providerAlias, deleted ? null : next);
}
