import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { cachedRead, dualWrite, fromRemote } from "../supabase.js";

// Remote rows store timestamps as timestamptz; normalize to the ISO strings
// callers expect (same shape as the SQLite rowToConn output).
function fromRemoteRow(r) {
  if (!r) return null;
  const data = r.data && typeof r.data === "object" ? r.data : fromRemote(r.data, {});
  return {
    ...(data || {}),
    id: r.id,
    provider: r.provider,
    authType: r.authType || r.auth_type,
    name: r.name,
    email: r.email,
    priority: r.priority,
    isActive: r.isActive ?? r.is_active ?? true,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : r.createdAt ? new Date(r.createdAt).toISOString() : r.createdAt,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : r.updatedAt ? new Date(r.updatedAt).toISOString() : r.updatedAt,
  };
}

function toRemoteRow(c) {
  const r = connToRow(c);
  // connToRow packs everything else into a JSON string; remote wants jsonb.
  return { ...r, isActive: r.isActive === 1, data: parseJson(r.data, {}) };
}
const OPTIONAL_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount", "idToken", "lastRefreshAt",
];

const MODEL_LOCK_PREFIX = "modelLock_";

function resetHealthStateOnActivation(existing, patch) {
  if (patch?.testStatus !== "active") return patch;

  const normalized = {
    ...patch,
    testStatus: "active",
    lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : null,
    lastErrorAt: Object.hasOwn(patch, "lastErrorAt") ? patch.lastErrorAt : null,
    errorCode: null,
    rateLimitedUntil: null,
    backoffLevel: 0,
  };

  for (const key of Object.keys(existing || {})) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) normalized[key] = null;
  }

  return normalized;
}

function rowToConn(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, c) {
  const r = connToRow(c);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.provider, r.authType, r.name, r.email, r.priority, r.isActive, r.data, r.createdAt, r.updatedAt]
  );
}

function deriveConnectionName(data, fallbackName) {
  if (data.provider === "github") {
    return data.providerSpecificData?.githubLogin
      || data.providerSpecificData?.githubEmail
      || data.email
      || data.providerSpecificData?.githubName
      || fallbackName;
  }
  return fallbackName;
}

function sortByPriority(list) {
  list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return list;
}

