import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { cachedRead, dualWrite, fromRemote } from "../supabase.js";

function rowToCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: typeof row.models === "string" ? parseJson(row.models, []) : fromRemote(row.models, []),
    createdAt: typeof row.createdAt === "string" ? row.createdAt : row.createdAt ? new Date(row.createdAt).toISOString() : row.createdAt,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : row.updatedAt ? new Date(row.updatedAt).toISOString() : row.updatedAt,
  };
}

function toRemoteRow(c) {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind ?? null,
    models: c.models || [],
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}
export async function getCombos() {
  return cachedRead(
    "combos:all",
    undefined,
    async (sb) => {
      const { data, error } = await sb.from("combos").select("*").order("createdAt", { ascending: true });
      if (error) throw error;
      return (data || []).map(rowToCombo);
    },
    async () => {
      const db = await getAdapter();
      const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
      return rows.map(rowToCombo);
    },
  );
}

export async function getComboById(id) {
  return cachedRead(
    `combos:id:${id}`,
    undefined,
    async (sb) => {
      const { data, error } = await sb.from("combos").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return rowToCombo(data);
    },
    async () => {
      const db = await getAdapter();
      const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
      return rowToCombo(row);
    },
  );
}

export async function getComboByName(name) {
  return cachedRead(
    `combos:name:${name}`,
    undefined,
    async (sb) => {
      const { data, error } = await sb.from("combos").select("*").eq("name", name).maybeSingle();
      if (error) throw error;
      return rowToCombo(data);
    },
    async () => {
      const db = await getAdapter();
      const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
      return rowToCombo(row);
    },
  );
}

export async function createCombo(data) {
  const now = new Date().toISOString();
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    createdAt: now,
    updatedAt: now,
  };
  await dualWrite(
    "combos",
    async (sb) => {
      const { error } = await sb.from("combos").insert(toRemoteRow(combo));
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      db.run(
        `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.createdAt, combo.updatedAt]
      );
    },
  );
  return combo;
}

export async function updateCombo(id, data) {
  let result = null;
  await dualWrite(
    "combos",
    async (sb) => {
      if (!result) return;
      const { error } = await sb.from("combos")
        .update({ name: result.name, kind: result.kind ?? null, models: result.models || [], updatedAt: result.updatedAt })
        .eq("id", id);
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      db.transaction(() => {
        const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
        if (!row) return;
        const merged = { ...rowToCombo(row), ...data, updatedAt: new Date().toISOString() };
        db.run(
          `UPDATE combos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?`,
          [merged.name, merged.kind, stringifyJson(merged.models || []), merged.updatedAt, id]
        );
        result = merged;
      });
    },
  );
  return result;
}

export async function deleteCombo(id) {
  let deleted = false;
  await dualWrite(
    "combos",
    async (sb) => {
      if (!deleted) return;
      const { error } = await sb.from("combos").delete().eq("id", id);
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
      deleted = (res?.changes ?? 0) > 0;
    },
  );
  return deleted;
}
