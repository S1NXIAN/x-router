import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { cachedRead, dualWrite, getSupabase } from "../supabase.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId ?? row.machine_id,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : row.createdAt ? new Date(row.createdAt).toISOString() : row.createdAt,
  };
}

function toRemoteRow(k) {
  return {
    id: k.id,
    key: k.key,
    name: k.name ?? null,
    machineId: k.machineId ?? null,
    isActive: k.isActive !== false,
    createdAt: k.createdAt,
  };
}
export async function getApiKeys() {
  return cachedRead(
    "keys:all",
    undefined,
    async (sb) => {
      const { data, error } = await sb.from("apiKeys").select("*").order("createdAt", { ascending: true });
      if (error) throw error;
      return (data || []).map(rowToKey);
    },
    async () => {
      const db = await getAdapter();
      const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
      return rows.map(rowToKey);
    },
  );
}

export async function getApiKeyById(id) {
  return cachedRead(
    `keys:id:${id}`,
    undefined,
    async (sb) => {
      const { data, error } = await sb.from("apiKeys").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return rowToKey(data);
    },
    async () => {
      const db = await getAdapter();
      const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
      return rowToKey(row);
    },
  );
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  await dualWrite(
    "keys",
    async (sb) => {
      const { error } = await sb.from("apiKeys").insert(toRemoteRow(apiKey));
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      db.run(
        `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt]
      );
    },
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  let result = null;
  await dualWrite(
    "keys",
    async (sb) => {
      if (!result) return;
      const { error } = await sb.from("apiKeys")
        .update({ key: result.key, name: result.name ?? null, machineId: result.machineId ?? null, isActive: result.isActive !== false })
        .eq("id", id);
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      db.transaction(() => {
        const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
        if (!row) return;
        const merged = { ...rowToKey(row), ...data };
        db.run(
          `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ? WHERE id = ?`,
          [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, id]
        );
        result = merged;
      });
    },
  );
  return result;
}

export async function deleteApiKey(id) {
  let deleted = false;
  await dualWrite(
    "keys",
    async (sb) => {
      if (!deleted) return;
      const { error } = await sb.from("apiKeys").delete().eq("id", id);
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
      deleted = (res?.changes ?? 0) > 0;
    },
  );
  return deleted;
}

export async function validateApiKey(key) {
  // Auth hot path: no cache — a revoked key must fail closed immediately.
  // Remote first (throws → local), so revocation propagates within one call.
  const sb = getSupabase();
  if (sb) {
    try {
      const { data, error } = await sb.from("apiKeys").select("isActive").eq("key", key).maybeSingle();
      if (error) throw error;
      if (data) return data.isActive === true;
      // Not found remotely — fall through to local (mirror may lag).
    } catch {
      // Fall through to local below.
    }
  }
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
