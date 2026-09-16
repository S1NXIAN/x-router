// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";
export { isSupabaseEnabled, invalidateCache as invalidateRemoteCache } from "./supabase.js";
// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
} from "./repos/apiKeysRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.js";

// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
} from "./repos/requestDetailsRepo.js";

// Export/import full DB
export async function exportDb() {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo.js");

  const out = {
    settings: await exportSettings(),
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: db.all(`SELECT * FROM apiKeys`).map((r) => ({ id: r.id, key: r.key, name: r.name, machineId: r.machineId, isActive: r.isActive === 1, createdAt: r.createdAt })),
    combos: db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);

  return out;
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();

  db.transaction(() => {
    // Wipe all tables (keep _meta)
    db.run(`DELETE FROM settings`);
    db.run(`DELETE FROM providerConnections`);
    db.run(`DELETE FROM providerNodes`);
    db.run(`DELETE FROM proxyPools`);
    db.run(`DELETE FROM apiKeys`);
    db.run(`DELETE FROM combos`);
    db.run(`DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing')`);

    // Settings
    if (payload.settings) {
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
    }

    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      db.run(
        `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run(
        `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run(
        `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const k of payload.apiKeys || []) {
      db.run(
        `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString()]
      );
    }
    for (const c of payload.combos || []) {
      db.run(
        `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
        [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
    }
    for (const m of payload.customModels || []) {
      const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
    }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
    }
    for (const [provider, models] of Object.entries(payload.pricing || {})) {
      db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
    }
  });

  await mirrorImportRemote(payload);

  return await exportDb();
}

// Mirror the full replace remote so a restore/import doesn't diverge the
// mirror. Best-effort: remote failure is logged, local stays source of truth.
async function mirrorImportRemote(payload) {
  try {
    const { getSupabase, invalidateCache } = await import("./supabase.js");
    const sb = getSupabase();
    if (!sb) return;
    const now = new Date().toISOString();
    const wipe = [
      sb.from("providerConnections").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
      sb.from("providerNodes").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
      sb.from("proxyPools").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
      sb.from("apiKeys").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
      sb.from("combos").delete().neq("id", "00000000-0000-0000-0000-000000000000"),
      sb.from("settings").delete().neq("id", -1),
      sb.from("kv").delete().neq("scope", ""),
    ];
    for (const q of wipe) {
      const { error } = await q;
      if (error) throw error;
    }
    const puts = [];
    if (payload.settings) puts.push(sb.from("settings").upsert({ id: 1, data: payload.settings }));
    const conns = (payload.providerConnections || []).map((c) => {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      return { id, provider, authType: authType || "oauth", name: name ?? null, email: email ?? null, priority: priority ?? null, isActive: isActive !== false, data: rest, createdAt: createdAt || now, updatedAt: updatedAt || now };
    });
    if (conns.length) puts.push(sb.from("providerConnections").insert(conns));
    const nodes = (payload.providerNodes || []).map((n) => {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      return { id, type: type ?? null, name: name ?? null, data: rest, createdAt: createdAt || now, updatedAt: updatedAt || now };
    });
    if (nodes.length) puts.push(sb.from("providerNodes").insert(nodes));
    const pools = (payload.proxyPools || []).map((p) => {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      return { id, isActive: isActive !== false, testStatus: testStatus ?? "unknown", data: rest, createdAt: createdAt || now, updatedAt: updatedAt || now };
    });
    if (pools.length) puts.push(sb.from("proxyPools").insert(pools));
    const keys = (payload.apiKeys || []).map((k) => ({ id: k.id, key: k.key, name: k.name ?? null, machineId: k.machineId ?? null, isActive: k.isActive !== false, createdAt: k.createdAt || now }));
    if (keys.length) puts.push(sb.from("apiKeys").insert(keys));
    const combos = (payload.combos || []).map((c) => ({ id: c.id, name: c.name, kind: c.kind ?? null, models: c.models || [], createdAt: c.createdAt || now, updatedAt: c.updatedAt || now }));
    if (combos.length) puts.push(sb.from("combos").insert(combos));
    const kvRows = [];
    for (const [a, m] of Object.entries(payload.modelAliases || {})) kvRows.push({ scope: "modelAliases", key: a, value: m });
    for (const m of payload.customModels || []) kvRows.push({ scope: "customModels", key: `${m.providerAlias}|${m.id}|${m.type || "llm"}`, value: m });
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) kvRows.push({ scope: "mitmAlias", key: tool, value: mappings || {} });
    for (const [provider, models] of Object.entries(payload.pricing || {})) kvRows.push({ scope: "pricing", key: provider, value: models || {} });
    if (kvRows.length) puts.push(sb.from("kv").insert(kvRows));
    for (const q of puts) {
      const { error } = await q;
      if (error) throw error;
    }
    invalidateCache();
  } catch (err) {
    console.warn(`[supabase] importDb remote mirror failed, local SQLite is source of truth: ${err?.message || err}`);
  }
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