export async function getProviderConnections(filter = {}) {
  const cacheKey = `connections:${JSON.stringify(filter)}`;
  return cachedRead(
    cacheKey,
    undefined,
    async (sb) => {
      let q = sb.from("providerConnections").select("*");
      if (filter.provider) q = q.eq("provider", filter.provider);
      if (filter.isActive !== undefined) q = q.eq("isActive", filter.isActive);
      const { data, error } = await q;
      if (error) throw error;
      return sortByPriority((data || []).map(fromRemoteRow));
    },
    async () => {
      const db = await getAdapter();
      const where = [];
      const params = [];
      if (filter.provider) { where.push("provider = ?"); params.push(filter.provider); }
      if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
      const sql = `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
      const rows = db.all(sql, params);
      return sortByPriority(rows.map(rowToConn));
    },
  );
}

export async function getProviderConnectionById(id) {
  return cachedRead(
    `connections:id:${id}`,
    undefined,
    async (sb) => {
      const { data, error } = await sb.from("providerConnections").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return fromRemoteRow(data);
    },
    async () => {
      const db = await getAdapter();
      const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
      return rowToConn(row);
    },
  );
}

// Internal sync reorder — must be called INSIDE a transaction
function reorderInTx(db, providerId) {
  const list = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId]).map(rowToConn);
  list.sort((a, b) => {
    const pDiff = (a.priority || 0) - (b.priority || 0);
    if (pDiff !== 0) return pDiff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  list.forEach((c, i) => {
    db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [i + 1, c.id]);
  });
}

export async function createProviderConnection(data) {
  const now = new Date().toISOString();
  let result;
  let providerRows;

  await dualWrite(
    `connections:${data.provider}`,
    async (sb) => {
      // Mirror the post-tx local state: upsert the result row, then push the
      // reordered priorities for the provider (reorder only touches priority).
      const { error } = await sb.from("providerConnections").upsert(toRemoteRow(result));
      if (error) throw error;
      if (providerRows) {
        const { error: pErr } = await sb.from("providerConnections").upsert(providerRows.map(toRemoteRow));
        if (pErr) throw pErr;
      }
    },
    async () => {
      const db = await getAdapter();
      db.transaction(() => {
        const all = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);

        let existing = null;
        if (data.authType === "oauth" && data.email) {
          const incomingUsername = data.providerSpecificData?.username;
          const incomingWs = data.providerSpecificData?.chatgptAccountId;
          existing = all.find(c => {
            if (c.authType !== "oauth" || c.email !== data.email) return false;

            // Codex/OpenAI can issue multiple OAuth grants for the same email.
            // Refresh tokens are rotated single-use; collapsing a new login onto an
            // existing bare-email row overwrites the first account's token pair and
            // makes it look "invalid" after adding a second account. Only update an
            // existing Codex row when both rows expose the same ChatGPT account ID.
            if (data.provider === "codex") {
              const existingWs = c.providerSpecificData?.chatgptAccountId;
              return !!incomingWs && !!existingWs && incomingWs === existingWs;
            }

            // Workspace providers use workspace ID when both sides have it
            const existingWs = c.providerSpecificData?.chatgptAccountId;
            if (incomingWs && existingWs) return incomingWs === existingWs;
            if (incomingWs && !existingWs) return false;
            if (!incomingWs && existingWs) return false;
            // Non-workspace providers: match on (email + username) so cross-IdP
            // accounts don't overwrite each other. Require username on both sides
            // — if only one side has it, treat as a distinct identity rather than
            // collapsing onto the bare-email fallback (which would re-introduce
            // the cross-IdP overwrite).
            const existingUsername = c.providerSpecificData?.username;
            if (incomingUsername && existingUsername) {
              return incomingUsername === existingUsername;
            }
            if (incomingUsername || existingUsername) return false;
            return true;
          });
        } else if (data.authType === "apikey" && data.name) {
          existing = all.find(c => c.authType === "apikey" && c.name === data.name);
        }
        // access_token: never dedup — user manages duplicates manually

        if (existing) {
          const normalized = resetHealthStateOnActivation(existing, data);
          const merged = { ...existing, ...normalized, updatedAt: now };
          upsert(db, merged);
          result = merged;
          return;
        }

        let connectionName = data.name || null;
        if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
          connectionName = deriveConnectionName(data, data.email || `Account ${all.length + 1}`);
        }
        let connectionPriority = data.priority;
        if (!connectionPriority) {
          connectionPriority = all.reduce((m, c) => Math.max(m, c.priority || 0), 0) + 1;
        }

        const conn = {
          id: uuidv4(),
          provider: data.provider,
          authType: data.authType || "oauth",
          name: connectionName,
          priority: connectionPriority,
          isActive: data.isActive !== undefined ? data.isActive : true,
          createdAt: now,
          updatedAt: now,
        };
        for (const f of OPTIONAL_FIELDS) {
          if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
        }
        if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
          conn.providerSpecificData = data.providerSpecificData;
        }
        if (data.email !== undefined) conn.email = data.email;

        upsert(db, conn);
        reorderInTx(db, data.provider);
        result = conn;
        providerRows = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);
      });
    },
  );

  return result;
}

// Critical: OAuth refresh token race — atomic merge inside transaction.
// Dual-write: local tx is the atomicity boundary; merged payload mirrors remote.
export async function updateProviderConnection(id, data) {
  let result;
  let providerRows = null;
  await dualWrite(
    "connections",
    async (sb) => {
      if (!result) return;
      const { error } = await sb.from("providerConnections").upsert(toRemoteRow(result));
      if (error) throw error;
      if (providerRows) {
        const { error: pErr } = await sb.from("providerConnections").upsert(providerRows.map(toRemoteRow));
        if (pErr) throw pErr;
      }
    },
    async () => {
      const db = await getAdapter();
      db.transaction(() => {
        const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
        if (!row) { result = null; return; }
        const existing = rowToConn(row);
        const normalized = resetHealthStateOnActivation(existing, data);
        const merged = { ...existing, ...normalized, updatedAt: new Date().toISOString() };
        upsert(db, merged);
        if (data.priority !== undefined) reorderInTx(db, existing.provider);
        result = merged;
        providerRows = data.priority !== undefined
          ? db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [existing.provider]).map(rowToConn)
          : null;
      });
    },
  );
  return result;
}

export async function deleteProviderConnection(id) {
  let ok = false;
  let providerRows = null;
  await dualWrite(
    "connections",
    async (sb) => {
      if (!ok) return;
      const { error } = await sb.from("providerConnections").delete().eq("id", id);
      if (error) throw error;
      if (providerRows) {
        const { error: pErr } = await sb.from("providerConnections").upsert(providerRows.map(toRemoteRow));
        if (pErr) throw pErr;
      }
    },
    async () => {
      const db = await getAdapter();
      db.transaction(() => {
        const row = db.get(`SELECT provider FROM providerConnections WHERE id = ?`, [id]);
        if (!row) return;
        db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
        reorderInTx(db, row.provider);
        providerRows = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [row.provider]).map(rowToConn);
        ok = true;
      });
    },
  );
  return ok;
}
export async function deleteProviderConnectionsByProvider(providerId) {
  let count = 0;
  await dualWrite(
    `connections:${providerId}`,
    async (sb) => {
      const { error } = await sb.from("providerConnections").delete().eq("provider", providerId);
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      const before = db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [providerId]);
      db.run(`DELETE FROM providerConnections WHERE provider = ?`, [providerId]);
      count = before?.n || 0;
    },
  );
  return count;
}

export async function reorderProviderConnections(providerId) {
  let providerRows = null;
  await dualWrite(
    `connections:${providerId}`,
    async (sb) => {
      if (!providerRows) return;
      const { error } = await sb.from("providerConnections").upsert(providerRows.map(toRemoteRow));
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      db.transaction(() => reorderInTx(db, providerId));
      providerRows = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId]).map(rowToConn);
    },
  );
}

export async function cleanupProviderConnections() {
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount",
  ];
  let cleaned = 0;
  let touched = null;
  await dualWrite(
    "connections",
    async (sb) => {
      if (!touched) return;
      const { error } = await sb.from("providerConnections").upsert(touched.map(toRemoteRow));
      if (error) throw error;
    },
    async () => {
      const db = await getAdapter();
      const dirty = [];
      db.transaction(() => {
        const rows = db.all(`SELECT * FROM providerConnections`);
        for (const row of rows) {
          const conn = rowToConn(row);
          let isDirty = false;
          for (const f of fieldsToCheck) {
            if (conn[f] === null || conn[f] === undefined) {
              if (f in conn) { delete conn[f]; cleaned++; isDirty = true; }
            }
          }
          if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
            delete conn.providerSpecificData;
            cleaned++;
            isDirty = true;
          }
          if (isDirty) { upsert(db, conn); dirty.push(conn); }
        }
      });
      touched = dirty.length ? dirty : null;
    },
  );
  return cleaned;
}
