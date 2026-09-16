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
    isActive: r.isActive ?? true,
    testStatus: r.testStatus,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : r.createdAt ? new Date(r.createdAt).toISOString() : r.createdAt,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : r.updatedAt ? new Date(r.updatedAt).toISOString() : r.updatedAt,
  };
}

function rowToPool(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function poolToRow(p) {
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    testStatus: testStatus ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, p) {
  const r = poolToRow(p);
  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       isActive=excluded.isActive, testStatus=excluded.testStatus,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.isActive, r.testStatus, r.data, r.createdAt, r.updatedAt]
  );
}

function toRemoteRow(p) {
  const r = poolToRow(p);
  return { ...r, isActive: r.isActive === 1, data: parseJson(r.data, {}) };
}

function sortByUpdatedDesc(list) {
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return list;
}

export async function getProxyPools(filter = {}) {
  return cachedRead(
    `pools:${JSON.stringify(filter)}`,
    undefined,
    async (sb) => {
      let q = sb.from("proxyPools").select("*");
      if (filter.isActive !== undefined) q = q.eq("isActive", filter.isActive);
      if (filter.testStatus) q = q.eq("testStatus", filter.testStatus);
      const { data, error } = await q;
      if (error) throw error;
      return sortByUpdatedDesc((data || []).map(fromRemoteRow));
    },
    async () => {
      const db = await getAdapter();
      const where = [];
      const params = [];
      if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
      if (filter.testStatus) { where.push("testStatus = ?"); params.push(filter.testStatus); }
      const sql = `SELECT * FROM proxyPools${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
      return sortByUpdatedDesc(db.all(sql, params).map(rowToPool));
    },
  );
}

export async function getProxyPoolById(id) {
  return cachedRead(
    `pools:id:${id}`,
    undefined,
    async (sb) => {
      const { data, error } = await sb.from("proxyPools").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return fromRemoteRow(data);
    },
    async () => {
      const db = await getAdapter();
      return rowToPool(db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]));
    },
  );
}

export async function createProxyPool(data) {
  const now = new Date().toISOString();
  const pool = {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    noProxy: data.noProxy || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastError: data.lastError || null,
    createdAt: now,
    updatedAt: now,
  };
  await dualWrite(
    "pools",
    async (sb) => {
      const { error } = await sb.from("proxyPools").upsert(toRemoteRow(pool));
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      upsert(db, pool);
    },
  );
  return pool;
}

export async function updateProxyPool(id, data) {
  let result = null;
  await dualWrite(
    "pools",
    async (sb) => {
      if (!result) return;
      const { error } = await sb.from("proxyPools").upsert(toRemoteRow(result));
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      db.transaction(() => {
        const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
        if (!row) return;
        const merged = { ...rowToPool(row), ...data, updatedAt: new Date().toISOString() };
        upsert(db, merged);
        result = merged;
      });
    },
  );
  return result;
}

export async function deleteProxyPool(id) {
  let removed = null;
  await dualWrite(
    "pools",
    async (sb) => {
      if (!removed) return;
      const { error } = await sb.from("proxyPools").delete().eq("id", id);
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      db.transaction(() => {
        const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
        if (!row) return;
        removed = rowToPool(row);
        db.run(`DELETE FROM proxyPools WHERE id = ?`, [id]);
      });
    },
  );
  return removed;
}
