// Remote config backend — Supabase (Postgres) for the CONFIG domain only.
//
// Scope: settings, providerConnections, providerNodes, proxyPools, apiKeys,
// combos, and the kv scopes owned by the config domain (modelAliases,
// customModels, mitmAlias, pricing, disabledModels). Enabled ONLY when
// SUPABASE_URL (+ a key) is set; otherwise the local SQLite layer in this
// directory remains the single backend.
//
// Telemetry (usageHistory/usageDaily/_meta lifetime counter, requestDetails)
// stays in local SQLite BY DESIGN: per-request writes are fire-and-forget and
// the usage repo assumes synchronous in-process transactions; moving them
// remote would put a network round-trip + failure mode on every inference.
//
// Failure mode: remote-primary with local SQLite as fallback. A remote error
// on ANY config read falls back to the local repo and logs loudly; writes
// dual-write (local first so the gateway never blocks on the network, remote
// mirrored second — local is the last-known-good copy, so an outage still
// serves stale config). Remote failures NEVER throw to callers.
//
// Hot-path mitigation: short-TTL read cache for the per-request config reads
// (settings / providerConnections / modelAliases). Writes go straight through
// and invalidate. Stale window is seconds; precedents are the 5s pricing
// cache and 30s connection-name cache already in the repos.
//
// Secrets: providerConnections.data holds PLAINTEXT OAuth tokens/API keys —
// parity with the local SQLite file. The server MUST use the service-role key
// server-side only (never the browser). RLS is enabled with NO permissive
// policies; the service-role key bypasses RLS. There is deliberately NO anon-
// key support: under deny-all RLS an anon read returns 200 with [] instead of
// an error, which would mask local config as empty. No service-role key =
// local SQLite only, no remote attempts at all.
//
// Sync/merge semantics: every local write that matters is read-merge-write
// (OAuth refresh race guard, settings merge, kv set-union, priority reorder).
// Under dual-write the LOCAL SQLite transaction is the atomicity boundary;
// the remote write is last-writer-wins on the same merged payload.
//
// Env:
//   SUPABASE_URL               https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  service-role key (server only, bypasses RLS)
//   SUPABASE_CONFIG_TTL_MS     read-cache TTL, default 5000
//   SUPABASE_TIMEOUT_MS        per-request fetch timeout, default 2500
import { createClient } from "@supabase/supabase-js";

function getTtlMs() {
  return Number(process.env.SUPABASE_CONFIG_TTL_MS) || 5000;
}

// supabase-js retries failed fetches internally (~7s observed against a
// refused connection), so this timeout only caps OUR wait, not the client's.
// Keep default under the 5s vitest budget; production can raise it.
function getTimeoutMs() {
  return Number(process.env.SUPABASE_TIMEOUT_MS) || 2500;
}

// Use global so Next.js dev hot-reload keeps one client (mirrors driver.js).
if (!global._supabaseConfig) {
  global._supabaseConfig = { client: null, url: null, key: null, cache: new Map(), warnedDown: false };
}
const state = global._supabaseConfig;

function withTimeout(promise) {
  const ms = getTimeoutMs();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`supabase timeout after ${ms}ms`)), ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Decode a jsonb value from PostgREST. Unlike the SQLite TEXT path, remote
// values arrive already parsed — except scalar strings (e.g. a model alias),
// where JSON.parse would fail on the raw string itself.
export function fromRemote(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function isSupabaseEnabled() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabase() {
  if (!isSupabaseEnabled()) return null;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (state.client && state.url === url && state.key === key) return state.client;
  state.client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (fetchUrl, init) => withTimeout(fetch(fetchUrl, init)) },
  });
  state.url = url;
  state.key = key;
  return state.client;
}

export function __resetSupabaseForTests() {
  state.client = null;
  state.url = null;
  state.key = null;
  state.cache.clear();
  state.warnedDown = false;
}

function logFallback(op, err) {
  // Warn once per outage; per-op after that so logs don't flood per request.
  if (!state.warnedDown) {
    console.warn(`[supabase] ${op} failed, using local SQLite fallback: ${err?.message || err}`);
    state.warnedDown = true;
    setTimeout(() => { state.warnedDown = false; }, 60000).unref?.();
  }
}

// Read-through cache for hot-path config reads. Key must include args JSON.
export async function cachedRead(key, ttlMs, fetchRemote, fetchLocal) {
  const sb = getSupabase();
  if (!sb) return fetchLocal();
  const now = Date.now();
  const hit = state.cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  try {
    const value = await fetchRemote(sb);
    state.cache.set(key, { value, expiresAt: now + (ttlMs ?? getTtlMs()) });
    return value;
  } catch (err) {
    logFallback(key, err);
    return fetchLocal();
  }
}

export function invalidateCache(prefix) {
  if (!prefix) { state.cache.clear(); return; }
  for (const k of state.cache.keys()) {
    if (k === prefix || k.startsWith(prefix + ":")) state.cache.delete(k);
  }
}

// Dual-write: local FIRST (never block the gateway on the network), remote
// mirrored second. Remote failure is logged + invalidates the read cache,
// never thrown. Returns the local result.
export async function dualWrite(op, writeRemote, writeLocal) {
  const localResult = await writeLocal();
  const sb = getSupabase();
  if (!sb) return localResult;
  try {
    await writeRemote(sb);
    invalidateCache(op.split(":")[0]);
  } catch (err) {
    logFallback(op, err);
    invalidateCache(op.split(":")[0]);
  }
  return localResult;
}
