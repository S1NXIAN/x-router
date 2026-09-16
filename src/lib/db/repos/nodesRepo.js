import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { cachedRead, dualWrite, fromRemote } from "../supabase.js";

function fromRemoteRow(r) {
  if (!r) return null;
  const data = r.data && typeof r.data === "object" ? r.data : fromRemote(r.data, {});
  return {
    ...(data || {}),
    id: r.id,
    type: r.type,
    name: r.name,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : r.createdAt ? new Date(r.createdAt).toISOString() : r.createdAt,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : r.updatedAt ? new Date(r.updatedAt).toISOString() : r.updatedAt,
  };
}

function rowToNode(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    type: row.type,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function nodeToRow(n) {
  const { id, type, name, createdAt, updatedAt, ...rest } = n;
  return {
    id,
    type: type ?? null,
    name: name ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, n) {
  const r = nodeToRow(n);
  db.run(
    `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.type, r.name, r.data, r.createdAt, r.updatedAt]
  );
}

function toRemoteRow(n) {
  const r = nodeToRow(n);
  return { ...r, data: parseJson(r.data, {}) };
}

export async function getProviderNodes(filter = {}) {
  return cachedRead(
    `nodes:${JSON.stringify(filter)}`,
    undefined,
    async (sb) => {
      let q = sb.from("providerNodes").select("*");
      if (filter.type) q = q.eq("type", filter.type);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []).map(fromRemoteRow);
    },
    async () => {
      const db = await getAdapter();
      const where = [];
      const params = [];
      if (filter.type) { where.push("type = ?"); params.push(filter.type); }
      const sql = `SELECT * FROM providerNodes${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
      return db.all(sql, params).map(rowToNode);
    },
  );
}

export async function getProviderNodeById(id) {
  return cachedRead(
    `nodes:id:${id}`,
    undefined,
    async (sb) => {
      const { data, error } = await sb.from("providerNodes").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return fromRemoteRow(data);
    },
    async () => {
      const db = await getAdapter();
      return rowToNode(db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]));
    },
  );
}

export async function createProviderNode(data) {
  const now = new Date().toISOString();
  const node = {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: data.prefix,
    apiType: data.apiType,
    baseUrl: data.baseUrl,
    createdAt: now,
    updatedAt: now,
  };
  await dualWrite(
    "nodes",
    async (sb) => {
      const { error } = await sb.from("providerNodes").upsert(toRemoteRow(node));
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      upsert(db, node);
    },
  );
  return node;
}

export async function updateProviderNode(id, data) {
  let result = null;
  await dualWrite(
    "nodes",
    async (sb) => {
      if (!result) return;
      const { error } = await sb.from("providerNodes").upsert(toRemoteRow(result));
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      db.transaction(() => {
        const row = db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]);
        if (!row) return;
        const merged = { ...rowToNode(row), ...data, updatedAt: new Date().toISOString() };
        upsert(db, merged);
        result = merged;
      });
    },
  );
  return result;
}

export async function deleteProviderNode(id) {
  let removed = null;
  await dualWrite(
    "nodes",
    async (sb) => {
      if (!removed) return;
      const { error } = await sb.from("providerNodes").delete().eq("id", id);
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      db.transaction(() => {
        const row = db.get(`SELECT * FROM providerNodes WHERE id = ?`, [id]);
        if (!row) return;
        removed = rowToNode(row);
        db.run(`DELETE FROM providerNodes WHERE id = ?`, [id]);
      });
    },
  );
  return removed;
}
